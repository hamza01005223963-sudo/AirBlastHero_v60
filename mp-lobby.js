/* ==========================================================
   AIR BLAST HERO — Room / Lobby system (mp-lobby.js)
   PHASE 1 of the "up to 20 players" expansion.

   WHAT THIS FILE DOES RIGHT NOW:
   - Lets players create/join a room with a 5-character code
     (stored in Firebase Realtime Database — needed because
     coordinating up to 20 phones can't be done with manual
     copy/paste codes anymore).
   - Shows a live player list (up to 20) with ready state.
   - Shows all planned arena types (Duel, Team, FFA, Co-op,
     Race, Boss Rush, Hunted) with automatic lock/unlock logic
     based on how many players are in the room (e.g. Team mode
     locks itself if the player count is odd).
   - For "Duel" (1v1) specifically, it fully works end-to-end:
     it automates the SDP offer/answer exchange that the old
     manual multiplayer screen (mpLobbyScreen) required you to
     copy/paste by hand, by relaying those two codes through
     Firebase instead. Once that handshake finishes, control is
     handed to the EXISTING, unmodified versus-mode game code in
     game.js (same MP.onState("connected") -> startVersusMatch()
     flow as before) — nothing about actual gameplay changed.

   CURRENT STATUS (kept up to date — see ARENAS[].ready below, which is
   the actual source of truth the UI reads from):
   - Duel is the only mode still on the 2-peer mp.js bridge (paste-code
     offer/answer relayed through Firebase). Team, FFA, Co-op vs Waves,
     Race, Boss Rush, and Hunted are all real and playable end-to-end
     (ready:true) via mp-room-net.js's host-relay star topology, now
     scaled up to the full 20-player cap (Co-op was 2-player-only before
     this pass — it's ported onto the same N-player transport now, see
     game.js's startRoomCoopMatch). Boss Rush reuses the SAME updateBoss()
     AI a single-player boss fight already uses — only the starting stat
     preset changes per encounter (3 bosses, escalating health), no
     second boss system was written. Hunted picks one real player as the
     Hunter (deterministic from the sorted roster) — faster, visibly
     marked in red, no AI/stealth — everyone else survives a countdown;
     host is sole authority on the timer, speed escalation and catches
     (see game.js's PHASE 7 block).
   - BUGFIX (this pass): Hunted was ready:true and fully built in game.js,
     but arena.id checks here still only listed ffa/team/race/bossrush —
     so pressing Start with Hunted selected silently hit the "coming
     soon" branch (host) or fell through to the wrong (Duel) bridge
     (guest). Hunted is now routed the same way as the other room-net
     modes; if this happens again for a future mode, check startMatch()'s
     two arena.id lists AND the "startedAt" listener below — all three
     need the new mode's id, and it's easy to update only one or two.

   - PHASE 16 (this pass) — private rooms + a public room browser:
     * Every room now carries a `private` flag, set from a checkbox at
       creation time. Nothing about joining-by-code changed — a private
       room works exactly as every room already did — the flag only
       controls whether the room is included in the new browse list below.
     * The join screen now also shows a live list of open PUBLIC rooms
       (db.ref("rooms"), a plain .on("value") — this project has no
       Cloud Functions, so filtering happens client-side). A room is
       listed only if: not private, has at least 1 player, has NOT
       started a match yet (no "startedAt"), and has a free slot for its
       mode (count < that arena's max). A room that finished its match
       reopens itself for this list the moment game.js's endMpSession()
       clears "startedAt" on the way out (see game.js PHASE 16) — so a
       finished room only reappears once it *also* has a free spot, same
       as this file's own arenaLockInfo() would require to actually start
       a NEW match in it.
     * Empty-room cleanup: since there's no server to notice a room went
       to 0 players on its own, this is handled two ways — (1) whoever
       explicitly clicks "leave" and was the last one there deletes the
       whole room immediately (see leaveRoom()); (2) as a fallback for
       silent disconnects (tab closed, crash, etc.), whichever client is
       currently the sole occupant keeps roomRef.onDisconnect().remove()
       armed (see renderPlayers()/updateEmptyRoomAutoCleanup()), and ANY
       client currently browsing the public list opportunistically
       deletes a room it sees sitting at 0 players or past ROOM_TTL_MS
       (see renderPublicRooms()) — so a ghost room can't survive past the
       next person who happens to open the room list.
     * REMOVED the old unconditional `roomRef.onDisconnect().remove()`
       from createRoom(): it fired whenever the HOST's connection dropped
       for ANY reason, wiping the room even with other players still
       inside — the opposite of "only when the room is actually empty".
       updateEmptyRoomAutoCleanup() replaces it with the count-aware
       version described above.

   SETUP REQUIRED: paste your own Firebase project config below
   (Realtime Database, same kind of project you already used for
   the Mafia game's online rooms). Nothing here will work until
   you do — it'll fail silently into a friendly error message.
   ========================================================== */

