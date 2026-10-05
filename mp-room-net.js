/* ==========================================================
   AIR BLAST HERO — N-player room networking (mp-room-net.js)
   PHASE 1 FOUNDATION for FFA / Team / Co-op / Race / Boss Rush /
   Hunted (up to 20 players).

   WHY THIS FILE EXISTS
   mp.js only knows how to open ONE WebRTC connection (1 host <->
   1 guest) — that's all Duel needs. None of the other modes can
   work without a way for the host to talk to MORE than one guest
   at once. This file adds exactly that, without touching mp.js,
   game.js, or mp-lobby.js.

   TOPOLOGY: host-relay star (per PHASE 1 rules — no full mesh,
   not realistic at 20 players in a browser).
     - The HOST opens one RTCPeerConnection PER GUEST.
     - Each GUEST opens exactly one RTCPeerConnection, to the host.
     - The HOST is the authority: guests send input/actions to the
       host; the host decides shared game state and broadcasts it.

   SIGNALING: reuses the room's existing Firebase ref (same room
   mp-lobby.js already created) under a new child path,
   "netSignal/{peerId}/{offer|answer}", so N connections can be
   set up automatically (same automated-handshake idea mp-lobby.js
   already uses for Duel, just fanned out to many peers instead
   of one).

   STATUS: this is networking only — no FFA/Team/Race game logic
   lives in this file itself. That logic now lives in game.js
   (applyFfaWorldState, startRoomRaceMatch, etc.), which calls into
   this file's hostInit/guestInit/hostConnectToAll for the actual
   connections. FFA, Team, and Race are unlocked (ready:true) in
   mp-lobby.js's arena list; only Boss Rush and Hunted are still
   locked, since nothing calls this file for those modes yet.
   ========================================================== */

