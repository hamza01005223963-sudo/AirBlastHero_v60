/* ==========================================================
   AIR BLAST HERO — Multiplayer networking layer (mp.js)
   Pure P2P via WebRTC. No backend server. Connection is
   established via manual "code" exchange (host generates an
   offer code, guest pastes it and generates an answer code,
   host pastes that back). Uses public STUN servers only for
   NAT traversal — no game data ever passes through a third
   party server.

   TWO DATA CHANNELS:
   - "state": unreliable + unordered, maxRetransmits 0. Used
     for high-frequency position/health snapshots (~20/s) where
     a dropped packet doesn't matter because a newer one is on
     the way a moment later.
   - "ctrl": reliable + ordered. Used for one-shot events that
     must arrive exactly once — round start/end, emotes,
     mission triggers, revive, hit registration, ping/pong.
   ========================================================== */

window.MP = (function () {
  "use strict";

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  const PING_INTERVAL_MS = 2000;

  let pc = null;
  let stateChannel = null;
  let ctrlChannel = null;
  let role = null; // "host" | "guest"
  let onStateMsgCb = null;   // (obj) -> void, fast/unreliable channel
  let onCtrlMsgCb = null;    // (obj) -> void, reliable channel
  let onConnStateCb = null;  // (state, detail) -> void ; states: connecting, connected, disconnected, error
  let pingTimer = null;
  let lastPingMs = null; // last measured round-trip time in ms, or null if unknown
  let stateOpen = false, ctrlOpen = false;

  function reportConnState(state, detail) {
    if (onConnStateCb) onConnStateCb(state, detail);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    lastPingMs = null;
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (ctrlChannel && ctrlChannel.readyState === "open") {
        try { ctrlChannel.send(JSON.stringify({ __t: "ping", ts: Date.now() })); } catch (e) {}
      }
    }, PING_INTERVAL_MS);
  }

  function reset() {
    stopPing();
    if (stateChannel) { try { stateChannel.close(); } catch (e) {} }
    if (ctrlChannel) { try { ctrlChannel.close(); } catch (e) {} }
    if (pc) { try { pc.close(); } catch (e) {} }
    pc = null;
    stateChannel = null;
    ctrlChannel = null;
    role = null;
    stateOpen = false;
    ctrlOpen = false;
  }

  function encode(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }
  function decode(str) {
    return JSON.parse(decodeURIComponent(escape(atob(str.trim()))));
  }

  function waitForIceGatheringComplete(peerConn) {
    return new Promise((resolve) => {
      if (peerConn.iceGatheringState === "complete") { resolve(); return; }
      function check() {
        if (peerConn.iceGatheringState === "complete") {
          peerConn.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      }
      peerConn.addEventListener("icegatheringstatechange", check);
      // safety timeout in case gathering stalls (still usable with fewer candidates)
      setTimeout(resolve, 4000);
    });
  }

  // Both channels report "connected" only once BOTH are open, so callers
  // never race a still-warming-up ctrl channel (needed for ping/emotes/etc).
  function maybeReportConnected() {
    if (stateOpen && ctrlOpen) {
      reportConnState("connected");
      startPing();
    }
  }

  function wireStateChannel(ch) {
    stateChannel = ch;
    stateChannel.onopen = () => { stateOpen = true; maybeReportConnected(); };
    stateChannel.onclose = () => { stateOpen = false; reportConnState("disconnected"); };
    stateChannel.onerror = (e) => reportConnState("error", e);
    stateChannel.onmessage = (ev) => {
      if (!onStateMsgCb) return;
      try { onStateMsgCb(JSON.parse(ev.data)); } catch (e) { /* ignore malformed */ }
    };
  }

  function wireCtrlChannel(ch) {
    ctrlChannel = ch;
    ctrlChannel.onopen = () => { ctrlOpen = true; maybeReportConnected(); };
    ctrlChannel.onclose = () => { ctrlOpen = false; reportConnState("disconnected"); };
    ctrlChannel.onerror = (e) => reportConnState("error", e);
    ctrlChannel.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.__t === "ping") {
        try { ctrlChannel.send(JSON.stringify({ __t: "pong", ts: msg.ts })); } catch (e) {}
        return;
      }
      if (msg.__t === "pong") {
        lastPingMs = Date.now() - msg.ts;
        return;
      }
      if (onCtrlMsgCb) onCtrlMsgCb(msg);
    };
  }

  function setupPCHandlers() {
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        stateOpen = false; ctrlOpen = false;
        reportConnState("disconnected");
      }
    };
  }

  // HOST SIDE ------------------------------------------------
  async function createHostOffer() {
    reset();
    role = "host";
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    setupPCHandlers();
    wireStateChannel(pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 }));
    wireCtrlChannel(pc.createDataChannel("ctrl", { ordered: true }));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    return encode({ sdp: pc.localDescription });
  }

  // host: after guest sends back their answer code
  async function acceptAnswer(answerCode) {
    const { sdp } = decode(answerCode);
    await pc.setRemoteDescription(sdp);
  }

  // GUEST SIDE -------------------------------------------------
  async function joinWithOfferCode(offerCode) {
    reset();
    role = "guest";
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    setupPCHandlers();
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === "state") wireStateChannel(ev.channel);
      else if (ev.channel.label === "ctrl") wireCtrlChannel(ev.channel);
    };

    const { sdp } = decode(offerCode);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    return encode({ sdp: pc.localDescription });
  }

  // Fast, lossy channel — position/health snapshots.
  function sendState(obj) {
    if (stateChannel && stateChannel.readyState === "open") {
      try { stateChannel.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // Reliable, ordered channel — one-shot events.
  function sendCtrl(obj) {
    if (ctrlChannel && ctrlChannel.readyState === "open") {
      try { ctrlChannel.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function isConnected() {
    return stateOpen && ctrlOpen;
  }

  function isHost() { return role === "host"; }

  // "good" | "ok" | "poor" | null (null = no reading yet / disconnected)
  function connectionQuality() {
    if (!isConnected() || lastPingMs === null) return null;
    if (lastPingMs <= 90) return "good";
    if (lastPingMs <= 200) return "ok";
    return "poor";
  }

  function getPing() { return lastPingMs; }

  function onStateMessage(cb) { onStateMsgCb = cb; }
  function onCtrlMessage(cb) { onCtrlMsgCb = cb; }
  function onState(cb) { onConnStateCb = cb; }

  function disconnect() {
    reset();
    reportConnState("disconnected");
  }

  return {
    createHostOffer,
    acceptAnswer,
    joinWithOfferCode,
    sendState,
    sendCtrl,
    isConnected,
    isHost,
    getPing,
    connectionQuality,
    onStateMessage,
    onCtrlMessage,
    onState,
    disconnect
  };
})();