window.MPLobby = (function () {
  "use strict";

  // ---- 1) PUT YOUR FIREBASE CONFIG HERE ----------------------
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyC7CcSPAqjToSNCg0hqWpX7zD6EqoT2zsE",
    authDomain: "mafia-game-c8ae4.firebaseapp.com",
    databaseURL: "https://mafia-game-c8ae4-default-rtdb.firebaseio.com",
    projectId: "mafia-game-c8ae4",
  };
  // -------------------------------------------------------------

  const MAX_PLAYERS = 20;
  const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // rooms auto-considered stale after 6h

  // Arena / mode definitions. `ready:true` = fully playable today.
  const ARENAS = [
    { id: "duel", icon: "⚔️", name: "مبارزة 1×1", min: 2, max: 2, parity: null, ready: true,
      desc: "نفس وضع المواجهة الحالي، أوتوماتيك من غير أكواد يدوية" },
    { id: "team", icon: "🛡️", name: "فريق × فريق", min: 4, max: 20, parity: "even", ready: true,
      desc: "فريقين - آخر فريق فيه حد لسه واقف يفوز. بيتقفل لو العدد فردي. لحد 20 لاعب" },
    { id: "ffa", icon: "🔥", name: "الكل ضد الكل", min: 3, max: 20, parity: null, ready: true,
      desc: "آخر واحد باقي يفوز - لحد 20 لاعب في الغرفة الواحدة" },
    { id: "coop", icon: "🤝", name: "تعاوني ضد الموجات", min: 2, max: 20, parity: null, ready: true,
      desc: "الكل مع بعض ضد 5 موجات أعداء بيزيدوا صعوبة وعدد كمان - فيه إنقاذ لو حد وقع. لحد 20 لاعب" },
    { id: "race", icon: "🏁", name: "سباق", min: 2, max: 20, parity: null, ready: true,
      desc: "أول واحد يوصل للنهاية - كل اللاعبين في نفس المرحلة بالظبط" },
    { id: "bossrush", icon: "👹", name: "مطاردة الزعيم", min: 2, max: 20, parity: null, ready: true,
      desc: "3 زعما ورا بعض بصحة متصاعدة - الكل يضرب نفس الزعيم مع بعض. لحد 20 لاعب" },
    { id: "hunted", icon: "🎯", name: "المطارَد", min: 3, max: 20, parity: null, ready: true,
      desc: "لاعب واحد (الصياد) أسرع وظاهر بعلامة حمراء - الباقيين لازم ينجوا من الوقت" }
  ];

  let db = null;
  let firebaseOk = false;
  let roomCode = null;
  let myId = null;
  let myName = "لاعب";
  let isHost = false;
  let selectedArena = "duel";
  let playersCache = {};
  let roomRef = null;
  let listenersAttached = false;
  let raceSeedCache = null;
  let raceLevelCache = null;
  let publicRoomsRef = null;
  let publicRoomsListenerAttached = false;
  // Non-hell, non-boss levels only — hell levels (5/10/15/20/25) and the
  // final boss level (30) would need extra systems a plain race isn't built for.
  const RACE_LEVEL_POOL = [2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 29];

  function initFirebase() {
    if (firebaseOk) return true;
    try {
      if (!window.firebase || FIREBASE_CONFIG.apiKey === "REPLACE_ME") return false;
      firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.database();
      firebaseOk = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function genCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
    let s = "";
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function genId() {
    return "p" + Math.random().toString(36).slice(2, 10);
  }

  function arenaMaxFor(modeId) {
    const arena = ARENAS.find((a) => a.id === modeId);
    return arena ? arena.max : MAX_PLAYERS;
  }

  // ---- Arena lock logic --------------------------------------
  function arenaLockInfo(arena, count) {
    if (!arena.ready) return { locked: true, reason: "قريباً - قيد التطوير" };
    if (count < arena.min) return { locked: true, reason: `محتاج ${arena.min} لاعبين على الأقل` };
    if (count > arena.max) return { locked: true, reason: `أقصى عدد ${arena.max} لاعب` };
    if (arena.parity === "even" && count % 2 !== 0) {
      return { locked: true, reason: "العدد لازم يكون زوجي (2، 4، 6...)" };
    }
    return { locked: false, reason: "" };
  }

  // ---- UI wiring ------------------------------------------------
  const els = {};
  function cacheEls() {
    els.joinBox = document.getElementById("mpRoomJoinBox");
    els.insideBox = document.getElementById("mpRoomInsideBox");
    els.nick = document.getElementById("mpNickInput");
    els.privateChk = document.getElementById("mpPrivateRoomChk");
    els.createBtn = document.getElementById("mpCreateRoomBtn");
    els.joinCodeInput = document.getElementById("mpJoinCodeInput");
    els.joinBtn = document.getElementById("mpJoinRoomBtn");
    els.publicRoomList = document.getElementById("mpPublicRoomList");
    els.statusText = document.getElementById("mpRoomStatusText");
    els.statusText2 = document.getElementById("mpRoomStatusText2");
    els.roomCodeShown = document.getElementById("mpRoomCodeShown");
    els.copyRoomCodeBtn = document.getElementById("mpCopyRoomCodeBtn");
    els.playerCount = document.getElementById("mpPlayerCount");
    els.playerList = document.getElementById("mpPlayerList");
    els.arenaGrid = document.getElementById("mpArenaGrid");
    els.arenaHint = document.getElementById("mpArenaHint");
    els.readyBtn = document.getElementById("mpReadyBtn");
    els.startBtn = document.getElementById("mpStartRoomBtn");
    els.leaveBtn = document.getElementById("mpLeaveRoomBtn");
    els.backBtn = document.getElementById("mpRoomBackBtn");
    els.menuOpenBtn = document.getElementById("mpRoomsBtn");
  }

  function setStatus(text) {
    if (els.statusText) els.statusText.textContent = text || "";
    if (els.statusText2) els.statusText2.textContent = text || "";
  }

  function renderArenas(count) {
    els.arenaGrid.innerHTML = "";
    ARENAS.forEach(arena => {
      const info = arenaLockInfo(arena, count);
      const card = document.createElement("button");
      card.className = "mpArenaCard" + (info.locked ? " locked" : "") + (selectedArena === arena.id ? " selected" : "");
      card.innerHTML = `<span class="mpArenaIcon">${arena.icon}</span>` +
        `<span class="mpArenaName">${arena.name}</span>` +
        (!arena.ready ? '<span class="mpArenaBadge">قريباً</span>' : "");
      card.disabled = info.locked && arena.ready; // "coming soon" ones still clickable to preview info
      card.addEventListener("click", () => {
        selectedArena = arena.id;
        if (isHost && roomRef) roomRef.child("mode").set(arena.id);
        renderArenas(Object.keys(playersCache).length);
        const li = arenaLockInfo(arena, Object.keys(playersCache).length);
        els.arenaHint.textContent = arena.desc + (li.locked ? " — " + li.reason : "");
      });
      els.arenaGrid.appendChild(card);
    });
  }

  function renderPlayers() {
    const ids = Object.keys(playersCache);
    els.playerCount.textContent = ids.length;
    els.playerList.innerHTML = "";
    ids.forEach(id => {
      const p = playersCache[id];
      const chip = document.createElement("div");
      chip.className = "mpPlayerChip" + (p.ready ? " ready" : "");
      chip.textContent = (p.isHost ? "👑 " : "") + (p.name || "لاعب") + (p.ready ? " ✅" : "");
      els.playerList.appendChild(chip);
    });
    renderArenas(ids.length);
    updateStartButton();
    updateEmptyRoomAutoCleanup(ids.length);
  }

  // See PHASE 16 note at the top of this file: keeps a room-level
  // onDisconnect().remove() armed on THIS client's connection only while
  // THIS client is the sole occupant, so a silent disconnect (crash, tab
  // closed) while alone still wipes the room — but cancels it the moment
  // a second player is present, so that same disconnect can't take the
  // room down from under people who are still actually using it.
  function updateEmptyRoomAutoCleanup(count) {
    if (!roomRef) return;
    if (count <= 1) {
      roomRef.onDisconnect().remove();
    } else {
      roomRef.onDisconnect().cancel();
    }
  }

  // ---- Public room browser ---------------------------------------
  function attachPublicRoomsListener() {
    if (publicRoomsListenerAttached) return;
    if (!els.publicRoomList) return;
    if (!initFirebase()) {
      els.publicRoomList.innerHTML = '<p class="mpPublicRoomEmpty">محتاج اتصال إنترنت عشان تشوف الغرف المتاحة</p>';
      return;
    }
    publicRoomsListenerAttached = true;
    publicRoomsRef = db.ref("rooms").orderByChild("createdAt").limitToLast(40);
    publicRoomsRef.on("value", (snap) => { renderPublicRooms(snap.val() || {}); });
  }

  function detachPublicRoomsListener() {
    if (publicRoomsRef) { try { publicRoomsRef.off(); } catch (e) {} }
    publicRoomsRef = null;
    publicRoomsListenerAttached = false;
  }

  function renderPublicRooms(roomsVal) {
    if (!els.publicRoomList) return;
    const now = Date.now();
    const rows = [];
    Object.keys(roomsVal).forEach((code) => {
      const data = roomsVal[code];
      if (!data) return;
      if (data.private) return; // code-only — never listed
      const players = data.players || {};
      const count = Object.keys(players).length;
      const isStale = data.createdAt && (now - data.createdAt > ROOM_TTL_MS);
      if (count === 0 || isStale) {
        // Nobody's actually there (or it's long dead) — sweep it out
        // instead of just hiding it, so the DB doesn't accumulate ghosts.
        try { db.ref("rooms/" + code).remove(); } catch (e) {}
        return;
      }
      if (data.startedAt) return; // mid-match — hidden until it finishes
      const max = arenaMaxFor(data.mode);
      if (count >= max) return; // full for its mode
      rows.push({ code, data, count, max });
    });

    els.publicRoomList.innerHTML = "";
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "mpPublicRoomEmpty";
      p.textContent = "لا توجد غرف عامة فاضية دلوقتي - جرب تعمل غرفة جديدة";
      els.publicRoomList.appendChild(p);
      return;
    }

    rows
      .sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0))
      .forEach(({ code, data, count, max }) => {
        const arena = ARENAS.find((a) => a.id === data.mode) || ARENAS[0];
        const row = document.createElement("div");
        row.className = "mpPublicRoomRow";
        row.innerHTML =
          `<span class="mpPublicRoomIcon">${arena.icon}</span>` +
          `<span class="mpPublicRoomInfo"><b>${code}</b> — ${arena.name} (${count}/${max})</span>`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "menuBtn secondary mpPublicRoomJoinBtn";
        btn.textContent = "انضمام";
        btn.addEventListener("click", () => joinRoomByCode(code));
        row.appendChild(btn);
        els.publicRoomList.appendChild(row);
      });
  }

  function updateStartButton() {
    if (!els.startBtn) return;
    els.startBtn.classList.toggle("hidden", !isHost);
    const count = Object.keys(playersCache).length;
    const arena = ARENAS.find(a => a.id === selectedArena);
    const info = arenaLockInfo(arena, count);
    const allReady = Object.values(playersCache).every(p => p.ready) && count >= 2;
    els.startBtn.disabled = info.locked || !allReady;
  }

  // ---- Room lifecycle --------------------------------------------
  function attachRoomListeners() {
    if (listenersAttached) return;
    listenersAttached = true;

    roomRef.child("players").on("value", (snap) => {
      playersCache = snap.val() || {};
      renderPlayers();
    });

    roomRef.child("mode").on("value", (snap) => {
      if (snap.val()) {
        selectedArena = snap.val();
        renderPlayers();
      }
    });

    roomRef.child("raceSeed").on("value", (snap) => { if (snap.val() !== null) raceSeedCache = snap.val(); });
    roomRef.child("raceLevel").on("value", (snap) => { if (snap.val() !== null) raceLevelCache = snap.val(); });

    // Host-only: watch for the guest's WebRTC answer code to complete duel handshake.
    roomRef.child("signal/answer").on("value", (snap) => {
      const answer = snap.val();
      if (answer && isHost && window.__mpBridgeHostAwaitingAnswer) {
        window.__mpBridgeHostAwaitingAnswer = false;
        bridgeHostAcceptAnswer(answer);
      }
    });

    // Guest-only: watch for the host's offer code to kick off the join flow.
    roomRef.child("signal/offer").on("value", (snap) => {
      const offer = snap.val();
      if (offer && !isHost && window.__mpBridgeGuestAwaitingOffer) {
        window.__mpBridgeGuestAwaitingOffer = false;
        bridgeGuestJoin(offer);
      }
    });

    roomRef.child("startedAt").on("value", (snap) => {
      if (snap.val() && !isHost) {
        if (selectedArena === "ffa" || selectedArena === "team" || selectedArena === "race" || selectedArena === "bossrush" || selectedArena === "hunted" || selectedArena === "coop") {
          // Room-net modes: no offer/answer paste-code needed, mp-room-net.js
          // handles its own signaling automatically once we call in.
          startRoomNetMatch(selectedArena);
        } else {
          // Guest side: host has begun the duel/co-op handshake, wait for the offer node.
          window.__mpBridgeGuestAwaitingOffer = true;
        }
      }
    });
  }

  function createRoom() {
    if (!initFirebase()) { setStatus("⚠️ محتاج اتصال إنترنت عشان نظام الغرف يشتغل"); return; }
    myName = (els.nick.value || "لاعب").trim().slice(0, 14) || "لاعب";
    myId = genId();
    isHost = true;
    roomCode = genCode();
    roomRef = db.ref("rooms/" + roomCode);
    roomRef.set({
      createdAt: Date.now(),
      hostId: myId,
      mode: selectedArena,
      private: !!(els.privateChk && els.privateChk.checked),
      players: {
        [myId]: { name: myName, ready: false, isHost: true, joinedAt: Date.now() }
      }
    });
    roomRef.child("players/" + myId).onDisconnect().remove();
    // Room-level empty-room cleanup is handled by updateEmptyRoomAutoCleanup()
    // (called from renderPlayers() on every roster change) instead of an
    // unconditional remove here — see PHASE 16 note at the top of this file.
    finishEnterRoom();
  }

  function joinRoom() {
    joinRoomByCode(els.joinCodeInput.value || "");
  }

  function joinRoomByCode(codeIn) {
    if (!initFirebase()) { setStatus("⚠️ محتاج اتصال إنترنت عشان نظام الغرف يشتغل"); return; }
    const code = (codeIn || "").trim().toUpperCase();
    if (code.length !== 5) { setStatus("اكتب كود الغرفة (5 حروف/أرقام)"); return; }
    myName = (els.nick.value || "لاعب").trim().slice(0, 14) || "لاعب";
    myId = genId();
    isHost = false;
    roomCode = code;
    roomRef = db.ref("rooms/" + roomCode);
    roomRef.once("value", (snap) => {
      if (!snap.exists()) { setStatus("⚠️ الكود ده مش موجود"); return; }
      const roomData = snap.val() || {};
      // PHASE 14 — stale room: ROOM_TTL_MS existed but was never actually
      // checked anywhere. A code from hours ago (host long gone, Firebase
      // node never cleaned up for whatever reason) should fail clearly
      // instead of dropping the guest into a dead, unresponsive lobby.
      if (roomData.createdAt && (Date.now() - roomData.createdAt > ROOM_TTL_MS)) {
        setStatus("⚠️ الغرفة دي قديمة وخلصت صلاحيتها - افتح غرفة جديدة");
        return;
      }
      // PHASE 14 — joining a room whose match already started used to be
      // silently allowed, dropping the guest into a half-started handshake
      // with no game to actually join. Block it with a clear message instead.
      if (roomData.startedAt) {
        setStatus("⚠️ اللعبة في الغرفة دي بدأت بالفعل - اطلب من صاحبك يفتح غرفة جديدة");
        return;
      }
      const players = roomData.players || {};
      if (Object.keys(players).length >= MAX_PLAYERS) { setStatus("⚠️ الغرفة كاملة (20 لاعب)"); return; }
      roomRef.child("players/" + myId).set({ name: myName, ready: false, isHost: false, joinedAt: Date.now() });
      roomRef.child("players/" + myId).onDisconnect().remove();
      finishEnterRoom();
    });
  }

  function finishEnterRoom() {
    detachPublicRoomsListener(); // no need to keep watching the browse list while inside a room
    els.joinBox.classList.add("hidden");
    els.insideBox.classList.remove("hidden");
    els.roomCodeShown.textContent = roomCode;
    setStatus("");
    attachRoomListeners();
  }

  function toggleReady() {
    if (!roomRef || !myId) return;
    const me = playersCache[myId];
    roomRef.child("players/" + myId + "/ready").set(!(me && me.ready));
  }

  function detachRoomListeners(ref) {
    // BUGFIX: leaveRoom() used to just null out the `roomRef` variable and
    // flip `listenersAttached` back to false — but the actual Firebase
    // .on() listeners attachRoomListeners() registered stay alive on that
    // OLD ref regardless (a JS variable going out of scope doesn't detach
    // a Firebase listener). Leaving a room and then creating/joining a
    // different one left both the old room's and the new room's listeners
    // firing at once, so stale data from the room you just left could
    // stomp the player list / arena selection / signal codes of the new
    // one. Every path attachRoomListeners() subscribes to must be turned
    // off here, on that same ref, before it's discarded.
    if (!ref) return;
    ["players", "mode", "raceSeed", "raceLevel", "signal/answer", "signal/offer", "startedAt"]
      .forEach((p) => { try { ref.child(p).off(); } catch (e) {} });
  }

  function leaveRoom() {
    if (roomRef && myId) {
      const remainingIds = Object.keys(playersCache).filter((id) => id !== myId);
      roomRef.child("players/" + myId).remove();
      if (remainingIds.length === 0) {
        // I was the last player here — nothing left to keep the room
        // around for, so remove it outright rather than leave an empty
        // ghost for the public list to notice and sweep up later.
        roomRef.remove();
      } else {
        // Cancel any auto-cleanup this client may have armed while it was
        // (at some earlier point) the sole occupant — see
        // updateEmptyRoomAutoCleanup(). Otherwise this client's eventual
        // real disconnect (closing the tab later) would still wipe the
        // room out from under the people who are still in it.
        roomRef.onDisconnect().cancel();
      }
    }
    detachRoomListeners(roomRef);
    roomRef = null; roomCode = null; myId = null; isHost = false;
    listenersAttached = false;
    playersCache = {};
    raceSeedCache = null; raceLevelCache = null;
    els.joinBox.classList.remove("hidden");
    els.insideBox.classList.add("hidden");
    setStatus("");
    attachPublicRoomsListener(); // back at the join screen — resume showing open rooms
  }

  function startMatch() {
    const count = Object.keys(playersCache).length;
    const arena = ARENAS.find(a => a.id === selectedArena);
    const info = arenaLockInfo(arena, count);
    if (info.locked) { setStatus("⚠️ " + info.reason); return; }
    if (arena.id !== "duel" && arena.id !== "coop" && arena.id !== "ffa" && arena.id !== "team" && arena.id !== "race" && arena.id !== "bossrush" && arena.id !== "hunted") {
      setStatus("⚠️ الساحة دي هتشتغل في تحديث جاي"); return;
    }

    setStatus("⏳ جاري الاتصال...");

    // FFA/Team/Co-op/Race/Boss Rush/Hunted use mp-room-net.js's N-player
    // star topology directly (its own Firebase-relayed signaling), not
    // the Duel offer/answer paste-code flow below — so the host can just
    // call straight into game.js once everyone's marked "startedAt".
    if (arena.id === "ffa" || arena.id === "team" || arena.id === "race" || arena.id === "bossrush" || arena.id === "hunted" || arena.id === "coop") {
      if (isHost) {
        if (arena.id === "race") {
          // Host picks ONE seed + ONE level for everyone — written to
          // Firebase BEFORE "startedAt" so guests already have it cached
          // (via the listeners above) by the time their own "startedAt"
          // handler fires. Same shared level for every racer (PHASE 9).
          raceSeedCache = Math.floor(Math.random() * 0xffffffff);
          raceLevelCache = RACE_LEVEL_POOL[Math.floor(Math.random() * RACE_LEVEL_POOL.length)];
          roomRef.child("raceSeed").set(raceSeedCache);
          roomRef.child("raceLevel").set(raceLevelCache);
        }
        roomRef.child("startedAt").set(Date.now());
        startRoomNetMatch(arena.id);
      }
      return; // guest side auto-starts via the "startedAt" listener below
    }

    if (isHost) {
      window.__mpBridgeHostAwaitingAnswer = true;
      roomRef.child("startedAt").set(Date.now());
      bridgeHostCreateOffer();
    }
    // Guest side auto-starts when it sees "startedAt" via the listener above.
  }

  function buildRoster() {
    const roster = {};
    Object.keys(playersCache).forEach((id) => {
      roster[id] = { name: (playersCache[id] && playersCache[id].name) || "لاعب" };
    });
    return roster;
  }

  function startRoomNetMatch(modeId) {
    if (!window.ABH_startRoomMatch) { setStatus("⚠️ اللعبة لسه مش جاهزة، جرب تاني بعد لحظة"); return; }
    const info = { roomRef, myId, isHost, roster: buildRoster(), mode: modeId };
    if (modeId === "race") {
      info.raceSeed = raceSeedCache;
      info.raceLevel = raceLevelCache;
      if (info.raceSeed === null || info.raceLevel === null) {
        // Guest's listener hasn't delivered the value yet (rare — Firebase
        // is normally ordered) — wait briefly instead of racing with null.
        setTimeout(() => startRoomNetMatch(modeId), 200);
        return;
      }
    }
    window.ABH_startRoomMatch(info);
  }

  // ---- Bridge into the EXISTING 2-player WebRTC flow -------------
  // These functions drive the old, hidden mpLobbyScreen controls
  // exactly the way a human would, but with the offer/answer codes
  // relayed through Firebase instead of copy/paste. Nothing about
  // game.js or mp.js is modified.
  function clickAndWait(selectorOrId, byId) {
    const el = byId ? document.getElementById(selectorOrId) : document.querySelector(selectorOrId);
    if (el) el.click();
    return el;
  }

  function pollForValue(elId, cb, timeoutMs) {
    const start = Date.now();
    const iv = setInterval(() => {
      const el = document.getElementById(elId);
      if (el && el.value && el.value.trim()) {
        clearInterval(iv);
        cb(el.value.trim());
      } else if (Date.now() - start > (timeoutMs || 8000)) {
        clearInterval(iv);
        setStatus("⚠️ حصل تأخير في الاتصال، جرب تاني");
      }
    }, 250);
  }

  function bridgeHostCreateOffer() {
    clickAndWait('.mpModeBtn[data-mode="' + selectedArena + '"]');
    clickAndWait("mpHostBtn", true);
    pollForValue("mpHostOfferCode", (offerCode) => {
      roomRef.child("signal/offer").set(offerCode);
      setStatus("⏳ في انتظار انضمام الخصم...");
    });
  }

  function bridgeGuestJoin(offerCode) {
    clickAndWait('.mpModeBtn[data-mode="' + selectedArena + '"]');
    clickAndWait("mpJoinBtn", true);
    const input = document.getElementById("mpJoinOfferInput");
    if (input) input.value = offerCode;
    clickAndWait("mpGenerateAnswerBtn", true);
    pollForValue("mpJoinAnswerCode", (answerCode) => {
      roomRef.child("signal/answer").set(answerCode);
      setStatus("⏳ جاري الاتصال بالمستضيف...");
    });
  }

  function bridgeHostAcceptAnswer(answerCode) {
    const input = document.getElementById("mpHostAnswerInput");
    if (input) input.value = answerCode;
    clickAndWait("mpConnectHostBtn", true);
    // From here, the existing MP.onState("connected") handler in
    // game.js takes over completely and starts the versus match.
  }

  // ---- Public init -------------------------------------------------
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    cacheEls();
    if (!els.menuOpenBtn) return; // screen not present in this build

    els.menuOpenBtn.addEventListener("click", () => {
      document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
      document.getElementById("mpRoomScreen").classList.remove("hidden");
      renderArenas(0);
      if (!roomRef) attachPublicRoomsListener(); // not already inside a room — show the browse list
    });
    els.backBtn.addEventListener("click", () => {
      leaveRoom(); // re-attaches the public list internally; we're navigating away next, so:
      detachPublicRoomsListener();
      document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
      document.getElementById("modeSelectScreen").classList.remove("hidden");
    });
    els.createBtn.addEventListener("click", createRoom);
    els.joinBtn.addEventListener("click", joinRoom);
    els.readyBtn.addEventListener("click", toggleReady);
    els.leaveBtn.addEventListener("click", leaveRoom);
    els.startBtn.addEventListener("click", startMatch);
    els.copyRoomCodeBtn.addEventListener("click", () => {
      if (roomCode) {
        navigator.clipboard && navigator.clipboard.writeText(roomCode).catch(() => {});
        setStatus("✅ اتنسخ الكود");
      }
    });

    renderArenas(0);
  }

  document.addEventListener("DOMContentLoaded", init);
  // In case this script loads after DOMContentLoaded already fired.
  if (document.readyState !== "loading") init();

  return { ARENAS, arenaLockInfo };
})();