window.MPRoomNet = (function () {
  "use strict";

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  let roomRef = null;
  let myId = null;
  let amHost = false;

  // Host side: peerId -> { pc, stateCh, ctrlCh, connected, answered }
  let hostPeers = {};

  // Guest side: single connection to the host.
  let guestPc = null;
  let guestStateCh = null;
  let guestCtrlCh = null;
  let guestAnswered = false;
  let guestConnected = false;
  let guestOfferRef = null;

  // Callbacks (same shape as mp.js so game code feels familiar)
  let onPeerStateCb = null;   // (peerId, obj) -> void   [host only]
  let onPeerCtrlCb = null;    // (peerId, obj) -> void   [host only]
  let onPeerJoinCb = null;    // (peerId) -> void        [host only]
  let onPeerLeaveCb = null;   // (peerId, reason) -> void [host only]
  let onHostStateCb = null;   // (obj) -> void            [guest only]
  let onHostCtrlCb = null;    // (obj) -> void             [guest only]
  let onHostConnCb = null;    // (state) -> void; "connecting"|"connected"|"lost" [guest only]

  function encode(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }
  function decode(str) {
    return JSON.parse(decodeURIComponent(escape(atob(str.trim()))));
  }

  function waitForIceGatheringComplete(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") { resolve(); return; }
      function check() {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      }
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(resolve, 4000); // safety timeout, same as mp.js
    });
  }

  // ---------------------------------------------------------------
  // HOST SIDE
  // ---------------------------------------------------------------

  function hostInit(roomRefIn, myIdIn) {
    hostShutdown(); // clean slate if re-entering
    roomRef = roomRefIn;
    myId = myIdIn;
    amHost = true;
  }

  function wireHostChannels(peerId, entry) {
    entry.stateCh.onmessage = (ev) => {
      if (!onPeerStateCb) return;
      try { onPeerStateCb(peerId, JSON.parse(ev.data)); } catch (e) { /* ignore malformed */ }
    };
    entry.ctrlCh.onopen = () => {
      entry.ctrlOpen = true;
      if (entry.stateOpen && !entry.connected) {
        entry.connected = true;
        if (onPeerJoinCb) onPeerJoinCb(peerId);
      }
    };
    entry.stateCh.onopen = () => {
      entry.stateOpen = true;
      if (entry.ctrlOpen && !entry.connected) {
        entry.connected = true;
        if (onPeerJoinCb) onPeerJoinCb(peerId);
      }
    };
    entry.ctrlCh.onmessage = (ev) => {
      if (!onPeerCtrlCb) return;
      try { onPeerCtrlCb(peerId, JSON.parse(ev.data)); } catch (e) { /* ignore malformed */ }
    };
    const onDown = () => removePeer(peerId, "disconnected");
    entry.stateCh.onclose = onDown;
    entry.ctrlCh.onclose = onDown;
    entry.pc.onconnectionstatechange = () => {
      const s = entry.pc.connectionState;
      if (s === "disconnected" || s === "failed" || s === "closed") removePeer(peerId, s);
    };
  }

  // Host opens a connection to ONE guest by peer id (their Firebase player id).
  async function hostConnectToGuest(peerId) {
    if (hostPeers[peerId] || peerId === myId) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, stateCh: null, ctrlCh: null, connected: false, stateOpen: false, ctrlOpen: false, answered: false, answerRef: null };
    entry.stateCh = pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 });
    entry.ctrlCh = pc.createDataChannel("ctrl", { ordered: true });
    hostPeers[peerId] = entry;
    wireHostChannels(peerId, entry);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    roomRef.child("netSignal/" + peerId + "/offer").set(encode({ sdp: pc.localDescription }));
    // BUGFIX: keep the exact ref this .on() was registered on, so removePeer
    // can call .off() on that SAME ref. Firebase's .off() only detaches
    // listeners on the exact path/ref it's called on — it does NOT cascade
    // to child paths — so calling .off() on the parent "netSignal/{peerId}"
    // ref (as removePeer already does) left this "answer" listener leaked
    // on every disconnect, and a later reconnect would stack a second one
    // on top instead of replacing it.
    entry.answerRef = roomRef.child("netSignal/" + peerId + "/answer");
    entry.answerRef.on("value", (snap) => {
      const val = snap.val();
      if (val && !entry.answered) {
        entry.answered = true;
        decodeAndSetAnswer(pc, val);
      }
    });
  }

  async function decodeAndSetAnswer(pc, answerEnc) {
    try {
      const { sdp } = decode(answerEnc);
      await pc.setRemoteDescription(sdp);
    } catch (e) { /* stale/garbled signal, ignore */ }
  }

  // Call once, with the list of every OTHER player id currently in the room,
  // to open connections to all of them at once.
  //
  // PERFORMANCE (proactive fix ahead of real 20-player testing): opening
  // 20 RTCPeerConnections in the exact same tick means 20 simultaneous
  // ICE-gathering + certificate-generation + STUN round-trips competing
  // for CPU and network at once, right as the match is starting — a
  // thundering herd that's more likely to cause slow/failed connections
  // than any small room ever would. Staggering the start of each one by
  // a short delay spreads that burst out over ~1-1.5s for a full 20-
  // player room while staying instant-feeling for small rooms (Duel/
  // Co-op-sized rooms see effectively zero delay).
  const HOST_CONNECT_STAGGER_MS = 60;
  function hostConnectToAll(peerIds) {
    (peerIds || []).forEach((id, i) => {
      if (i === 0) hostConnectToGuest(id);
      else setTimeout(() => hostConnectToGuest(id), i * HOST_CONNECT_STAGGER_MS);
    });
  }

  function removePeer(peerId, reason) {
    const entry = hostPeers[peerId];
    if (!entry) return;
    try { entry.stateCh && entry.stateCh.close(); } catch (e) {}
    try { entry.ctrlCh && entry.ctrlCh.close(); } catch (e) {}
    try { entry.pc && entry.pc.close(); } catch (e) {}
    delete hostPeers[peerId];
    // BUGFIX: .off() the exact ref the listener was registered on (see the
    // comment in hostConnectToGuest) AND the parent path, so nothing is
    // left listening after a peer leaves.
    if (entry.answerRef) { try { entry.answerRef.off(); } catch (e) {} }
    if (roomRef) roomRef.child("netSignal/" + peerId).off();
    if (onPeerLeaveCb) onPeerLeaveCb(peerId, reason || "left");
  }

  function hostBroadcastState(obj) {
    const msg = JSON.stringify(obj);
    Object.values(hostPeers).forEach((entry) => {
      if (entry.stateCh && entry.stateCh.readyState === "open") {
        try { entry.stateCh.send(msg); } catch (e) {}
      }
    });
  }

  function hostBroadcastCtrl(obj) {
    const msg = JSON.stringify(obj);
    Object.values(hostPeers).forEach((entry) => {
      if (entry.ctrlCh && entry.ctrlCh.readyState === "open") {
        try { entry.ctrlCh.send(msg); } catch (e) {}
      }
    });
  }

  function hostSendCtrlTo(peerId, obj) {
    const entry = hostPeers[peerId];
    if (entry && entry.ctrlCh && entry.ctrlCh.readyState === "open") {
      try { entry.ctrlCh.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function hostConnectedPeerIds() {
    return Object.keys(hostPeers).filter((id) => hostPeers[id].connected);
  }

  function hostShutdown() {
    Object.keys(hostPeers).forEach((id) => removePeer(id, "shutdown"));
    hostPeers = {};
  }

  // ---------------------------------------------------------------
  // GUEST SIDE
  // ---------------------------------------------------------------

  function guestInit(roomRefIn, myIdIn) {
    guestShutdown();
    roomRef = roomRefIn;
    myId = myIdIn;
    amHost = false;
    guestAnswered = false;
    if (onHostConnCb) onHostConnCb("connecting");
    // BUGFIX: keep the exact ref, same reason as hostConnectToGuest's
    // answerRef above — guestShutdown's .off() on the parent path alone
    // never actually detached this listener.
    guestOfferRef = roomRef.child("netSignal/" + myId + "/offer");
    guestOfferRef.on("value", (snap) => {
      const val = snap.val();
      if (val && !guestAnswered) {
        guestAnswered = true;
        guestAcceptOffer(val);
      }
    });
  }

  async function guestAcceptOffer(offerEnc) {
    try {
      const { sdp } = decode(offerEnc);
      guestPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      guestPc.ondatachannel = (ev) => {
        if (ev.channel.label === "state") wireGuestChannel(ev.channel, "state");
        else if (ev.channel.label === "ctrl") wireGuestChannel(ev.channel, "ctrl");
      };
      guestPc.onconnectionstatechange = () => {
        const s = guestPc.connectionState;
        if (s === "disconnected" || s === "failed" || s === "closed") {
          guestConnected = false;
          if (onHostConnCb) onHostConnCb("lost");
        }
      };
      await guestPc.setRemoteDescription(sdp);
      const answer = await guestPc.createAnswer();
      await guestPc.setLocalDescription(answer);
      await waitForIceGatheringComplete(guestPc);
      roomRef.child("netSignal/" + myId + "/answer").set(encode({ sdp: guestPc.localDescription }));
    } catch (e) {
      if (onHostConnCb) onHostConnCb("lost");
    }
  }

  function wireGuestChannel(ch, kind) {
    if (kind === "state") {
      guestStateCh = ch;
      ch.onopen = () => { maybeGuestConnected(); };
      ch.onmessage = (ev) => {
        if (!onHostStateCb) return;
        try { onHostStateCb(JSON.parse(ev.data)); } catch (e) {}
      };
      ch.onclose = () => { guestConnected = false; if (onHostConnCb) onHostConnCb("lost"); };
    } else {
      guestCtrlCh = ch;
      ch.onopen = () => { maybeGuestConnected(); };
      ch.onmessage = (ev) => {
        if (!onHostCtrlCb) return;
        try { onHostCtrlCb(JSON.parse(ev.data)); } catch (e) {}
      };
      ch.onclose = () => { guestConnected = false; if (onHostConnCb) onHostConnCb("lost"); };
    }
  }

  function maybeGuestConnected() {
    if (guestStateCh && guestStateCh.readyState === "open" &&
        guestCtrlCh && guestCtrlCh.readyState === "open" && !guestConnected) {
      guestConnected = true;
      if (onHostConnCb) onHostConnCb("connected");
    }
  }

  function guestSendState(obj) {
    if (guestStateCh && guestStateCh.readyState === "open") {
      try { guestStateCh.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function guestSendCtrl(obj) {
    if (guestCtrlCh && guestCtrlCh.readyState === "open") {
      try { guestCtrlCh.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function guestIsConnected() { return guestConnected; }

  function guestShutdown() {
    try { guestStateCh && guestStateCh.close(); } catch (e) {}
    try { guestCtrlCh && guestCtrlCh.close(); } catch (e) {}
    try { guestPc && guestPc.close(); } catch (e) {}
    guestPc = null; guestStateCh = null; guestCtrlCh = null;
    guestConnected = false; guestAnswered = false;
    // BUGFIX: off() the exact "offer" ref (see guestInit), not just the
    // parent path, which never actually removed this listener.
    if (guestOfferRef) { try { guestOfferRef.off(); } catch (e) {} guestOfferRef = null; }
    if (roomRef && myId) roomRef.child("netSignal/" + myId).off();
  }

  // ---------------------------------------------------------------
  // SHARED
  // ---------------------------------------------------------------

  function shutdown() {
    if (amHost) hostShutdown(); else guestShutdown();
    roomRef = null; myId = null;
  }

  function onPeerState(cb) { onPeerStateCb = cb; }
  function onPeerCtrl(cb) { onPeerCtrlCb = cb; }
  function onPeerJoin(cb) { onPeerJoinCb = cb; }
  function onPeerLeave(cb) { onPeerLeaveCb = cb; }
  function onHostState(cb) { onHostStateCb = cb; }
  function onHostCtrl(cb) { onHostCtrlCb = cb; }
  function onHostConn(cb) { onHostConnCb = cb; }

  return {
    // host
    hostInit, hostConnectToAll, hostConnectToGuest, hostBroadcastState,
    hostBroadcastCtrl, hostSendCtrlTo, hostConnectedPeerIds, hostShutdown,
    // guest
    guestInit, guestSendState, guestSendCtrl, guestIsConnected, guestShutdown,
    // shared
    shutdown,
    onPeerState, onPeerCtrl, onPeerJoin, onPeerLeave,
    onHostState, onHostCtrl, onHostConn
  };
})();
