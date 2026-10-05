/* ==========================================================
   AIR BLAST HERO — v2 full 2D mobile game
   No jump button. Movement via analog stick.
   Air Blast = directional impulse (aim-based, auto-corrects
   downward aim into an upward recovery burst).
   Energy Pulse = ranged attack on enemies, costs energy.
   ========================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------
  // CANVAS SETUP
  // ---------------------------------------------------------
  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");

  // ---------------------------------------------------------
  // PHASE 15 — NETWORK DEBUG MODE (?debug=1 only, never shown otherwise)
  // ---------------------------------------------------------
  let DEBUG = false;
  try { DEBUG = new URLSearchParams(window.location.search).get("debug") === "1"; } catch (e) { DEBUG = false; }
  const netDebugPanel = DEBUG ? document.getElementById("netDebugPanel") : null;
  if (netDebugPanel) netDebugPanel.classList.remove("hidden");
  let debugFrameCount = 0, debugFpsAccum = 0, debugFps = 0, debugRefreshAccum = 0;
  // Room id / seed aren't tracked anywhere else in the codebase (Duel/Co-op
  // use manual offer/answer codes, not a room id) — this is the one place
  // that remembers them, purely for the debug readout.
  let debugRoomId = null, debugLevelSeed = null, debugTick = 0;

  let VW = 960, VH = 540; // internal virtual resolution (VH adapts to real aspect ratio in resize())
  const GROUND_MARGIN = 220; // gap between ground line and screen bottom, so the joystick/action buttons never cover the player, terrain or enemies
  let GROUND_Y = VH - GROUND_MARGIN; // recomputed live in resize() below — must track VH, never go stale
  let scaleFactor = 1, offsetX = 0, offsetY = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Defensive fallback: some embedding contexts (e.g. an iframe that
    // hasn't finished laying out yet) can briefly report 0 for innerWidth/
    // innerHeight — dividing by that produces Infinity/NaN and breaks every
    // canvas draw call downstream (createLinearGradient throws first).
    // Real browser tabs/PWA installs always give a real, positive size.
    const w = window.innerWidth || 960;
    const h = window.innerHeight || 540;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Keep the horizontal virtual width fixed at 960 so side-scrolling
    // visibility/difficulty stays consistent, and adapt the virtual
    // height to match the real screen's aspect ratio. This lets the
    // game fill a tall portrait phone screen naturally (no forced
    // rotation, no black bars) instead of being locked to landscape.
    // Clamped so very extreme device shapes (a super-tall narrow phone,
    // or a wide tablet/monitor) don't stretch the play area into an
    // unplayable sliver or a mostly-empty column.
    VH = Math.max(480, Math.min(VW * (h / w), 1000));
    if (!Number.isFinite(VH) || VH <= 0) VH = 540; // last-resort safety net, same reasoning as above
    scaleFactor = w / VW;
    offsetX = 0;
    offsetY = 0;
    GROUND_Y = VH - GROUND_MARGIN;
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));
  resize();

  // ---------------------------------------------------------
  // SETTINGS + SAVE (localStorage)
  // ---------------------------------------------------------
  const TOTAL_LEVELS = 30;
  const BOSS_LEVEL = TOTAL_LEVELS;
  const MAX_GENERATION_ATTEMPTS = 10; // PHASE 10 — regeneration retry cap before falling back to a known-safe layout
  // Permanent upgrades (bought with lifetime upgrade points, persisted in save)
  const UPGRADE_DEFS = {
    energy: { label: "الطاقة القصوى", step: 15, maxLevel: 4, baseCost: 3, icon: "⚡" },
    health: { label: "الصحة القصوى", step: 15, maxLevel: 4, baseCost: 3, icon: "❤️" },
    damage: { label: "قوة الرشاش", step: 4, maxLevel: 4, baseCost: 4, icon: "🔫" }
  };

  const SAVE_KEY = "airBlastHero_save_v2";

  function loadSave() {
    const fallback = { unlockedLevel: 1, soundEnabled: true, vibrationEnabled: true, medals: {}, goldSkinUnlocked: false, goldSkinActive: false, legendarySkinUnlocked: false, trailColor: "default", bestScore: 0, upgradePoints: 0, upgrades: { energy: 0, health: 0, damage: 0 }, timeAttackUnlocked: false, timeAttackBest: {}, tutorialDone: false, perfectRuns: {} };
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      const upg = parsed.upgrades && typeof parsed.upgrades === "object" ? parsed.upgrades : {};
      return {
        unlockedLevel: Math.max(1, Math.min(parsed.unlockedLevel || 1, TOTAL_LEVELS)),
        soundEnabled: parsed.soundEnabled !== false,
        vibrationEnabled: parsed.vibrationEnabled !== false,
        medals: parsed.medals && typeof parsed.medals === "object" ? parsed.medals : {},
        goldSkinUnlocked: !!parsed.goldSkinUnlocked,
        goldSkinActive: !!parsed.goldSkinActive,
        legendarySkinUnlocked: !!parsed.legendarySkinUnlocked,
        trailColor: typeof parsed.trailColor === "string" ? parsed.trailColor : "default",
        bestScore: Number.isFinite(parsed.bestScore) ? parsed.bestScore : 0,
        upgradePoints: Number.isFinite(parsed.upgradePoints) ? parsed.upgradePoints : 0,
        upgrades: {
          energy: clamp(upg.energy || 0, 0, UPGRADE_DEFS.energy.maxLevel),
          health: clamp(upg.health || 0, 0, UPGRADE_DEFS.health.maxLevel),
          damage: clamp(upg.damage || 0, 0, UPGRADE_DEFS.damage.maxLevel)
        },
        timeAttackUnlocked: !!parsed.timeAttackUnlocked,
        timeAttackBest: parsed.timeAttackBest && typeof parsed.timeAttackBest === "object" ? parsed.timeAttackBest : {},
        tutorialDone: !!parsed.tutorialDone,
        // PHASE 12 — Perfect Run, independent from the S-medal: per-level
        // boolean, added backward-compatibly (old saves just get {}).
        perfectRuns: parsed.perfectRuns && typeof parsed.perfectRuns === "object" ? parsed.perfectRuns : {}
      };
    } catch (e) {
      return fallback;
    }
  }
  let saveData = loadSave();
  function writeSave() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(saveData)); }
    catch (e) { /* storage unavailable (private mode, quota, etc.) - ignore silently */ }
  }

  // ---------------------------------------------------------
  // PHASE 11 — GHOST RIVAL ("YOUR BEST")
  // Stored in its OWN localStorage key, separate from saveData, so a
  // large replay array can never risk corrupting/bloating the main save.
  // Visual-only playback: no collision, no damage, can't touch objects.
  // ---------------------------------------------------------
  const GHOST_SAVE_KEY = "airBlastHero_ghosts_v1";
  const GHOST_SAMPLE_INTERVAL = 0.1; // seconds between recorded frames
  function loadGhostStore() {
    try {
      const raw = localStorage.getItem(GHOST_SAVE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) { return {}; }
  }
  function writeGhostStore() {
    try { localStorage.setItem(GHOST_SAVE_KEY, JSON.stringify(ghostStore)); }
    catch (e) { /* quota/private mode — losing the ghost save is non-critical, ignore */ }
  }
  let ghostStore = loadGhostStore(); // { [levelNum]: { time, frames: [[t,x,y,facing]] } }
  let ghostRecordBuffer = [];
  let ghostRecordAccum = 0;
  let ghostRecordingEnabled = false; // false for MP, tutorial, Sing Mode, THE HELL
  let activeGhost = null;   // the loaded ghost for the CURRENT level, or null
  let ghostSprite = { x: 0, y: 0, facing: 1, visible: false };
  let ghostAheadShown = false; // guards the "ahead of ghost" toast to once per attempt

  function updateGhost(dt) {
    if (mp.active || !level) { ghostSprite.visible = false; return; }
    const elapsed = (performance.now() - levelStartTime) / 1000;

    // --- record this attempt ---
    if (ghostRecordingEnabled) {
      ghostRecordAccum += dt;
      if (ghostRecordAccum >= GHOST_SAMPLE_INTERVAL) {
        ghostRecordAccum = 0;
        ghostRecordBuffer.push([elapsed, Math.round(player.x), Math.round(player.y), player.facing]);
      }
    }

    // --- play back the saved ghost, if this level has one ---
    if (!activeGhost || !activeGhost.frames || !activeGhost.frames.length) { ghostSprite.visible = false; return; }
    const frames = activeGhost.frames;
    if (elapsed > activeGhost.time + 0.5) { ghostSprite.visible = false; return; } // ghost finished its run — stop showing it, don't just park it at the goal
    let lo = 0;
    while (lo < frames.length - 1 && frames[lo + 1][0] <= elapsed) lo++;
    const a = frames[lo], b = frames[Math.min(lo + 1, frames.length - 1)];
    const span = b[0] - a[0];
    const f = span > 0 ? clamp((elapsed - a[0]) / span, 0, 1) : 0;
    ghostSprite.x = a[1] + (b[1] - a[1]) * f;
    ghostSprite.y = a[2] + (b[2] - a[2]) * f;
    ghostSprite.facing = a[3];
    ghostSprite.visible = true;

    // one-time, non-spammy "you're ahead" feedback
    if (!ghostAheadShown && player.x > ghostSprite.x + 40) {
      ghostAheadShown = true;
      spawnFloatText(player.x + player.w / 2, player.y - 70, "🚀 إنت قدام أفضل وقت ليك!", "#5cff8a");
    }
  }

  function drawGhost() {
    if (!ghostSprite.visible) return;
    const sx = ghostSprite.x - camera.x;
    if (sx < -60 || sx > VW + 60) return;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "#c9c9ff";
    ctx.fillRect(sx, ghostSprite.y, PLAYER_W, PLAYER_H);
    ctx.fillStyle = "#1a0a2a";
    ctx.fillRect(sx + (ghostSprite.facing > 0 ? PLAYER_W - 10 : 2), ghostSprite.y + 8, 8, 8);
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = "#c9c9ff";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("👻", sx + PLAYER_W / 2, ghostSprite.y - 6);
    ctx.restore();
  }

  // Effective stats after applying purchased permanent upgrades on top
  // of the base constants defined above.
  function effMaxHealth() { return PLAYER_MAX_HEALTH + saveData.upgrades.health * UPGRADE_DEFS.health.step; }
  function effMaxEnergy() { return ENERGY_MAX + saveData.upgrades.energy * UPGRADE_DEFS.energy.step; }
  function effPulseDamage() { return PULSE_DAMAGE + saveData.upgrades.damage * UPGRADE_DEFS.damage.step; }
  function upgradeCost(key) {
    const def = UPGRADE_DEFS[key];
    const lvl = saveData.upgrades[key];
    return def.baseCost + lvl * 2;
  }

  const MEDAL_RANK = { none: 0, bronze: 1, silver: 2, gold: 3, s: 4 };
  const MEDAL_ICON = { bronze: "🥉", silver: "🥈", gold: "🥇", s: "🌟" };
  // Game Over screen image — alternates between the two each death.
  const GAMEOVER_IMAGES = ["gameover-moai.jpg", "gameover-slender.jpg"];
  let gameOverImgIndex = 0;
  function computeMedal(lvl, timeTaken, gemsFraction, noDamage) {
    const par = lvl.length / 210; // approx seconds for a solid run at this level's length
    // S-Rank: a genuinely "legendary" clear — every gem, zero damage, well
    // under par. Sits above gold as the top tier.
    if (noDamage && timeTaken <= par * 0.85 && gemsFraction >= 1) return "s";
    if (noDamage && timeTaken <= par * 1.05 && gemsFraction >= 0.8) return "gold";
    if (timeTaken <= par * 1.4 && gemsFraction >= 0.4) return "silver";
    return "bronze";
  }
  function recordMedal(levelNum, medal) {
    const prev = saveData.medals[levelNum];
    if (!prev || MEDAL_RANK[medal] > MEDAL_RANK[prev]) {
      saveData.medals[levelNum] = medal;
    }
    let allGold = true, allS = true;
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      if (MEDAL_RANK[saveData.medals[i]] < MEDAL_RANK.gold) allGold = false;
      if (saveData.medals[i] !== "s") allS = false;
    }
    if (allGold && !saveData.goldSkinUnlocked) saveData.goldSkinUnlocked = true;
    if (allS && !saveData.legendarySkinUnlocked) saveData.legendarySkinUnlocked = true;
    writeSave();
    return saveData.medals[levelNum];
  }
  function unlockLevel(num) {
    if (num > saveData.unlockedLevel) {
      saveData.unlockedLevel = Math.min(num, TOTAL_LEVELS);
      writeSave();
    }
  }
  function vibrate(pattern) {
    if (!saveData.vibrationEnabled) return;
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
  }

  // ---------------------------------------------------------
  // SOUND ENGINE (lightweight WebAudio beeps, no asset files)
  // ---------------------------------------------------------
  let actx = null;
  function ensureAudio() {
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { actx = null; }
    }
    if (actx && actx.state === "suspended") actx.resume();
  }
  function playTone(freq, duration, type, gainVal, sweepTo) {
    if (!actx || !saveData.soundEnabled) return;
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, actx.currentTime);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, actx.currentTime + duration);
    gain.gain.setValueAtTime(gainVal || 0.15, actx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + duration);
    osc.connect(gain);
    gain.connect(actx.destination);
    osc.start();
    osc.stop(actx.currentTime + duration);
  }
  function playGunshot() {
    if (!actx || !saveData.soundEnabled) return;
    const dur = 0.07;
    const bufferSize = Math.max(1, Math.floor(actx.sampleRate * dur));
    const buffer = actx.createBuffer(1, bufferSize, actx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = actx.createBufferSource();
    noise.buffer = buffer;
    const filter = actx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1400;
    filter.Q.value = 0.7;
    const gain = actx.createGain();
    gain.gain.setValueAtTime(0.22, actx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(actx.destination);
    noise.start();
    // low thump underneath the crack for a punchier gunshot feel
    playTone(120, 0.05, "square", 0.1, 60);
  }
  const sfx = {
    blast: (soft) => soft ? playTone(220, 0.1, "sawtooth", 0.055, 420) : playTone(220, 0.22, "sawtooth", 0.14, 480),
    pulse: () => playGunshot(),
    hit: () => playTone(140, 0.1, "square", 0.12, 60),
    hurt: () => playTone(160, 0.18, "sawtooth", 0.16, 50),
    gem: () => playTone(880, 0.16, "sine", 0.14, 1400),
    bossHit: () => playTone(100, 0.12, "square", 0.15, 40),
    phase: () => playTone(90, 0.4, "sawtooth", 0.2, 300),
    victory: () => playTone(523, 0.6, "triangle", 0.18, 1046),
    gameover: () => playTone(200, 0.6, "sawtooth", 0.18, 60)
  };
  window.addEventListener("pointerdown", ensureAudio, { once: true });

  // ---------------------------------------------------------
  // CONSTANTS
  // ---------------------------------------------------------
  const GRAVITY = 1500;
  const MOVE_SPEED = 260;
  const AIR_MOVE_SPEED = 200;
  const FRICTION_GROUND = 2200;
  const AIR_BLAST_FORCE = 720;
  const AIR_BLAST_COOLDOWN = 0.5;
  // Wall Blast: touching a wall leaves a short grace window during which an
  // Air Blast aimed away from that wall gets an extra kick, like pushing off it.
  const WALL_TOUCH_GRACE = 0.16;
  const WALL_KICK_VX = 320;
  const WALL_KICK_VY = -150;
  // Charge Blast: holding the blast button (the continuous glide pulses)
  // ramps up in strength and energy cost the longer it's held, capping at
  // CHARGE_MAX_TIME seconds of continuous hold.
  const CHARGE_MAX_TIME = 1.0;
  const CHARGE_MAX_BONUS = 0.75; // up to +75% force at max charge
  const CHARGE_ENERGY_BASE = 2;
  const CHARGE_ENERGY_SCALE = 5;
  const BLAST_HOLD_INTERVAL = 0.11; // while the blast button is held, fire a gentle sustained thrust pulse this often — smooth continuous rise instead of one big hop
  const PULSE_COOLDOWN = 0; // machine gun cooldown removed entirely per request — fires nonstop for as long as it's held
  const PULSE_ENERGY_COST = 5; // lowered so sustained bursts are possible at the new fire rate
  const ENERGY_MAX = 100;
  const ENERGY_REGEN = 22; // per second
  const PULSE_SPEED = 640;
  const PULSE_DAMAGE = 25;
  const PULSE_RANGE = 520;
  const PLAYER_MAX_HEALTH = 100;
  const ENEMY_TOUCH_DAMAGE = 15;
  const FALL_DAMAGE = 25;
  const INVULN_TIME = 0.9;
  const PLAYER_W = 34, PLAYER_H = 44;

  // Scoring
  const SCORE_GEM = 10;
  const SCORE_SECRET_GEM = 40;
  const SCORE_ENEMY = 25;
  const SCORE_ELITE = 150;
  const SCORE_BOSS = 1000;
  const TIME_BONUS_MAX = 500;

  // Combo system: kills within COMBO_WINDOW seconds of each other chain
  // a multiplier; getting hit or letting the timer run out resets it.
  const COMBO_WINDOW = 2.5;
  const COMBO_MAX_TIER = 8; // tier caps the multiplier at 1 + 8*0.25 = 3x

  // Air Blast interaction radius: used for knocking back light enemies,
  // breaking shield-enemy shields, and deflecting incoming projectiles.
  const BLAST_HIT_RADIUS = 100;
  const BLAST_KNOCKBACK_SPEED = 340;
  const BLAST_KNOCKBACK_TIME = 0.5;
  const BLAST_PARRY_RADIUS = 85;
  // Directional punch: enemies caught in the jet's path (a forward cone
  // toward wherever the stick is aimed) get launched. The closest one takes
  // the full hit and flies into the air; any others further back in the
  // same line only get a lighter shove.
  const BLAST_CONE_DOT = 0.35; // min alignment with aim direction to count as "in front" (~70° cone)
  const BLAST_LAUNCH_KNOCKBACK_SPEED = 460; // primary target: strong shove
  const BLAST_LAUNCH_VY = -520; // primary target: launched airborne
  const BLAST_CHAIN_KNOCKBACK_SPEED = 160; // enemies behind the primary: light shove

  // --- Air Blast Techniques (Phase 1) ---
  // Blast Chain: consecutive DISCRETE taps (not the auto-repeat while
  // holding) fired within this window stack a small force/score bonus.
  const BLAST_CHAIN_WINDOW_MS = 480;
  const BLAST_CHAIN_MAX_TIER = 5;
  const BLAST_CHAIN_FORCE_PER_TIER = 0.07; // +7% travel force per stacked tier
  // Recovery Blast: reward for using Air Blast to cut a long freefall short
  // instead of just riding it out - a real "get back in control" moment.
  const RECOVERY_FALL_TIME = 1.1;
  const RECOVERY_SCORE = 25;
  // Kill Momentum: any kill directly caused by Air Blast (a countered/
  // deflected projectile finishing an enemy off, or a punched enemy dying
  // to an environmental/ring-out knockback) refunds a sliver of energy and
  // a small score bonus on top of the normal combo-scaled score.
  const KILL_MOMENTUM_ENERGY_REFUND = 10;
  const KILL_MOMENTUM_SCORE_BONUS = 15;
  const WALL_BLAST_SCORE = 15;
  const BLAST_CHAIN_VY = -140; // enemies behind the primary: small hop

  // Vacuum enemy: pulls the player toward it within range — forces
  // defensive use of Air Blast to break free or push past it.
  const VACUUM_RANGE = 260;
  const VACUUM_PULL_FORCE = 340;

  // Bomber enemy: harmless until the player gets close, then arms and
  // detonates — Air Blast is the safe way to shove it away before the
  // fuse runs out (see the "bomber" branch in tryAirBlast/updateEnemies).
  const BOMBER_FUSE_RANGE = 78;
  const BOMBER_DISARM_RANGE = 130; // stepping back past this cancels the fuse
  const BOMBER_ARM_TIME = 0.85;
  const BOMBER_EXPLOSION_RADIUS = 95;
  const BOMBER_EXPLOSION_DAMAGE = 30;

  // Cloner enemy: a machine-gun hit splits it into two weaker copies
  // instead of doing damage; only a close-range direct Air Blast hit
  // actually kills it (and its clones, which can't split again).
  const CLONER_DIRECT_HIT_RADIUS = 60;

  // Trapper enemy: doesn't attack directly — keeps its distance and
  // seeds the ground with small explosive traps to box the player in.
  const TRAPPER_FLEE_RANGE = 300;
  const TRAPPER_DROP_INTERVAL = 2.2;
  const TRAPPER_MAX_DROPS = 3;

  // Thief enemy: flees like the Trapper, but a blast hit on it steals the
  // player's Air Blast instead of knocking it back — the player has to hunt
  // it down with the machine gun to get it back (see tryAirBlast's guard
  // and the bullet-hit death handling for "thief").
  const THIEF_KEEP_DIST = 300;     // المسافة اللي بيحاول يحافظ عليها وهو بيراقب
  const THIEF_TRIGGER_DIST = 480;  // لو اللاعب أقرب من كده يبدأ يفكر في الاندفاع
  const THIEF_DASH_SPEED = 560;
  const THIEF_FLEE_SPEED = 260;    // سرعته وهو هارب بعد ما ياخد البلاست

  // Mirror enemy: replays the player's own left/right movement (and Air
  // Blast use) after a short delay, using a rolling history buffer of the
  // player's recent state (see recordPlayerHistory/getPlayerHistoryAt).
  const MIRROR_DELAY = 0.45;
  const MIRROR_HISTORY_MAX_AGE = 1.2;

  // Temporary power-ups
  // Air Blast trail cosmetics: purely visual, unlocked by medal milestones.
  const TRAIL_SKINS = {
    default: { color: "#bfe8ff", label: "افتراضي", unlocked: () => true },
    amber: { color: "#ffd166", label: "كهرماني", unlocked: () => saveData.goldSkinUnlocked },
    violet: { color: "#c65cff", label: "بنفسجي", unlocked: () => Object.values(saveData.medals).some(m => m === "s") },
    inferno: { color: "#ff5c3d", label: "أسطوري", unlocked: () => saveData.legendarySkinUnlocked }
  };
  function getTrailColor() {
    const skin = TRAIL_SKINS[saveData.trailColor];
    return (skin && skin.unlocked()) ? skin.color : TRAIL_SKINS.default.color;
  }

  const POWERUP_TYPES = ["shield", "rapid", "overcharge"];
  const POWERUP_DURATION = { shield: 8, rapid: 10, overcharge: 7 };
  const POWERUP_COLORS = { shield: "#6fe9ff", rapid: "#ffd166", overcharge: "#ff8a3d" };

  // Performance caps: keep active entity counts bounded so later,
  // longer levels stay smooth on low-end mobile devices.
  const MAX_WALKERS = 12, MAX_FAST = 9, MAX_CHASERS = 7, MAX_FLYERS = 9,
        MAX_SHOOTERS = 6, MAX_FLOATS = 15, MAX_MOVERS = 9, MAX_SECRETS = 8, MAX_GEMS = 16,
        MAX_SHIELDS = 5, MAX_POWERUPS = 3, MAX_VACUUMS = 4, MAX_BOMBERS = 4, MAX_CLONERS = 3,
        MAX_TRAPPERS = 3, MAX_THIEVES = 3, MAX_MIRRORS = 3;


  // ---------------------------------------------------------
  // INPUT: FLOATING VIRTUAL JOYSTICK (Pointer Events = true multitouch)
  // ---------------------------------------------------------
  const joystick = { active: false, dx: 0, dy: 0, id: null, aimDx: 0, aimDy: -1 };
  const joyBase = document.getElementById("joystickBase");
  const joyThumb = document.getElementById("joystickThumb");
  const joyZone = document.getElementById("joystickZone");
  const JOY_RADIUS = 45;
  let joyOriginX = 0, joyOriginY = 0; // base center, in px relative to zone

  function zoneCenter() {
    const rect = joyZone.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2, rect };
  }

  function joyPointerDown(e) {
    if (joystick.active) return; // one finger controls the stick
    e.preventDefault();
    joyZone.setPointerCapture(e.pointerId);
    joystick.active = true;
    joystick.id = e.pointerId;

    // floating: base jumps to the touch point (clamped inside the zone)
    const { rect } = zoneCenter();
    const maxOffset = rect.width / 2 - 20;
    let ox = e.clientX - rect.left - rect.width / 2;
    let oy = e.clientY - rect.top - rect.height / 2;
    const od = Math.hypot(ox, oy);
    if (od > maxOffset) { ox = (ox / od) * maxOffset; oy = (oy / od) * maxOffset; }
    joyOriginX = ox; joyOriginY = oy;
    joyBase.style.left = `calc(50% + ${ox}px)`;
    joyBase.style.top = `calc(50% + ${oy}px)`;
    joyBase.style.opacity = "1";

    updateJoyFromClient(e.clientX, e.clientY);
  }
  function joyPointerMove(e) {
    if (!joystick.active || e.pointerId !== joystick.id) return;
    e.preventDefault();
    updateJoyFromClient(e.clientX, e.clientY);
  }
  function joyPointerUp(e) {
    if (!joystick.active || e.pointerId !== joystick.id) return;
    joystick.active = false;
    joystick.id = null;
    joystick.dx = 0;
    joystick.dy = 0;
    joyThumb.style.transform = "translate(-50%, -50%)";
    joyBase.style.left = "50%";
    joyBase.style.top = "50%";
  }
  function updateJoyFromClient(clientX, clientY) {
    const rect = joyZone.getBoundingClientRect();
    const baseCx = rect.left + rect.width / 2 + joyOriginX;
    const baseCy = rect.top + rect.height / 2 + joyOriginY;
    let dx = clientX - baseCx;
    let dy = clientY - baseCy;
    const dist = Math.min(Math.hypot(dx, dy), JOY_RADIUS);
    const angle = Math.atan2(dy, dx);
    const nx = Math.cos(angle) * dist;
    const ny = Math.sin(angle) * dist;
    joyThumb.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
    joystick.dx = nx / JOY_RADIUS;
    joystick.dy = ny / JOY_RADIUS;
    const mag = Math.hypot(joystick.dx, joystick.dy);
    if (mag > 0.2) {
      joystick.aimDx = joystick.dx / mag;
      joystick.aimDy = joystick.dy / mag;
    }
  }

  joyZone.addEventListener("pointerdown", joyPointerDown);
  joyZone.addEventListener("pointermove", joyPointerMove);
  joyZone.addEventListener("pointerup", joyPointerUp);
  joyZone.addEventListener("pointercancel", joyPointerUp);

  // ---------------------------------------------------------
  // KEYBOARD CONTROLS (desktop) — feeds the same joystick/input state
  // that touch uses, so all downstream gameplay code stays untouched.
  // Arrows / WASD = move & aim, Space/J = Air Blast, K/Ctrl = machine gun.
  // ---------------------------------------------------------
  const keys = { left: false, right: false, up: false, down: false };
  function updateKeyboardJoystick() {
    const anyKey = keys.left || keys.right || keys.up || keys.down;
    if (!anyKey) {
      if (joystick.usingKeyboard) {
        joystick.usingKeyboard = false;
        if (joystick.id === null) { joystick.active = false; joystick.dx = 0; joystick.dy = 0; }
      }
      return;
    }
    let dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    let dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const mag = Math.hypot(dx, dy) || 1;
    dx /= mag; dy /= mag;
    joystick.usingKeyboard = true;
    joystick.active = true;
    joystick.dx = dx;
    joystick.dy = dy;
    joystick.aimDx = dx;
    joystick.aimDy = dy;
  }
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "Escape") {
      if (state === STATE.PLAYING) { state = STATE.PAUSED; showScreen("pauseScreen"); }
      else if (state === STATE.PAUSED) { state = STATE.PLAYING; showScreen(null); }
      return;
    }
    switch (e.code) {
      case "ArrowLeft": case "KeyA": keys.left = true; break;
      case "ArrowRight": case "KeyD": keys.right = true; break;
      case "ArrowUp": case "KeyW": keys.up = true; break;
      case "ArrowDown": case "KeyS": keys.down = true; break;
      case "Space": case "KeyJ":
        ensureAudio();
        if (!input.blastHeld) input.blast = true; // fire the strong initial pulse only on the actual press
        input.blastHeld = true;
        e.preventDefault();
        break;
      case "KeyF": case "KeyK": case "ControlLeft": case "ControlRight":
        ensureAudio();
        input.pulseHeld = true;
        e.preventDefault();
        break;
      default: return;
    }
    updateKeyboardJoystick();
  });
  window.addEventListener("keyup", (e) => {
    switch (e.code) {
      case "ArrowLeft": case "KeyA": keys.left = false; break;
      case "ArrowRight": case "KeyD": keys.right = false; break;
      case "ArrowUp": case "KeyW": keys.up = false; break;
      case "ArrowDown": case "KeyS": keys.down = false; break;
      case "KeyF": case "KeyK": case "ControlLeft": case "ControlRight": input.pulseHeld = false; break;
      case "Space": case "KeyJ": input.blastHeld = false; break;
      default: return;
    }
    updateKeyboardJoystick();
  });
  // if the window loses focus mid-keypress, don't leave keys stuck "down"
  window.addEventListener("blur", () => {
    keys.left = keys.right = keys.up = keys.down = false;
    input.pulseHeld = false;
    input.blastHeld = false;
    updateKeyboardJoystick();
  });

  // ---------------------------------------------------------
  // ACTION BUTTONS (independent pointers -> work simultaneously with joystick)
  // ---------------------------------------------------------
  const input = { blast: false, blastHeld: false, pulseHeld: false };
  const blastBtn = document.getElementById("blastBtn");
  const pulseBtn = document.getElementById("pulseBtn");

  // Air Blast: a tap fires one strong pulse; holding it down keeps blasting
  // smoothly (see BLAST_HOLD_INTERVAL in update()) for as long as it's held,
  // so the player rises in a steady stream of gentle pushes instead of one
  // instant jump.
  blastBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    blastBtn.setPointerCapture(e.pointerId);
    input.blast = true;
    input.blastHeld = true;
  });
  blastBtn.addEventListener("pointerup", () => { input.blastHeld = false; });
  blastBtn.addEventListener("pointercancel", () => { input.blastHeld = false; });

  // Energy Pulse is auto-fire: a tap fires one shot, holding it down keeps
  // firing automatically at the weapon's cooldown rate until released.
  pulseBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pulseBtn.setPointerCapture(e.pointerId);
    input.pulseHeld = true;
  });
  pulseBtn.addEventListener("pointerup", () => { input.pulseHeld = false; });
  pulseBtn.addEventListener("pointercancel", () => { input.pulseHeld = false; });

  // MOUSE (desktop/computer): left mouse button fires the rasha (pulse
  // weapon), same auto-fire-while-held behavior as the F key / pulse
  // button above — feeds the exact same input.pulseHeld flag, so nothing
  // else about the weapon logic changes.
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left click only
    ensureAudio();
    input.pulseHeld = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    input.pulseHeld = false;
  });
  // ---------------------------------------------------------
  // UTIL
  // ---------------------------------------------------------
  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  // currentRng is swapped to a seeded generator ONLY for the synchronous
  // duration of a seeded buildLevel() call (see PHASE 9), then restored.
  // Nothing else runs in between (JS is single-threaded, buildLevel has
  // no awaits), so this can never leak a seeded stream into unrelated
  // gameplay randomness (particles, AI, etc.) which keep using Math.random.
  let currentRng = Math.random;
  function rand(min, max) { return min + currentRng() * (max - min); }
  // mulberry32: small, fast, deterministic PRNG. Same seed -> same output
  // sequence every time, across host and guest — needed so Race mode (and
  // any future mode requiring identical procedural levels for every
  // player) can agree on a level from a shared seed alone.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------
  // PARTICLES
  // ---------------------------------------------------------
  let particles = [];
  function spawnParticles(x, y, color, count, spread, life, kind) {
    kind = kind || "dot";
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = rand(40, spread);
      particles.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, life, maxLife: life, color, kind });
    }
  }
  // A short thick streak oriented along (dirX,dirY) instead of a random-angle
  // dot — used for the air-jet trail and the "gust punching through an
  // enemy" effect, so the wind actually reads as directional motion.
  function spawnStreak(x, y, color, dirX, dirY, speed, life, len) {
    particles.push({
      x, y,
      vx: dirX * speed + rand(-18, 18), vy: dirY * speed + rand(-18, 18),
      life, maxLife: life, color, kind: "streak", dirX, dirY, len: len || 16
    });
  }
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // wind streaks and ground dust don't arc under gravity like debris —
      // they drift/hang instead, which reads as air/dust rather than chunks
      if (p.kind !== "streak" && p.kind !== "dust") p.vy += 300 * dt;
      else if (p.kind === "dust") p.vy += 60 * dt;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }
  function drawParticles() {
    for (const p of particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      if (p.kind === "streak") {
        const ang = Math.atan2(p.dirY || 0, p.dirX || 1);
        ctx.save();
        ctx.translate(p.x - camera.x, p.y);
        ctx.rotate(ang);
        const len = (p.len || 16) * (0.55 + alpha * 0.45);
        ctx.fillRect(-len / 2, -1.6, len, 3.2);
        ctx.restore();
      } else if (p.kind === "dust") {
        ctx.beginPath();
        ctx.ellipse(p.x - camera.x, p.y, 4.5 * alpha + 1.5, 2.4 * alpha + 1, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p.x - camera.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------
  // SCREEN FLASH
  // ---------------------------------------------------------
  const flashOverlay = document.getElementById("flashOverlay");
  function flashScreen(color, duration) {
    flashOverlay.style.background = color;
    flashOverlay.style.transition = "none";
    flashOverlay.style.opacity = "0.85";
    requestAnimationFrame(() => {
      flashOverlay.style.transition = `opacity ${duration}s ease-out`;
      flashOverlay.style.opacity = "0";
    });
  }

  // ---------------------------------------------------------
  // LEVEL DATA (5 distinct levels)
  // ---------------------------------------------------------
  // seed: optional. When provided (currently used by the level validator's
  // retry path, and reserved for Race mode's shared-seed requirement),
  // generation becomes fully deterministic. When omitted, behaves exactly
  // as before (Math.random) — single-player feel is unchanged.
  function buildLevel(levelNum, seed) {
    const prevRng = currentRng;
    if (seed !== undefined && seed !== null) currentRng = mulberry32(seed >>> 0);
    const platforms = [];
    const movers = [];
    const traps = [];
    const gems = [];
    const enemies = [];

    let x = 0;
    // Length grows with level but is capped past level 14 so the very
    // late levels stay fast to render on low-end mobile devices instead
    // of becoming enormous.
    const lengthLevel = Math.min(levelNum, 14);
    const totalLength = 2700 + lengthLevel * 520 + Math.max(0, levelNum - 14) * 200;
    const gapChance = Math.min(0.26 + levelNum * 0.025, 0.52);
    const gapWidth = () => rand(70 + levelNum * 7, 120 + Math.min(levelNum, 16) * 13);
    const segMin = 220, segMax = 380;

    while (x < totalLength) {
      const segW = rand(segMin, segMax);
      platforms.push({ x: x, y: GROUND_Y, w: segW, h: 200, type: "ground" });
      x += segW;
      if (currentRng() < gapChance && x < totalLength - 300) {
        // occasional spike trap right before a gap on later levels
        if (levelNum >= 2 && currentRng() < 0.4) {
          traps.push({ x: x - 30, y: GROUND_Y - 14, w: 26, h: 14 });
        }
        x += gapWidth();
      }
    }

    // static floating platforms
    const floatCount = Math.min(4 + levelNum, MAX_FLOATS);
    for (let i = 0; i < floatCount; i++) {
      const fx = rand(300, totalLength - 300);
      const fy = rand(GROUND_Y - 320, GROUND_Y - 90);
      const fw = rand(90, 160);
      platforms.push({ x: fx, y: fy, w: fw, h: 24, type: "float" });
    }

    // moving platforms (increase with level)
    const moverCount = Math.min(Math.max(1, levelNum - 1) + 1, MAX_MOVERS);
    for (let i = 0; i < moverCount; i++) {
      const mx = rand(400, totalLength - 400);
      const my = rand(GROUND_Y - 260, GROUND_Y - 100);
      const horizontal = currentRng() < 0.6;
      const range = rand(90, 180);
      const mp = {
        x: mx, y: my, w: rand(90, 130), h: 22, type: "moving",
        baseX: mx, baseY: my, range, speed: rand(0.6, 1.1) + levelNum * 0.08,
        horizontal, t: rand(0, 6)
      };
      platforms.push(mp);
      movers.push(mp);
    }

    // secret high platform + gem reachable only via air blast
    const secretCount = Math.min(2 + Math.floor(levelNum / 2), MAX_SECRETS);
    for (let i = 0; i < secretCount; i++) {
      const sx = rand(350, totalLength - 350);
      const sy = GROUND_Y - rand(360, 440); // high up, needs air blast chain
      platforms.push({ x: sx, y: sy, w: 70, h: 20, type: "secret" });
      gems.push({ x: sx + 35, y: sy - 26, r: 10, collected: false, secret: true });
    }

    // regular reachable gems along the path
    const gemCount = Math.min(4 + levelNum, MAX_GEMS);
    for (let i = 0; i < gemCount; i++) {
      const gx = rand(200, totalLength - 200);
      const gy = GROUND_Y - rand(40, 160);
      gems.push({ x: gx, y: gy, r: 9, collected: false, secret: false });
    }

    // enemies: mix of types depending on level
    const groundSegs = platforms.filter(p => p.type === "ground" && p.w > 150);
    function pickSeg() { return groundSegs[Math.floor(rand(0, groundSegs.length))]; }

    const walkerCount = Math.min(2 + levelNum, MAX_WALKERS);
    for (let i = 0; i < walkerCount; i++) {
      const seg = pickSeg();
      if (!seg) continue;
      const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
      enemies.push({
        x: ex, y: seg.y - 30, w: 30, h: 30,
        w0: seg.x + 10, w1: seg.x + seg.w - 40,
        speed: rand(50, 70) + levelNum * 10,
        dir: currentRng() < 0.5 ? 1 : -1,
        health: 40 + levelNum * 15, maxHealth: 40 + levelNum * 15,
        damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "walker", hitFlash: 0
      });
    }

    if (levelNum >= 1) {
      const fastCount = Math.min(Math.floor(levelNum / 1.5) + 1, MAX_FAST);
      for (let i = 0; i < fastCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 24, w: 22, h: 24,
          w0: seg.x + 10, w1: seg.x + seg.w - 30,
          speed: rand(150, 190) + levelNum * 8,
          dir: currentRng() < 0.5 ? 1 : -1,
          health: 20 + levelNum * 8, maxHealth: 20 + levelNum * 8,
          damage: 10, alive: true, type: "fast", hitFlash: 0,
          flipTimer: rand(0.4, 1.2)
        });
      }
    }

    if (levelNum >= 2) {
      const chaseCount = Math.min(Math.floor(levelNum / 2) + 1, MAX_CHASERS);
      for (let i = 0; i < chaseCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 34, w: 32, h: 34,
          w0: seg.x - 220, w1: seg.x + seg.w + 220,
          speed: rand(90, 120) + levelNum * 8,
          dir: 1,
          health: 55 + levelNum * 18, maxHealth: 55 + levelNum * 18,
          damage: 18, alive: true, type: "chaser", hitFlash: 0,
          aggroRange: 340
        });
      }
    }

    if (levelNum >= 2) {
      const flyCount = Math.min(levelNum, MAX_FLYERS);
      for (let i = 0; i < flyCount; i++) {
        const fx = rand(400, totalLength - 300);
        const fy = rand(GROUND_Y - 300, GROUND_Y - 120);
        enemies.push({
          x: fx, y: fy, w: 30, h: 24, baseY: fy, t: rand(0, 10),
          speed: 90 + levelNum * 10,
          health: 30 + levelNum * 10, maxHealth: 30 + levelNum * 10,
          damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "flyer", hitFlash: 0
        });
      }
    }

    if (levelNum >= 3) {
      const shooterCount = Math.min(Math.floor(levelNum / 3) + 1, MAX_SHOOTERS);
      for (let i = 0; i < shooterCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 30, w: 28, h: 30,
          w0: seg.x + 10, w1: seg.x + seg.w - 40,
          speed: rand(25, 40),
          dir: currentRng() < 0.5 ? 1 : -1,
          health: 35 + levelNum * 10, maxHealth: 35 + levelNum * 10,
          damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "shooter", hitFlash: 0,
          range: 480, attackTimer: rand(0.5, 1.5)
        });
      }
    }

    // shield enemies: immune to the machine gun until their shield is
    // broken by an Air Blast hit — forces mixing both combat tools
    if (levelNum >= 4) {
      const shieldCount = Math.min(Math.floor(levelNum / 4), MAX_SHIELDS);
      for (let i = 0; i < shieldCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 34, w: 34, h: 34,
          w0: seg.x + 10, w1: seg.x + seg.w - 40,
          speed: rand(40, 60), dir: currentRng() < 0.5 ? 1 : -1,
          health: 45 + levelNum * 12, maxHealth: 45 + levelNum * 12,
          damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "shield", hitFlash: 0,
          shielded: true, shieldBreakFx: 0, knockbackVX: 0, knockbackTime: 0
        });
      }
    }

    // vacuum enemies: stationary, pull the player toward them within range —
    // an Air Blast in the opposite direction is the way to break free
    if (levelNum >= 6) {
      const vacuumCount = Math.min(Math.floor((levelNum - 6) / 3) + 1, MAX_VACUUMS);
      for (let i = 0; i < vacuumCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 40, w: 38, h: 40,
          w0: ex, w1: ex, speed: 0, dir: 1,
          health: 60 + levelNum * 10, maxHealth: 60 + levelNum * 10,
          damage: 8, alive: true, type: "vacuum", hitFlash: 0, t: 0
        });
      }
    }

    // bomber enemies: patrol like a walker but arm and detonate if the
    // player lingers too close — punch them away with Air Blast instead
    // of fighting them at melee range
    if (levelNum >= 5) {
      const bomberCount = Math.min(Math.floor((levelNum - 5) / 3) + 1, MAX_BOMBERS);
      for (let i = 0; i < bomberCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 30, w: 30, h: 30,
          w0: seg.x + 10, w1: seg.x + seg.w - 40,
          speed: rand(35, 55), dir: currentRng() < 0.5 ? 1 : -1,
          health: 30 + levelNum * 8, maxHealth: 30 + levelNum * 8,
          damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "bomber", hitFlash: 0,
          fuseTimer: 0, armed: false
        });
      }
    }

    // cloner enemies: shrug off the machine gun by splitting into two
    // weaker copies on hit — only a close, direct Air Blast finishes them
    if (levelNum >= 7) {
      const clonerCount = Math.min(Math.floor((levelNum - 7) / 4) + 1, MAX_CLONERS);
      for (let i = 0; i < clonerCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 32, w: 32, h: 32,
          w0: seg.x + 10, w1: seg.x + seg.w - 40,
          speed: rand(45, 65), dir: currentRng() < 0.5 ? 1 : -1,
          health: 50 + levelNum * 10, maxHealth: 50 + levelNum * 10,
          damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "cloner", hitFlash: 0,
          canSplit: true
        });
      }
    }

    // trapper enemies: don't attack directly — they back away and drop
    // small explosive traps on the ground to box the player in
    if (levelNum >= 6) {
      const trapperCount = Math.min(Math.floor((levelNum - 6) / 4) + 1, MAX_TRAPPERS);
      for (let i = 0; i < trapperCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 28, w: 28, h: 28,
          w0: seg.x + 10, w1: seg.x + seg.w - 40,
          speed: rand(70, 90), dir: currentRng() < 0.5 ? 1 : -1,
          health: 25 + levelNum * 6, maxHealth: 25 + levelNum * 6,
          damage: 0, alive: true, type: "trapper", hitFlash: 0,
          dropTimer: rand(0.6, 1.4), dropsLeft: TRAPPER_MAX_DROPS
        });
      }
    }

    // thief enemies: the "legendary" enemy — keeps its distance, studies the
    // player's movement, then times a dash to steal the Air Blast on contact.
    // Appears from level 8 onward, capped low since one active thief already
    // changes how the whole level must be played.
    if (levelNum >= 8) {
      const thiefCount = Math.min(Math.floor((levelNum - 8) / 4) + 1, MAX_THIEVES);
      for (let i = 0; i < thiefCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 32, w: 30, h: 32,
          w0: seg.x - 260, w1: seg.x + seg.w + 260,
          speed: rand(110, 140) + levelNum * 4,
          dir: currentRng() < 0.5 ? 1 : -1,
          health: 70 + levelNum * 12, maxHealth: 70 + levelNum * 12,
          damage: 14, alive: true, type: "thief", hitFlash: 0,
          state: "patrol", telegraph: 0, dashTimer: rand(0.8, 1.6),
          dashVX: 0, dashVY: 0, hasStolenBlast: false,
          dashesAttempted: 0, dashesLanded: 0, predictTime: 0.15
        });
      }
    }

    // mirror enemies: replay the player's own left/right movement (and Air
    // Blast use, cosmetically) after a short delay
    if (levelNum >= 4) {
      const mirrorCount = Math.min(Math.floor((levelNum - 4) / 3) + 1, MAX_MIRRORS);
      for (let i = 0; i < mirrorCount; i++) {
        const seg = pickSeg();
        if (!seg) continue;
        const ex = seg.x + rand(20, Math.max(21, seg.w - 40));
        enemies.push({
          x: ex, y: seg.y - 30, w: 28, h: 30,
          w0: seg.x + 10, w1: seg.x + seg.w - 40,
          speed: rand(90, 120), dir: currentRng() < 0.5 ? 1 : -1,
          health: 22 + levelNum * 5, maxHealth: 22 + levelNum * 5,
          damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "mirror", hitFlash: 0,
          nextBlastCheckIdx: blastPulseEvents.length
        });
      }
    }

    // temporary power-up pickups: shield / rapid-fire / cooldown-free blast
    const powerups = [];
    if (levelNum >= 2) {
      const puCount = Math.min(1 + Math.floor(levelNum / 5), MAX_POWERUPS);
      for (let i = 0; i < puCount; i++) {
        const px = rand(300, totalLength - 300);
        const py = GROUND_Y - rand(40, 160);
        const type = POWERUP_TYPES[Math.floor(rand(0, POWERUP_TYPES.length))];
        powerups.push({ x: px, y: py, r: 13, type, collected: false });
      }
    }

    // milestone mini-boss: a tougher, tankier elite enemy that needs several
    // hits, placed every 5 levels along the run (not on the final boss level)
    if (levelNum % 5 === 0 && levelNum !== BOSS_LEVEL) {
      const seg = groundSegs.length ? groundSegs[groundSegs.length - 1] : null;
      if (seg) {
        const eliteHealth = 300 + levelNum * 22;
        enemies.push({
          x: seg.x + seg.w * 0.5, y: seg.y - 60, w: 52, h: 60,
          w0: seg.x + 10, w1: seg.x + seg.w - 60,
          speed: 70 + levelNum * 2, dir: 1,
          health: eliteHealth, maxHealth: eliteHealth,
          damage: 24, alive: true, type: "elite", hitFlash: 0,
          telegraph: 0, chargeVX: 0, attackTimer: rand(1, 2)
        });
      }
    }

    // the level exit gate the player must reach to clear a non-boss stage
    const goal = { x: totalLength - 60, y: GROUND_Y - 80, w: 40, h: 80 };

    let boss = null;
    if (levelNum === BOSS_LEVEL) {
      const bossHealth = 1400;
      boss = {
        x: totalLength - 40, y: GROUND_Y - 120, w: 74, h: 104,
        health: bossHealth, maxHealth: bossHealth,
        phase: 1, timer: 0, attackTimer: 1.5,
        alive: true, hitFlash: 0, baseY: GROUND_Y - 120,
        pattern: "burst", telegraph: 0, dashVX: 0, enraged: false,
        // PHASE 13 — behavior-adaptation stats, gathered fresh each fight.
        // Only ever used to re-weight which EXISTING telegraphed pattern
        // gets picked next (see chooseBossPattern) — never to add new
        // attacks, skip telegraphs, or react to input directly.
        stats: { grounded: 0, airborne: 0, dashUses: 0, recentPatterns: [] }
      };
      platforms.push({ x: totalLength - 520, y: GROUND_Y, w: 950, h: 200, type: "ground" });
    }

    // theme colors per level for visual variety — one distinct theme per stage
    // (30 entries now, one per level — see TOTAL_LEVELS. If TOTAL_LEVELS ever
    // grows past this list's length again, the modulo below just cycles back
    // to the start rather than breaking, but a real new tier deserves its own
    // new themes the same way levels 21-30 got these.)
    const allThemes = [
      { hue: 210, name: "الغابة الرقمية" },
      { hue: 265, name: "الكهوف الأرجوانية" },
      { hue: 15, name: "الصحراء المحترقة" },
      { hue: 330, name: "المنطقة المحرمة" },
      { hue: 190, name: "الشعاب المتجمدة" },
      { hue: 45, name: "أراضي الرمال الذهبية" },
      { hue: 300, name: "مصنع الظلام" },
      { hue: 130, name: "الغابة السامة" },
      { hue: 5, name: "بوابة الجحيم" },
      { hue: 175, name: "المستنقع المضيء" },
      { hue: 250, name: "برج الساعة المحطم" },
      { hue: 95, name: "الأدغال الإلكترونية" },
      { hue: 55, name: "خطوط الأنابيب الصدئة" },
      { hue: 320, name: "سوق الأشباح" },
      { hue: 200, name: "محطة الفضاء المهجورة" },
      { hue: 30, name: "براكين الحمم" },
      { hue: 280, name: "متاهة البلورات" },
      { hue: 145, name: "الشعاب السامة" },
      { hue: 10, name: "أطلال الحرب" },
      { hue: 350, name: "حصن منتصف الرحلة" },
      { hue: 225, name: "أنقاض المدينة الغارقة" },
      { hue: 60, name: "حقول البرق" },
      { hue: 290, name: "كاتدرائية الظلال" },
      { hue: 165, name: "غابة الأشباح المتجمدة" },
      { hue: 20, name: "جحيم الرماد الأحمر" },
      { hue: 205, name: "مرصد النجوم المهجور" },
      { hue: 340, name: "حفرة اللحم الحي" },
      { hue: 110, name: "مستنقع الطاعون" },
      { hue: 270, name: "بوابة البعد الآخر" },
      { hue: 0, name: "عرش الزعيم الأخير" }
    ];
    const theme = allThemes[((levelNum - 1) % allThemes.length + allThemes.length) % allThemes.length];

    // PHASE 8 — real checkpoints: fixed markers tied to an actual ground
    // platform (never the "nearest ground segment to wherever the player
    // happens to be" hack the old respawnAtCheckpoint() used). Each one is
    // only usable once the player has actually walked over it.
    const checkpoints = [];
    const CHECKPOINT_SPACING = 900;
    let cpId = 0;
    for (let targetX = CHECKPOINT_SPACING; targetX < totalLength - 250; targetX += CHECKPOINT_SPACING) {
      let seg = null, bestDist = Infinity;
      for (const p of platforms) {
        if (p.type !== "ground") continue;
        const segLo = p.x + 20, segHi = p.x + p.w - 20;
        if (segHi <= segLo) continue;
        const cx = clamp(targetX, segLo, segHi);
        const d = Math.abs(cx - targetX);
        if (d < bestDist) { bestDist = d; seg = p; }
      }
      if (!seg) continue;
      const cx = clamp(targetX, seg.x + 20, seg.x + seg.w - 20);
      checkpoints.push({ id: "cp" + (++cpId), x: cx, y: seg.y, levelNum, activated: false });
    }

    currentRng = prevRng; // restore — see note above buildLevel()
    return {
      platforms, movers, traps, gems, enemies, goal, boss, powerups, checkpoints,
      length: totalLength + (levelNum === BOSS_LEVEL ? 950 : 0),
      startX: 40, startY: GROUND_Y - PLAYER_H,
      theme,
      totalGems: gems.length,
      totalSecrets: gems.filter(g => g.secret).length
    };
  }

  // TUTORIAL STAGE — a short, hand-built level (not procedurally generated)
  // that teaches movement, Air Blast, and the rasha one section at a time
  // before the player ever reaches the real, harder level 1. Uses levelNum
  // 0, kept completely separate from the 1..TOTAL_LEVELS progression/medal/
  // save system so it can never affect them.
  function buildTutorialLevel() {
    const platforms = [
      { x: 0, y: GROUND_Y, w: 480, h: 200, type: "ground" },
      { x: 580, y: GROUND_Y, w: 480, h: 200, type: "ground" }, // 100px gap: teaches Air Blast
      { x: 1060, y: GROUND_Y, w: 480, h: 200, type: "ground" }
    ];
    const gems = [
      { x: 760, y: GROUND_Y - 90, r: 9, collected: false, secret: false }
    ];
    const enemySeg = platforms[2];
    const enemies = [
      {
        x: enemySeg.x + enemySeg.w * 0.5, y: enemySeg.y - 30, w: 30, h: 30,
        w0: enemySeg.x + 10, w1: enemySeg.x + enemySeg.w - 40,
        speed: 35, dir: 1,
        health: 25, maxHealth: 25,
        damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "walker", hitFlash: 0
      }
    ];
    const totalLength = 1540;
    const goal = { x: totalLength - 60, y: GROUND_Y - 80, w: 40, h: 80 };
    const hints = [
      { x: 50, shown: false, text: "🕹️ استخدم الأسهم أو WASD للحركة يمين وشمال" },
      { x: 400, shown: false, text: "💨 دوس Space (أو زر Air Blast) عشان تندفع فوق الفجوة" },
      { x: 640, shown: false, text: "⚡ دوس F أو زرار الماوس الشمال عشان تطلق الرصاص على العدو" },
      { x: 1100, shown: false, text: "🏁 امشي لآخر المرحلة عشان تبدأ اللعب الحقيقي" }
    ];
    return {
      platforms, movers: [], traps: [], gems, enemies, goal, boss: null, powerups: [],
      checkpoints: [],
      length: totalLength,
      startX: 40, startY: GROUND_Y - PLAYER_H,
      theme: { hue: 210, name: "الدور التعليمي" },
      totalGems: gems.length,
      totalSecrets: 0,
      isTutorial: true,
      hints
    };
  }

  // PHASE 10 — lightweight sanity/reachability pass over a generated level.
  // This is NOT a full physics simulation of every jump/blast (that's a
  // much bigger project on its own); it catches the kind of thing that
  // would actually make a level broken or unplayable: a gap wider than
  // the generator's own formula should ever produce (i.e. a real bug, not
  // intended difficulty), a missing goal/boss, or any enemy/checkpoint
  // ending up with a NaN/undefined position.
  function computeGroundGaps(platforms, totalLength) {
    const segs = platforms.filter(p => p.type === "ground").map(p => [p.x, p.x + p.w]).sort((a, b) => a[0] - b[0]);
    const gaps = [];
    let cursor = 0;
    for (const [sx, ex] of segs) {
      if (sx > cursor) gaps.push(sx - cursor);
      cursor = Math.max(cursor, ex);
    }
    if (cursor < totalLength - 5) gaps.push(totalLength - cursor);
    return gaps;
  }

  function validateLevel(lvl) {
    const reasons = [];
    const MAX_GAP = 340; // generous — the generator's own gapWidth() formula tops out well under this
    for (const g of computeGroundGaps(lvl.platforms, lvl.length)) {
      if (g > MAX_GAP) { reasons.push("gap too wide (" + Math.round(g) + "px)"); break; }
    }
    if (!lvl.goal && !lvl.boss) reasons.push("no goal or boss present");
    for (const e of lvl.enemies) {
      if (!isFinite(e.x) || !isFinite(e.y)) { reasons.push("enemy has invalid position"); break; }
    }
    for (const cp of lvl.checkpoints || []) {
      if (!isFinite(cp.x) || !isFinite(cp.y)) { reasons.push("checkpoint has invalid position"); break; }
    }

    // PHASE 10 (extra passes) — a handful of cheap, targeted checks on top
    // of the gap/goal/finite checks above. None of these need a full path
    // simulation: the generator already guarantees most structure (ground
    // enemies sit on a chosen segment, checkpoints snap to one), so these
    // just catch the rare bad roll instead of re-deriving reachability
    // from scratch.

    // Start safety: nothing should be able to hit the player in the very
    // first stretch of the level, before they've even had a chance to move.
    const START_SAFE_RADIUS = 140;
    for (const e of lvl.enemies) {
      if (Math.abs(e.x - lvl.startX) < START_SAFE_RADIUS && Math.abs(e.y - lvl.startY) < 220) {
        reasons.push("enemy spawns on top of the player's start"); break;
      }
    }

    // Enemy embedded in the ground: a ground-walking enemy's feet (y + h)
    // should sit at-or-above the ground line, never noticeably below it
    // (which would mean it spawned buried inside solid ground).
    for (const e of lvl.enemies) {
      const feetY = e.y + (e.h || 0);
      if (feetY > GROUND_Y + 20) { reasons.push("enemy embedded in ground"); break; }
    }

    // Finish reachable: the goal (non-boss levels) must sit inside the
    // level's own length and not past the last real ground/float platform.
    if (lvl.goal && !lvl.boss) {
      const lastPlatformEnd = Math.max(0, ...lvl.platforms.filter(p => p.type === "ground").map(p => p.x + p.w));
      if (lvl.goal.x > lvl.length + 5 || lvl.goal.x + lvl.goal.w < lastPlatformEnd - MAX_GAP) {
        reasons.push("goal not reachable from the last ground segment");
      }
    }

    // Secret / floating platforms: each one must have some other platform
    // within a flight-friendly vertical reach below it — otherwise a bad
    // RNG roll could park a secret so high (or so isolated) that even the
    // Air Blast's chained flight can't realistically reach it.
    const MAX_SECRET_LIFT = 460; // matches the generator's own sy formula (see buildLevel) + margin
    for (const p of lvl.platforms) {
      if (p.type !== "secret" && p.type !== "float") continue;
      let hasSupportBelow = false;
      for (const other of lvl.platforms) {
        if (other === p) continue;
        const dy = other.y - p.y;
        const dx = Math.abs((other.x + other.w / 2) - (p.x + p.w / 2));
        if (dy > 0 && dy <= MAX_SECRET_LIFT && dx <= 700) { hasSupportBelow = true; break; }
      }
      if (!hasSupportBelow) { reasons.push("floating/secret platform has no reachable support below it"); break; }
    }

    return { valid: reasons.length === 0, reasons };
  }

  // Known-safe, hand-built flat layout. Used only if generation fails
  // validation MAX_GENERATION_ATTEMPTS times in a row for the same level —
  // should be extremely rare — so the player is never stuck unable to play.
  function buildFallbackLevel(levelNum) {
    const length = 2400;
    const platforms = [{ x: 0, y: GROUND_Y, w: length, h: 200, type: "ground" }];
    const goal = { x: length - 60, y: GROUND_Y - 80, w: 40, h: 80 };
    return {
      platforms, movers: [], traps: [], gems: [], enemies: [], goal, boss: null, powerups: [],
      checkpoints: [{ id: "cp1", x: length / 2, y: GROUND_Y, levelNum, activated: false }],
      length, startX: 40, startY: GROUND_Y - PLAYER_H,
      theme: { hue: 210, name: "منطقة آمنة" },
      totalGems: 0, totalSecrets: 0
    };
  }

  // Runs buildLevel, validates the result, and retries with a fresh seed
  // (up to MAX_GENERATION_ATTEMPTS) if validation fails, before finally
  // falling back to buildFallbackLevel. Never enters an infinite loop.
  function buildValidatedLevel(levelNum) {
    if (levelNum === 0) return buildTutorialLevel(); // tutorial: hand-built, skip generation/validation
    let built = buildLevel(levelNum);
    let check = validateLevel(built);
    let attempts = 1;
    while (!check.valid && attempts < MAX_GENERATION_ATTEMPTS) {
      attempts++;
      const retrySeed = (Date.now() ^ (attempts * 2654435761)) >>> 0;
      built = buildLevel(levelNum, retrySeed);
      check = validateLevel(built);
    }
    if (!check.valid) {
      built = buildFallbackLevel(levelNum);
    }
    return built;
  }

  // Race-mode variant of buildValidatedLevel(): every client must reach
  // the EXACT same final layout from the EXACT same starting seed, so
  // retries must be derived from that seed too — never from Date.now()
  // (which would differ per device and desync the race).
  function buildValidatedRaceLevel(levelNum, seed) {
    let s = seed >>> 0;
    let built = buildLevel(levelNum, s);
    let check = validateLevel(built);
    let attempts = 1;
    while (!check.valid && attempts < MAX_GENERATION_ATTEMPTS) {
      attempts++;
      s = (s ^ (attempts * 2654435761)) >>> 0; // deterministic — same sequence on every client
      built = buildLevel(levelNum, s);
      check = validateLevel(built);
    }
    if (!check.valid) built = buildFallbackLevel(levelNum);
    return built;
  }

  // ---------------------------------------------------------
  // THE HELL — secret punishment level for level 13
  // Triggered when the player falls in a hole OR dies on level 13.
  // Not a normal "reach the goal" stage: it's a flat arena where
  // 20-25 weakened bosses (5 hits each) + small mobs (2 hits each)
  // spawn in staged waves. Clearing every wave sends the player on
  // to level 14.
  // ---------------------------------------------------------
  let hellState = { active: false, phase: 0, waves: [], totalBosses: 0, clearTimer: 0, finished: false };

  function buildHellLevel() {
    const length = 2200; // tighter arena — the horde spawns close to the player anyway
    const platforms = [{ x: 0, y: GROUND_Y, w: length, h: 200, type: "ground" }];
    return {
      platforms, movers: [], traps: [], gems: [], enemies: [],
      goal: { x: -9999, y: -9999, w: 1, h: 1 }, // unreachable — Hell is cleared via waves, not a goal gate
      boss: null, powerups: [],
      length, startX: 60, startY: GROUND_Y - PLAYER_H,
      theme: { hue: 0, name: "THE HELL" },
      totalGems: 0, totalSecrets: 0,
      isHell: true
    };
  }

  // Splits a big random total of bosses (40-60) across 5 escalating waves,
  // with small mobs escalating fast too — a real horde, not a trickle.
  function planHellWaves() {
    const totalBosses = Math.floor(rand(40, 61));
    const waveCount = 5;
    const perWave = Math.floor(totalBosses / waveCount);
    let remainder = totalBosses - perWave * waveCount;
    const waves = [];
    for (let i = 0; i < waveCount; i++) {
      let bosses = perWave + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      waves.push({ bosses, mobs: 4 + i * 3 }); // later waves add a lot more small mobs
    }
    return { totalBosses, waves };
  }

  // Picks a spawn point close to the player instead of scattered across the
  // whole arena — enemies erupt in a ring around the player, alternating
  // sides, so the player is instantly surrounded instead of walking up to
  // them from a distance.
  function hellSpawnX(sideFlip) {
    const dist = rand(150, 480);
    const side = sideFlip ? -1 : 1;
    const px = player.x + player.w / 2 + side * dist;
    return clamp(px, 100, level.length - 100);
  }

  // A quick "portal tear" burst of dark/red particles at a spawn point so
  // enemies visibly rip into existence instead of just popping in.
  function spawnHellPortalFx(x, y) {
    spawnParticles(x, y, "#ff2f1a", 14, 200, 0.5);
    spawnParticles(x, y, "#1a0000", 10, 140, 0.6, "dust");
    spawnStreak(x, y - 20, "#ff5c33", 0, -1, 220, 0.3, 22);
  }

  function spawnHellWave(idx) {
    const wave = hellState.waves[idx];
    if (!wave) return;
    let sideFlip = false;
    for (let i = 0; i < wave.bosses; i++) {
      const ex = hellSpawnX(sideFlip); sideFlip = !sideFlip;
      spawnHellPortalFx(ex, GROUND_Y - 40);
      level.enemies.push({
        x: ex, y: GROUND_Y - 60, w: 50, h: 58,
        w0: ex - 100, w1: ex + 100,
        speed: rand(45, 75), dir: Math.random() < 0.5 ? 1 : -1,
        // weakened 5x vs a normal enemy: low damage, and dies in exactly
        // 5 hits from the machine gun no matter the player's upgrade level
        health: 5, maxHealth: 5, hitsToKill: 5, fixedHits: true,
        damage: 10, alive: true, hitFlash: 0, type: "elite", isHellBoss: true,
        telegraph: 0, chargeVX: 0, attackTimer: rand(1, 2)
      });
    }
    for (let i = 0; i < wave.mobs; i++) {
      const ex = hellSpawnX(sideFlip); sideFlip = !sideFlip;
      spawnHellPortalFx(ex, GROUND_Y - 15);
      level.enemies.push({
        x: ex, y: GROUND_Y - 30, w: 28, h: 30,
        w0: ex - 90, w1: ex + 90,
        speed: rand(60, 95), dir: Math.random() < 0.5 ? 1 : -1,
        health: 2, maxHealth: 2, hitsToKill: 2, fixedHits: true,
        damage: 6, alive: true, hitFlash: 0, type: "walker"
      });
    }
    hellState.phase = idx + 1;
    hellState.clearTimer = 0;
    const li = document.getElementById("levelIndicator");
    if (li) li.textContent = `THE HELL — الموجة ${hellState.phase}/${hellState.waves.length}`;
    flashScreen("rgba(255,50,20,0.5)", 0.55);
    screenShake = 14;
    vibrate([30, 20, 30, 20, 60]);
    spawnFloatText(player.x + player.w / 2, player.y - 50, `الموجة ${hellState.phase}!`, "#ff4d4d");
  }

  function enterTheHell() {
    levelGen++;
    level = buildHellLevel();
    currentLevelNum = 13;
    projectiles = []; shockwaves = []; particles = [];
    camera.x = 0;
    resetPlayer();
    levelStartTime = performance.now();
    levelNoDamage = true;
    usedCheckpointThisLevel = false;
    updateHealthUI(); updateEnergyUI(); updateGemUI(); updateScoreUI();
    const bossWrap = document.getElementById("bossBarWrap");
    if (bossWrap) bossWrap.classList.add("hidden");
    const li = document.getElementById("levelIndicator");
    if (li) li.textContent = "THE HELL — استعد...";
    const vign = document.getElementById("hellVignette");
    if (vign) vign.classList.add("active");
    const plan = planHellWaves();
    hellState = { active: true, phase: 0, waves: plan.waves, totalBosses: plan.totalBosses, clearTimer: 0, finished: false, emberTimer: 0 };
    spawnHellWave(0);
    state = STATE.PLAYING;
    showScreen(null);
    playLevelTransition();
    flashScreen("rgba(160,0,0,0.75)", 1.0);
    screenShake = 20;
    sfx.gameover();
    vibrate([50, 40, 50, 40, 80]);
  }

  function completeHell() {
    hellState.finished = true;
    const earned = 6;
    saveData.upgradePoints += earned;
    writeSave();
    const vign = document.getElementById("hellVignette");
    if (vign) vign.classList.remove("active");
    flashScreen("rgba(255,255,255,0.85)", 1.0);
    spawnFloatText(player.x + player.w / 2, player.y - 50, "نجوت من THE HELL!", "#ffd166");
    const genAtClear = levelGen;
    setTimeout(() => {
      if (genAtClear !== levelGen) return;
      // Drop the player back into the REAL level 13 (not skip ahead to
      // 14) — same fix as level 26's gauntlet: the secret is a detour,
      // not a shortcut past the actual level.
      loadLevel(13);
      state = STATE.PLAYING;
      showScreen(null);
    }, 1500);
  }

  // ---------------------------------------------------------
  // LEVEL 26 EASTER EGG — "جيش الزعماء" (Army of Bosses). Same secret-
  // area architecture as THE HELL above (falling off the level triggers
  // it instead of a normal respawn — an optional secret, not a mandatory
  // gate; the real level 26 goal is still reachable normally), scaled up
  // per the request: 100 bosses tripled (300 total) across 5 waves, every
  // regular monster type mixed in too, monsters take 5 hits to kill,
  // "bosses" take 10 — all built on the exact same fixedHits mechanic
  // THE HELL already uses, just with bigger numbers and more variety.
  // ---------------------------------------------------------
  let level26State = { active: false, phase: 0, waves: [], totalBosses: 0, clearTimer: 0, finished: false };

  function buildLevel26Level() {
    const length = 2400; // a bit roomier than Hell — 300 bosses need space to spread out
    const platforms = [{ x: 0, y: GROUND_Y, w: length, h: 200, type: "ground" }];
    return {
      platforms, movers: [], traps: [], gems: [], enemies: [],
      goal: { x: -9999, y: -9999, w: 1, h: 1 }, // unreachable — cleared via waves, not a goal gate
      boss: null, powerups: [],
      length, startX: 60, startY: GROUND_Y - PLAYER_H,
      theme: { hue: 280, name: "جيش الزعماء" },
      totalGems: 0, totalSecrets: 0,
      isLevel26Gauntlet: true
    };
  }

  // 100 bosses × 3 = 300, split across 5 escalating waves (60 each), with
  // a growing mix of regular monsters (every type, not just walkers)
  // alongside them each wave.
  function planLevel26Waves() {
    const totalBosses = 100 * 3;
    const waveCount = 5;
    const perWave = Math.floor(totalBosses / waveCount);
    let remainder = totalBosses - perWave * waveCount;
    const waves = [];
    for (let i = 0; i < waveCount; i++) {
      let bosses = perWave + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      waves.push({ bosses, mobs: 14 + i * 8 });
    }
    return { totalBosses, waves };
  }

  // Same "portal tear" idea as Hell's FX, recolored gold/purple to match
  // the observatory theme instead of hellfire red.
  function spawnLevel26PortalFx(x, y) {
    spawnParticles(x, y, "#c98cff", 14, 200, 0.5);
    spawnParticles(x, y, "#2a0a40", 10, 140, 0.6, "dust");
    spawnStreak(x, y - 20, "#ffd166", 0, -1, 220, 0.3, 22);
  }

  function spawnLevel26Wave(idx) {
    const wave = level26State.waves[idx];
    if (!wave) return;
    let sideFlip = false;
    for (let i = 0; i < wave.bosses; i++) {
      const ex = hellSpawnX(sideFlip); sideFlip = !sideFlip;
      spawnLevel26PortalFx(ex, GROUND_Y - 50);
      level.enemies.push({
        x: ex, y: GROUND_Y - 60, w: 52, h: 60,
        w0: ex - 110, w1: ex + 110,
        speed: rand(55, 90), dir: Math.random() < 0.5 ? 1 : -1,
        // "بوسات ليها 10 مش 5" — 10 fixed hits to kill, no matter upgrades
        health: 10, maxHealth: 10, hitsToKill: 10, fixedHits: true,
        damage: 18, alive: true, hitFlash: 0, type: "elite", isLevel26Boss: true,
        showPhaseLabel: true,
        telegraph: 0, chargeVX: 0, attackTimer: rand(1, 2)
      });
    }
    const mobTypes = ["walker", "fast", "chaser", "flyer", "shield"];
    for (let i = 0; i < wave.mobs; i++) {
      const ex = hellSpawnX(sideFlip); sideFlip = !sideFlip;
      spawnLevel26PortalFx(ex, GROUND_Y - 15);
      const t = mobTypes[Math.floor(rand(0, mobTypes.length))];
      // "حتى الوحوش العادية ليها 5 فيز" — every regular monster type also
      // gets the same fixedHits treatment, just 5 instead of 10.
      const base = {
        x: ex, y: GROUND_Y - 30, w: 28, h: 30,
        w0: ex - 95, w1: ex + 95,
        speed: rand(65, 105), dir: Math.random() < 0.5 ? 1 : -1,
        health: 5, maxHealth: 5, hitsToKill: 5, fixedHits: true,
        damage: 9, alive: true, hitFlash: 0, type: t, showPhaseLabel: true
      };
      if (t === "chaser") { base.w0 = 0; base.w1 = level.length; base.aggroRange = 320; base.w = 32; base.h = 34; }
      if (t === "flyer") { base.y = GROUND_Y - rand(90, 210); base.baseY = base.y; base.t = rand(0, 10); }
      if (t === "shield") { base.w = 32; base.h = 34; base.shielded = true; base.shieldBreakFx = 0; base.knockbackVX = 0; base.knockbackTime = 0; }
      level.enemies.push(base);
    }
    level26State.phase = idx + 1;
    level26State.clearTimer = 0;
    const li = document.getElementById("levelIndicator");
    if (li) li.textContent = `👑 جيش الزعماء — الموجة ${level26State.phase}/${level26State.waves.length}`;
    flashScreen("rgba(180,90,255,0.5)", 0.55);
    screenShake = 16;
    vibrate([30, 20, 30, 20, 80]);
    spawnFloatText(player.x + player.w / 2, player.y - 50, `الموجة ${level26State.phase}! (${wave.bosses} بوس 👑)`, "#c98cff");
  }

  function enterLevel26Gauntlet() {
    levelGen++;
    level = buildLevel26Level();
    currentLevelNum = 26;
    projectiles = []; shockwaves = []; particles = [];
    camera.x = 0;
    resetPlayer();
    levelStartTime = performance.now();
    levelNoDamage = true;
    usedCheckpointThisLevel = false;
    updateHealthUI(); updateEnergyUI(); updateGemUI(); updateScoreUI();
    const bossWrap = document.getElementById("bossBarWrap");
    if (bossWrap) bossWrap.classList.add("hidden");
    const li = document.getElementById("levelIndicator");
    if (li) li.textContent = "👑 جيش الزعماء — استعد...";
    const plan = planLevel26Waves();
    level26State = { active: true, phase: 0, waves: plan.waves, totalBosses: plan.totalBosses, clearTimer: 0, finished: false };
    spawnLevel26Wave(0);
    state = STATE.PLAYING;
    showScreen(null);
    playLevelTransition();
    flashScreen("rgba(120,40,200,0.75)", 1.0);
    screenShake = 20;
    sfx.gameover();
    vibrate([50, 40, 50, 40, 80]);
  }

  function completeLevel26Gauntlet() {
    level26State.finished = true;
    const earned = 20; // 300 "bosses" deserve a real reward for whoever actually finishes this
    saveData.upgradePoints += earned;
    writeSave();
    flashScreen("rgba(255,255,255,0.9)", 1.0);
    // the punchline — the whole point of the easter egg
    spawnFloatText(player.x + player.w / 2, player.y - 70, "ههه عبيط 😂", "#ffd166");
    const genAtClear = levelGen;
    setTimeout(() => {
      if (genAtClear !== levelGen) return;
      // Drop the player back into the REAL level 26 (not skip ahead to 27)
      // — the gauntlet is a detour, not a shortcut past the actual level.
      loadLevel(26);
      state = STATE.PLAYING;
      showScreen(null);
    }, 2200);
  }


  // its own arena builder, its own spawn logic, its own state object,
  // and it never sets currentLevelNum to 13, so the Hell-trigger code
  // in update() can never fire while this mode is active).
  // ---------------------------------------------------------
  let singMode = { active: false, beats: [], beatIdx: 0, duration: 0, audioEl: null, objUrl: null, kills: 0, fileName: "", nextBaselineAt: 0, elapsed: 0, audioStarted: false };

  function buildSingLevel() {
    const length = 2600;
    const platforms = [{ x: 0, y: GROUND_Y, w: length, h: 200, type: "ground" }];
    return {
      platforms, movers: [], traps: [], gems: [], enemies: [],
      goal: { x: -9999, y: -9999, w: 1, h: 1 }, // cleared when the song ends, not by reaching a goal
      boss: null, powerups: [],
      length, startX: 60, startY: GROUND_Y - PLAYER_H,
      theme: { hue: 260, name: "غنيها يا معلم" },
      totalGems: 0, totalSecrets: 0,
      isSing: true
    };
  }

  // Simple offline onset/beat detector: slices the decoded audio into
  // ~50ms windows, tracks a rolling energy average, and flags a window as
  // a "beat" whenever it spikes well above the recent average (classic
  // energy-based beat detection — good enough to feel synced without
  // needing a full FFT/tempo model).
  async function analyzeSongBeats(arrayBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let audioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      ctx.close();
    }
    const data = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.floor(sampleRate * 0.05);
    const energies = [];
    let maxEnergy = 0;
    for (let i = 0; i < data.length; i += windowSize) {
      let sum = 0;
      const end = Math.min(i + windowSize, data.length);
      for (let j = i; j < end; j++) sum += data[j] * data[j];
      const e = sum / (end - i);
      energies.push(e);
      if (e > maxEnergy) maxEnergy = e;
    }
    // Thresholds scale to THIS track's own loudness range instead of fixed
    // absolute numbers - a fixed floor tuned for one mastering level found
    // zero beats on quieter recordings (never cleared the floor) and on
    // very loud/compressed ones (energy stays high with too little spike
    // to clear the relative multiplier), which left Sing Mode with no
    // enemies at all on plenty of real songs.
    const floor = maxEnergy * 0.015;
    // Each detected onset now also records a 0..1 "strength" - how far it
    // spiked above its local threshold relative to the track's own energy
    // range - so combat intensity can actually track the music's intensity
    // instead of just alternating a fixed 1-2 count every 4th beat.
    const beats = [];
    const historyLen = 40; // ~2s of rolling history
    for (let i = 0; i < energies.length; i++) {
      const start = Math.max(0, i - historyLen);
      let avg = 0;
      for (let k = start; k < i; k++) avg += energies[k];
      avg = (i - start) > 0 ? avg / (i - start) : energies[i];
      const threshold = avg * 1.3 + floor;
      if (energies[i] > threshold && energies[i] > floor * 0.5) {
        const t = i * windowSize / sampleRate;
        if (!beats.length || t - beats[beats.length - 1].t > 0.22) {
          const strength = clamp((energies[i] - threshold) / Math.max(maxEnergy - threshold, 1e-9), 0, 1);
          beats.push({ t, strength });
        }
      }
    }

    // --- Real tempo (BPM) estimation, not just a raw onset list ---
    // Classic inter-onset-interval histogram: look at the time gap between
    // every pair of consecutive onsets, fold octave errors (a detector
    // catching only every other beat, or catching upbeats too) back into
    // one tempo band, bucket into ~20ms bins across a plausible 50-200 BPM
    // range, and take the most common bucket as the track's dominant beat
    // period. This is what turns "spikes we noticed" into an actual BPM.
    let bpm = null;
    if (beats.length > 3) {
      const minPeriod = 60 / 200, maxPeriod = 60 / 50;
      const binSize = 0.02;
      const bins = new Map();
      for (let i = 1; i < beats.length; i++) {
        let iv = beats[i].t - beats[i - 1].t;
        while (iv > maxPeriod) iv /= 2;
        while (iv > 0 && iv < minPeriod) iv *= 2;
        if (iv < minPeriod || iv > maxPeriod) continue;
        const bin = Math.round(iv / binSize);
        bins.set(bin, (bins.get(bin) || 0) + 1);
      }
      let bestBin = null, bestCount = 0;
      for (const [bin, count] of bins) {
        if (count > bestCount) { bestCount = count; bestBin = bin; }
      }
      if (bestBin !== null) bpm = Math.round(60 / (bestBin * binSize));
    }

    return { beats, duration: audioBuffer.duration, bpm };
  }

  // Spawns enemies right next to the player, timed to a beat. Count scales
  // with that beat's detected strength (a quiet onset spawns 1, a hard hit
  // spawns up to 4) instead of a fixed alternating count, so combat density
  // actually tracks how intense the music is at that moment. Reuses the
  // same "fixedHits" 2-hit mob as Hell's small mobs, but this is its own
  // code path, not hellState/spawnHellWave.
  function spawnSingBeatEnemies(strength) {
    const count = clamp(1 + Math.round(strength * 3), 1, 4);
    const strong = strength > 0.6;
    let sideFlip = Math.random() < 0.5;
    for (let i = 0; i < count; i++) {
      const dist = rand(140, 320);
      const side = sideFlip ? -1 : 1; sideFlip = !sideFlip;
      const ex = clamp(player.x + player.w / 2 + side * dist, 100, level.length - 100);
      spawnHellPortalFx(ex, GROUND_Y - 15);
      level.enemies.push({
        x: ex, y: GROUND_Y - 30, w: 28, h: 30,
        w0: ex - 90, w1: ex + 90,
        speed: rand(60, 95), dir: Math.random() < 0.5 ? 1 : -1,
        health: 2, maxHealth: 2, hitsToKill: 2, fixedHits: true,
        damage: 6, alive: true, hitFlash: 0, type: "walker"
      });
    }
    flashScreen(strong ? "rgba(150,80,255,0.4)" : "rgba(120,80,255,0.2)", strong ? 0.35 : 0.2);
    if (strong) screenShake = Math.max(screenShake, 6);
  }

  // Some browsers/devices block audioEl.play() outright (autoplay policy) -
  // when that happens we no longer leave the run silently stuck: we retry
  // playback on the player's very next tap/click, and gameplay timing
  // below never depends on this succeeding anyway.
  function attemptSingAudioPlay() {
    if (!singMode.audioEl) return;
    singMode.audioEl.play().then(() => {
      singMode.audioStarted = true;
      updateSingAudioHint();
    }).catch(() => {
      singMode.audioStarted = false;
      updateSingAudioHint();
      document.addEventListener("pointerdown", retrySingAudioOnce, { once: true });
    });
  }
  function retrySingAudioOnce() {
    if (singMode.active && singMode.audioEl && !singMode.audioStarted) {
      singMode.audioEl.play().then(() => { singMode.audioStarted = true; updateSingAudioHint(); }).catch(() => {});
    }
  }
  // Lets the player know why it's silent (browser blocked autoplay) instead
  // of leaving them guessing - clears itself the moment sound gets going.
  function updateSingAudioHint() {
    if (!level || !level.isSing) return;
    const li = document.getElementById("levelIndicator");
    if (!li) return;
    li.textContent = singMode.audioStarted
      ? `🎤 ${singMode.fileName}`
      : `🎤 ${singMode.fileName} — دوس أي حتة في الشاشة عشان الصوت يشتغل`;
  }

  function enterSingMode(file) {
    levelGen++;
    level = buildSingLevel();
    currentLevelNum = 0; // deliberately NOT 13 — keeps this mode fully outside THE HELL's trigger
    projectiles = []; shockwaves = []; particles = [];
    camera.x = 0;
    resetPlayer();
    levelStartTime = performance.now();
    levelNoDamage = true;
    usedCheckpointThisLevel = false;
    updateHealthUI(); updateEnergyUI(); updateGemUI(); updateScoreUI();
    const bossWrap = document.getElementById("bossBarWrap");
    if (bossWrap) bossWrap.classList.add("hidden");

    if (singMode.objUrl) URL.revokeObjectURL(singMode.objUrl);
    singMode.objUrl = URL.createObjectURL(file);
    const audioEl = new Audio(singMode.objUrl);
    audioEl.loop = false;
    singMode = { ...singMode, active: true, beatIdx: 0, audioEl, kills: 0, fileName: file.name, nextBaselineAt: 1.2, elapsed: 0, audioStarted: false };
    attemptSingAudioPlay();

    const li = document.getElementById("levelIndicator");
    if (li) li.textContent = `🎤 ${file.name}`;

    state = STATE.PLAYING;
    showScreen(null);
    playLevelTransition();
  }

  function completeSingMode() {
    if (!singMode.active) return;
    singMode.active = false;
    if (singMode.audioEl) { singMode.audioEl.pause(); }
    const earned = Math.min(10, Math.floor(singMode.kills / 4));
    saveData.upgradePoints += earned;
    writeSave();
    flashScreen("rgba(255,255,255,0.85)", 1.0);
    document.getElementById("singResultText").textContent =
      `قتلت ${singMode.kills} عدو على إيقاع "${singMode.fileName}" — كسبت ${earned} نقطة ترقية!`;
    state = STATE.MENU;
    showScreen("singResultScreen");
  }


  const STATE = { MENU: "menu", PLAYING: "playing", PAUSED: "paused", GAMEOVER: "gameover", VICTORY: "victory", LEVEL_COMPLETE: "levelcomplete" };
  let state = STATE.MENU;
  let currentLevelNum = 1;
  let level = null;
  let camera = { x: 0 };
  let projectiles = [];
  let shockwaves = []; // ground shockwave hazards from boss slam
  let screenShake = 0;
  let collectedGemsTotal = 0;
  let levelStartTime = 0;
  let timeAttackMode = false;
  let timeAttackElapsed = 0;
  let levelNoDamage = true;
  // PHASE 12 — Perfect Run tracks a stricter "no invalid state" condition
  // than the S-medal: the medal only cares about time+gems+noDamage, but a
  // Perfect Run is also voided by falling back on a checkpoint respawn
  // (i.e. the player never had to be bailed out mid-level).
  let usedCheckpointThisLevel = false;
  let runTotalGemsPossible = 0;
  let runScore = 0;
  let visitedLevels = new Set(); // avoid double-counting gems when a level is retried
  let levelGen = 0; // bumped every loadLevel(); guards stale setTimeout callbacks (e.g. boss burst attacks)
  let comboCount = 0;
  let comboTimer = 0;
  let runUpgradePointsEarned = 0;
  let lastBlastAt = -999; // performance.now() timestamp of the last Air Blast, used for the Perfect Dodge window
  let lastDiscreteBlastAt = -999; // like lastBlastAt but only counts real taps, not held-continuous pulses - drives Blast Chain
  let blastChainCount = 0;
  let fallTime = 0; // seconds spent continuously airborne+falling; drives Recovery Blast
  const PERFECT_DODGE_WINDOW = 260; // ms after an Air Blast during which incoming damage is fully negated

  const player = {
    x: 0, y: 0, vx: 0, vy: 0, w: PLAYER_W, h: PLAYER_H,
    facing: 1, health: PLAYER_MAX_HEALTH, maxHealth: PLAYER_MAX_HEALTH,
    energy: ENERGY_MAX, maxEnergy: ENERGY_MAX,
    onGround: false, blastCooldown: 0, pulseCooldown: 0,
    invuln: 0, blastFx: 0,
    shieldTime: 0, rapidTime: 0, overchargeTime: 0,
    blastTargetVX: 0, blastTargetVY: 0, blastEase: 0,
    blastHoldTimer: 0, blastChargeTime: 0,
    wallSide: 0, wallTime: 0,
    activeCheckpoint: null, // PHASE 8: last checkpoint object actually reached this level, or null
    down: false // PHASE 3 (co-op): true while downed, waiting for a teammate to revive
  };

  // --- Mirror-enemy support: a rolling buffer of the player's recent
  // horizontal state, so a Mirror enemy can replay it MIRROR_DELAY seconds
  // later. mirrorClock is just a simple accumulating timer, independent of
  // performance.now(), so pausing doesn't skew the delay.
  let mirrorClock = 0;
  let playerHistory = [];
  let blastPulseEvents = [];
  function recordPlayerHistory(dt) {
    mirrorClock += dt;
    playerHistory.push({ t: mirrorClock, x: player.x, vx: player.vx });
    while (playerHistory.length > 1 && mirrorClock - playerHistory[0].t > MIRROR_HISTORY_MAX_AGE) playerHistory.shift();
    while (blastPulseEvents.length && mirrorClock - blastPulseEvents[0] > MIRROR_HISTORY_MAX_AGE) blastPulseEvents.shift();
  }
  function getPlayerHistoryAt(t) {
    if (!playerHistory.length) return null;
    let best = playerHistory[0];
    for (const s of playerHistory) { if (s.t <= t) best = s; else break; }
    return best;
  }

  function resetPlayer() {
    player.x = level.startX;
    player.y = level.startY;
    player.vx = 0;
    player.vy = 0;
    player.facing = 1;
    player.onGround = false;
    player.blastCooldown = 0;
    player.blastStolen = false;
    player.pulseCooldown = 0;
    player.blastEase = 0;
    player.blastHoldTimer = 0;
    player.blastChargeTime = 0;
    player.wallSide = 0;
    player.wallTime = 0;
    player.invuln = 1.0;
    player.maxHealth = effMaxHealth();
    player.health = player.maxHealth;
    player.maxEnergy = effMaxEnergy();
    player.energy = player.maxEnergy;
    player.shieldTime = 0;
    player.rapidTime = 0;
    player.overchargeTime = 0;
    player.activeCheckpoint = null;
    player.down = false;
    comboCount = 0;
    comboTimer = 0;
    updateComboUI();
  }

  // ---------------------------------------------------------
  // MULTIPLAYER: shared player-sync / emote / ping infrastructure.
  // Each side stays fully authoritative over its OWN player (position,
  // health, energy) and simply broadcasts a snapshot ~20x/sec on the
  // fast "state" channel. player2 never runs local physics — it only
  // renders wherever the last snapshot (smoothed toward with a light
  // interpolation) says it is. One-shot events (emotes, hits, mode/
  // round control) travel on the reliable "ctrl" channel instead.
  // ---------------------------------------------------------
  const player2 = {
    x: 0, y: 0, vx: 0, vy: 0, w: PLAYER_W, h: PLAYER_H,
    facing: -1, health: PLAYER_MAX_HEALTH, maxHealth: PLAYER_MAX_HEALTH,
    energy: ENERGY_MAX, maxEnergy: ENERGY_MAX,
    blastFx: 0, invuln: 0,
    connected: false, // true once at least one snapshot has arrived
    tx: 0, ty: 0,       // interpolation target (latest received position)
    down: false // PHASE 3 (co-op): mirrored from peer's snapshot
  };
  // co-op revive bookkeeping (PHASE 3) — how long I've been standing next
  // to a downed teammate; separate from mp.coopReviveProgress, which is
  // the OTHER direction (my own downed bar, filled in by the reviver).
  let coopReviveTimer = 0;
  let coopReviveProgressSendAccum = 0;
  const COOP_REVIVE_RADIUS = 90;
  const COOP_REVIVE_TIME = 3.0;
  const EMOTES = [
    { id: "wave", icon: "👋" },
    { id: "like", icon: "👍" },
    { id: "laugh", icon: "😂" },
    { id: "help", icon: "🆘" },
    { id: "here", icon: "📍" },
    { id: "gg", icon: "🎉" }
  ];
  let localEmoteIcon = null, localEmoteUntil = 0;
  let peerEmoteIcon = null, peerEmoteUntil = 0;
  let mpSyncAccum = 0;
  const MP_SYNC_INTERVAL = 0.05; // ~20Hz outgoing state broadcast

  function resetPlayer2() {
    player2.x = level ? level.startX : 0;
    player2.y = level ? level.startY : 0;
    player2.tx = player2.x; player2.ty = player2.y;
    player2.vx = 0; player2.vy = 0; player2.facing = -1;
    player2.maxHealth = PLAYER_MAX_HEALTH; player2.health = player2.maxHealth;
    player2.maxEnergy = ENERGY_MAX; player2.energy = player2.maxEnergy;
    player2.blastFx = 0; player2.invuln = 0;
    player2.connected = false;
    player2.down = false;
  }

  function mpBroadcastState() {
    if (!mp.active || !MP.isConnected()) return;
    MP.sendState({
      x: player.x, y: player.y, vx: player.vx, vy: player.vy,
      facing: player.facing, health: player.health, maxHealth: player.maxHealth,
      energy: player.energy, blastFx: player.blastFx, invuln: player.invuln,
      down: player.down
    });
  }

  function mpApplyIncomingState(msg) {
    const firstSnapshot = !player2.connected;
    player2.connected = true;
    player2.tx = msg.x; player2.ty = msg.y;
    player2.vx = msg.vx; player2.vy = msg.vy;
    player2.facing = msg.facing;
    player2.health = msg.health; player2.maxHealth = msg.maxHealth;
    player2.energy = msg.energy; player2.blastFx = msg.blastFx; player2.invuln = msg.invuln;
    player2.down = !!msg.down;
    if (firstSnapshot) { player2.x = msg.x; player2.y = msg.y; } // snap on first contact, no slide-in from (0,0)
  }

  // PHASE 3 (co-op) — the host's authoritative enemy-wave state, sent on the
  // same fast "state" channel as the player snapshot above but tagged so the
  // receiver can tell them apart. Guests never run their own enemy AI in
  // co-op (see the updateEnemies() call site) — this is the only source of
  // truth for where enemies are, corrected ~20x/sec exactly like player2.
  function coopEnemySnapshot(e) {
    return {
      type: e.type, x: Math.round(e.x), y: Math.round(e.y), w: e.w, h: e.h,
      health: Math.round(e.health), maxHealth: e.maxHealth, alive: e.alive,
      dir: e.dir || 1, hitFlash: e.hitFlash || 0, baseY: e.baseY, t: e.t
    };
  }

  function mpBroadcastCoopWorld() {
    if (!(mp.active && mp.mode === "coop" && MP.isHost() && level && level.enemies)) return;
    MP.sendState({ t: "cw", enemies: level.enemies.map(coopEnemySnapshot), remaining: mp.coopEnemiesRemaining });
  }

  function updateMpSync(dt) {
    if (!mp.active) return;
    // interpolate player2's render position toward the latest snapshot
    player2.x += (player2.tx - player2.x) * clamp(dt * 14, 0, 1);
    player2.y += (player2.ty - player2.y) * clamp(dt * 14, 0, 1);
    mpSyncAccum += dt;
    if (mpSyncAccum >= MP_SYNC_INTERVAL) { mpSyncAccum = 0; mpBroadcastState(); mpBroadcastCoopWorld(); }
  }

  function mpSendEmote(id) {
    const e = EMOTES.find(x => x.id === id);
    if (!e || !MP.isConnected()) return;
    localEmoteIcon = e.icon;
    localEmoteUntil = performance.now() + 2200;
    MP.sendCtrl({ t: "emote", id });
    vibrate(15);
  }

  function updateMpPingUI() {
    const wrap = document.getElementById("mpPingIndicator");
    if (!wrap) return;
    if (!mp.active && !MP.isConnected()) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    const q = MP.connectionQuality();
    const dot = document.getElementById("mpPingDot");
    const text = document.getElementById("mpPingText");
    const ping = MP.getPing();
    dot.className = "mpPingDot " + (q || "none");
    text.textContent = ping === null ? "..." : Math.round(ping) + " ms";
  }

  function loadLevel(num) {
    levelGen++;
    currentLevelNum = num;
    level = buildValidatedLevel(num);
    const vign = document.getElementById("hellVignette");
    if (vign) vign.classList.remove("active"); // always clear Hell's red vignette on a normal level load
    if (!visitedLevels.has(num)) {
      visitedLevels.add(num);
      runTotalGemsPossible += level.totalGems;
    }
    projectiles = [];
    shockwaves = [];
    particles = [];
    camera.x = 0;
    resetPlayer();
    player.health = player.maxHealth;
    player.energy = player.maxEnergy;
    levelStartTime = performance.now();
    timeAttackElapsed = 0;
    levelNoDamage = true;
    usedCheckpointThisLevel = false;
    // PHASE 11 — Ghost Rival: only real numbered levels (1..TOTAL_LEVELS)
    // record/play a ghost; the tutorial (num 0) has nothing to compare.
    ghostRecordBuffer = [];
    ghostRecordAccum = 0;
    ghostAheadShown = false;
    ghostRecordingEnabled = num >= 1;
    const savedGhost = ghostStore[num];
    activeGhost = (savedGhost && savedGhost.frames && savedGhost.frames.length) ? savedGhost : null;
    ghostSprite.visible = false;
    updateHealthUI();
    updateEnergyUI();
    updateGemUI();
    updateScoreUI();
    document.getElementById("levelIndicator").textContent = num === 0
      ? "🎓 الدور التعليمي"
      : `المرحلة ${num}/${TOTAL_LEVELS} - ${level.theme.name}`;
    const bossWrap = document.getElementById("bossBarWrap");
    const bossNameEl = document.getElementById("bossName");
    const bossPhaseEl = document.getElementById("bossPhaseText");
    if (level.boss) {
      bossWrap.classList.remove("hidden");
      bossNameEl.classList.remove("enraged");
      bossNameEl.textContent = "الزعيم";
      if (bossPhaseEl) bossPhaseEl.textContent = "المرحلة القتالية 1/5";
    } else bossWrap.classList.add("hidden");
    const taTimerEl = document.getElementById("timeAttackTimer");
    if (taTimerEl) {
      taTimerEl.classList.toggle("hidden", !timeAttackMode);
      if (timeAttackMode) taTimerEl.textContent = "⏱️ 0.0";
    }
    playLevelTransition();
  }

  // Brief fade-to-black/fade-in whenever a new level loads, so moving
  // between stages reads as a deliberate transition rather than a snap-cut.
  function playLevelTransition() {
    const overlay = document.getElementById("transitionOverlay");
    if (!overlay) return;
    overlay.classList.add("active");
    requestAnimationFrame(() => {
      setTimeout(() => overlay.classList.remove("active"), 60);
    });
  }

  // TUTORIAL hint banner — a short instruction line shown once per
  // threshold as the player reaches that part of the tutorial stage.
  let tutorialHintTimer = null;
  function showTutorialHint(text) {
    const el = document.getElementById("tutorialHint");
    if (!el) return;
    el.textContent = text;
    el.classList.add("visible");
    if (tutorialHintTimer) clearTimeout(tutorialHintTimer);
    tutorialHintTimer = setTimeout(() => el.classList.remove("visible"), 3200);
  }
  function updateTutorialHints() {
    if (!level.hints) return;
    for (const h of level.hints) {
      if (!h.shown && player.x >= h.x) {
        h.shown = true;
        showTutorialHint(h.text);
      }
    }
  }

  // Small rising score/label popup at a world position (e.g. "+25", "سري!").
  function spawnFloatText(worldX, worldY, text, color) {
    const layer = document.getElementById("floatingTextLayer");
    if (!layer) return;
    const el = document.createElement("div");
    el.className = "floatText";
    el.textContent = text;
    el.style.color = color || "#fff3d0";
    el.style.left = (worldX - camera.x) * scaleFactor + offsetX + "px";
    el.style.top = worldY * scaleFactor + offsetY + "px";
    layer.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  // ---------------------------------------------------------
  // UI HELPERS
  // ---------------------------------------------------------
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
    if (id) document.getElementById(id).classList.remove("hidden");
    if (id === "menuScreen") refreshMenuScreen();
    if (id === "modeSelectScreen") refreshMenuScreen();
    if (id === "levelSelectScreen") refreshLevelSelectScreen();
    if (id === "settingsScreen") refreshSettingsScreen();
  }
  function refreshMenuScreen() {
    const btn = document.getElementById("continueBtn");
    const numEl = document.getElementById("continueLevelNum");
    if (saveData.unlockedLevel > 1) {
      btn.classList.add("visible");
      numEl.textContent = saveData.unlockedLevel;
    } else {
      btn.classList.remove("visible");
    }
    const taBtn = document.getElementById("timeAttackBtn");
    if (taBtn) taBtn.classList.toggle("hidden", !saveData.timeAttackUnlocked);
  }
  function refreshLevelSelectScreen() {
    const grid = document.getElementById("levelGrid");
    grid.innerHTML = "";
    // Tutorial stage — sits before level 1, replayable any time once
    // the player has completed it once via "لعب فردي" the first time.
    const tutLocked = !saveData.tutorialDone;
    const tutCell = document.createElement("button");
    tutCell.className = "levelCell tutorial" + (tutLocked ? " locked" : "");
    tutCell.innerHTML = `<span>${tutLocked ? "🔒" : "🎓"}</span>`;
    if (!tutLocked) {
      tutCell.addEventListener("click", () => {
        loadLevel(0);
        state = STATE.PLAYING;
        showScreen(null);
      });
    }
    grid.appendChild(tutCell);
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const cell = document.createElement("button");
      const locked = !timeAttackMode && i > saveData.unlockedLevel;
      cell.className = "levelCell" + (locked ? " locked" : "") + (i === BOSS_LEVEL ? " boss" : "");
      const numLabel = locked ? "🔒" : (i === BOSS_LEVEL ? "👹" : i);
      const medal = saveData.medals[i];
      let badge = (!locked && medal) ? `<span class="medalBadge">${MEDAL_ICON[medal]}</span>` : "";
      if (timeAttackMode && saveData.timeAttackBest[i] !== undefined) {
        badge = `<span class="medalBadge">⏱️${saveData.timeAttackBest[i].toFixed(1)}</span>`;
      }
      cell.innerHTML = `<span>${numLabel}</span>` + badge;
      if (!locked) {
        cell.addEventListener("click", () => {
          loadLevel(i);
          state = STATE.PLAYING;
          showScreen(null);
        });
      }
      grid.appendChild(cell);
    }
  }
  function refreshSettingsScreen() {
    document.getElementById("soundToggleBtn").classList.toggle("on", saveData.soundEnabled);
    document.getElementById("vibrationToggleBtn").classList.toggle("on", saveData.vibrationEnabled);
    const skinRow = document.getElementById("skinSettingsRow");
    if (saveData.goldSkinUnlocked) {
      skinRow.innerHTML = `<span>🏆 المظهر الذهبي</span><button class="toggleBtn" id="goldSkinToggleBtn"></button>`;
      document.getElementById("goldSkinToggleBtn").classList.toggle("on", saveData.goldSkinActive);
      document.getElementById("goldSkinToggleBtn").addEventListener("click", () => {
        saveData.goldSkinActive = !saveData.goldSkinActive;
        writeSave();
        refreshSettingsScreen();
      });
    } else {
      skinRow.innerHTML = `<span style="opacity:0.5">🏆 المظهر الذهبي (احصل على الذهب في كل المراحل)</span>`;
    }

    // Air Blast trail color swatches — purely cosmetic, unlocked by medal milestones.
    const trailRow = document.getElementById("trailSkinSettingsRow");
    if (trailRow) {
      trailRow.innerHTML = `<span>💨 لون أثر البلاست</span>`;
      const swatchWrap = document.createElement("div");
      swatchWrap.style.cssText = "display:flex;gap:8px;";
      for (const key in TRAIL_SKINS) {
        const skin = TRAIL_SKINS[key];
        const unlocked = skin.unlocked();
        const sw = document.createElement("button");
        sw.className = "toggleBtn";
        sw.title = skin.label;
        sw.style.cssText = `width:32px;height:32px;border-radius:50%;background:${unlocked ? skin.color : "#333"};opacity:${unlocked ? 1 : 0.35};border:2px solid ${saveData.trailColor === key ? "#fff" : "transparent"};`;
        if (unlocked) {
          sw.addEventListener("click", () => {
            saveData.trailColor = key;
            writeSave();
            refreshSettingsScreen();
          });
        }
        swatchWrap.appendChild(sw);
      }
      trailRow.appendChild(swatchWrap);
    }
  }
  function updateHealthUI() {
    const pct = clamp(player.health / player.maxHealth, 0, 1) * 100;
    document.getElementById("healthFill").style.width = pct + "%";
    document.getElementById("healthText").textContent = `${Math.max(0, Math.round(player.health))}/${player.maxHealth}`;
  }
  function updateEnergyUI() {
    const pct = clamp(player.energy / player.maxEnergy, 0, 1) * 100;
    document.getElementById("energyFill").style.width = pct + "%";
    document.getElementById("energyText").textContent = `⚡ ${Math.max(0, Math.round(player.energy))}`;
  }
  function updateGemUI() {
    const collected = level ? level.gems.filter(g => g.collected).length : 0;
    document.getElementById("gemIndicator").textContent = `💎 ${collected}/${level ? level.totalGems : 0}`;
  }
  function updateScoreUI() {
    const el = document.getElementById("scoreIndicator");
    if (el) el.textContent = `🏆 ${runScore}`;
  }
  function updateButtonStates() {
    if (blastBtn) {
      blastBtn.classList.toggle("ready", player.blastCooldown <= 0 && !player.blastStolen);
      blastBtn.classList.toggle("disabled", !!player.blastStolen);
      blastBtn.style.setProperty("--cooldownPct", "360deg");
    }
    if (pulseBtn) {
      pulseBtn.classList.toggle("disabled", player.energy < PULSE_ENERGY_COST);
      pulseBtn.classList.toggle("firing", input.pulseHeld && player.energy >= PULSE_ENERGY_COST);
    }
  }
  function addScore(amount, worldX, worldY, label, color) {
    runScore += amount;
    updateScoreUI();
    if (worldX !== undefined) spawnFloatText(worldX, worldY, label || `+${amount}`, color);
  }
  function comboMultiplier() {
    return 1 + Math.min(comboCount, COMBO_MAX_TIER) * 0.25;
  }
  function updateComboUI() {
    const el = document.getElementById("comboIndicator");
    if (!el) return;
    if (comboCount >= 2) {
      el.classList.remove("hidden");
      el.textContent = `🔥 كومبو x${(comboMultiplier()).toFixed(2).replace(/\.?0+$/, "")}`;
    } else {
      el.classList.add("hidden");
    }
  }
  // Called whenever an enemy or boss dies from player damage; chains the
  // combo multiplier and awards score scaled by it.
  function registerKill(baseScore, worldX, worldY, color) {
    if (level.isSing && singMode.active) singMode.kills++;
    comboCount++;
    comboTimer = COMBO_WINDOW;
    const mult = comboMultiplier();
    const total = Math.round(baseScore * mult);
    const label = comboCount >= 2 ? `+${total} (x${mult.toFixed(2).replace(/\.?0+$/, "")})` : `+${total}`;
    addScore(total, worldX, worldY, label, color);
    updateComboUI();
  }
  function updateBossUI() {
    if (!level.boss) return;
    const pct = clamp(level.boss.health / level.boss.maxHealth, 0, 1) * 100;
    document.getElementById("bossFill").style.width = pct + "%";
  }

  // ---------------------------------------------------------
  // GAME FLOW BUTTONS
  // ---------------------------------------------------------
  document.getElementById("startBtn").addEventListener("click", () => {
    ensureAudio();
    showScreen("modeSelectScreen");
  });
  document.getElementById("modeBackBtn").addEventListener("click", () => {
    showScreen("menuScreen");
  });
  document.getElementById("modeStoryBtn").addEventListener("click", () => {
    ensureAudio();
    timeAttackMode = false;
    collectedGemsTotal = 0; runTotalGemsPossible = 0; visitedLevels.clear(); runScore = 0;
    loadLevel(saveData.tutorialDone ? 1 : 0);
    state = STATE.PLAYING;
    showScreen(null);
  });
  document.getElementById("continueBtn").addEventListener("click", () => {
    ensureAudio();
    timeAttackMode = false;
    collectedGemsTotal = 0; runTotalGemsPossible = 0; visitedLevels.clear(); runScore = 0;
    loadLevel(saveData.unlockedLevel);
    state = STATE.PLAYING;
    showScreen(null);
  });
  document.getElementById("levelSelectBtn").addEventListener("click", () => {
    ensureAudio();
    timeAttackMode = false;
    collectedGemsTotal = 0; runTotalGemsPossible = 0; visitedLevels.clear(); runScore = 0;
    showScreen("levelSelectScreen");
  });
  document.getElementById("closeLevelSelectBtn").addEventListener("click", () => showScreen("modeSelectScreen"));

  // ---- غنيها يا معلم — UI wiring ----
  let singPickedFile = null, singPickedBeats = null;
  let singPickGen = 0; // bumped on every file pick; guards a slower, older analysis
  // from overwriting a newer pick's result/status if the user selects two songs quickly.
  document.getElementById("singModeBtn").addEventListener("click", () => {
    ensureAudio();
    singPickGen++;
    singPickedFile = null; singPickedBeats = null;
    document.getElementById("singStatusText").textContent = "";
    document.getElementById("singStartBtn").classList.add("hidden");
    showScreen("singScreen");
  });
  document.getElementById("singBackBtn").addEventListener("click", () => showScreen("modeSelectScreen"));
  document.getElementById("singPickBtn").addEventListener("click", () => {
    document.getElementById("singFileInput").click();
  });
  document.getElementById("singFileInput").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // reset so picking the same file again still fires "change"
    if (!file) return;
    const myGen = ++singPickGen;
    singPickedFile = file;
    singPickedBeats = null;
    document.getElementById("singStartBtn").classList.add("hidden");
    document.getElementById("singStatusText").textContent = `⏳ بيتحلل "${file.name}"...`;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await analyzeSongBeats(arrayBuffer);
      if (myGen !== singPickGen) return; // a newer pick superseded this one - drop stale result
      singPickedBeats = result;
      const mins = Math.floor(result.duration / 60), secs = Math.floor(result.duration % 60).toString().padStart(2, "0");
      const bpmTxt = result.bpm ? ` — ${result.bpm} BPM` : "";
      document.getElementById("singStatusText").textContent =
        `✅ جاهز! "${file.name}" — ${mins}:${secs}${bpmTxt} — لقيت ${result.beats.length} نبضة`;
      document.getElementById("singStartBtn").classList.remove("hidden");
    } catch (err) {
      if (myGen !== singPickGen) return; // stale - don't clobber a newer pick's status
      document.getElementById("singStatusText").textContent = "❌ معرفتش أحلل الملف ده، جرب أغنية تانية";
    }
  });
  document.getElementById("singStartBtn").addEventListener("click", () => {
    if (!singPickedFile || !singPickedBeats) return;
    ensureAudio();
    singMode.beats = singPickedBeats.beats;
    singMode.duration = singPickedBeats.duration;
    enterSingMode(singPickedFile);
  });
  document.getElementById("singResultBackBtn").addEventListener("click", () => {
    showScreen("menuScreen");
  });
  document.getElementById("timeAttackRetryBtn").addEventListener("click", () => {
    loadLevel(currentLevelNum);
    state = STATE.PLAYING;
    showScreen(null);
  });
  document.getElementById("timeAttackBackBtn").addEventListener("click", () => {
    showScreen("levelSelectScreen");
  });
  document.getElementById("timeAttackBtn").addEventListener("click", () => {
    ensureAudio();
    timeAttackMode = true;
    collectedGemsTotal = 0; runTotalGemsPossible = 0; visitedLevels.clear(); runScore = 0;
    showScreen("levelSelectScreen");
  });

  let settingsReturnScreen = "menuScreen";
  document.getElementById("settingsBtn").addEventListener("click", () => {
    settingsReturnScreen = "menuScreen";
    showScreen("settingsScreen");
  });
  document.getElementById("settingsFromPauseBtn").addEventListener("click", () => {
    settingsReturnScreen = "pauseScreen";
    showScreen("settingsScreen");
  });
  document.getElementById("closeSettingsBtn").addEventListener("click", () => showScreen(settingsReturnScreen));
  document.getElementById("soundToggleBtn").addEventListener("click", () => {
    saveData.soundEnabled = !saveData.soundEnabled;
    writeSave();
    refreshSettingsScreen();
  });
  document.getElementById("vibrationToggleBtn").addEventListener("click", () => {
    saveData.vibrationEnabled = !saveData.vibrationEnabled;
    writeSave();
    refreshSettingsScreen();
    if (saveData.vibrationEnabled) vibrate(15);
  });

  // ---------------------------------------------------------
  // PERMANENT UPGRADES SCREEN
  // ---------------------------------------------------------
  function refreshUpgradesScreen() {
    document.getElementById("upgradePointsText").textContent = `نقاط الترقية: ${saveData.upgradePoints} ⭐`;
    const list = document.getElementById("upgradesList");
    list.innerHTML = "";
    for (const key in UPGRADE_DEFS) {
      const def = UPGRADE_DEFS[key];
      const lvl = saveData.upgrades[key];
      const maxed = lvl >= def.maxLevel;
      const cost = upgradeCost(key);
      const row = document.createElement("div");
      row.className = "upgradeRow";
      row.innerHTML = `
        <div class="upgradeInfo">
          <div class="upgradeName">${def.icon} ${def.label}</div>
          <div class="upgradeLevel">المستوى ${lvl}/${def.maxLevel}</div>
        </div>
        <button class="upgradeBuyBtn" ${(maxed || saveData.upgradePoints < cost) ? "disabled" : ""}>
          ${maxed ? "أقصى مستوى" : `⭐ ${cost}`}
        </button>
      `;
      if (!maxed) {
        row.querySelector(".upgradeBuyBtn").addEventListener("click", () => {
          if (saveData.upgradePoints < cost) return;
          saveData.upgradePoints -= cost;
          saveData.upgrades[key]++;
          writeSave();
          refreshUpgradesScreen();
        });
      }
      list.appendChild(row);
    }
  }
  document.getElementById("upgradesBtn").addEventListener("click", () => {
    refreshUpgradesScreen();
    showScreen("upgradesScreen");
  });
  document.getElementById("closeUpgradesBtn").addEventListener("click", () => showScreen("menuScreen"));

  // ---------------------------------------------------------
  // MULTIPLAYER LOBBY (WebRTC, no server — manual code exchange)
  // ---------------------------------------------------------
  const mp = {
    mode: null,        // "versus" | "coop" | "missions"
    role: null,        // "host" | "guest"
    status: "idle",     // idle | connecting | connected | disconnected
    active: false,       // true while an actual MP session (shared level) is running
    // --- versus mode state ---
    roundWins: { me: 0, peer: 0 },
    roundsToWin: 2,       // best of 3
    roundNumber: 1,
    roundActive: false,   // false during the brief pause between rounds (no damage applies)
    roundResolving: false, // guards against double-counting a round when both sides report near-simultaneously
    // --- co-op mode state (PHASE 3/4 — 2-player wave survival) ---
    coopWave: 1,
    coopTotalWaves: 5,
    coopEnemiesRemaining: 0,
    coopWaveState: "idle", // idle | active | transition | victory | defeat
    coopReviveProgress: 0, // 0..1 — progress of MY revive bar, while I'm downed and a teammate is reviving me
    coopTransport: "duel", // "duel" = old 2-peer mp.js connection, "room" = N-player mp-room-net.js (up to 20)
    // --- room PvP state (PHASE 1 — FFA / Team, N players via mp-room-net.js) ---
    ffaAlive: true,
    ffaOver: false,
    // --- race mode state (PHASE 5 — seeded shared-level race, N players) ---
    raceFinished: false,
    raceOver: false,
    raceMyRank: null,
    raceOrder: [], // [{id, name}] in finish order, as known so far
    // --- boss rush state (PHASE 6 — chained boss fights, N players) ---
    bossRushIndex: 0,
    bossRushTotal: 3,
    bossRushOver: false,
    // --- PHASE 7 — Hunted mode: one real player is the Hunter (faster,
    // marked in red), everyone else is a Runner trying to survive a timer.
    // No stealth/AI on the Hunter — being a visible human player IS the
    // telegraph, and escalations are announced, never a silent ambush.
    huntedRole: null,        // "hunter" | "runner"
    huntedTimeLeft: 0,
    huntedEscalation: 0,
    huntedOver: false,
    huntedHunterId: null,
    // --- PHASE 16 — tracks the Firebase room this match is running inside,
    // so endMpSession() can reopen it (clear "startedAt") for mp-lobby.js's
    // public room browser once the match is over. null/false outside a
    // room-net match (Duel and old 2-peer co-op don't use this).
    roomNetRoomRef: null,
    roomNetIsHost: false
  };

  // FFA/Team (room PvP) — separate from the player2 1-peer mirror above,
  // since this uses the N-player star topology in mp-room-net.js, not
  // mp.js's single connection. peerId -> mirror object.
  let remotePlayers = {};
  let hostRoomRawStates = {}; // host-only: peerId -> latest raw snapshot received from that guest
  let localPeerId = null;
  let ffaIsHost = false;
  let myFfaName = "لاعب";
  let myFfaTeam = null; // "A" | "B" | null (null = FFA, not Team)
  let ffaSyncAccum = 0;
  const FFA_SYNC_INTERVAL = 0.05; // base rate for small rooms (<=6 players), ~20Hz

  // PERFORMANCE (proactive fix ahead of real 20-player testing): in this
  // star topology the HOST's upload is the real bottleneck — it sends
  // its own state individually to every connected peer, so total
  // outgoing traffic scales with room size, not just player density.
  // Slowing the broadcast tick down as the room grows keeps that roughly
  // bounded instead of climbing linearly forever; small rooms (Duel/
  // Co-op-sized, <=6) are completely unaffected.
  function roomSyncInterval() {
    const n = 1 + Object.keys(remotePlayers).length;
    if (n <= 6) return FFA_SYNC_INTERVAL;
    if (n <= 12) return 0.08;
    return 0.12;
  }
  // PHASE 7 — Hunted mode tuning
  const HUNTED_SURVIVAL_TIME = 90;     // seconds Runners must survive
  const HUNTED_ESCALATION_INTERVAL = 20; // seconds between speed-up announcements
  const HUNTED_SPEED_STEP = 0.12;      // +12% Hunter speed per escalation
  // Race mode (PHASE 5) reuses the same remotePlayers/hostRoomRawStates
  // mirrors and ffaIsHost flag as FFA/Team above (only one room-net mode
  // is ever active at once), but keeps its own sync timer and grace timer
  // so it can never interfere with FFA/Team's win-condition logic.
  let raceSyncAccum = 0;
  let raceFirstFinishAt = 0;
  const RACE_GRACE_MS = 30000; // once someone finishes, give stragglers this long before closing the race
  // Boss Rush (PHASE 6) also reuses the same remotePlayers/hostRoomRawStates
  // mirrors, and reuses the SAME updateBoss()/telegraph/pattern AI a
  // single-player boss fight already uses — just fed a fresh boss preset
  // per encounter instead of writing new boss logic (per the spec's own
  // "reuse existing boss behavior instead of copying boss code" note).
  let bossRushSyncAccum = 0;
  // Non-hell, non-boss levels — hell levels (5/10/15/20/25) and the final
  // boss level (30) need systems a plain race isn't built to handle.
  const RACE_LEVEL_POOL = [2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19, 21, 22, 23, 24, 26, 27, 28, 29];

  const mpEls = {
    modeSelect: document.getElementById("mpModeSelect"),
    roleSelect: document.getElementById("mpRoleSelect"),
    hostFlow: document.getElementById("mpHostFlow"),
    joinFlow: document.getElementById("mpJoinFlow"),
    statusText: document.getElementById("mpStatusText"),
    hostOfferCode: document.getElementById("mpHostOfferCode"),
    hostAnswerInput: document.getElementById("mpHostAnswerInput"),
    joinOfferInput: document.getElementById("mpJoinOfferInput"),
    joinAnswerCode: document.getElementById("mpJoinAnswerCode")
  };

  function mpSetStatus(text) { mpEls.statusText.textContent = text || ""; }

  function mpResetLobbyUI() {
    mp.mode = null; mp.role = null; mp.status = "idle";
    mpEls.modeSelect.classList.add("hidden"); // only one real mode left on this screen (Duel) - see Phase 2 cleanup
    mpEls.roleSelect.classList.add("hidden");
    mpEls.hostFlow.classList.add("hidden");
    mpEls.joinFlow.classList.add("hidden");
    mpEls.hostOfferCode.value = "";
    mpEls.hostAnswerInput.value = "";
    mpEls.joinOfferInput.value = "";
    mpEls.joinAnswerCode.value = "";
    document.querySelectorAll(".mpModeBtn").forEach(b => b.classList.remove("selected"));
    mpSetStatus("");
    MP.disconnect();
  }

  // ---------------------------------------------------------
  // MULTIPLAYER SESSION — generic fallback used only if mp.mode is ever
  // something other than "versus" or "ffa" when a connection completes.
  // Since Phase 2 removed the old screen's non-functional "تعاوني"/"مهام"
  // buttons (they connected real players but then just loaded ordinary
  // single-player level 1 for each - see mpResetLobbyUI), this path is no
  // longer reachable through the UI. Left in place as a defensive fallback
  // rather than deleted, per the "don't delete without a clear reason" rule.
  // ---------------------------------------------------------
  function startMpSession() {
    mp.active = true;
    resetPlayer2();
    localEmoteIcon = null; peerEmoteIcon = null;
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    document.getElementById("mpEmoteWrap").classList.remove("hidden");
    timeAttackMode = false;
    collectedGemsTotal = 0; runTotalGemsPossible = 0; visitedLevels.clear(); runScore = 0;
    loadLevel(1);
    state = STATE.PLAYING;
    showScreen(null);
  }

  function endMpSession(reasonText) {
    const wasRoomPvp = mp.mode === "ffa" || mp.mode === "team" || mp.mode === "race" || mp.mode === "bossrush" || mp.mode === "hunted" || (mp.mode === "coop" && mp.coopTransport === "room");
    mp.active = false;
    mp.mode = null;
    document.getElementById("mpPingIndicator").classList.add("hidden");
    document.getElementById("mpEmoteWrap").classList.add("hidden");
    document.getElementById("mpEmotePanel").classList.add("hidden");
    document.getElementById("versusHud").classList.add("hidden");
    const coopWrap = document.getElementById("coopHud"); if (coopWrap) coopWrap.classList.add("hidden");
    const ffaWrap = document.getElementById("ffaHud"); if (ffaWrap) ffaWrap.classList.add("hidden");
    const raceWrap = document.getElementById("raceHud"); if (raceWrap) raceWrap.classList.add("hidden");
    const huntedWrap = document.getElementById("huntedHud"); if (huntedWrap) huntedWrap.classList.add("hidden");
    document.getElementById("statsWrap").classList.remove("hidden");
    document.getElementById("centerStats").classList.remove("hidden");
    if (wasRoomPvp) {
      try { MPRoomNet.shutdown(); } catch (e) {}
      remotePlayers = {}; hostRoomRawStates = {};
      // PHASE 16 — reopen the room for mp-lobby.js's public browse list:
      // it filters out any room with "startedAt" set, so clearing it here
      // is what lets a finished room show up again (once it also has a
      // free slot — see renderPublicRooms()). Only the host writes this;
      // guests have no reason to and every room-net match already only
      // lets the host flip "startedAt" on in the first place.
      if (mp.roomNetIsHost && mp.roomNetRoomRef) {
        try { mp.roomNetRoomRef.child("startedAt").remove(); } catch (e) {}
      }
    }
    mp.roomNetRoomRef = null; mp.roomNetIsHost = false;
    mp.raceFinished = false; mp.raceOver = false; mp.raceMyRank = null; mp.raceOrder = [];
    raceFirstFinishAt = 0;
    mp.huntedRole = null; mp.huntedOver = false; mp.huntedHunterId = null; mp.huntedEscalation = 0;
    if (DEBUG) { debugRoomId = null; debugLevelSeed = null; } // small cleanup: don't show a stale room/seed once back in single-player
    if (state === STATE.PLAYING || state === STATE.PAUSED) {
      state = STATE.MENU;
      showScreen("menuScreen");
    }
    if (reasonText) mpSetStatus(reasonText);
  }

  // ---------------------------------------------------------
  // VERSUS MODE (1×1) — small closed arena, separate health bars,
  // Best of 3 rounds, mid-arena power-ups. Each side stays
  // authoritative over its own health (see damagePlayer / the "hit"
  // ctrl message); the host is authoritative over power-up spawns
  // so both screens always show the same pickups in the same spots.
  // ---------------------------------------------------------
  let mpNextPowerupAt = 0;
  let mpPowerupIdCounter = 0;

  function buildVersusArena() {
    const length = VW;
    return {
      length,
      startX: 100, startY: GROUND_Y - PLAYER_H,
      platforms: [
        { x: 0, y: GROUND_Y, w: length, h: 200, type: "ground" },
        { x: length * 0.5 - 70, y: GROUND_Y - 140, w: 140, h: 22, type: "static" },
        { x: length * 0.15 - 55, y: GROUND_Y - 240, w: 110, h: 22, type: "static" },
        { x: length * 0.85 - 55, y: GROUND_Y - 240, w: 110, h: 22, type: "static" }
      ],
      movers: [], traps: [], enemies: [], gems: [], totalGems: 0,
      powerups: [], goal: null, boss: null,
      theme: { hue: 210, name: "ساحة المواجهة" }
    };
  }

  function startVersusMatch() {
    mp.mode = "versus";
    mp.active = true;
    mp.roundWins = { me: 0, peer: 0 };
    mp.roundNumber = 1;
    localEmoteIcon = null; peerEmoteIcon = null;
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    document.getElementById("mpEmoteWrap").classList.remove("hidden");
    document.getElementById("statsWrap").classList.add("hidden");
    document.getElementById("centerStats").classList.add("hidden");
    state = STATE.PLAYING;
    showScreen(null);
    startVersusRound();
  }

  function startVersusRound() {
    mp.roundResolving = false;
    levelGen++;
    level = buildVersusArena();
    camera.x = 0;
    projectiles = []; shockwaves = []; particles = [];
    const iAmHost = MP.isHost();
    player.x = iAmHost ? 100 : VW - 100 - PLAYER_W;
    player.y = GROUND_Y - PLAYER_H;
    player.vx = 0; player.vy = 0; player.facing = iAmHost ? 1 : -1;
    player.maxHealth = PLAYER_MAX_HEALTH; player.health = player.maxHealth;
    player.maxEnergy = ENERGY_MAX; player.energy = player.maxEnergy;
    player.invuln = 1.2; player.shieldTime = 0; player.rapidTime = 0; player.overchargeTime = 0;
    player.activeCheckpoint = null; // arena has no checkpoints; also clears any stale one from single-player
    resetPlayer2();
    player2.x = iAmHost ? VW - 100 - PLAYER_W : 100;
    player2.y = GROUND_Y - PLAYER_H;
    player2.tx = player2.x; player2.ty = player2.y;
    updateHealthUI();
    updateEnergyUI();
    updateVersusHud();
    mpNextPowerupAt = performance.now() + rand(4000, 7000);
    spawnFloatText(VW / 2, 90, `الجولة ${mp.roundNumber}`, "#ffd166");
    mp.roundActive = true;
  }

  function handleVersusRoundLoss() {
    if (mp.roundResolving) return;
    mp.roundResolving = true;
    mp.roundActive = false;
    mp.roundWins.peer++;
    MP.sendCtrl({ t: "roundLost" });
    showVersusRoundResult(false);
  }

  function showVersusRoundResult(won) {
    updateVersusHud();
    vibrate(won ? [20, 40, 20] : [60, 80]);
    spawnFloatText(VW / 2, VH / 2 - 30, won ? "فزت بالجولة! 🏆" : "خسرت الجولة 💔", won ? "#5cff8a" : "#ff5c7a");
    const meWon = mp.roundWins.me >= mp.roundsToWin;
    const peerWon = mp.roundWins.peer >= mp.roundsToWin;
    const genAtResolve = levelGen;
    if (meWon || peerWon) {
      setTimeout(() => { if (genAtResolve === levelGen) endVersusMatch(meWon); }, 1800);
    } else {
      mp.roundNumber++;
      setTimeout(() => { if (mp.active && mp.mode === "versus" && genAtResolve === levelGen) startVersusRound(); }, 1800);
    }
  }

  function endVersusMatch(won) {
    spawnFloatText(VW / 2, VH / 2, won ? "🏆 فزت بالمواجهة!" : "خسرت المواجهة", won ? "#ffd166" : "#ff5c7a");
    vibrate(won ? [50, 60, 50, 60, 120] : [80, 100]);
    const score = `${mp.roundWins.me}-${mp.roundWins.peer}`;
    setTimeout(() => {
      endMpSession(won ? `🏆 فزت بالمواجهة! ${score}` : `خسرت المواجهة ${score}`);
    }, 2200);
  }

  function spawnVersusPowerup() {
    if (!MP.isHost() || !level || !level.powerups) return;
    const type = POWERUP_TYPES[Math.floor(rand(0, POWERUP_TYPES.length))];
    const x = rand(VW * 0.35, VW * 0.65);
    const y = GROUND_Y - rand(60, 220);
    const id = "pu" + (++mpPowerupIdCounter) + "-" + Date.now();
    level.powerups.push({ x, y, r: 14, type, id, collected: false });
    MP.sendCtrl({ t: "powerupSpawn", id, x, y, type });
    mpNextPowerupAt = performance.now() + rand(5000, 9000);
  }

  // ---------------------------------------------------------
  // CO-OP MODE (2 players, wave survival) — PHASE 3/4.
  // Reuses the exact same proven 2-peer WebRTC connection as Duel (host +
  // 1 guest), NOT the experimental up-to-20 star topology in
  // mp-room-net.js — that foundation isn't wired to any gameplay yet, and
  // bolting real-time co-op onto it in the same pass would be far riskier
  // than reusing the connection that's already known to work end-to-end.
  //
  // AUTHORITY MODEL: the host runs the real enemy-wave simulation locally
  // (the exact same updateEnemies()/damagePlayer() code single-player
  // already uses, completely untouched) and streams it to the guest, who
  // never runs enemy AI of their own (see the updateEnemies() call site
  // in update()) — only mirrors host's enemies and predicts hits locally
  // for instant feedback, corrected by the next host snapshot. This is
  // the same "client predicts, host corrects" pattern already used for
  // versus-mode hits (see the "optimistic local prediction" comments).
  // ---------------------------------------------------------
  function buildCoopArena() {
    // Same proven, always-reachable geometry as the versus arena (no gaps,
    // no procedural randomness — nothing to desync between host/guest).
    const length = VW * 1.3;
    return {
      length,
      startX: 100, startY: GROUND_Y - PLAYER_H,
      platforms: [
        { x: 0, y: GROUND_Y, w: length, h: 200, type: "ground" },
        { x: length * 0.5 - 80, y: GROUND_Y - 150, w: 160, h: 22, type: "static" },
        { x: length * 0.18 - 55, y: GROUND_Y - 240, w: 110, h: 22, type: "static" },
        { x: length * 0.82 - 55, y: GROUND_Y - 240, w: 110, h: 22, type: "static" }
      ],
      movers: [], traps: [], enemies: [], gems: [], totalGems: 0,
      powerups: [], goal: null, boss: null, checkpoints: [],
      theme: { hue: 145, name: "ساحة الصمود" }
    };
  }

  // Escalating enemy composition per wave — reuses the exact same enemy
  // object shapes buildLevel() creates (same fields updateEnemies() and
  // the renderer already know how to handle), just placed on the fixed
  // co-op arena instead of a procedurally generated level.
  function coopWaveComposition(waveNum) {
    const comps = [
      [{ type: "walker", count: 3 }],
      [{ type: "walker", count: 2 }, { type: "fast", count: 2 }],
      [{ type: "walker", count: 2 }, { type: "fast", count: 2 }, { type: "chaser", count: 1 }],
      [{ type: "fast", count: 3 }, { type: "chaser", count: 2 }],
      [{ type: "chaser", count: 2 }, { type: "flyer", count: 2 }, { type: "walker", count: 2 }]
    ];
    return comps[Math.min(waveNum, comps.length) - 1];
  }

  function buildCoopWaveEnemies(waveNum, playerCount) {
    const groundSeg = level.platforms.find(p => p.type === "ground");
    const scale = 1 + (waveNum - 1) * 0.18; // escalating difficulty per PHASE 6/16 test-matrix intent
    // More players → more enemies per wave, capped so a 20-player room
    // doesn't spawn an unreasonable swarm. Omitting playerCount (the old
    // 2-player call site) keeps the multiplier at 1x — unchanged behavior.
    const countMult = Math.min(4, Math.max(1, Math.ceil((playerCount || 2) / 2)));
    const enemies = [];
    let slot = 0;
    const comp = coopWaveComposition(waveNum);
    const totalCount = comp.reduce((s, c) => s + c.count * countMult, 0);
    for (const group of comp) {
      for (let i = 0; i < group.count * countMult; i++) {
        slot++;
        const ex = groundSeg.x + 220 + (slot / (totalCount + 1)) * (level.length - 440);
        if (group.type === "walker") {
          enemies.push({
            x: ex, y: GROUND_Y - 30, w: 30, h: 30,
            w0: ex - 140, w1: ex + 140,
            speed: 55 * scale, dir: Math.random() < 0.5 ? 1 : -1,
            health: Math.round(40 * scale), maxHealth: Math.round(40 * scale),
            damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "walker", hitFlash: 0
          });
        } else if (group.type === "fast") {
          enemies.push({
            x: ex, y: GROUND_Y - 24, w: 22, h: 24,
            w0: ex - 160, w1: ex + 160,
            speed: 160 * scale, dir: Math.random() < 0.5 ? 1 : -1,
            health: Math.round(22 * scale), maxHealth: Math.round(22 * scale),
            damage: 10, alive: true, type: "fast", hitFlash: 0, flipTimer: rand(0.4, 1.2)
          });
        } else if (group.type === "chaser") {
          enemies.push({
            x: ex, y: GROUND_Y - 34, w: 32, h: 34,
            w0: 0, w1: level.length,
            speed: 100 * scale, dir: 1,
            health: Math.round(60 * scale), maxHealth: Math.round(60 * scale),
            damage: 18, alive: true, type: "chaser", hitFlash: 0, aggroRange: 340
          });
        } else if (group.type === "flyer") {
          enemies.push({
            x: ex, y: GROUND_Y - rand(160, 260), w: 30, h: 24, baseY: GROUND_Y - rand(160, 260), t: rand(0, 10),
            speed: 95 * scale,
            health: Math.round(32 * scale), maxHealth: Math.round(32 * scale),
            damage: ENEMY_TOUCH_DAMAGE, alive: true, type: "flyer", hitFlash: 0
          });
        }
      }
    }
    return enemies;
  }

  function startCoopMatch() {
    mp.mode = "coop";
    mp.coopTransport = "duel";
    mp.active = true;
    mp.coopWave = 1;
    mp.coopWaveState = "active";
    mp.coopReviveProgress = 0;
    coopReviveTimer = 0;
    localEmoteIcon = null; peerEmoteIcon = null;
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    document.getElementById("mpEmoteWrap").classList.remove("hidden");
    document.getElementById("statsWrap").classList.add("hidden");
    document.getElementById("centerStats").classList.add("hidden");
    levelGen++;
    level = buildCoopArena();
    camera.x = 0;
    projectiles = []; shockwaves = []; particles = [];
    const iAmHost = MP.isHost();
    player.x = iAmHost ? level.startX : level.startX + 120;
    player.y = level.startY;
    player.vx = 0; player.vy = 0; player.facing = 1;
    player.maxHealth = effMaxHealth(); player.health = player.maxHealth;
    player.maxEnergy = effMaxEnergy(); player.energy = player.maxEnergy;
    player.invuln = 1.2; player.down = false; player.activeCheckpoint = null;
    resetPlayer2();
    player2.x = iAmHost ? level.startX + 120 : level.startX;
    player2.y = level.startY; player2.tx = player2.x; player2.ty = player2.y;
    updateHealthUI(); updateEnergyUI();
    state = STATE.PLAYING;
    showScreen(null);
    spawnFloatText(VW / 2, 90, "تعاوني ضد الموجات 🤝", "#5cff8a");
    if (iAmHost) startCoopWave(1);
    else level.enemies = []; // guest waits for host's first waveStart/cw broadcast
    updateCoopHud();
  }

  function startCoopWave(waveNum) {
    if (!MP.isHost()) return;
    mp.coopWave = waveNum;
    mp.coopWaveState = "active";
    level.enemies = buildCoopWaveEnemies(waveNum);
    mp.coopEnemiesRemaining = level.enemies.length;
    MP.sendCtrl({ t: "waveStart", wave: waveNum, enemies: level.enemies.map(coopEnemySnapshot) });
    spawnFloatText(VW / 2, 90, `الموجة ${waveNum} / ${mp.coopTotalWaves}`, "#ffd166");
    vibrate(20);
    updateCoopHud();
  }

  // Host-only: watches for a fully-cleared wave and advances the mission.
  function updateCoopWaveProgress() {
    if (!(MP.isHost() && mp.active && mp.mode === "coop" && mp.coopWaveState === "active")) return;
    const remaining = level.enemies.filter(e => e.alive).length;
    mp.coopEnemiesRemaining = remaining;
    if (remaining === 0 && level.enemies.length > 0) {
      mp.coopWaveState = "transition";
      const doneWave = mp.coopWave;
      MP.sendCtrl({ t: "waveCleared", wave: doneWave });
      spawnFloatText(VW / 2, VH / 2 - 40, `✅ الموجة ${doneWave} خلصت!`, "#5cff8a");
      const genAtClear = levelGen;
      setTimeout(() => {
        if (genAtClear !== levelGen || !(mp.active && mp.mode === "coop")) return;
        if (doneWave >= mp.coopTotalWaves) {
          mp.coopWaveState = "victory";
          MP.sendCtrl({ t: "coopVictory" });
          endCoopMatch(true);
        } else {
          startCoopWave(doneWave + 1);
        }
      }, 1800);
    }
  }

  function enterCoopDown() {
    player.down = true;
    player.vx = 0; player.vy = 0;
    player.invuln = 999;
    input.blast = false; input.blastHeld = false; input.pulseHeld = false;
    spawnFloatText(player.x + player.w / 2, player.y - 20, "سقطت! 💫", "#ff5c7a");
    vibrate([50, 50, 50]);
    updateCoopHud();
  }

  // Runs every frame in co-op: handles reviving a downed teammate (I'm the
  // reviver) and, host-side only, detects the shared fail condition (both
  // players down at once).
  function updateCoopRevive(dt) {
    if (!(mp.active && mp.mode === "coop")) return;
    if (!player.down && player2.connected && player2.down) {
      const d = Math.hypot((player.x + player.w / 2) - (player2.x + player2.w / 2), (player.y + player.h / 2) - (player2.y + player2.h / 2));
      if (d < COOP_REVIVE_RADIUS) {
        coopReviveTimer += dt;
        const prog = clamp(coopReviveTimer / COOP_REVIVE_TIME, 0, 1);
        coopReviveProgressSendAccum += dt;
        if (coopReviveProgressSendAccum > 0.15) { coopReviveProgressSendAccum = 0; MP.sendCtrl({ t: "revProg", v: prog }); }
        if (coopReviveTimer >= COOP_REVIVE_TIME) {
          MP.sendCtrl({ t: "revived" });
          coopReviveTimer = 0;
          spawnFloatText(player2.x + player2.w / 2, player2.y - 20, "أنقذته! 🙌", "#5cff8a");
          vibrate([20, 30, 20]);
        }
      } else if (coopReviveTimer > 0) {
        coopReviveTimer = 0;
        coopReviveProgressSendAccum = 0;
        MP.sendCtrl({ t: "revProg", v: 0 });
      }
    } else if (coopReviveTimer > 0) {
      // BUGFIX (revive interruption): this branch fires whenever a revive
      // was in progress and stopped being valid for any reason OTHER than
      // moving out of range (the reviver themselves got downed, or the
      // partner disconnected) — it used to reset the local timer but never
      // tell the downed partner, so their revive progress bar stayed stuck
      // showing whatever percentage they'd last received instead of
      // reflecting that the attempt was actually interrupted.
      coopReviveTimer = 0;
      coopReviveProgressSendAccum = 0;
      MP.sendCtrl({ t: "revProg", v: 0 });
    }
    // Shared fail condition — host is the sole authority on this to avoid
    // both sides racing to declare failure independently.
    if (MP.isHost() && player.down && player2.connected && player2.down && mp.coopWaveState !== "defeat" && mp.coopWaveState !== "victory") {
      mp.coopWaveState = "defeat";
      MP.sendCtrl({ t: "coopFail" });
      endCoopMatch(false);
    }
    updateCoopHud();
  }

  // Guests never run updateEnemies() in co-op (that would make them a
  // second, conflicting authority over enemy state) — but they still need
  // to take contact damage from the host-driven enemies they can see.
  function updateCoopGuestContact() {
    if (!(mp.active && mp.mode === "coop" && !MP.isHost()) || player.down) return;
    for (const e of level.enemies) {
      if (!e.alive) continue;
      if (aabb(player, e)) { damagePlayer(e.damage || ENEMY_TOUCH_DAMAGE, false); break; }
    }
  }

  function endCoopMatch(won) {
    if (!(mp.active && mp.mode === "coop")) return;
    mp.coopWaveState = won ? "victory" : "defeat";
    spawnFloatText(VW / 2, VH / 2, won ? "🏆 نجحتوا في كل الموجات!" : "😵 المهمة فشلت", won ? "#ffd166" : "#ff5c7a");
    vibrate(won ? [50, 60, 50, 60, 120] : [80, 100, 80]);
    const genAtEnd = levelGen;
    setTimeout(() => {
      if (genAtEnd !== levelGen) return;
      endMpSession(won ? "🏆 نجحتوا سوا! كل الموجات اتصفت" : "😵 المهمة فشلت - سقط اللاعبين كلهم");
    }, 2200);
  }

  function updateCoopHud() {
    const wrap = document.getElementById("coopHud");
    if (!wrap) return;
    if (!(mp.active && mp.mode === "coop")) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    const waveEl = document.getElementById("coopWaveText");
    const remEl = document.getElementById("coopEnemiesText");
    if (waveEl) waveEl.textContent = `🌊 الموجة ${mp.coopWave}/${mp.coopTotalWaves}`;
    if (remEl) remEl.textContent = `👾 متبقي: ${mp.coopEnemiesRemaining}`;
    const downedWrap = document.getElementById("coopDownWrap");
    if (downedWrap) {
      if (player.down) {
        downedWrap.classList.remove("hidden");
        const fill = document.getElementById("coopReviveFill");
        if (fill) fill.style.width = clamp(mp.coopReviveProgress, 0, 1) * 100 + "%";
      } else {
        downedWrap.classList.add("hidden");
      }
    }
  }

  // ---------------------------------------------------------
  // CO-OP — N PLAYERS (PHASE 3/4 expansion, up to 20) — the exact same
  // wave-survival design as the 2-player version above (same arena
  // builder, same wave compositions, same escalating-health enemies),
  // ported onto mp-room-net.js's host-relay star topology instead of
  // the 2-peer mp.js connection, so more than 2 people can play
  // together. Revive and the shared fail condition are the one real
  // behavior change: they loop over every connected remotePlayers
  // mirror instead of assuming a single player2.
  // ---------------------------------------------------------
  let coopSyncAccum = 0;

  function startRoomCoopMatch(info) {
    mp.mode = "coop";
    mp.coopTransport = "room";
    mp.active = true;
    mp.roomNetRoomRef = info.roomRef; mp.roomNetIsHost = !!info.isHost;
    mp.coopWave = 1;
    mp.coopTotalWaves = 5;
    mp.coopWaveState = "active";
    mp.coopReviveProgress = 0;
    coopReviveTimer = 0;
    coopReviveProgressSendAccum = 0;
    coopSyncAccum = 0;
    localPeerId = info.myId;
    ffaIsHost = !!info.isHost;
    remotePlayers = {};
    hostRoomRawStates = {};
    myFfaName = (info.roster[info.myId] && info.roster[info.myId].name) || "لاعب";
    myFfaTeam = null;

    const ids = Object.keys(info.roster).sort();
    const myIndex = ids.indexOf(info.myId);
    const playerCount = ids.length;
    level = buildCoopArena();
    if (playerCount > 2) level.length = Math.max(level.length, VW * (0.8 + playerCount * 0.35));
    const spawns = [];
    for (let i = 0; i < playerCount; i++) spawns.push(90 + (i * (level.length - 180)) / (Math.max(playerCount, 2) - 1 || 1));

    camera.x = 0;
    projectiles = []; shockwaves = []; particles = [];
    player.x = spawns[myIndex] !== undefined ? spawns[myIndex] : level.startX;
    player.y = level.startY;
    player.vx = 0; player.vy = 0; player.facing = 1;
    player.maxHealth = effMaxHealth(); player.health = player.maxHealth;
    player.maxEnergy = effMaxEnergy(); player.energy = player.maxEnergy;
    player.invuln = 1.2; player.down = false; player.activeCheckpoint = null;

    ids.forEach((id, idx) => {
      if (id === info.myId) return;
      const mirror = makeRemoteMirror((info.roster[id] && info.roster[id].name) || "لاعب", null);
      mirror.x = spawns[idx] !== undefined ? spawns[idx] : level.startX;
      mirror.y = level.startY; mirror.tx = mirror.x; mirror.ty = mirror.y;
      mirror.down = false;
      remotePlayers[id] = mirror;
    });

    updateHealthUI(); updateEnergyUI();
    state = STATE.PLAYING;
    showScreen(null);
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    spawnFloatText(VW / 2, 90, "تعاوني ضد الموجات 🤝", "#5cff8a");

    if (ffaIsHost) {
      MPRoomNet.hostInit(info.roomRef, info.myId);
      MPRoomNet.onPeerJoin(() => updateCoopHud());
      MPRoomNet.onPeerLeave((id) => {
        if (remotePlayers[id]) { remotePlayers[id].connected = false; remotePlayers[id].down = true; }
        delete hostRoomRawStates[id];
        updateCoopHud();
        checkRoomCoopWipe();
      });
      MPRoomNet.onPeerState((id, obj) => { hostRoomRawStates[id] = obj; });
      MPRoomNet.onPeerCtrl((id, obj) => { handleRoomCoopHostCtrl(id, obj); });
      MPRoomNet.hostConnectToAll(ids.filter((id) => id !== info.myId));
      startRoomCoopWave(1, playerCount);
    } else {
      level.enemies = [];
      MPRoomNet.guestInit(info.roomRef, info.myId);
      MPRoomNet.onHostState((obj) => applyRoomCoopWorldState(obj));
      MPRoomNet.onHostCtrl((obj) => handleRoomCoopGuestCtrl(obj));
      MPRoomNet.onHostConn((connState) => {
        if (connState === "lost") endMpSession("⚠️ الاتصال بالمستضيف انقطع");
      });
    }
    updateCoopHud();
  }

  function startRoomCoopWave(waveNum, playerCount) {
    if (!ffaIsHost) return;
    mp.coopWave = waveNum;
    mp.coopWaveState = "active";
    level.enemies = buildCoopWaveEnemies(waveNum, playerCount || (1 + Object.keys(remotePlayers).length));
    mp.coopEnemiesRemaining = level.enemies.length;
    MPRoomNet.hostBroadcastCtrl({ t: "waveStart", wave: waveNum, enemies: level.enemies.map(coopEnemySnapshot) });
    spawnFloatText(VW / 2, 90, `الموجة ${waveNum} / ${mp.coopTotalWaves}`, "#ffd166");
    vibrate(20);
    updateCoopHud();
  }

  function applyRoomCoopWorldState(obj) {
    if (!(mp.active && mp.mode === "coop" && mp.coopTransport === "room")) return;
    if (obj.players) {
      Object.keys(obj.players).forEach((id) => {
        if (id === localPeerId) return;
        const s = obj.players[id];
        let mirror = remotePlayers[id];
        if (!mirror) { mirror = makeRemoteMirror(s.name, null); remotePlayers[id] = mirror; }
        mirror.connected = true;
        mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
        mirror.facing = s.facing; mirror.health = s.health; mirror.maxHealth = s.maxHealth;
        mirror.down = !!s.down; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
        if (s.name) mirror.name = s.name;
      });
    }
    if (obj.enemies && level && level.enemies) {
      for (let k = 0; k < obj.enemies.length; k++) {
        if (level.enemies[k]) Object.assign(level.enemies[k], obj.enemies[k]);
        else level.enemies[k] = Object.assign({}, obj.enemies[k]);
      }
      mp.coopEnemiesRemaining = obj.remaining;
    }
    updateCoopHud();
  }

  function updateRoomCoopSync(dt) {
    if (!(mp.active && mp.mode === "coop" && mp.coopTransport === "room")) return;
    coopSyncAccum += dt;
    if (coopSyncAccum < roomSyncInterval()) return;
    coopSyncAccum = 0;
    const mySnap = {
      name: myFfaName, x: Math.round(player.x), y: Math.round(player.y), vx: Math.round(player.vx), vy: Math.round(player.vy),
      facing: player.facing, health: Math.round(player.health), maxHealth: player.maxHealth,
      down: player.down, blastFx: player.blastFx, invuln: player.invuln
    };
    if (ffaIsHost) {
      const players = Object.assign({}, hostRoomRawStates);
      players[localPeerId] = mySnap;
      const payload = { players };
      if (level.enemies) { payload.enemies = level.enemies.map(coopEnemySnapshot); payload.remaining = mp.coopEnemiesRemaining; }
      MPRoomNet.hostBroadcastState(payload);
      Object.keys(hostRoomRawStates).forEach((id) => {
        const s = hostRoomRawStates[id];
        let mirror = remotePlayers[id];
        if (!mirror) { mirror = makeRemoteMirror(s.name, null); remotePlayers[id] = mirror; }
        mirror.connected = true;
        mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
        mirror.facing = s.facing; mirror.health = s.health; mirror.maxHealth = s.maxHealth;
        mirror.down = !!s.down; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
        if (s.name) mirror.name = s.name;
      });
    } else {
      MPRoomNet.guestSendState(mySnap);
    }
    updateCoopHud();
  }

  function sendRoomCoopEnemyHit(i, dmg) {
    if (ffaIsHost) return;
    MPRoomNet.guestSendCtrl({ t: "enemyHit", i, dmg });
  }

  // Host-only: watches for a fully-cleared wave and advances the mission.
  function updateRoomCoopWaveProgress() {
    if (!(ffaIsHost && mp.active && mp.mode === "coop" && mp.coopTransport === "room" && mp.coopWaveState === "active")) return;
    const remaining = level.enemies.filter(e => e.alive).length;
    mp.coopEnemiesRemaining = remaining;
    if (remaining === 0 && level.enemies.length > 0) {
      mp.coopWaveState = "transition";
      const doneWave = mp.coopWave;
      MPRoomNet.hostBroadcastCtrl({ t: "waveCleared", wave: doneWave });
      spawnFloatText(VW / 2, VH / 2 - 40, `✅ الموجة ${doneWave} خلصت!`, "#5cff8a");
      const genAtClear = levelGen;
      setTimeout(() => {
        if (genAtClear !== levelGen || !(mp.active && mp.mode === "coop" && mp.coopTransport === "room")) return;
        if (doneWave >= mp.coopTotalWaves) {
          mp.coopWaveState = "victory";
          MPRoomNet.hostBroadcastCtrl({ t: "coopVictory" });
          endCoopMatch(true);
        } else {
          startRoomCoopWave(doneWave + 1, 1 + Object.keys(remotePlayers).length);
        }
      }, 1800);
    }
  }

  // Every frame: try to revive the NEAREST downed teammate within range
  // (loops over every connected remote player instead of the single
  // player2 the 2-player version above checks).
  function updateRoomCoopRevive(dt) {
    if (!(mp.active && mp.mode === "coop" && mp.coopTransport === "room")) return;
    if (player.down) {
      if (coopReviveTimer > 0) coopReviveTimer = 0;
    } else {
      let nearestId = null, nearestDist = Infinity;
      Object.keys(remotePlayers).forEach((id) => {
        const rp = remotePlayers[id];
        if (!rp.connected || !rp.down) return;
        const d = Math.hypot((player.x + player.w / 2) - (rp.x + PLAYER_W / 2), (player.y + player.h / 2) - (rp.y + PLAYER_H / 2));
        if (d < nearestDist) { nearestDist = d; nearestId = id; }
      });
      if (nearestId && nearestDist < COOP_REVIVE_RADIUS) {
        coopReviveTimer += dt;
        const prog = clamp(coopReviveTimer / COOP_REVIVE_TIME, 0, 1);
        coopReviveProgressSendAccum += dt;
        if (coopReviveProgressSendAccum > 0.15) {
          coopReviveProgressSendAccum = 0;
          if (ffaIsHost) MPRoomNet.hostSendCtrlTo(nearestId, { t: "revProg", v: prog });
          else MPRoomNet.guestSendCtrl({ t: "revProgReport", targetId: nearestId, v: prog });
        }
        if (coopReviveTimer >= COOP_REVIVE_TIME) {
          if (ffaIsHost) MPRoomNet.hostSendCtrlTo(nearestId, { t: "revived" });
          else MPRoomNet.guestSendCtrl({ t: "revivedReport", targetId: nearestId });
          coopReviveTimer = 0;
          const rp = remotePlayers[nearestId];
          spawnFloatText(rp.x + PLAYER_W / 2, rp.y - 20, "أنقذته! 🙌", "#5cff8a");
          vibrate([20, 30, 20]);
        }
      } else if (coopReviveTimer > 0) {
        coopReviveTimer = 0;
        coopReviveProgressSendAccum = 0;
      }
    }
    if (ffaIsHost) checkRoomCoopWipe();
    updateCoopHud();
  }

  function handleRoomCoopHostCtrl(fromId, obj) {
    if (!(mp.active && mp.mode === "coop" && mp.coopTransport === "room")) return;
    if (obj.t === "enemyHit") {
      const e = level.enemies && level.enemies[obj.i];
      if (e && e.alive) {
        e.health -= obj.dmg;
        e.hitFlash = 0.15;
        if (e.health <= 0) {
          e.health = 0; e.alive = false;
          spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#ff9142", 16, 220, 0.5);
          registerKill(SCORE_ENEMY, e.x + e.w / 2, e.y, "#ff9142");
        }
      }
    } else if (obj.t === "revProgReport") {
      // relay a guest-to-guest revive-progress ping through the host
      if (obj.targetId === localPeerId) mp.coopReviveProgress = obj.v;
      else MPRoomNet.hostSendCtrlTo(obj.targetId, { t: "revProg", v: obj.v });
    } else if (obj.t === "revivedReport") {
      if (obj.targetId === localPeerId) applyRoomCoopRevive();
      else MPRoomNet.hostSendCtrlTo(obj.targetId, { t: "revived" });
    }
  }

  function handleRoomCoopGuestCtrl(obj) {
    if (!(mp.active && mp.mode === "coop" && mp.coopTransport === "room")) return;
    if (obj.t === "waveStart") {
      mp.coopWave = obj.wave;
      mp.coopWaveState = "active";
      level.enemies = obj.enemies.map(e => Object.assign({}, e));
      mp.coopEnemiesRemaining = level.enemies.filter(e => e.alive).length;
      spawnFloatText(VW / 2, 90, `الموجة ${obj.wave} / ${mp.coopTotalWaves}`, "#ffd166");
      vibrate(20);
      updateCoopHud();
    } else if (obj.t === "waveCleared") {
      spawnFloatText(VW / 2, VH / 2 - 40, `✅ الموجة ${obj.wave} خلصت!`, "#5cff8a");
    } else if (obj.t === "revProg") {
      mp.coopReviveProgress = obj.v;
    } else if (obj.t === "revived") {
      applyRoomCoopRevive();
    } else if (obj.t === "coopVictory") {
      endCoopMatch(true);
    } else if (obj.t === "coopFail") {
      endCoopMatch(false);
    }
  }

  function applyRoomCoopRevive() {
    if (!player.down) return;
    player.down = false;
    player.health = Math.round(player.maxHealth * 0.4);
    player.invuln = 1.2;
    mp.coopReviveProgress = 0;
    spawnFloatText(player.x + player.w / 2, player.y - 30, "تم إنقاذك! 🙌", "#5cff8a");
    vibrate([30, 40, 30]);
  }

  // Host-only shared fail condition: every connected player is down.
  function checkRoomCoopWipe() {
    if (!(ffaIsHost && mp.active && mp.mode === "coop" && mp.coopTransport === "room" && mp.coopWaveState !== "defeat" && mp.coopWaveState !== "victory")) return;
    const totalKnown = 1 + Object.keys(remotePlayers).length;
    if (totalKnown <= 1) return;
    const anyoneUp = !player.down || Object.values(remotePlayers).some(rp => rp.connected && !rp.down);
    if (!anyoneUp) {
      mp.coopWaveState = "defeat";
      MPRoomNet.hostBroadcastCtrl({ t: "coopFail" });
      endCoopMatch(false);
    }
  }

  // Guests never run updateEnemies() in the N-player co-op either — same
  // reasoning as the 2-player version's updateCoopGuestContact() above.
  function updateRoomCoopGuestContact() {
    if (!(mp.active && mp.mode === "coop" && mp.coopTransport === "room" && !ffaIsHost) || player.down) return;
    for (const e of level.enemies) {
      if (!e.alive) continue;
      if (aabb(player, e)) { damagePlayer(e.damage || ENEMY_TOUCH_DAMAGE, false); break; }
    }
  }


  // host-relay star topology. Team mode reuses this same skeleton with
  // one extra layer (team assignment + friendly-fire check + team-based
  // win condition) instead of being a separate system.
  //
  // Guests can't talk to each other directly in a star topology, so the
  // HOST is the relay for both world-state (positions/health) AND combat
  // (a guest who lands a hit tells the host, the host either applies it
  // directly if it owns the target, or forwards it to whichever guest
  // does) — the same "each side is authoritative over its own health"
  // rule Duel already uses, just relayed through one extra hop.
  // ---------------------------------------------------------
  function makeRemoteMirror(name, team) {
    return {
      name: name || "لاعب", team: team || null,
      x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, facing: 1,
      health: 100, maxHealth: 100, alive: true, connected: false,
      blastFx: 0, invuln: 0
    };
  }

  function buildRoomArena(n) {
    const length = Math.max(VW * 1.4, VW * (0.55 + n * 0.32));
    const segs = Math.max(n, 2);
    const spawns = [];
    for (let i = 0; i < segs; i++) spawns.push(90 + (i * (length - 180)) / (segs - 1 || 1));
    return {
      length, startX: spawns[0], startY: GROUND_Y - PLAYER_H, spawns,
      platforms: [
        { x: 0, y: GROUND_Y, w: length, h: 200, type: "ground" },
        { x: length * 0.33 - 70, y: GROUND_Y - 150, w: 140, h: 22, type: "static" },
        { x: length * 0.66 - 70, y: GROUND_Y - 220, w: 140, h: 22, type: "static" }
      ],
      movers: [], traps: [], enemies: [], gems: [], totalGems: 0,
      powerups: [], goal: null, boss: null, checkpoints: [],
      theme: { hue: 5, name: "حلبة المواجهة" }
    };
  }

  // info = { roomRef, myId, isHost, roster: {id: {name}}, mode: "ffa"|"team" }
  function startRoomPvpMatch(info) {
    mp.mode = info.mode; // "ffa" or "team"
    mp.active = true;
    mp.roomNetRoomRef = info.roomRef; mp.roomNetIsHost = !!info.isHost;
    if (DEBUG) debugRoomId = (info.roomRef && info.roomRef.key) || null;
    mp.ffaAlive = true;
    mp.ffaOver = false;
    localPeerId = info.myId;
    ffaIsHost = !!info.isHost;
    remotePlayers = {};
    hostRoomRawStates = {};
    ffaSyncAccum = 0;
    myFfaName = (info.roster[info.myId] && info.roster[info.myId].name) || "لاعب";

    const ids = Object.keys(info.roster).sort();
    // Team assignment: deterministic from the SAME sorted roster every
    // client already has (via Firebase), so no extra network round-trip
    // is needed for everyone to agree on who's on which team.
    const teamOf = {};
    if (info.mode === "team") ids.forEach((id, i) => { teamOf[id] = (i % 2 === 0) ? "A" : "B"; });
    myFfaTeam = info.mode === "team" ? teamOf[info.myId] : null;

    // BUGFIX (Team spawn locations): spawn slots used to be handed out in
    // plain sorted-id order, which — combined with the A/B/A/B team
    // assignment right above — interleaved the two teams along the arena
    // (A,B,A,B,...) instead of grouping them. Every player landed right
    // next to an enemy at the whistle, and never near their own teammate.
    // For Team mode, sort by team first so team A gets the first
    // contiguous block of spawn slots and team B gets the rest; FFA has
    // no teams, so its order is untouched.
    const spawnOrderIds = info.mode === "team"
      ? ids.slice().sort((a, b) => {
          if (teamOf[a] !== teamOf[b]) return teamOf[a] < teamOf[b] ? -1 : 1;
          return a < b ? -1 : 1;
        })
      : ids;
    const myIndex = spawnOrderIds.indexOf(info.myId);

    level = buildRoomArena(ids.length);
    camera.x = 0;
    projectiles = []; shockwaves = []; particles = [];
    player.x = level.spawns[myIndex] !== undefined ? level.spawns[myIndex] : level.startX;
    player.y = level.startY;
    player.vx = 0; player.vy = 0; player.facing = 1;
    player.maxHealth = effMaxHealth(); player.health = player.maxHealth;
    player.maxEnergy = effMaxEnergy(); player.energy = player.maxEnergy;
    player.invuln = 1.2; player.down = false; player.activeCheckpoint = null;

    ids.forEach((id) => {
      if (id === info.myId) return;
      const spawnIdx = spawnOrderIds.indexOf(id);
      const mirror = makeRemoteMirror((info.roster[id] && info.roster[id].name) || "لاعب", teamOf[id] || null);
      mirror.x = level.spawns[spawnIdx] !== undefined ? level.spawns[spawnIdx] : level.startX;
      mirror.y = level.startY; mirror.tx = mirror.x; mirror.ty = mirror.y;
      remotePlayers[id] = mirror;
    });


    updateHealthUI(); updateEnergyUI();
    state = STATE.PLAYING;
    showScreen(null);
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    spawnFloatText(VW / 2, 90, info.mode === "team" ? "فريق × فريق 🛡️" : "الكل ضد الكل ⚔️", "#ff8a3d");

    if (ffaIsHost) {
      MPRoomNet.hostInit(info.roomRef, info.myId);
      MPRoomNet.onPeerJoin(() => updateFfaHud());
      MPRoomNet.onPeerLeave((id) => {
        if (remotePlayers[id]) { remotePlayers[id].connected = false; remotePlayers[id].alive = false; }
        delete hostRoomRawStates[id];
        updateFfaHud();
        checkFfaWinCondition();
      });
      MPRoomNet.onPeerState((id, obj) => { hostRoomRawStates[id] = obj; });
      MPRoomNet.onPeerCtrl((id, obj) => { handleFfaHostCtrl(id, obj); });
      MPRoomNet.hostConnectToAll(ids.filter((id) => id !== info.myId));
    } else {
      MPRoomNet.guestInit(info.roomRef, info.myId);
      MPRoomNet.onHostState((obj) => applyFfaWorldState(obj));
      MPRoomNet.onHostCtrl((obj) => handleFfaGuestCtrl(obj));
      MPRoomNet.onHostConn((connState) => {
        if (connState === "lost") endMpSession("⚠️ الاتصال بالمستضيف انقطع");
      });
    }
    updateFfaHud();
  }

  function applyFfaWorldState(obj) {
    if (!(mp.active && (mp.mode === "ffa" || mp.mode === "team")) || !obj.players) return;
    Object.keys(obj.players).forEach((id) => {
      if (id === localPeerId) return;
      const s = obj.players[id];
      let mirror = remotePlayers[id];
      if (!mirror) { mirror = makeRemoteMirror(s.name, s.team); remotePlayers[id] = mirror; }
      mirror.connected = true;
      mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
      mirror.facing = s.facing; mirror.health = s.health; mirror.maxHealth = s.maxHealth;
      mirror.alive = s.alive; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
      if (s.name) mirror.name = s.name;
      if (s.team) mirror.team = s.team;
    });
    updateFfaHud();
  }

  function updateFfaSync(dt) {
    if (!(mp.active && (mp.mode === "ffa" || mp.mode === "team"))) return;
    ffaSyncAccum += dt;
    if (ffaSyncAccum < roomSyncInterval()) return;
    ffaSyncAccum = 0;
    const mySnap = {
      name: myFfaName, team: myFfaTeam, x: Math.round(player.x), y: Math.round(player.y), vx: Math.round(player.vx), vy: Math.round(player.vy),
      facing: player.facing, health: Math.round(player.health), maxHealth: player.maxHealth,
      alive: mp.ffaAlive, blastFx: player.blastFx, invuln: player.invuln
    };
    if (ffaIsHost) {
      const players = Object.assign({}, hostRoomRawStates);
      players[localPeerId] = mySnap;
      MPRoomNet.hostBroadcastState({ players });
      Object.keys(hostRoomRawStates).forEach((id) => {
        const s = hostRoomRawStates[id];
        let mirror = remotePlayers[id];
        if (!mirror) { mirror = makeRemoteMirror(s.name, s.team); remotePlayers[id] = mirror; }
        mirror.connected = true;
        mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
        mirror.facing = s.facing; mirror.health = s.health; mirror.maxHealth = s.maxHealth;
        mirror.alive = s.alive; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
        if (s.name) mirror.name = s.name;
      });
      checkFfaWinCondition();
    } else {
      MPRoomNet.guestSendState(mySnap);
    }
    updateFfaHud();
  }

  function sendFfaHit(targetId, dmg) {
    if (ffaIsHost) MPRoomNet.hostSendCtrlTo(targetId, { t: "hit", dmg });
    else MPRoomNet.guestSendCtrl({ t: "hitReport", targetId, dmg });
  }

  function handleFfaHostCtrl(fromId, obj) {
    if (!(mp.active && (mp.mode === "ffa" || mp.mode === "team"))) return;
    if (obj.t === "hitReport") {
      if (obj.targetId === localPeerId) {
        if (mp.ffaAlive) damagePlayer(obj.dmg, false);
      } else {
        MPRoomNet.hostSendCtrlTo(obj.targetId, { t: "hit", dmg: obj.dmg });
      }
    }
  }

  function handleFfaGuestCtrl(obj) {
    if (!(mp.active && (mp.mode === "ffa" || mp.mode === "team"))) return;
    if (obj.t === "hit") {
      if (mp.ffaAlive) damagePlayer(obj.dmg, false);
    } else if (obj.t === "ffaEnd") {
      endFfaMatch(obj.winnerId, obj.winnerName, obj.winnerTeam);
    }
  }

  function eliminateFfaPlayer() {
    mp.ffaAlive = false;
    player.vx = 0; player.vy = 0; player.invuln = 999;
    spawnFloatText(player.x + player.w / 2, player.y - 20, "تم إقصاؤك 💀", "#ff5c7a");
    vibrate([80, 80, 80]);
    updateFfaHud();
    updateBossRushHud();
    if (ffaIsHost) {
      if (mp.mode === "bossrush") checkBossRushWipe();
      else checkFfaWinCondition();
    }
  }

  // Host-only authority: decides when the match is over. FFA = last
  // player standing; Team = last team with anyone still alive.
  function checkFfaWinCondition() {
    if (!(ffaIsHost && mp.active && (mp.mode === "ffa" || mp.mode === "team") && !mp.ffaOver)) return;
    const totalKnown = 1 + Object.keys(remotePlayers).length;
    if (totalKnown <= 1) return; // still waiting for peers to connect
    if (mp.mode === "team") {
      const aliveTeams = new Set();
      if (mp.ffaAlive) aliveTeams.add(myFfaTeam);
      Object.values(remotePlayers).forEach((rp) => { if (rp.alive && rp.connected) aliveTeams.add(rp.team); });
      if (aliveTeams.size <= 1) {
        mp.ffaOver = true;
        const winnerTeam = [...aliveTeams][0] || null;
        MPRoomNet.hostBroadcastCtrl({ t: "ffaEnd", winnerTeam });
        endFfaMatch(null, null, winnerTeam);
      }
    } else {
      const aliveIds = [];
      if (mp.ffaAlive) aliveIds.push(localPeerId);
      Object.keys(remotePlayers).forEach((id) => { if (remotePlayers[id].alive && remotePlayers[id].connected) aliveIds.push(id); });
      if (aliveIds.length <= 1) {
        mp.ffaOver = true;
        const winnerId = aliveIds[0] || null;
        const winnerName = winnerId === localPeerId ? myFfaName : (winnerId && remotePlayers[winnerId] ? remotePlayers[winnerId].name : null);
        MPRoomNet.hostBroadcastCtrl({ t: "ffaEnd", winnerId, winnerName });
        endFfaMatch(winnerId, winnerName, null);
      }
    }
  }

  function endFfaMatch(winnerId, winnerName, winnerTeam) {
    if (!(mp.active && (mp.mode === "ffa" || mp.mode === "team"))) return;
    mp.ffaOver = true;
    let msg, color;
    if (mp.mode === "team") {
      const iWon = winnerTeam && winnerTeam === myFfaTeam;
      msg = winnerTeam ? (iWon ? "🏆 فريقك فاز!" : `🏆 فريق ${winnerTeam} فاز!`) : "🏁 خلصت الجولة";
      color = iWon ? "#ffd166" : "#eaf6ff";
    } else {
      const iWon = winnerId === localPeerId;
      msg = iWon ? "🏆 انت الفايز!" : (winnerName ? `🏆 ${winnerName} فاز!` : "🏁 خلصت الجولة");
      color = iWon ? "#ffd166" : "#eaf6ff";
    }
    spawnFloatText(VW / 2, VH / 2, msg, color);
    vibrate(color === "#ffd166" ? [50, 60, 50, 60, 120] : [60, 60]);
    const genAtEnd = levelGen;
    setTimeout(() => {
      if (genAtEnd !== levelGen) return;
      endMpSession(msg);
    }, 2200);
  }

  function updateFfaHud() {
    const wrap = document.getElementById("ffaHud");
    if (!wrap) return;
    if (!(mp.active && (mp.mode === "ffa" || mp.mode === "team"))) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    const aliveCount = (mp.ffaAlive ? 1 : 0) + Object.values(remotePlayers).filter((rp) => rp.alive && rp.connected).length;
    const totalCount = 1 + Object.keys(remotePlayers).length;
    const line = document.getElementById("ffaAliveText");
    if (line) {
      if (mp.mode === "team") {
        const aTeam = (mp.ffaAlive && myFfaTeam === "A" ? 1 : 0) + Object.values(remotePlayers).filter(rp => rp.team === "A" && rp.alive && rp.connected).length;
        const bTeam = (mp.ffaAlive && myFfaTeam === "B" ? 1 : 0) + Object.values(remotePlayers).filter(rp => rp.team === "B" && rp.alive && rp.connected).length;
        line.textContent = `🛡️ فريقي (${myFfaTeam}) — A:${aTeam} B:${bTeam}`;
      } else {
        line.textContent = `⚔️ الباقيين: ${aliveCount}/${totalCount}`;
      }
    }
  }

  // ===========================================================
  // PHASE 7 — HUNTED MODE
  // One real player = Hunter (visible, faster, no stealth — that
  // visibility IS the telegraph). Everyone else = Runner. Runners win by
  // surviving HUNTED_SURVIVAL_TIME; Hunter wins by eliminating every
  // Runner first. Host is the sole authority on the timer, escalation and
  // catches, exactly like FFA's win-condition authority above.
  // ===========================================================
  function startRoomHuntedMatch(info) {
    mp.mode = "hunted";
    mp.active = true;
    mp.roomNetRoomRef = info.roomRef; mp.roomNetIsHost = !!info.isHost;
    if (DEBUG) debugRoomId = (info.roomRef && info.roomRef.key) || null;
    mp.huntedOver = false;
    mp.huntedTimeLeft = HUNTED_SURVIVAL_TIME;
    mp.huntedEscalation = 0;
    mp.ffaAlive = true; // reused as "still in the round" (catch = eliminated, same as FFA)
    localPeerId = info.myId;
    ffaIsHost = !!info.isHost;
    remotePlayers = {};
    hostRoomRawStates = {};
    ffaSyncAccum = 0;
    myFfaName = (info.roster[info.myId] && info.roster[info.myId].name) || "لاعب";
    myFfaTeam = null;

    // Deterministic Hunter pick: same sorted roster everyone already has,
    // no extra round-trip needed to agree on who it is.
    const ids = Object.keys(info.roster).sort();
    mp.huntedHunterId = ids[0];
    mp.huntedRole = (info.myId === mp.huntedHunterId) ? "hunter" : "runner";

    level = buildRoomArena(ids.length);
    camera.x = 0;
    projectiles = []; shockwaves = []; particles = [];
    const myIndex = ids.indexOf(info.myId);
    player.x = level.spawns[myIndex] !== undefined ? level.spawns[myIndex] : level.startX;
    player.y = level.startY;
    player.vx = 0; player.vy = 0; player.facing = 1;
    player.maxHealth = effMaxHealth(); player.health = player.maxHealth;
    player.maxEnergy = effMaxEnergy(); player.energy = player.maxEnergy;
    player.invuln = 1.2; player.down = false; player.activeCheckpoint = null;

    ids.forEach((id) => {
      if (id === info.myId) return;
      const spawnIdx = ids.indexOf(id);
      const mirror = makeRemoteMirror((info.roster[id] && info.roster[id].name) || "لاعب", null);
      mirror.x = level.spawns[spawnIdx] !== undefined ? level.spawns[spawnIdx] : level.startX;
      mirror.y = level.startY; mirror.tx = mirror.x; mirror.ty = mirror.y;
      mirror.isHunter = (id === mp.huntedHunterId);
      remotePlayers[id] = mirror;
    });

    updateHealthUI(); updateEnergyUI();
    state = STATE.PLAYING;
    showScreen(null);
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    spawnFloatText(VW / 2, 90, mp.huntedRole === "hunter" ? "🎯 انت الصياد!" : "🏃 اهرب من الصياد!",
      mp.huntedRole === "hunter" ? "#ff5c7a" : "#5cff8a");

    if (ffaIsHost) {
      MPRoomNet.hostInit(info.roomRef, info.myId);
      MPRoomNet.onPeerJoin(() => updateHuntedHud());
      MPRoomNet.onPeerLeave((id) => {
        if (remotePlayers[id]) { remotePlayers[id].connected = false; remotePlayers[id].alive = false; }
        delete hostRoomRawStates[id];
        updateHuntedHud();
        checkHuntedWinCondition();
      });
      MPRoomNet.onPeerState((id, obj) => { hostRoomRawStates[id] = obj; });
      MPRoomNet.onPeerCtrl((id, obj) => { handleHuntedHostCtrl(id, obj); });
      MPRoomNet.hostConnectToAll(ids.filter((id) => id !== info.myId));
    } else {
      MPRoomNet.guestInit(info.roomRef, info.myId);
      MPRoomNet.onHostState((obj) => applyHuntedWorldState(obj));
      MPRoomNet.onHostCtrl((obj) => handleHuntedGuestCtrl(obj));
      MPRoomNet.onHostConn((connState) => {
        if (connState === "lost") endMpSession("⚠️ الاتصال بالمستضيف انقطع");
      });
    }
    updateHuntedHud();
  }

  function applyHuntedWorldState(obj) {
    if (!(mp.active && mp.mode === "hunted")) return;
    if (typeof obj.timeLeft === "number") mp.huntedTimeLeft = obj.timeLeft;
    if (typeof obj.escalation === "number" && obj.escalation > mp.huntedEscalation) mp.huntedEscalation = obj.escalation;
    if (!obj.players) { updateHuntedHud(); return; }
    Object.keys(obj.players).forEach((id) => {
      if (id === localPeerId) return;
      const s = obj.players[id];
      let mirror = remotePlayers[id];
      if (!mirror) { mirror = makeRemoteMirror(s.name, null); mirror.isHunter = (id === mp.huntedHunterId); remotePlayers[id] = mirror; }
      mirror.connected = true;
      mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
      mirror.facing = s.facing; mirror.alive = s.alive; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
      if (s.name) mirror.name = s.name;
    });
    updateHuntedHud();
  }

  function updateHuntedSync(dt) {
    if (!(mp.active && mp.mode === "hunted")) return;
    if (ffaIsHost && !mp.huntedOver) {
      mp.huntedTimeLeft = Math.max(0, mp.huntedTimeLeft - dt);
      checkHuntedEscalation();
    }
    ffaSyncAccum += dt;
    if (ffaSyncAccum < roomSyncInterval()) return;
    ffaSyncAccum = 0;
    const mySnap = {
      name: myFfaName, x: Math.round(player.x), y: Math.round(player.y), vx: Math.round(player.vx), vy: Math.round(player.vy),
      facing: player.facing, alive: mp.ffaAlive, blastFx: player.blastFx, invuln: player.invuln
    };
    if (ffaIsHost) {
      const players = Object.assign({}, hostRoomRawStates);
      players[localPeerId] = mySnap;
      MPRoomNet.hostBroadcastState({ players, timeLeft: mp.huntedTimeLeft, escalation: mp.huntedEscalation });
      Object.keys(hostRoomRawStates).forEach((id) => {
        const s = hostRoomRawStates[id];
        let mirror = remotePlayers[id];
        if (!mirror) { mirror = makeRemoteMirror(s.name, null); mirror.isHunter = (id === mp.huntedHunterId); remotePlayers[id] = mirror; }
        mirror.connected = true;
        mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
        mirror.facing = s.facing; mirror.alive = s.alive; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
        if (s.name) mirror.name = s.name;
      });
      checkHuntedContacts();
      checkHuntedWinCondition();
    } else {
      MPRoomNet.guestSendState(mySnap);
    }
    updateHuntedHud();
  }

  // Host-only: every HUNTED_ESCALATION_INTERVAL seconds of time REMAINING
  // that ticks past, bump the Hunter's speed — announced to everyone the
  // instant it happens, so it's never a silent/unfair surprise.
  function checkHuntedEscalation() {
    const elapsed = HUNTED_SURVIVAL_TIME - mp.huntedTimeLeft;
    const dueLevel = Math.floor(elapsed / HUNTED_ESCALATION_INTERVAL);
    if (dueLevel > mp.huntedEscalation) {
      mp.huntedEscalation = dueLevel;
      MPRoomNet.hostBroadcastCtrl({ t: "huntedEscalate", level: dueLevel });
      spawnFloatText(VW / 2, 120, "🎯 الصياد بقى أسرع!", "#ff5c7a");
      vibrate([60, 40, 60]);
    }
  }

  // Host-only: AABB contact between the Hunter and any still-alive Runner
  // eliminates that Runner. Simple, visible, unambiguous — no gradual
  // "damage without a clear reason" the spec warns against.
  function checkHuntedContacts() {
    if (!(ffaIsHost && mp.active && mp.mode === "hunted" && !mp.huntedOver)) return;
    const hunterBox = (mp.huntedRole === "hunter")
      ? { x: player.x, y: player.y, w: player.w, h: player.h, alive: mp.ffaAlive }
      : (() => { const h = remotePlayers[mp.huntedHunterId]; return h ? { x: h.tx, y: h.ty, w: PLAYER_W, h: PLAYER_H, alive: h.alive && h.connected } : null; })();
    if (!hunterBox || !hunterBox.alive) return;

    const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    if (mp.huntedRole === "runner" && mp.ffaAlive) {
      if (overlaps(hunterBox, { x: player.x, y: player.y, w: player.w, h: player.h })) {
        eliminateFfaPlayer();
        spawnFloatText(player.x + player.w / 2, player.y - 20, "🎯 امسكك الصياد!", "#ff5c7a");
      }
    }
    Object.keys(remotePlayers).forEach((id) => {
      if (id === mp.huntedHunterId) return;
      const rp = remotePlayers[id];
      if (!rp.alive || !rp.connected) return;
      if (overlaps(hunterBox, { x: rp.tx, y: rp.ty, w: PLAYER_W, h: PLAYER_H })) {
        rp.alive = false;
        MPRoomNet.hostSendCtrlTo(id, { t: "huntedCaught" });
      }
    });
  }

  function handleHuntedHostCtrl(fromId, obj) {
    if (!(mp.active && mp.mode === "hunted")) return;
    // Runners never deal damage in Hunted mode, so there's nothing to
    // relay here besides what checkHuntedContacts already resolves —
    // kept as a named handler (rather than omitted) so MPRoomNet.onPeerCtrl
    // always has a defined target, matching the other room modes.
  }

  function handleHuntedGuestCtrl(obj) {
    if (!(mp.active && mp.mode === "hunted")) return;
    if (obj.t === "huntedCaught") {
      if (mp.ffaAlive) eliminateFfaPlayer();
    } else if (obj.t === "huntedEscalate") {
      if (obj.level > mp.huntedEscalation) {
        mp.huntedEscalation = obj.level;
        spawnFloatText(VW / 2, 120, "🎯 الصياد بقى أسرع!", "#ff5c7a");
        vibrate([60, 40, 60]);
      }
    } else if (obj.t === "huntedEnd") {
      endHuntedMatch(obj.hunterWon, obj.hunterLeft);
    }
  }

  // Host-only authority, mirrors checkFfaWinCondition's shape.
  function checkHuntedWinCondition() {
    if (!(ffaIsHost && mp.active && mp.mode === "hunted" && !mp.huntedOver)) return;
    const totalKnown = 1 + Object.keys(remotePlayers).length;
    if (totalKnown <= 1) return; // still waiting for peers to connect
    // If the Hunter itself disconnects, nobody can be caught anymore —
    // end the round in the Runners' favor right away instead of making
    // everyone sit out the rest of the timer against a match that can no
    // longer be lost.
    const hunterStillIn = (mp.huntedRole === "hunter")
      || (remotePlayers[mp.huntedHunterId] && remotePlayers[mp.huntedHunterId].connected);
    if (!hunterStillIn) {
      mp.huntedOver = true;
      MPRoomNet.hostBroadcastCtrl({ t: "huntedEnd", hunterWon: false, hunterLeft: true });
      endHuntedMatch(false, true);
      return;
    }
    const runnersAlive = (mp.huntedRole === "runner" && mp.ffaAlive ? 1 : 0)
      + Object.keys(remotePlayers).filter((id) => id !== mp.huntedHunterId && remotePlayers[id].alive && remotePlayers[id].connected).length;
    if (runnersAlive <= 0) {
      mp.huntedOver = true;
      MPRoomNet.hostBroadcastCtrl({ t: "huntedEnd", hunterWon: true });
      endHuntedMatch(true);
    } else if (mp.huntedTimeLeft <= 0) {
      mp.huntedOver = true;
      MPRoomNet.hostBroadcastCtrl({ t: "huntedEnd", hunterWon: false });
      endHuntedMatch(false);
    }
  }

  function endHuntedMatch(hunterWon, hunterLeft) {
    if (!(mp.active && mp.mode === "hunted")) return;
    mp.huntedOver = true;
    const iAmHunter = mp.huntedRole === "hunter";
    const iWon = hunterWon === iAmHunter;
    const msg = hunterLeft
      ? "🚪 الصياد انسحب — نجى الجميع!"
      : hunterWon
      ? (iAmHunter ? "🏆 مسكت كل اللاعبين! فزت!" : "💀 الصياد مسك الكل")
      : (iAmHunter ? "⏰ خلص الوقت... اللاعبين نجوا" : "🏆 نجيت من الصياد!");
    spawnFloatText(VW / 2, VH / 2, msg, (hunterLeft || !iAmHunter) ? "#eaf6ff" : (iWon ? "#ffd166" : "#eaf6ff"));
    vibrate(!hunterLeft && iWon ? [50, 60, 50, 60, 120] : [60, 60]);
    const genAtEnd = levelGen;
    setTimeout(() => {
      if (genAtEnd !== levelGen) return;
      endMpSession(msg);
    }, 2200);
  }

  function updateHuntedHud() {
    const wrap = document.getElementById("huntedHud");
    if (!wrap) return;
    if (!(mp.active && mp.mode === "hunted")) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    const runnersAlive = (mp.huntedRole === "runner" && mp.ffaAlive ? 1 : 0)
      + Object.values(remotePlayers).filter((rp) => !rp.isHunter && rp.alive && rp.connected).length;
    const mins = Math.floor(mp.huntedTimeLeft / 60);
    const secs = Math.floor(mp.huntedTimeLeft % 60).toString().padStart(2, "0");
    const line = document.getElementById("huntedStatusText");
    if (line) {
      line.textContent = mp.huntedRole === "hunter"
        ? `🎯 انت الصياد — الباقيين: ${runnersAlive} — ⏱️ ${mins}:${secs}`
        : `🏃 اهرب — الباقيين: ${runnersAlive} — ⏱️ ${mins}:${secs}`;
    }
  }

  // Contact/pursuit damage between players isn't a thing here — only
  // blast/bullet hits — so, unlike co-op, FFA/Team never call
  // updateEnemies() at all (buildRoomArena() always has an empty
  // enemies array; nothing to simulate).
  function drawRemotePlayers() {
    Object.keys(remotePlayers).forEach((id) => {
      const rp = remotePlayers[id];
      if (!rp.connected) return;
      rp.x += (rp.tx - rp.x) * 0.35;
      rp.y += (rp.ty - rp.y) * 0.35;
      const sx = rp.x - camera.x;
      if (sx < -60 || sx > VW + 60) return;
      ctx.save();
      const isDown = !!rp.down; // co-op only — FFA/Team/Hunted use rp.alive instead
      if (!rp.alive || isDown) ctx.globalAlpha = 0.35;
      const isHunted = mp.active && mp.mode === "hunted";
      const color = isHunted ? (rp.isHunter ? "#ff5c7a" : "#5cff8a") : (mp.mode === "team" ? (rp.team === "A" ? "#2fe0ff" : "#ff8a3d") : "#ff5c7a");
      if (isHunted && rp.isHunter && rp.alive) {
        const pulse = 6 + Math.sin(performance.now() / 150) * 3;
        ctx.strokeStyle = "rgba(255,92,122,0.85)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx + PLAYER_W / 2, rp.y + PLAYER_H / 2, PLAYER_W / 2 + pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.fillRect(sx, rp.y, PLAYER_W, PLAYER_H);
      ctx.fillStyle = "#1a0a0a";
      ctx.fillRect(sx + (rp.facing > 0 ? PLAYER_W - 10 : 2), rp.y + 8, 8, 8);
      ctx.fillStyle = "#eaf6ff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText((!rp.alive ? "💀 " : isDown ? "🆘 " : "") + rp.name, sx + PLAYER_W / 2, rp.y - 8);
      // tiny health sliver above the name tag — Hunted mode has no health
      // concept (contact = eliminated), so it's skipped there.
      if (!isHunted) {
        const hpw = 34;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(sx + PLAYER_W / 2 - hpw / 2, rp.y - 20, hpw, 4);
        ctx.fillStyle = color;
        ctx.fillRect(sx + PLAYER_W / 2 - hpw / 2, rp.y - 20, hpw * clamp(rp.health / (rp.maxHealth || 100), 0, 1), 4);
      }
      ctx.restore();
    });
  }

  // ---------------------------------------------------------
  // RACE MODE (PHASE 5) — up to 20 players, ONE shared seeded level
  // (host picks seed + level, both written to Firebase before start —
  // see mp-lobby.js), no combat, no shared enemies. Host is authority
  // over finish order (guests report "I finished", host assigns rank
  // and rebroadcasts the standing list) — same host-relay star topology
  // as FFA/Team via mp-room-net.js, just a different payload.
  // ---------------------------------------------------------
  // info = { roomRef, myId, isHost, roster: {id:{name}}, mode:"race", raceSeed, raceLevel }
  function startRoomRaceMatch(info) {
    mp.mode = "race";
    mp.active = true;
    mp.roomNetRoomRef = info.roomRef; mp.roomNetIsHost = !!info.isHost;
    if (DEBUG) { debugRoomId = (info.roomRef && info.roomRef.key) || null; debugLevelSeed = info.raceSeed; }
    mp.raceFinished = false;
    mp.raceOver = false;
    mp.raceMyRank = null;
    mp.raceOrder = [];
    localPeerId = info.myId;
    ffaIsHost = !!info.isHost;
    remotePlayers = {};
    hostRoomRawStates = {};
    raceSyncAccum = 0;
    raceFirstFinishAt = 0;
    myFfaName = (info.roster[info.myId] && info.roster[info.myId].name) || "لاعب";
    myFfaTeam = null;

    const ids = Object.keys(info.roster).sort();

    // Same seed + same level number for every client (PHASE 9): nobody
    // calls Math.random() here, so all clients build an identical layout.
    level = buildValidatedRaceLevel(info.raceLevel, info.raceSeed >>> 0);
    level.enemies = []; // pure movement race — no shared-enemy sync needed
    level.boss = null;

    camera.x = 0;
    projectiles = []; shockwaves = []; particles = [];
    player.x = level.startX; player.y = level.startY;
    player.vx = 0; player.vy = 0; player.facing = 1;
    player.maxHealth = effMaxHealth(); player.health = player.maxHealth;
    player.maxEnergy = effMaxEnergy(); player.energy = player.maxEnergy;
    player.invuln = 1.2; player.down = false; player.activeCheckpoint = null;

    ids.forEach((id) => {
      if (id === info.myId) return;
      const mirror = makeRemoteMirror((info.roster[id] && info.roster[id].name) || "لاعب", null);
      mirror.x = level.startX; mirror.y = level.startY; mirror.tx = mirror.x; mirror.ty = mirror.y;
      remotePlayers[id] = mirror;
    });

    updateHealthUI(); updateEnergyUI();
    state = STATE.PLAYING;
    showScreen(null);
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    spawnFloatText(VW / 2, 90, "سباق 🏁 - يلا بينا!", "#ffd166");

    if (ffaIsHost) {
      MPRoomNet.hostInit(info.roomRef, info.myId);
      MPRoomNet.onPeerJoin(() => updateRaceHud());
      MPRoomNet.onPeerLeave((id) => {
        if (remotePlayers[id]) { remotePlayers[id].connected = false; }
        delete hostRoomRawStates[id];
        // A straggler leaving shouldn't block the race from ever ending.
        checkRaceEnd();
        updateRaceHud();
      });
      MPRoomNet.onPeerState((id, obj) => { hostRoomRawStates[id] = obj; });
      MPRoomNet.onPeerCtrl((id, obj) => { handleRaceHostCtrl(id, obj); });
      MPRoomNet.hostConnectToAll(ids.filter((id) => id !== info.myId));
    } else {
      MPRoomNet.guestInit(info.roomRef, info.myId);
      MPRoomNet.onHostState((obj) => applyRaceWorldState(obj));
      MPRoomNet.onHostCtrl((obj) => handleRaceGuestCtrl(obj));
      MPRoomNet.onHostConn((connState) => {
        if (connState === "lost") {
          // Small polish: if you'd already finished before the host's
          // connection dropped, say so instead of a bare "connection lost"
          // — your run still counted, you're just not getting the final
          // synced standings from a host that's no longer there.
          const msg = mp.raceFinished
            ? `⚠️ الاتصال بالمستضيف انقطع - كنت وصلت (${mp.raceMyRank ? "المركز " + mp.raceMyRank : "لسه مش معروف ترتيبك"})`
            : "⚠️ الاتصال بالمستضيف انقطع";
          endMpSession(msg);
        }
      });
    }
    updateRaceHud();
  }

  function applyRaceWorldState(obj) {
    if (!(mp.active && mp.mode === "race") || !obj.players) return;
    Object.keys(obj.players).forEach((id) => {
      if (id === localPeerId) return;
      const s = obj.players[id];
      let mirror = remotePlayers[id];
      if (!mirror) { mirror = makeRemoteMirror(s.name, null); remotePlayers[id] = mirror; }
      mirror.connected = true;
      mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
      mirror.facing = s.facing; mirror.alive = true; mirror.invuln = 0;
      if (s.name) mirror.name = s.name;
    });
  }

  function updateRaceSync(dt) {
    if (!(mp.active && mp.mode === "race")) return;
    raceSyncAccum += dt;
    if (raceSyncAccum < roomSyncInterval()) return;
    raceSyncAccum = 0;
    const mySnap = { name: myFfaName, x: Math.round(player.x), y: Math.round(player.y), vx: Math.round(player.vx), vy: Math.round(player.vy), facing: player.facing };
    if (ffaIsHost) {
      const players = Object.assign({}, hostRoomRawStates);
      players[localPeerId] = mySnap;
      MPRoomNet.hostBroadcastState({ players });
      Object.keys(hostRoomRawStates).forEach((id) => {
        const s = hostRoomRawStates[id];
        let mirror = remotePlayers[id];
        if (!mirror) { mirror = makeRemoteMirror(s.name, null); remotePlayers[id] = mirror; }
        mirror.connected = true;
        mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
        mirror.facing = s.facing; mirror.alive = true; mirror.invuln = 0;
        if (s.name) mirror.name = s.name;
      });
    } else {
      MPRoomNet.guestSendState(mySnap);
    }
  }

  // Called the instant a player (host or guest) touches level.goal.
  function handleRaceFinish() {
    if (!(mp.active && mp.mode === "race") || mp.raceFinished) return;
    mp.raceFinished = true;
    player.vx = 0;
    spawnFloatText(player.x + player.w / 2, player.y - 20, "🏁 وصلت!", "#ffd166");
    vibrate([50, 60, 50, 60, 120]);
    if (ffaIsHost) {
      reportRaceFinish(localPeerId, myFfaName);
    } else {
      MPRoomNet.guestSendCtrl({ t: "raceFinish" });
    }
    updateRaceHud();
  }

  // Host-only authority over finish order (mirrors checkFfaWinCondition's
  // role for FFA/Team, but for race the "win condition" is a ranked list,
  // not a single winner).
  function reportRaceFinish(id, name) {
    if (!(ffaIsHost && mp.active && mp.mode === "race" && !mp.raceOver)) return;
    if (mp.raceOrder.some((r) => r.id === id)) return; // already recorded
    mp.raceOrder.push({ id, name: name || "لاعب" });
    if (mp.raceOrder.length === 1) {
      raceFirstFinishAt = performance.now();
      setTimeout(() => { if (mp.active && mp.mode === "race" && !mp.raceOver) endRaceMatch(); }, RACE_GRACE_MS);
    }
    if (id === localPeerId) mp.raceMyRank = mp.raceOrder.length;
    MPRoomNet.hostBroadcastCtrl({ t: "raceStanding", order: mp.raceOrder });
    checkRaceEnd();
    updateRaceHud();
  }

  function checkRaceEnd() {
    if (!(ffaIsHost && mp.active && mp.mode === "race" && !mp.raceOver)) return;
    const totalKnown = 1 + Object.keys(remotePlayers).length;
    if (totalKnown <= 1) return; // still waiting for peers to connect
    const finishedIds = new Set(mp.raceOrder.map(r => r.id));
    const hostDone = finishedIds.has(localPeerId);
    const allConnectedGuestsDone = Object.keys(remotePlayers).every(
      (id) => !remotePlayers[id].connected || finishedIds.has(id)
    );
    if (hostDone && allConnectedGuestsDone) endRaceMatch();
  }

  function endRaceMatch() {
    if (!(mp.active && mp.mode === "race") || mp.raceOver) return;
    mp.raceOver = true;
    if (ffaIsHost) MPRoomNet.hostBroadcastCtrl({ t: "raceEnd", order: mp.raceOrder });
    updateRaceHud();
    const genAtEnd = levelGen;
    setTimeout(() => {
      if (genAtEnd !== levelGen) return;
      const myRankTxt = mp.raceMyRank ? `المركز ${mp.raceMyRank}` : "لم تكمل السباق";
      endMpSession(`🏁 خلص السباق - ${myRankTxt}`);
    }, 2600);
  }

  function handleRaceHostCtrl(fromId, obj) {
    if (!(mp.active && mp.mode === "race")) return;
    if (obj.t === "raceFinish") {
      const name = (remotePlayers[fromId] && remotePlayers[fromId].name) || "لاعب";
      reportRaceFinish(fromId, name);
    }
  }

  function handleRaceGuestCtrl(obj) {
    if (!(mp.active && mp.mode === "race")) return;
    if (obj.t === "raceStanding" || obj.t === "raceEnd") {
      mp.raceOrder = obj.order || [];
      const mine = mp.raceOrder.find((r) => r.id === localPeerId);
      if (mine) mp.raceMyRank = mp.raceOrder.indexOf(mine) + 1;
      if (obj.t === "raceEnd") endRaceMatch();
      updateRaceHud();
    }
  }

  // PHASE 5 (completeness) — live ranking while the race is still running.
  // Before this, the HUD only listed players once they'd actually finished
  // (mp.raceOrder) — while the race was in progress there was no "where do
  // I stand right now" feedback at all, which is most of what makes a race
  // feel like a race. Ranks finishers first (by finish order), then
  // everyone still running by how far along the level they've gotten.
  function computeLiveRaceRank() {
    const entries = [{ id: localPeerId, x: player.x, finished: mp.raceFinished }];
    Object.keys(remotePlayers).forEach((id) => {
      const rp = remotePlayers[id];
      if (!rp.connected) return;
      entries.push({ id, x: rp.tx !== undefined ? rp.tx : rp.x, finished: mp.raceOrder.some((r) => r.id === id) });
    });
    entries.sort((a, b) => {
      const aRank = mp.raceOrder.findIndex((r) => r.id === a.id);
      const bRank = mp.raceOrder.findIndex((r) => r.id === b.id);
      if (a.finished && b.finished) return aRank - bRank;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.x - a.x;
    });
    const myPos = entries.findIndex((e) => e.id === localPeerId) + 1;
    return { rank: myPos, total: entries.length };
  }

  function updateRaceHud() {
    const wrap = document.getElementById("raceHud");
    if (!wrap) return;
    if (!(mp.active && mp.mode === "race")) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    const rankText = document.getElementById("raceRankText");
    if (rankText) {
      if (mp.raceFinished) {
        rankText.textContent = mp.raceMyRank ? `🏁 وصلت - المركز ${mp.raceMyRank}` : "🏁 وصلت - في انتظار الباقيين";
      } else {
        const live = computeLiveRaceRank();
        rankText.textContent = live.total > 1 ? `🏃 المركز الحالي: ${live.rank}/${live.total}` : "🏃 جاري السباق...";
      }
    }
    const list = document.getElementById("raceStandingList");
    if (list) {
      list.innerHTML = mp.raceOrder.slice(0, 5).map((r, i) =>
        `<div>${i + 1}. ${r.id === localPeerId ? "أنت" : r.name}</div>`
      ).join("");
    }
  }

  function drawRacePlayers() {
    Object.keys(remotePlayers).forEach((id) => {
      const rp = remotePlayers[id];
      if (!rp.connected) return;
      rp.x += (rp.tx - rp.x) * 0.35;
      rp.y += (rp.ty - rp.y) * 0.35;
      const sx = rp.x - camera.x;
      if (sx < -60 || sx > VW + 60) return;
      ctx.save();
      ctx.fillStyle = "#2fe0ff";
      ctx.fillRect(sx, rp.y, PLAYER_W, PLAYER_H);
      ctx.fillStyle = "#04222c";
      ctx.fillRect(sx + (rp.facing > 0 ? PLAYER_W - 10 : 2), rp.y + 8, 8, 8);
      ctx.fillStyle = "#eaf6ff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(rp.name, sx + PLAYER_W / 2, rp.y - 8);
      ctx.restore();
    });
  }

  // ---------------------------------------------------------
  // BOSS RUSH (PHASE 6) — a chain of boss fights, up to 6 players
  // co-operating against them one at a time. Deliberately reuses
  // updateBoss()'s existing telegraph/pattern/phase AI completely
  // unmodified (same as the single-player final boss) — only the
  // starting stat preset changes per encounter, per the spec's own
  // note not to invent a second boss system from scratch.
  //
  // Host runs the real fight (updateBoss targets the host's own
  // player, same limitation already accepted for co-op's enemies);
  // guests mirror the boss state and report their own hits, exactly
  // like the co-op enemyHit relay, just carried over mp-room-net.js's
  // N-player channel instead of the 2-peer Duel connection.
  // ---------------------------------------------------------
  function makeBossRushBoss(index) {
    const scale = 1 + index * 0.35;
    const bossHealth = Math.round(1400 * scale);
    return {
      x: 0, y: GROUND_Y - 120, w: 74, h: 104,
      health: bossHealth, maxHealth: bossHealth,
      phase: 1, timer: 0, attackTimer: 1.5,
      alive: true, hitFlash: 0, baseY: GROUND_Y - 120,
      pattern: "burst", telegraph: 0, dashVX: 0, enraged: false,
      stats: { grounded: 0, airborne: 0, dashUses: 0, recentPatterns: [] }
    };
  }

  function placeBossRushBoss(b) {
    b.x = level.length - 160; b.y = GROUND_Y - 120; b.baseY = b.y;
  }

  // info = { roomRef, myId, isHost, roster: {id:{name}}, mode:"bossrush" }
  function startRoomBossRushMatch(info) {
    mp.mode = "bossrush";
    mp.active = true;
    mp.roomNetRoomRef = info.roomRef; mp.roomNetIsHost = !!info.isHost;
    if (DEBUG) debugRoomId = (info.roomRef && info.roomRef.key) || null;
    mp.ffaAlive = true;
    mp.bossRushIndex = 0;
    mp.bossRushTotal = 3;
    mp.bossRushOver = false;
    localPeerId = info.myId;
    ffaIsHost = !!info.isHost;
    remotePlayers = {};
    hostRoomRawStates = {};
    bossRushSyncAccum = 0;
    myFfaName = (info.roster[info.myId] && info.roster[info.myId].name) || "لاعب";
    myFfaTeam = null;

    const ids = Object.keys(info.roster).sort();
    const myIndex = ids.indexOf(info.myId);
    level = buildRoomArena(ids.length);
    level.boss = ffaIsHost ? makeBossRushBoss(0) : null;
    if (level.boss) placeBossRushBoss(level.boss);

    camera.x = 0;
    projectiles = []; shockwaves = []; particles = [];
    player.x = level.spawns[myIndex] !== undefined ? level.spawns[myIndex] : level.startX;
    player.y = level.startY;
    player.vx = 0; player.vy = 0; player.facing = 1;
    player.maxHealth = effMaxHealth(); player.health = player.maxHealth;
    player.maxEnergy = effMaxEnergy(); player.energy = player.maxEnergy;
    player.invuln = 1.2; player.down = false; player.activeCheckpoint = null;

    ids.forEach((id, idx) => {
      if (id === info.myId) return;
      const mirror = makeRemoteMirror((info.roster[id] && info.roster[id].name) || "لاعب", null);
      mirror.x = level.spawns[idx] !== undefined ? level.spawns[idx] : level.startX;
      mirror.y = level.startY; mirror.tx = mirror.x; mirror.ty = mirror.y;
      remotePlayers[id] = mirror;
    });

    updateHealthUI(); updateEnergyUI(); updateBossUI();
    state = STATE.PLAYING;
    showScreen(null);
    document.getElementById("mpPingIndicator").classList.remove("hidden");
    spawnFloatText(VW / 2, 90, "مطاردة الزعيم 👹", "#ff5c7a");

    if (ffaIsHost) {
      MPRoomNet.hostInit(info.roomRef, info.myId);
      MPRoomNet.onPeerJoin(() => updateBossRushHud());
      MPRoomNet.onPeerLeave((id) => {
        if (remotePlayers[id]) { remotePlayers[id].connected = false; remotePlayers[id].alive = false; }
        delete hostRoomRawStates[id];
        checkBossRushWipe();
        updateBossRushHud();
      });
      MPRoomNet.onPeerState((id, obj) => { hostRoomRawStates[id] = obj; });
      MPRoomNet.onPeerCtrl((id, obj) => { handleBossRushHostCtrl(id, obj); });
      MPRoomNet.hostConnectToAll(ids.filter((id) => id !== info.myId));
    } else {
      MPRoomNet.guestInit(info.roomRef, info.myId);
      MPRoomNet.onHostState((obj) => applyBossRushWorldState(obj));
      MPRoomNet.onHostCtrl((obj) => handleBossRushGuestCtrl(obj));
      MPRoomNet.onHostConn((connState) => {
        if (connState === "lost") endMpSession("⚠️ الاتصال بالمستضيف انقطع");
      });
    }
    updateBossRushHud();
  }

  function bossRushSnapshot(b) {
    return {
      x: Math.round(b.x), y: Math.round(b.y), w: b.w, h: b.h, health: Math.round(b.health), maxHealth: b.maxHealth,
      alive: b.alive, phase: b.phase, pattern: b.pattern, telegraph: b.telegraph,
      enraged: b.enraged, hitFlash: b.hitFlash || 0, baseY: b.baseY
    };
  }

  function applyBossRushWorldState(obj) {
    if (!(mp.active && mp.mode === "bossrush")) return;
    if (obj.players) {
      Object.keys(obj.players).forEach((id) => {
        if (id === localPeerId) return;
        const s = obj.players[id];
        let mirror = remotePlayers[id];
        if (!mirror) { mirror = makeRemoteMirror(s.name, null); remotePlayers[id] = mirror; }
        mirror.connected = true;
        mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
        mirror.facing = s.facing; mirror.health = s.health; mirror.maxHealth = s.maxHealth;
        mirror.alive = s.alive; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
        if (s.name) mirror.name = s.name;
      });
    }
    if (obj.boss) {
      if (!level.boss) level.boss = makeBossRushBoss(mp.bossRushIndex);
      Object.assign(level.boss, obj.boss);
      updateBossUI();
    }
    updateBossRushHud();
  }

  function updateBossRushSync(dt) {
    if (!(mp.active && mp.mode === "bossrush")) return;
    bossRushSyncAccum += dt;
    if (bossRushSyncAccum < roomSyncInterval()) return;
    bossRushSyncAccum = 0;
    const mySnap = {
      name: myFfaName, x: Math.round(player.x), y: Math.round(player.y), vx: Math.round(player.vx), vy: Math.round(player.vy),
      facing: player.facing, health: Math.round(player.health), maxHealth: player.maxHealth,
      alive: mp.ffaAlive, blastFx: player.blastFx, invuln: player.invuln
    };
    if (ffaIsHost) {
      const players = Object.assign({}, hostRoomRawStates);
      players[localPeerId] = mySnap;
      const payload = { players };
      if (level.boss) payload.boss = bossRushSnapshot(level.boss);
      MPRoomNet.hostBroadcastState(payload);
      Object.keys(hostRoomRawStates).forEach((id) => {
        const s = hostRoomRawStates[id];
        let mirror = remotePlayers[id];
        if (!mirror) { mirror = makeRemoteMirror(s.name, null); remotePlayers[id] = mirror; }
        mirror.connected = true;
        mirror.tx = s.x; mirror.ty = s.y; mirror.vx = s.vx; mirror.vy = s.vy;
        mirror.facing = s.facing; mirror.health = s.health; mirror.maxHealth = s.maxHealth;
        mirror.alive = s.alive; mirror.blastFx = s.blastFx; mirror.invuln = s.invuln;
        if (s.name) mirror.name = s.name;
      });
      checkBossRushWipe();
    } else {
      MPRoomNet.guestSendState(mySnap);
    }
    updateBossRushHud();
  }

  function sendBossRushHit(dmg) {
    if (ffaIsHost) return; // host applies its own hits directly, no relay needed
    MPRoomNet.guestSendCtrl({ t: "bossHit", dmg });
  }

  function handleBossRushHostCtrl(fromId, obj) {
    if (!(mp.active && mp.mode === "bossrush") || !level.boss) return;
    if (obj.t === "bossHit" && level.boss.alive) {
      level.boss.health -= obj.dmg;
      level.boss.hitFlash = 0.15;
      if (level.boss.health <= 0) {
        level.boss.alive = false;
        spawnParticles(level.boss.x + level.boss.w / 2, level.boss.y + level.boss.h / 2, "#ffd166", 46, 320, 0.9);
        screenShake = 16;
        flashScreen("rgba(255,209,102,0.7)", 0.7);
        addScore(SCORE_BOSS, level.boss.x + level.boss.w / 2, level.boss.y, `+${SCORE_BOSS}`, "#ffd166");
        handleBossRushKill();
      }
      updateBossUI();
    }
  }

  function handleBossRushGuestCtrl(obj) {
    if (!(mp.active && mp.mode === "bossrush")) return;
    if (obj.t === "brNextBoss") {
      mp.bossRushIndex = obj.index;
      level.boss = makeBossRushBoss(obj.index);
      placeBossRushBoss(level.boss);
      spawnFloatText(VW / 2, 90, `👹 الزعيم ${obj.index + 1}/${mp.bossRushTotal}`, "#ffd166");
      updateBossUI();
      updateBossRushHud();
    } else if (obj.t === "brEnd") {
      endBossRushMatch(obj.won);
    }
  }

  // Host-only: fires right after level.boss.health hits 0, whether that
  // kill came from the host's own local hit or a relayed guest "bossHit".
  function handleBossRushKill() {
    if (!(ffaIsHost && mp.active && mp.mode === "bossrush")) return;
    mp.bossRushIndex++;
    if (mp.bossRushIndex >= mp.bossRushTotal) {
      mp.bossRushOver = true;
      MPRoomNet.hostBroadcastCtrl({ t: "brEnd", won: true });
      endBossRushMatch(true);
    } else {
      MPRoomNet.hostBroadcastCtrl({ t: "brNextBoss", index: mp.bossRushIndex });
      spawnFloatText(VW / 2, VH / 2 - 40, "✅ الزعيم وقع!", "#ffd166");
      const genAtKill = levelGen;
      setTimeout(() => {
        if (genAtKill !== levelGen || !(mp.active && mp.mode === "bossrush")) return;
        level.boss = makeBossRushBoss(mp.bossRushIndex);
        placeBossRushBoss(level.boss);
        updateBossUI();
        spawnFloatText(VW / 2, 90, `👹 الزعيم ${mp.bossRushIndex + 1}/${mp.bossRushTotal}`, "#ffd166");
      }, 1800);
    }
    updateBossRushHud();
  }

  // Host-only: shared fail condition — everyone in the room is down.
  function checkBossRushWipe() {
    if (!(ffaIsHost && mp.active && mp.mode === "bossrush" && !mp.bossRushOver)) return;
    const totalKnown = 1 + Object.keys(remotePlayers).length;
    if (totalKnown <= 1) return; // still waiting for peers to connect
    const anyoneAlive = mp.ffaAlive || Object.values(remotePlayers).some(rp => rp.alive && rp.connected);
    if (!anyoneAlive) {
      mp.bossRushOver = true;
      MPRoomNet.hostBroadcastCtrl({ t: "brEnd", won: false });
      endBossRushMatch(false);
    }
  }

  function endBossRushMatch(won) {
    if (!(mp.active && mp.mode === "bossrush")) return;
    mp.bossRushOver = true;
    spawnFloatText(VW / 2, VH / 2, won ? "🏆 خلصتوا كل الزعما!" : "😵 الفريق كله وقع", won ? "#ffd166" : "#ff5c7a");
    vibrate(won ? [50, 60, 50, 60, 120] : [80, 100, 80]);
    const genAtEnd = levelGen;
    setTimeout(() => {
      if (genAtEnd !== levelGen) return;
      endMpSession(won ? "🏆 خلصتوا Boss Rush!" : "😵 الفريق وقع قدام الزعيم");
    }, 2200);
  }

  // Guests never run updateBoss() in Boss Rush (that would make them a
  // second, conflicting authority over the fight) — but they still need
  // to take contact damage from the host-driven boss they can see,
  // mirroring the single check updateBoss() itself uses (aabb(player,b)).
  function updateBossRushGuestContact() {
    if (!(mp.active && mp.mode === "bossrush" && !ffaIsHost) || player.down || !mp.ffaAlive) return;
    if (level.boss && level.boss.alive && aabb(player, level.boss)) damagePlayer(22, false);
  }

  function updateBossRushHud() {
    const wrap = document.getElementById("bossRushHud");
    if (!wrap) return;
    if (!(mp.active && mp.mode === "bossrush")) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    const el = document.getElementById("bossRushText");
    if (el) el.textContent = `👹 الزعيم ${Math.min(mp.bossRushIndex + 1, mp.bossRushTotal)}/${mp.bossRushTotal}`;
  }

  function updateVersusHud() {
    const wrap = document.getElementById("versusHud");
    if (!wrap) return;
    if (!(mp.active && mp.mode === "versus")) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    document.getElementById("versusMeFill").style.width = clamp(player.health / player.maxHealth, 0, 1) * 100 + "%";
    document.getElementById("versusPeerFill").style.width = clamp(player2.health / player2.maxHealth, 0, 1) * 100 + "%";
    let pips = "";
    for (let i = 0; i < mp.roundsToWin; i++) pips += (i < mp.roundWins.me ? "🔵" : "⚪");
    pips += ` ${mp.roundNumber} `;
    for (let i = 0; i < mp.roundsToWin; i++) pips += (i < mp.roundWins.peer ? "🟠" : "⚪");
    document.getElementById("versusRoundPips").textContent = pips;
  }

  MP.onStateMessage((msg) => {
    if (msg.t === "cw") {
      if (mp.active && mp.mode === "coop" && !MP.isHost() && level && level.enemies) {
        for (let k = 0; k < msg.enemies.length; k++) {
          if (level.enemies[k]) Object.assign(level.enemies[k], msg.enemies[k]);
          else level.enemies[k] = Object.assign({}, msg.enemies[k]);
        }
        mp.coopEnemiesRemaining = msg.remaining;
      }
      return;
    }
    mpApplyIncomingState(msg);
  });
  MP.onCtrlMessage((msg) => {
    if (msg.t === "emote") {
      const e = EMOTES.find(x => x.id === msg.id);
      if (e) { peerEmoteIcon = e.icon; peerEmoteUntil = performance.now() + 2200; }
    } else if (msg.t === "hit") {
      if (mp.active && mp.mode === "versus" && mp.roundActive) damagePlayer(msg.dmg, false);
    } else if (msg.t === "roundLost") {
      if (mp.active && mp.mode === "versus" && !mp.roundResolving) {
        mp.roundResolving = true;
        mp.roundActive = false;
        mp.roundWins.me++;
        showVersusRoundResult(true);
      }
    } else if (msg.t === "powerupSpawn") {
      if (mp.active && mp.mode === "versus" && !MP.isHost() && level && level.powerups) {
        level.powerups.push({ x: msg.x, y: msg.y, r: 14, type: msg.type, id: msg.id, collected: false });
      }
    } else if (msg.t === "powerupTaken") {
      if (mp.active && mp.mode === "versus" && level && level.powerups) {
        const p = level.powerups.find(pp => pp.id === msg.id);
        if (p) p.collected = true;
      }
    } else if (msg.t === "waveStart") {
      if (mp.active && mp.mode === "coop") {
        mp.coopWave = msg.wave;
        mp.coopWaveState = "active";
        if (!MP.isHost()) {
          level.enemies = msg.enemies.map(e => Object.assign({}, e));
          mp.coopEnemiesRemaining = level.enemies.filter(e => e.alive).length;
        }
        spawnFloatText(VW / 2, 90, `الموجة ${msg.wave} / ${mp.coopTotalWaves}`, "#ffd166");
        vibrate(20);
        updateCoopHud();
      }
    } else if (msg.t === "waveCleared") {
      if (mp.active && mp.mode === "coop") {
        spawnFloatText(VW / 2, VH / 2 - 40, `✅ الموجة ${msg.wave} خلصت!`, "#5cff8a");
      }
    } else if (msg.t === "enemyHit") {
      // Guest reports a hit; host is the only one allowed to actually
      // apply it, since host's copy of level.enemies is the real one.
      if (mp.active && mp.mode === "coop" && MP.isHost() && level && level.enemies && level.enemies[msg.i]) {
        const e = level.enemies[msg.i];
        if (e.alive) {
          e.health -= msg.dmg;
          e.hitFlash = 0.15;
          if (e.health <= 0) {
            e.health = 0; e.alive = false;
            spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#ff9142", 16, 220, 0.5);
            registerKill(SCORE_ENEMY, e.x + e.w / 2, e.y, "#ff9142");
          }
        }
      }
    } else if (msg.t === "revProg") {
      if (mp.active && mp.mode === "coop") mp.coopReviveProgress = msg.v;
    } else if (msg.t === "revived") {
      if (mp.active && mp.mode === "coop" && player.down) {
        player.down = false;
        player.health = Math.round(player.maxHealth * 0.4);
        player.invuln = 1.2;
        mp.coopReviveProgress = 0;
        spawnFloatText(player.x + player.w / 2, player.y - 30, "تم إنقاذك! 🙌", "#5cff8a");
        vibrate([30, 40, 30]);
      }
    } else if (msg.t === "coopVictory") {
      if (mp.active && mp.mode === "coop") endCoopMatch(true);
    } else if (msg.t === "coopFail") {
      if (mp.active && mp.mode === "coop") endCoopMatch(false);
    }
  });

  document.querySelectorAll(".mpEmoteBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      mpSendEmote(btn.dataset.emote);
      document.getElementById("mpEmotePanel").classList.add("hidden");
    });
  });
  document.getElementById("mpEmoteToggleBtn").addEventListener("click", () => {
    document.getElementById("mpEmotePanel").classList.toggle("hidden");
  });

  setInterval(updateMpPingUI, 500);

  document.getElementById("multiplayerBtn").addEventListener("click", () => {
    ensureAudio();
    mpResetLobbyUI();
    // Only one real mode lives on this screen now (Duel) - see Phase 2
    // cleanup notes on mpResetLobbyUI. Skip straight to Host/Join instead
    // of a "choose between 1 option" step.
    mp.mode = "versus";
    mpEls.roleSelect.classList.remove("hidden");
    showScreen("mpLobbyScreen");
  });
  document.getElementById("mpBackBtn").addEventListener("click", () => {
    mpResetLobbyUI();
    showScreen("modeSelectScreen");
  });

  document.querySelectorAll(".mpModeBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mpModeBtn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      mp.mode = btn.dataset.mode;
      mpEls.roleSelect.classList.remove("hidden");
    });
  });

  document.getElementById("mpHostBtn").addEventListener("click", async () => {
    mp.role = "host";
    mpEls.hostFlow.classList.remove("hidden");
    mpEls.joinFlow.classList.add("hidden");
    mpSetStatus("جاري توليد الكود...");
    try {
      const code = await MP.createHostOffer();
      mpEls.hostOfferCode.value = code;
      mpSetStatus("ابعت الكود لصاحبك وانتظر كود الرد");
    } catch (e) {
      mpSetStatus("حصل خطأ في توليد الكود");
    }
  });

  document.getElementById("mpJoinBtn").addEventListener("click", () => {
    mp.role = "guest";
    mpEls.joinFlow.classList.remove("hidden");
    mpEls.hostFlow.classList.add("hidden");
    mpSetStatus("الصق كود الاستضافة وكمل");
  });

  document.getElementById("mpCopyOfferBtn").addEventListener("click", () => {
    mpEls.hostOfferCode.select();
    document.execCommand("copy");
    mpSetStatus("اتنسخ! ابعته لصاحبك");
  });

  document.getElementById("mpCopyAnswerBtn").addEventListener("click", () => {
    mpEls.joinAnswerCode.select();
    document.execCommand("copy");
    mpSetStatus("اتنسخ! ابعته للمستضيف");
  });

  document.getElementById("mpGenerateAnswerBtn").addEventListener("click", async () => {
    const offerCode = mpEls.joinOfferInput.value.trim();
    if (!offerCode) { mpSetStatus("الصق الكود الأول"); return; }
    mpSetStatus("جاري المعالجة...");
    try {
      const answerCode = await MP.joinWithOfferCode(offerCode);
      mpEls.joinAnswerCode.value = answerCode;
      mpSetStatus("ابعت كود الرد وانتظر الاتصال...");
    } catch (e) {
      mpSetStatus("كود غير صالح، جرب تاني");
    }
  });

  document.getElementById("mpConnectHostBtn").addEventListener("click", async () => {
    const answerCode = mpEls.hostAnswerInput.value.trim();
    if (!answerCode) { mpSetStatus("الصق كود الرد الأول"); return; }
    mpSetStatus("جاري الاتصال...");
    try {
      await MP.acceptAnswer(answerCode);
    } catch (e) {
      mpSetStatus("كود غير صالح، جرب تاني");
    }
  });

  MP.onState((s) => {
    const wasActive = mp.active;
    mp.status = s;
    if (s === "connected") {
      mpSetStatus("✅ اتصل! جاري بدء اللعبة...");
      vibrate(20);
      if (mp.mode === "versus") startVersusMatch();
      else if (mp.mode === "coop") startCoopMatch();
      else startMpSession();
    } else if (s === "disconnected") {
      if (wasActive) endMpSession("⚠️ انقطع الاتصال بصاحبك");
      else if (mp.status !== "idle") mpSetStatus("⚠️ انقطع الاتصال");
    } else if (s === "error") {
      mpSetStatus("⚠️ حصل خطأ في الاتصال");
    }
  });

  function stopSingAudio() {
    if (singMode.active) {
      singMode.active = false;
      if (singMode.audioEl) singMode.audioEl.pause();
    }
  }

  document.getElementById("pauseBtn").addEventListener("click", () => {
    if (state === STATE.PLAYING) {
      state = STATE.PAUSED;
      if (singMode.active && singMode.audioEl) singMode.audioEl.pause();
      const pauseScoreEl = document.getElementById("pauseScoreText");
      if (pauseScoreEl) pauseScoreEl.textContent = `🏆 النقاط الحالية: ${runScore}`;
      showScreen("pauseScreen");
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === STATE.PLAYING) {
      state = STATE.PAUSED;
      if (singMode.active && singMode.audioEl) singMode.audioEl.pause();
      const pauseScoreEl = document.getElementById("pauseScoreText");
      if (pauseScoreEl) pauseScoreEl.textContent = `🏆 النقاط الحالية: ${runScore}`;
      showScreen("pauseScreen");
    }
  });
  window.addEventListener("blur", () => {
    if (state === STATE.PLAYING) {
      state = STATE.PAUSED;
      if (singMode.active && singMode.audioEl) singMode.audioEl.pause();
      const pauseScoreEl = document.getElementById("pauseScoreText");
      if (pauseScoreEl) pauseScoreEl.textContent = `🏆 النقاط الحالية: ${runScore}`;
      showScreen("pauseScreen");
    }
  });
  document.getElementById("resumeBtn").addEventListener("click", () => {
    state = STATE.PLAYING;
    if (singMode.active && singMode.audioEl) attemptSingAudioPlay();
    showScreen(null);
  });
  // Sing Mode isn't a numbered level (currentLevelNum stays 0 while it's
  // active), so "retry"/"restart" can't just call loadLevel(currentLevelNum)
  // the way normal levels do - that used to build level 0 with a broken
  // theme lookup and crash. Replay the same song instead; if it's not
  // available anymore (e.g. session reload), fall back to the main menu
  // instead of building a bogus level.
  function restartCurrentRun() {
    if (level && level.isSing) {
      if (singPickedFile && singPickedBeats) {
        singMode.beats = singPickedBeats.beats;
        singMode.duration = singPickedBeats.duration;
        enterSingMode(singPickedFile);
      } else {
        state = STATE.MENU; showScreen("menuScreen");
      }
    } else {
      loadLevel(currentLevelNum); state = STATE.PLAYING; showScreen(null);
    }
  }
  document.getElementById("restartFromPauseBtn").addEventListener("click", () => {
    stopSingAudio();
    restartCurrentRun();
  });
  document.getElementById("menuFromPauseBtn").addEventListener("click", () => {
    stopSingAudio();
    if (mp.active) {
      endMpSession(); // clears mp.active first so the disconnect below doesn't also fire the "connection lost" message
      MP.disconnect();
    } else {
      state = STATE.MENU; showScreen("menuScreen");
    }
  });
  document.getElementById("retryBtn").addEventListener("click", () => {
    stopSingAudio();
    restartCurrentRun();
  });
  document.getElementById("menuFromGameOverBtn").addEventListener("click", () => { stopSingAudio(); state = STATE.MENU; showScreen("menuScreen"); });
  document.getElementById("playAgainBtn").addEventListener("click", () => {
    stopSingAudio();
    collectedGemsTotal = 0; runTotalGemsPossible = 0; visitedLevels.clear(); runScore = 0;
    loadLevel(1); state = STATE.PLAYING; showScreen(null);
  });
  document.getElementById("menuFromVictoryBtn").addEventListener("click", () => { stopSingAudio(); state = STATE.MENU; showScreen("menuScreen"); });
  document.getElementById("nextLevelBtn").addEventListener("click", () => {
    loadLevel(currentLevelNum + 1); state = STATE.PLAYING; showScreen(null);
  });

  function triggerGameOver() {
    state = STATE.GAMEOVER;
    const vign = document.getElementById("hellVignette");
    if (vign) vign.classList.remove("active");
    sfx.gameover();
    if (runScore > saveData.bestScore) { saveData.bestScore = runScore; writeSave(); }
    const earned = Math.max(1, Math.floor(runScore / 300));
    saveData.upgradePoints += earned;
    writeSave();
    document.getElementById("gameOverLevelText").textContent = `توقفت عند المرحلة ${currentLevelNum}`;
    const scoreEl = document.getElementById("gameOverScoreText");
    if (scoreEl) scoreEl.textContent = `🏆 النقاط: ${runScore} (الأفضل: ${saveData.bestScore}) · ⭐ +${earned} نقطة ترقية`;
    const goImg = document.getElementById("gameOverImg");
    if (goImg) {
      goImg.src = GAMEOVER_IMAGES[gameOverImgIndex];
      gameOverImgIndex = (gameOverImgIndex + 1) % GAMEOVER_IMAGES.length; // alternate every death
    }
    showScreen("gameOverScreen");
  }
  function triggerLevelComplete() {
    if (currentLevelNum === 0) { // tutorial stage — no medals/score/progression, just move on to level 1
      saveData.tutorialDone = true;
      writeSave();
      collectedGemsTotal = 0; runTotalGemsPossible = 0; visitedLevels.clear(); // keep the tutorial's own gem out of the real run's totals
      loadLevel(1);
      state = STATE.PLAYING;
      showScreen(null);
      return;
    }
    if (timeAttackMode) {
      const finalTime = timeAttackElapsed;
      const prevBest = saveData.timeAttackBest[currentLevelNum];
      const isRecord = prevBest === undefined || finalTime < prevBest;
      if (isRecord) { saveData.timeAttackBest[currentLevelNum] = finalTime; writeSave(); }
      state = STATE.LEVEL_COMPLETE;
      sfx.gem();
      const resultEl = document.getElementById("timeAttackResultText");
      if (resultEl) {
        resultEl.textContent = isRecord
          ? `🏆 رقم قياسي جديد! ${finalTime.toFixed(2)} ثانية`
          : `⏱️ وقتك: ${finalTime.toFixed(2)}ث (الأفضل: ${prevBest.toFixed(2)}ث)`;
      }
      showScreen("timeAttackResultScreen");
      return;
    }

    unlockLevel(currentLevelNum + 1);
    const timeTaken = (performance.now() - levelStartTime) / 1000;
    const collected = level.gems.filter(g => g.collected).length;
    const gemsFraction = level.totalGems > 0 ? collected / level.totalGems : 1;
    const medal = computeMedal(level, timeTaken, gemsFraction, levelNoDamage);
    recordMedal(currentLevelNum, medal);
    const medalIcon = MEDAL_ICON[medal] || "";

    // PHASE 12 — Perfect Run: independent from the S-medal (which also
    // requires a time/gem threshold). A Perfect Run only cares about "did
    // nothing go wrong": no damage taken, no checkpoint bailout, and the
    // level was actually completed (true by definition at this point).
    // Doesn't touch medal/progression — purely an extra flag + small bonus.
    const isPerfectRun = levelNoDamage && !usedCheckpointThisLevel;
    if (isPerfectRun) {
      saveData.perfectRuns[currentLevelNum] = true;
    }

    // PHASE 11 — Ghost Rival: a new best clears the old ghost for this
    // level. Only real recorded runs (ghostRecordingEnabled, set in
    // loadLevel) are eligible — Sing Mode/THE HELL never reach here anyway
    // since they don't call triggerLevelComplete's normal path.
    const prevGhostTime = ghostStore[currentLevelNum] ? ghostStore[currentLevelNum].time : null;
    const isNewGhostRecord = ghostRecordingEnabled && (prevGhostTime === null || timeTaken < prevGhostTime);
    if (isNewGhostRecord) {
      ghostStore[currentLevelNum] = { time: timeTaken, frames: ghostRecordBuffer.slice() };
      writeGhostStore();
    }

    // time bonus: faster, cleaner clears earn more points
    const timeBonus = Math.max(0, Math.round(TIME_BONUS_MAX - timeTaken * 3));
    addScore(timeBonus);

    // permanent upgrade currency: 1 point per level clear, +1 more per medal tier
    const medalBonus = medal === "gold" ? 2 : medal === "silver" ? 1 : 0;
    // Perfect Run reward: +1 upgrade point on top of the existing medal
    // bonus, every time it's achieved — same repeatable-reward pattern the
    // medal bonus already uses, so it doesn't change how progression works.
    const perfectRunBonus = isPerfectRun ? 1 : 0;
    const earnedUpgradePoints = 1 + medalBonus + perfectRunBonus;
    saveData.upgradePoints += earnedUpgradePoints;
    writeSave();

    if (currentLevelNum >= TOTAL_LEVELS) {
      state = STATE.VICTORY;
      sfx.victory();
      vibrate([50, 60, 50, 60, 120]);
      flashScreen("rgba(255,255,255,0.9)", 0.8);
      if (runScore > saveData.bestScore) { saveData.bestScore = runScore; writeSave(); }
      if (!saveData.timeAttackUnlocked) { saveData.timeAttackUnlocked = true; writeSave(); }
      const victoryTextEl = document.getElementById("victoryGemsText");
      if (victoryTextEl) victoryTextEl.textContent = `💎 إجمالي الجواهر التي جمعتها: ${collectedGemsTotal}/${runTotalGemsPossible}`;
      const victoryMedalEl = document.getElementById("victoryMedalText");
      if (victoryMedalEl) victoryMedalEl.textContent = `${medalIcon} ميدالية المرحلة الأخيرة: ${medal === "s" ? "أسطورية" : medal === "gold" ? "ذهبية" : medal === "silver" ? "فضية" : "برونزية"}`;
      const victoryScoreEl = document.getElementById("victoryScoreText");
      if (victoryScoreEl) victoryScoreEl.textContent = `🏆 مجموع النقاط: ${runScore} (الأفضل: ${saveData.bestScore})`;
      const victoryPerfectEl = document.getElementById("victoryPerfectRunText");
      if (victoryPerfectEl) victoryPerfectEl.textContent = isPerfectRun ? "🌟 أداء مثالي في المرحلة الأخيرة! (بدون ضرر، بدون نقطة حفظ)" : "";
      const victoryGhostEl = document.getElementById("victoryGhostText");
      if (victoryGhostEl) victoryGhostEl.textContent = isNewGhostRecord ? "👻 رقم قياسي جديد في المرحلة الأخيرة!" : "";
      if (saveData.goldSkinUnlocked) {
        const unlockEl = document.getElementById("victorySkinUnlock");
        if (unlockEl) unlockEl.textContent = "🏆 مبروك! فتحت المظهر الذهبي - فعّله من الإعدادات";
      }
      showScreen("victoryScreen");
    } else {
      state = STATE.LEVEL_COMPLETE;
      sfx.gem();
      document.getElementById("levelCompleteText").textContent =
        `أكملت المرحلة ${currentLevelNum} بنجاح — جواهر: ${collected}/${level.totalGems}`;
      const lcScoreEl = document.getElementById("levelCompleteScoreText");
      if (lcScoreEl) lcScoreEl.textContent = `🏆 النقاط: ${runScore} (+${timeBonus} مكافأة وقت) · ⭐ +${earnedUpgradePoints} نقطة ترقية`;
      const medalEl = document.getElementById("medalText");
      if (medalEl) {
        const medalName = medal === "s" ? "أسطورية" : medal === "gold" ? "ذهبية" : medal === "silver" ? "فضية" : "برونزية";
        medalEl.textContent = `${medalIcon} ميدالية ${medalName}`;
      }
      const perfectRunEl = document.getElementById("perfectRunText");
      if (perfectRunEl) perfectRunEl.textContent = isPerfectRun ? "🌟 أداء مثالي! (بدون ضرر، بدون نقطة حفظ) +1 نقطة ترقية إضافية" : "";
      const ghostEl = document.getElementById("ghostRecordText");
      if (ghostEl) ghostEl.textContent = isNewGhostRecord ? "👻 رقم قياسي جديد! هيظهر شبحك في المحاولة الجاية" : "";
      showScreen("levelCompleteScreen");
    }
  }

  // ---------------------------------------------------------
  // PLAYER ACTIONS
  // ---------------------------------------------------------
  function tryAirBlast(continuous) {
    if (player.blastCooldown > 0) return;
    if (player.blastStolen) {
      // a thief is holding the Air Blast — nothing happens until it's
      // killed (or the level/checkpoint is restarted); a rare cue so the
      // player understands why the button stopped working, without
      // spamming a float-text on every single held-button tick.
      if (!continuous && Math.random() < 0.35) {
        spawnFloatText(player.x + player.w / 2, player.y - 28, "السارق أخد البلاست! اقتله عشان تسترجعه", "#ffcf5c");
      }
      return;
    }
    player.blastCooldown = 0; // Air Blast has no cooldown — always available
    const wasOnGround = player.onGround; // captured before we clear it below, used for the ground-dust kick-up
    // PHASE 13 — feeds the boss's behavior-adaptation stats (see updateBoss/
    // chooseBossPattern); harmless no-op outside an active boss fight.
    if (level.boss && level.boss.alive) {
      if (!level.boss.stats) level.boss.stats = { grounded: 0, airborne: 0, dashUses: 0, recentPatterns: [] };
      level.boss.stats.dashUses++;
    }

    // The joystick/arrow now sets the travel direction DIRECTLY — push the
    // stick up and the blast carries you up, push it toward the wall/enemy
    // and it carries you that way, exactly like a jetpack aimed where you
    // point it. (No more rocket-style recoil, which used to send the player
    // the OPPOSITE way of the arrow and made "up" feel broken.)
    // No input -> straight up, so a plain tap always gets you off the ground.
    let aimX = joystick.aimDx, aimY = joystick.aimDy;
    const aimMag = Math.hypot(aimX, aimY);
    if (!joystick.active || aimMag < 0.2) { aimX = 0; aimY = -1; }
    else { aimX /= aimMag; aimY /= aimMag; }
    const dx = aimX, dy = aimY; // travel direction = arrow direction (ground or air)

    // ease into the new velocity instead of snapping to it instantly, and
    // fly through it with lightened gravity for a real "flying" glide
    // instead of a hop/jump. While the button is held, this function is
    // called repeatedly at a short interval (see BLAST_HOLD_INTERVAL in
    // update()) with continuous=true — each call re-targets the velocity
    // and re-arms the ease, so the player keeps gliding upward smoothly in
    // small feel-able pushes instead of one instant snap-to-the-top jump.
    // Charge Blast: while continuously held, the sustained pulses ramp up in
    // force (and energy cost) the longer the button has stayed down.
    let chargeMul = 1;
    if (continuous && player.blastChargeTime > 0) {
      chargeMul = 1 + (player.blastChargeTime / CHARGE_MAX_TIME) * CHARGE_MAX_BONUS;
      const chargeCost = CHARGE_ENERGY_BASE + (chargeMul - 1) * CHARGE_ENERGY_SCALE;
      if (player.energy >= chargeCost) {
        player.energy -= chargeCost;
        updateEnergyUI();
      } else {
        chargeMul = 1; // not enough energy to sustain the charge bonus this pulse
      }
    }

    // Blast Chain: consecutive real taps (never the held-continuous
    // auto-repeat) fired within BLAST_CHAIN_WINDOW_MS of each other stack a
    // small travel-force bonus, rewarding tight tap timing instead of just
    // holding the button. Missing the window resets the chain.
    let chainMul = 1;
    if (!continuous) {
      const now = performance.now();
      blastChainCount = (now - lastDiscreteBlastAt < BLAST_CHAIN_WINDOW_MS)
        ? Math.min(blastChainCount + 1, BLAST_CHAIN_MAX_TIER)
        : 1;
      lastDiscreteBlastAt = now;
      chainMul = 1 + (blastChainCount - 1) * BLAST_CHAIN_FORCE_PER_TIER;
      if (blastChainCount >= 2) {
        addScore(blastChainCount * 5, player.x + player.w / 2, player.y - 20, `CHAIN x${blastChainCount}`, "#bfe8ff");
      }
    }

    // Recovery Blast: cutting a long freefall short instead of riding it
    // out - a real "get back in control" save, not just any old blast.
    if (!wasOnGround && fallTime > RECOVERY_FALL_TIME) {
      addScore(RECOVERY_SCORE, player.x + player.w / 2, player.y - 40, "RECOVERY!", "#8affc1");
      fallTime = 0;
    }

    player.blastTargetVX = dx * AIR_BLAST_FORCE * chargeMul * chainMul;
    player.blastTargetVY = dy * AIR_BLAST_FORCE * 1.15 * chargeMul * chainMul - 120;
    if (dy < 0.2 && dy > -0.2) player.blastTargetVY -= 200; // mostly-sideways blasts still get some lift

    // Wall Blast: if we're still inside the post-wall-touch grace window and
    // this blast pushes away from that wall, add an extra kick-off impulse —
    // a real wall-jump, on top of the normal recoil.
    let wallKicked = false;
    if (player.wallTime > 0 && dx !== 0 && Math.sign(dx) === -player.wallSide) {
      wallKicked = true;
      player.blastTargetVX += -player.wallSide * WALL_KICK_VX;
      player.blastTargetVY += WALL_KICK_VY;
      player.wallTime = 0;
    }
    if (chargeMul > 1.01 || wallKicked) {
      const glowR = wallKicked ? "#ffe38a" : "#eaf9ff";
      spawnParticles(player.x + player.w / 2, player.y + player.h / 2, glowR, Math.round(10 * chargeMul), 260, 0.4);
    }

    player.blastEase = 1;
    player.onGround = false;
    player.blastFx = 0.28;
    player.blastDirX = dx;
    player.blastDirY = dy;
    lastBlastAt = performance.now();
    blastPulseEvents.push(mirrorClock); // lets Mirror enemies echo this blast later
    if (dx !== 0) player.facing = dx > 0 ? 1 : -1;
    const cx = player.x + player.w / 2, cy = player.y + player.h / 2;
    // the air jet itself bursts out opposite to travel (i.e. toward aimX/aimY)
    // Held-repeat pulses are toned down (fewer particles, softer shake/sound)
    // so the sustained climb reads as one smooth flight, not a string of
    // separate "hits".
    const trailColor = getTrailColor();
    // nozzle sits BEHIND the travel direction (opposite of dx/dy) so the
    // exhaust reads as pushing the player forward, like a real thruster
    spawnParticles(cx - dx * 18, cy - dy * 18, trailColor, continuous ? 9 : 26, 320, 0.55);
    for (let i = 0; i < (continuous ? 3 : 6); i++) {
      spawnStreak(cx - dx * 16, cy - dy * 16, trailColor, -dx, -dy, 260, continuous ? 0.18 : 0.26, continuous ? 14 : 20);
    }
    screenShake = Math.max(screenShake, continuous ? 2 : 6);
    sfx.blast(continuous);
    vibrate(continuous ? 7 : 18);

    // Ground dust: a mostly-horizontal blast fired while still grounded
    // kicks up a puff of dust behind the player at their feet — the same
    // "something real just pushed off the ground" cue a jump would give,
    // but only when the blast is actually horizontal enough to plausibly
    // scrape the floor.
    if (wasOnGround && Math.abs(dx) > 0.35) {
      const footY = player.y + player.h - 2;
      const kickX = cx - dx * 12; // dust kicks up on the trailing side, behind the direction of travel
      spawnParticles(kickX, footY, "#aab8c2", continuous ? 3 : 7, 90, continuous ? 0.28 : 0.4, "dust");
    }

    // --- Air Blast combat interactions ---
    // 1) Deflect nearby incoming enemy projectiles back at whoever fired them.
    for (const pr of projectiles) {
      if (pr.friendly) continue;
      if (Math.hypot(pr.x - cx, pr.y - cy) < BLAST_PARRY_RADIUS) {
        pr.vx *= -1.15; pr.vy *= -1.15;
        pr.friendly = true;
        pr.dmg = 20;
        pr.life = Math.max(pr.life, 1.2);
        spawnParticles(pr.x, pr.y, "#7fe0ff", 10, 160, 0.3);
        sfx.hit();
      }
    }

    // 2) Hit enemies caught in the jet's path: break shields, and punch
    //    light enemies away. The enemy closest to the player, in front along
    //    the aim direction, flies into the air and gets shoved back hard;
    //    any others lined up behind it only get a lighter push — like a
    //    real gust hitting whoever's standing in the way first.
    const punchTargets = [];
    for (const e of level.enemies) {
      if (!e.alive) continue;
      const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
      const edx = ex - cx, edy = ey - cy;
      const dist = Math.hypot(edx, edy);
      if (dist > BLAST_HIT_RADIUS) continue;
      if (e.type === "shield" && e.shielded) {
        e.shielded = false;
        e.shieldBreakFx = 0.4;
        spawnParticles(ex, ey, "#ffffff", 18, 220, 0.5);
        sfx.hit();
        continue;
      }
      // Legendary AI: elites are too heavy to be knocked back by Air Blast,
      // but a hit still teaches them something — each one remembers which
      // side it keeps getting blasted from, and reacts faster to that side
      // next time it attacks (see the "elite" branch in updateEnemies).
      if (e.type === "elite") {
        if (!e.hitSides) e.hitSides = { left: 0, right: 0 };
        if (cx < ex) e.hitSides.left++; else e.hitSides.right++;
        e.hitFlash = 0.15;
        spawnParticles(ex, ey, "#b98cff", 8, 140, 0.25);
        sfx.hit();
        continue;
      }
      // Cloner: bullets can't finish it off (see the projectile-hit loop),
      // but a close, direct Air Blast hit kills it outright — clones
      // included, since they're marked canSplit:false and never split again.
      if (e.type === "cloner" && dist < CLONER_DIRECT_HIT_RADIUS) {
        e.alive = false;
        spawnParticles(ex, ey, "#5cffb0", 20, 220, 0.5);
        sfx.hit();
        registerKill(SCORE_ENEMY, ex, ey, "#5cffb0");
        continue;
      }

      // Thief: handled entirely in updateEnemies (patrol/telegraph/dash
      // state machine) — a blast hit here just knocks it back like a
      // normal light enemy, same as walker/fast/chaser; it doesn't drop
      // or lose anything from being punched. See the "thief" branch in
      // updateEnemies for how the steal itself actually happens.

      if (e.type === "walker" || e.type === "fast" || e.type === "chaser" || e.type === "bomber" || e.type === "cloner" || e.type === "trapper" || e.type === "thief") {
        // must be roughly in front of the jet (aimed direction), not just
        // anywhere nearby, so the punch only lands on whoever's in the way
        const align = dist > 0.001 ? (edx * aimX + edy * aimY) / dist : 1;
        if (align < BLAST_CONE_DOT) {
          // Dodge reaction: a chaser that's alert and nearby but not lined up
          // to actually get hit has a chance to flinch/hop away on reflex,
          // instead of just standing there ignoring the gust that missed it.
          if (e.type === "chaser" && dist < BLAST_HIT_RADIUS * 1.4 && Math.random() < 0.55) {
            e.panicTime = 0.3;
            e.panicVX = Math.sign(ex - cx || 1) * 200;
            spawnParticles(ex, ey, "#ffffff", 5, 90, 0.2);
          }
          continue;
        }
        // Getting punched away always defuses a Bomber's fuse, even if it
        // had already armed — this is the intended safe counterplay.
        if (e.type === "bomber") { e.armed = false; e.fuseTimer = 0; }
        punchTargets.push({ e, ex, ey, dist });
      }
    }
    punchTargets.sort((a, b) => a.dist - b.dist);
    punchTargets.forEach((t, i) => {
      const e = t.e;
      const primary = i === 0;
      e.knockbackVX = aimX * (primary ? BLAST_LAUNCH_KNOCKBACK_SPEED : BLAST_CHAIN_KNOCKBACK_SPEED);
      e.knockbackVY = primary ? BLAST_LAUNCH_VY : BLAST_CHAIN_VY;
      e.knockbackGroundY = e.y;
      e.knockbackTime = BLAST_KNOCKBACK_TIME;
      e.hitFlash = primary ? 0.2 : 0.12;
      spawnParticles(t.ex, t.ey, "#ffffff", primary ? 16 : 8, primary ? 240 : 140, primary ? 0.4 : 0.25);
      // "feeds" the gust straight through the enemy in the blast direction —
      // reads as the air actually punching through them, not just a static burst
      const feedCount = primary ? 6 : 3;
      for (let k = 0; k < feedCount; k++) {
        spawnStreak(t.ex - aimX * 12, t.ey - aimY * 12, "#bfe8ff", aimX, aimY, 240, primary ? 0.24 : 0.18, primary ? 18 : 13);
      }
    });

    // 3) Versus mode: Air Blast also hits the opposing player at close range.
    if (mp.active && mp.mode === "versus" && mp.roundActive && player2.connected) {
      const p2x = player2.x + player2.w / 2, p2y = player2.y + player2.h / 2;
      if (Math.hypot(p2x - cx, p2y - cy) < BLAST_HIT_RADIUS) {
        const dmg = 16;
        MP.sendCtrl({ t: "hit", dmg });
        player2.health = Math.max(0, player2.health - dmg); // optimistic local prediction; corrected by next snapshot
        spawnParticles(p2x, p2y, "#ffffff", 14, 220, 0.4);
        sfx.hit();
      }
    }
    // PHASE 1 (FFA/Team): same close-range blast check, generalized over
    // every remote player instead of the single player2 mirror.
    if (mp.active && (mp.mode === "ffa" || mp.mode === "team") && mp.ffaAlive) {
      Object.keys(remotePlayers).forEach((id) => {
        const rp = remotePlayers[id];
        if (!rp.alive || !rp.connected) return;
        if (mp.mode === "team" && rp.team === myFfaTeam) return; // no friendly fire
        const rx = rp.x + PLAYER_W / 2, ry = rp.y + PLAYER_H / 2;
        if (Math.hypot(rx - cx, ry - cy) < BLAST_HIT_RADIUS) {
          const dmg = 16;
          sendFfaHit(id, dmg);
          rp.health = Math.max(0, rp.health - dmg); // optimistic; corrected by next host broadcast
          spawnParticles(rx, ry, "#ffffff", 14, 220, 0.4);
          sfx.hit();
        }
      });
    }
  }

  function tryEnergyPulse() {
    // Machine gun cooldown AND energy limit removed per request — it fires
    // nonstop for as long as the button/key is held, no downtime, no running out.
    player.pulseCooldown = 0;

    // auto-turret aim: fire toward wherever the joystick/arrows are
    // pointing (joystick.aimDx/aimDy keeps the last aimed direction even
    // after the stick is released); fall back to facing direction when
    // there's no active aim input at all.
    let adx = joystick.aimDx, ady = joystick.aimDy;
    const amag = Math.hypot(adx, ady);
    if (!joystick.active || amag < 0.2) { adx = player.facing; ady = 0; }
    else { adx /= amag; ady /= amag; }
    const aimAng = Math.atan2(ady, adx);

    const muzzleX = player.x + player.w / 2 + adx * (player.w / 2 + 4);
    const muzzleY = player.y + player.h / 2 + ady * (player.h / 2 + 4);
    const dmg = effPulseDamage() * (player.overchargeTime > 0 ? 2 : 1);
    const spreadAmt = player.rapidTime > 0 ? 0.09 : 0.05;
    const shots = player.rapidTime > 0 ? [-spreadAmt, spreadAmt] : [rand(-spreadAmt, spreadAmt)];
    for (const spread of shots) {
      const ang = aimAng + spread;
      projectiles.push({
        x: muzzleX, y: muzzleY,
        vx: Math.cos(ang) * PULSE_SPEED, vy: Math.sin(ang) * PULSE_SPEED,
        life: PULSE_RANGE / PULSE_SPEED, friendly: true, r: 9, dmg
      });
    }
    if (Math.abs(adx) > 0.15) player.facing = adx > 0 ? 1 : -1;
    spawnParticles(muzzleX, muzzleY, "#ffcf5c", 5, 90, 0.12); // muzzle flash
    spawnParticles(muzzleX, muzzleY, "#8a5a1f", 2, 60, 0.25); // ejected shell casing
    sfx.pulse();
    vibrate(10);
    screenShake = Math.min(4, screenShake + 1.5); // light recoil kick
    updateEnergyUI();
  }

  // ---------------------------------------------------------
  // UPDATE
  // ---------------------------------------------------------
  let lastTime = performance.now();

  function update(dt) {
    dt = Math.min(dt, 1 / 30);
    if (state !== STATE.PLAYING) return;

    player.blastCooldown = Math.max(0, player.blastCooldown - dt);
    player.pulseCooldown = Math.max(0, player.pulseCooldown - dt);
    player.invuln = Math.max(0, player.invuln - dt);
    player.blastFx = Math.max(0, player.blastFx - dt);
    player.shieldTime = Math.max(0, player.shieldTime - dt);
    player.rapidTime = Math.max(0, player.rapidTime - dt);
    player.overchargeTime = Math.max(0, player.overchargeTime - dt);
    player.wallTime = Math.max(0, player.wallTime - dt);
    screenShake = Math.max(0, screenShake - dt * 20);

    if (comboTimer > 0) {
      comboTimer -= dt;
      if (comboTimer <= 0) { comboCount = 0; updateComboUI(); }
    }

    if (timeAttackMode) {
      timeAttackElapsed += dt;
      const taTimerEl = document.getElementById("timeAttackTimer");
      if (taTimerEl) taTimerEl.textContent = "⏱️ " + timeAttackElapsed.toFixed(1);
    }

    if (player.energy < player.maxEnergy) {
      player.energy = Math.min(player.maxEnergy, player.energy + ENERGY_REGEN * dt);
      updateEnergyUI();
    }

    // Air Blast: the initial press fires one full-strength pulse immediately;
    // while the button stays held, keep re-firing softer sustained pulses at
    // a steady interval so the player glides upward smoothly and continuously
    // for as long as it's pressed, instead of a single hop.
    // PHASE 3 (co-op): a downed player is frozen — no blast, no shooting —
    // until a teammate revives them (see updateCoopRevive()).
    if (player.down) {
      input.blast = false; input.blastHeld = false; input.pulseHeld = false;
      player.blastHoldTimer = 0; player.blastChargeTime = 0;
    } else if (input.blast) {
      tryAirBlast(false);
      input.blast = false;
      player.blastHoldTimer = BLAST_HOLD_INTERVAL;
      player.blastChargeTime = 0;
    } else if (input.blastHeld) {
      player.blastChargeTime = Math.min(CHARGE_MAX_TIME, player.blastChargeTime + dt);
      player.blastHoldTimer -= dt;
      if (player.blastHoldTimer <= 0) {
        tryAirBlast(true);
        player.blastHoldTimer = BLAST_HOLD_INTERVAL;
      }
    } else {
      player.blastHoldTimer = 0;
      player.blastChargeTime = 0;
    }
    if (input.pulseHeld && !player.down) { tryEnergyPulse(); }
    updateButtonStates();

    // Ease the Air Blast velocity in over a real, feel-able window instead
    // of snapping to it instantly, so it reads as flying/gliding rather
    // than a sudden hop.
    if (player.blastEase > 0) {
      const ease = clamp(dt * 5, 0, 1);
      player.vx += (player.blastTargetVX - player.vx) * ease;
      player.vy += (player.blastTargetVY - player.vy) * ease;
      player.blastEase = Math.max(0, player.blastEase - dt * 3);

      // wind trail: directional streaks peeling off behind the player,
      // opposite to the direction of travel, for as long as the blast is
      // carrying them — this is what actually reads as "flying through
      // air" rather than a jump arc.
      const bcx = player.x + player.w / 2, bcy = player.y + player.h / 2;
      const speed = Math.hypot(player.vx, player.vy);
      if (speed > 30) {
        const tdx = -player.vx / speed, tdy = -player.vy / speed; // trailing = opposite of travel
        const tc = getTrailColor();
        if (Math.random() < 0.8) {
          spawnStreak(bcx + tdx * 6, bcy + tdy * 6, tc, tdx, tdy, 70, 0.28, 15);
        }
        if (Math.random() < 0.4) {
          spawnParticles(bcx + tdx * 4, bcy + tdy * 4, tc, 1, 40, 0.24);
        }
      }

      // low skim: if the blast is carrying the player close to the ground
      // (a horizontal dash rather than a climb), keep kicking up light dust
      // at their feet the whole time they're skimming, not just at launch.
      if (player.onGround === false && player.y + player.h > GROUND_Y - 26 && Math.abs(player.vx) > 80 && Math.random() < 0.5) {
        const tdx2 = player.vx > 0 ? -1 : 1;
        spawnParticles(player.x + player.w / 2 + tdx2 * 10, player.y + player.h - 2, "#aab8c2", 1, 70, 0.32, "dust");
      }
    }

    const jx = player.down ? 0 : (Math.abs(joystick.dx) > 0.15 ? joystick.dx : 0);
    // PHASE 7 — the Hunter moves faster, escalating over the round; every
    // step is announced (see checkHuntedEscalation), never a silent buff.
    const huntedSpeedMul = (mp.active && mp.mode === "hunted" && mp.huntedRole === "hunter")
      ? (1 + mp.huntedEscalation * HUNTED_SPEED_STEP) : 1;
    const targetSpeed = (player.onGround ? MOVE_SPEED : AIR_MOVE_SPEED) * jx * huntedSpeedMul;
    if (jx !== 0) {
      player.vx += (targetSpeed - player.vx) * clamp(dt * 10, 0, 1);
      player.facing = jx > 0 ? 1 : -1;
    } else if (player.onGround) {
      const drop = FRICTION_GROUND * dt;
      if (Math.abs(player.vx) <= drop) player.vx = 0;
      else player.vx -= Math.sign(player.vx) * drop;
    }

    // lighten gravity while still riding out a blast, so it arcs through
    // the air like flight instead of gravity yanking it back down like a jump
    const gravityMul = player.blastEase > 0 ? 0.4 + 0.6 * (1 - player.blastEase) : 1;
    player.vy += GRAVITY * gravityMul * dt;
    player.vy = Math.min(player.vy, 1400);

    player.x += player.vx * dt;
    player.y += player.vy * dt;
    player.onGround = false;

    // update moving platforms first
    for (const m of level.movers) {
      m.t += dt * m.speed;
      if (m.horizontal) m.x = m.baseX + Math.sin(m.t) * m.range;
      else m.y = m.baseY + Math.sin(m.t) * m.range;
    }

    for (const p of level.platforms) {
      if (aabb(player, p)) {
        const prevBottom = player.y - player.vy * dt + player.h;
        if (player.vy >= 0 && prevBottom <= p.y + 6) {
          player.y = p.y - player.h;
          player.vy = 0;
          player.onGround = true;
          if (p.type === "moving") {
            // carry player with moving platform
            player.x += (p.horizontal ? Math.cos(p.t) * p.range * p.speed * dt : 0);
          }
        } else if (player.vy < 0 && player.y - player.vy * dt >= p.y + p.h - 6) {
          player.y = p.y + p.h;
          player.vy = 0;
        } else {
          if (player.x + player.w / 2 < p.x + p.w / 2) { player.x = p.x - player.w; player.wallSide = 1; }
          else { player.x = p.x + p.w; player.wallSide = -1; }
          player.vx = 0;
          player.wallTime = WALL_TOUCH_GRACE;
        }
      }
    }

    player.x = clamp(player.x, 0, level.length - player.w);

    // Recovery Blast tracking: counts continuous time spent airborne and
    // actually falling (not still rising from a blast) - grounding or a
    // fresh blast both clear it (see tryAirBlast).
    if (!player.onGround && player.vy > 40) fallTime += dt;
    else fallTime = 0;

    // trap contact
    for (const t of level.traps) {
      if (aabb(player, t)) damagePlayer(20, false);
    }

    if (player.y > GROUND_Y + 200) {
      // BUGFIX: currentLevelNum is only updated by loadLevel(), so it stays
      // stale at whatever single-player level was last loaded once a
      // Versus match starts (startVersusMatch/startVersusRound never touch
      // it). Without the `!mp.active` guard, falling off the small Versus
      // arena right after having played level 13 in single-player would
      // wrongly trigger THE HELL mid-duel instead of a normal respawn.
      if (currentLevelNum === 13 && !level.isHell && !level.isSing && !mp.active) {
        enterTheHell();
        return;
      }
      if (currentLevelNum === 26 && !level.isLevel26Gauntlet && !level.isSing && !mp.active) {
        enterLevel26Gauntlet();
        return;
      }
      damagePlayer(FALL_DAMAGE, true);
      respawnAtCheckpoint();
    }

    // THE HELL wave progression: once every enemy in the current wave is
    // dead, wait a beat then either spawn the next wave or, once all
    // waves are cleared, finish the level.
    if (level.isHell && !hellState.finished) {
      // ambient hellfire: embers keep drifting up near the player the
      // whole fight, so the arena reads as actively hostile, not static
      hellState.emberTimer = (hellState.emberTimer || 0) + dt;
      if (hellState.emberTimer > 0.12) {
        hellState.emberTimer = 0;
        const ex = player.x + player.w / 2 + rand(-260, 260);
        spawnParticles(ex, GROUND_Y + rand(-10, 10), Math.random() < 0.5 ? "#ff5c1a" : "#ff2f1a", 2, 60, rand(0.5, 0.9), "dust");
      }
      if (level.enemies.length && level.enemies.every(e => !e.alive)) {
        hellState.clearTimer += dt;
        if (hellState.clearTimer > 1.1) {
          if (hellState.phase < hellState.waves.length) spawnHellWave(hellState.phase);
          else completeHell();
        }
      } else {
        hellState.clearTimer = 0;
      }
    }

    // LEVEL 26 EASTER EGG — same wave-clear/advance loop as THE HELL above.
    if (level.isLevel26Gauntlet && !level26State.finished) {
      if (level.enemies.length && level.enemies.every(e => !e.alive)) {
        level26State.clearTimer += dt;
        if (level26State.clearTimer > 1.1) {
          if (level26State.phase < level26State.waves.length) spawnLevel26Wave(level26State.phase);
          else completeLevel26Gauntlet();
        }
      } else {
        level26State.clearTimer = 0;
      }
    }

    // غنيها يا معلم — completely separate loop, never touches hellState.
    // Gameplay timing runs off its own elapsed clock (advanced by dt below,
    // which already only flows while state === PLAYING) instead of the
    // <audio> element's currentTime - some browsers block autoplay outright,
    // and combat used to freeze completely (0 enemies, silence) whenever
    // that happened, since everything was gated on audio actually playing.
    // Now the fight always runs on schedule; the song plays alongside it
    // whenever the browser allows it (attemptSingAudioPlay/retrySingAudioOnce
    // handle getting sound going, including a retry on the next tap).
    if (level.isSing && singMode.active) {
      singMode.elapsed += dt;
      const t = singMode.elapsed;
      let spawnedThisFrame = false;
      while (singMode.beatIdx < singMode.beats.length && singMode.beats[singMode.beatIdx].t <= t) {
        spawnSingBeatEnemies(singMode.beats[singMode.beatIdx].strength);
        singMode.beatIdx++;
        spawnedThisFrame = true;
        singMode.nextBaselineAt = t + 1.4; // a real beat just fired - push the baseline back so it doesn't double up
      }
      if (t >= singMode.nextBaselineAt) {
        // Interval tightens as the song goes on (2.0s -> 0.9s), so the
        // fight ramps up over the track the way a survival mode would.
        // Strength ramps up right alongside it, same as a detected beat would.
        const progress = singMode.duration > 0 ? clamp(t / singMode.duration, 0, 1) : 0;
        const interval = 2.0 - progress * 1.1;
        spawnSingBeatEnemies(progress);
        singMode.nextBaselineAt = t + interval;
        spawnedThisFrame = true;
      }
      if (!spawnedThisFrame && Math.random() < dt * 1.2) {
        const ex = player.x + player.w / 2 + rand(-260, 260);
        spawnParticles(ex, GROUND_Y + rand(-10, 10), "#a86bff", 1, 50, rand(0.5, 0.9), "dust");
      }
      const audioDone = singMode.audioEl && singMode.audioStarted && singMode.audioEl.ended;
      if (audioDone || t >= singMode.duration - 0.05) {
        completeSingMode();
        return;
      }
    }

    const targetCam = clamp(player.x - VW / 2 + player.w / 2, 0, Math.max(0, level.length - VW));
    camera.x += (targetCam - camera.x) * clamp(dt * 6, 0, 1);
    recordPlayerHistory(dt);

    updateMpSync(dt);
    if (mp.active && mp.mode === "versus") {
      if (mp.roundActive && MP.isHost() && performance.now() > mpNextPowerupAt) spawnVersusPowerup();
      updateVersusHud();
    }
    // PHASE 3 (co-op): only the host runs real enemy AI. The guest mirrors
    // host's enemies (via mpApplyIncomingState's "cw" branch) and only
    // checks contact damage against them — see updateCoopGuestContact().
    const coopIsGuest = mp.active && mp.mode === "coop" &&
      ((mp.coopTransport === "room" && !ffaIsHost) || (mp.coopTransport !== "room" && !MP.isHost()));
    if (coopIsGuest) {
      if (mp.coopTransport === "room") updateRoomCoopGuestContact();
      else updateCoopGuestContact();
    } else {
      updateEnemies(dt);
    }
    if (mp.active && mp.mode === "coop") {
      if (mp.coopTransport === "room") {
        updateRoomCoopSync(dt);
        updateRoomCoopWaveProgress();
        updateRoomCoopRevive(dt);
      } else {
        updateCoopWaveProgress();
        updateCoopRevive(dt);
      }
    }
    if (mp.active && (mp.mode === "ffa" || mp.mode === "team")) {
      updateFfaSync(dt);
    }
    if (mp.active && mp.mode === "race") {
      updateRaceSync(dt);
    }
    if (mp.active && mp.mode === "bossrush") {
      updateBossRushSync(dt);
    }
    if (mp.active && mp.mode === "hunted") {
      updateHuntedSync(dt);
    }
    // PHASE 6 (Boss Rush): only the host runs the real boss AI — a guest
    // running its own copy against its own local `player` would fight a
    // second, conflicting boss (same reasoning as co-op's enemies above).
    if (level.boss && !(mp.active && mp.mode === "bossrush" && !ffaIsHost)) updateBoss(dt);
    else if (mp.active && mp.mode === "bossrush" && !ffaIsHost) updateBossRushGuestContact();
    updateProjectiles(dt);
    updateShockwaves(dt);
    updateGems();
    updatePowerups();
    updateCheckpoints();
    updateParticles(dt);
    updateGhost(dt); // PHASE 11 — visual-only, no collision, safe in any state

    if (!level.boss && !mp.active) {
      if (aabb(player, level.goal)) triggerLevelComplete();
    }
    if (mp.active && mp.mode === "race" && !mp.raceFinished && level.goal && aabb(player, level.goal)) {
      handleRaceFinish();
    }
    if (level.isTutorial) updateTutorialHints();

    updateHealthUI();
  }

  function updateGems() {
    for (const g of level.gems) {
      if (g.collected) continue;
      const dx = (player.x + player.w / 2) - g.x;
      const dy = (player.y + player.h / 2) - g.y;
      if (Math.hypot(dx, dy) < g.r + 20) {
        g.collected = true;
        collectedGemsTotal++;
        spawnParticles(g.x, g.y, "#ffe066", 14, 200, 0.5);
        sfx.gem();
        updateGemUI();
        if (g.secret) addScore(SCORE_SECRET_GEM, g.x, g.y, `سري! +${SCORE_SECRET_GEM}`, "#ffd166");
        else addScore(SCORE_GEM, g.x, g.y, `+${SCORE_GEM}`, "#7fe0ff");
      }
    }
  }

  function applyPowerup(type) {
    if (type === "shield") {
      player.shieldTime = POWERUP_DURATION.shield;
    } else if (type === "rapid") {
      player.rapidTime = POWERUP_DURATION.rapid;
    } else if (type === "overcharge") {
      player.overchargeTime = POWERUP_DURATION.overcharge;
    }
  }

  function updatePowerups() {
    if (!level.powerups) return;
    for (const p of level.powerups) {
      if (p.collected) continue;
      const dx = (player.x + player.w / 2) - p.x;
      const dy = (player.y + player.h / 2) - p.y;
      if (Math.hypot(dx, dy) < p.r + 20) {
        p.collected = true;
        applyPowerup(p.type);
        const color = POWERUP_COLORS[p.type];
        spawnParticles(p.x, p.y, color, 18, 220, 0.5);
        sfx.gem();
        vibrate(20);
        const labels = { shield: "🛡️ درع!", rapid: "🔫 رشاش مزدوج!", overcharge: "💥 ضرر مضاعف!" };
        spawnFloatText(p.x, p.y, labels[p.type], color);
        if (mp.active && mp.mode === "versus" && p.id !== undefined) {
          MP.sendCtrl({ t: "powerupTaken", id: p.id });
        }
      }
    }
  }

  // PHASE 8 — activates a checkpoint the instant the player walks over it.
  // Single-player only: Co-op/FFA/Team/Race all build their own arena or
  // shared level fresh per match (see buildCoopArena / startRoomRaceMatch)
  // and don't route through level.checkpoints, so no "shared vs per-player"
  // checkpoint split is needed here.
  function updateCheckpoints() {
    if (!level.checkpoints || mp.active) return;
    for (const cp of level.checkpoints) {
      if (cp.activated) continue;
      if (Math.abs((player.x + player.w / 2) - cp.x) < 40 && player.y + player.h >= cp.y - 60) {
        cp.activated = true;
        player.activeCheckpoint = cp;
        spawnParticles(cp.x, cp.y - 30, "#5cff8a", 14, 200, 0.5);
        spawnFloatText(cp.x, cp.y - 60, "✅ نقطة حفظ", "#5cff8a");
        sfx.gem();
      }
    }
  }

  // Real checkpoint respawn: goes to the last checkpoint object the player
  // actually reached this level, not the nearest ground segment to wherever
  // they happened to be standing (the old, fake behavior).
  function respawnAtCheckpoint() {
    usedCheckpointThisLevel = true; // PHASE 12 — falling back on a checkpoint voids Perfect Run, even if the next segment is then played with no damage
    if (player.activeCheckpoint) {
      player.x = player.activeCheckpoint.x;
      player.y = player.activeCheckpoint.y - player.h;
    } else {
      player.x = level.startX;
      player.y = level.startY;
    }
    player.vx = 0;
    player.vy = 0;
    player.invuln = 1.0;
  }

  // killing the specific thief that stole the Air Blast is what gives it
  // back — killing any other enemy while it's stolen does nothing, since
  // the ability physically left with the one that took it
  function reclaimBlastIfStolenBy(e) {
    if (e.type === "thief" && e.hasStolenBlast) {
      e.hasStolenBlast = false;
      player.blastStolen = false;
      spawnFloatText(player.x + player.w / 2, player.y - 30, "استرجعت البلاست!", "#5cff8a");
      sfx.phase();
    }
  }

  function damagePlayer(amount, ignoreInvuln) {
    if (!ignoreInvuln && player.invuln > 0) return;
    if (player.shieldTime > 0) {
      // the shield power-up fully blocks damage but doesn't stop the knockback/fall trigger
      spawnParticles(player.x + player.w / 2, player.y + player.h / 2, "#6fe9ff", 10, 180, 0.35);
      sfx.hit();
      return;
    }
    // Perfect Dodge: an Air Blast fired in the last instant fully negates
    // this hit and grants a short bonus invulnerability + score reward.
    if (!ignoreInvuln && performance.now() - lastBlastAt < PERFECT_DODGE_WINDOW) {
      lastBlastAt = -999; // consume it so one blast can't dodge repeatedly
      player.invuln = Math.max(player.invuln, 0.5);
      spawnParticles(player.x + player.w / 2, player.y + player.h / 2, "#ffffff", 16, 240, 0.4);
      // Perfect Dodges now chain into the same combo multiplier as kills,
      // rewarding stringing dodges and kills together into one hot streak.
      registerKill(30, player.x + player.w / 2, player.y - 10, "#ffffff");
      spawnFloatText(player.x + player.w / 2, player.y - 28, "تفادي مثالي!", "#ffffff");
      sfx.hit();
      vibrate(15);
      return;
    }
    player.health -= amount;
    player.invuln = INVULN_TIME;
    levelNoDamage = false;
    comboCount = 0;
    updateComboUI();
    screenShake = 8;
    spawnParticles(player.x + player.w / 2, player.y + player.h / 2, "#ff5c7a", 12, 200, 0.4);
    sfx.hurt();
    vibrate(35);
    if (player.health <= 0) {
      player.health = 0;
      updateHealthUI();
      vibrate([40, 60, 80]);
      // BUGFIX: same stale-currentLevelNum issue as the fall-off-arena
      // check above — must not fire while any multiplayer match is active.
      if (currentLevelNum === 13 && !level.isHell && !level.isSing && !mp.active) {
        enterTheHell();
      } else if (currentLevelNum === 26 && !level.isLevel26Gauntlet && !level.isSing && !mp.active) {
        enterLevel26Gauntlet();
      } else if (mp.active && mp.mode === "versus") {
        handleVersusRoundLoss();
      } else if (mp.active && mp.mode === "coop") {
        enterCoopDown();
      } else if (mp.active && (mp.mode === "ffa" || mp.mode === "team" || mp.mode === "bossrush")) {
        eliminateFfaPlayer();
      } else if (mp.active && mp.mode === "race") {
        // Race has no elimination — just a costly reset to the last
        // checkpoint, same as single-player, so the race stays alive.
        player.health = player.maxHealth;
        spawnFloatText(player.x + player.w / 2, player.y - 20, "🔄 رجعت لآخر نقطة", "#ffcf5c");
        respawnAtCheckpoint();
        updateHealthUI();
      } else {
        if (level.isSing && singMode.active) {
          singMode.active = false;
          if (singMode.audioEl) singMode.audioEl.pause();
        }
        triggerGameOver();
      }
    }
  }

  function updateEnemies(dt) {
    for (const e of level.enemies) {
      if (!e.alive) continue;
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      if (e.shieldBreakFx > 0) e.shieldBreakFx -= dt;

      // Air Blast knockback overrides normal AI for a short window: enemy
      // gets shoved along the blast direction and can be knocked into a
      // trap, or clean off the edge of its patrol ledge (falls to its death).
      // A punched-in-front enemy also gets a vertical launch (knockbackVY)
      // so it visibly flies up and arcs back down, instead of just sliding.
      if (e.knockbackTime > 0) {
        e.knockbackTime -= dt;
        e.x += e.knockbackVX * dt;
        e.knockbackVX *= 0.9;

        if (e.knockbackVY) {
          e.y += e.knockbackVY * dt;
          e.knockbackVY += GRAVITY * 0.6 * dt; // arcs back down like a real launch
          const groundY = e.knockbackGroundY !== undefined ? e.knockbackGroundY : e.y;
          if (e.y >= groundY) { e.y = groundY; e.knockbackVY = 0; }
        }

        let dead = false;
        for (const t of level.traps) {
          if (aabb(e, t)) { dead = true; break; }
        }
        const lo = (e.w0 !== undefined ? e.w0 : -Infinity) - 46;
        const hi = (e.w1 !== undefined ? e.w1 : Infinity) + 46;
        if (e.x < lo || e.x > hi) dead = true;

        if (dead) {
          e.alive = false;
          spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#ff9142", 18, 240, 0.5);
          sfx.hit();
          registerKill(SCORE_ENEMY, e.x + e.w / 2, e.y, "#ff9142");
          reclaimBlastIfStolenBy(e);
          continue;
        }
        if (aabb(player, e)) damagePlayer(e.damage, false);
        continue;
      }

      if (e.type === "walker" || e.type === "shield" || e.type === "cloner") {
        e.x += e.dir * e.speed * dt;
        if (e.x < e.w0) { e.x = e.w0; e.dir = 1; }
        if (e.x > e.w1) { e.x = e.w1; e.dir = -1; }
      } else if (e.type === "bomber") {
        e.x += e.dir * e.speed * dt;
        if (e.x < e.w0) { e.x = e.w0; e.dir = 1; }
        if (e.x > e.w1) { e.x = e.w1; e.dir = -1; }
        const bdx = (player.x + player.w / 2) - (e.x + e.w / 2);
        const bdy = (player.y + player.h / 2) - (e.y + e.h / 2);
        const bdist = Math.hypot(bdx, bdy);
        if (bdist < BOMBER_FUSE_RANGE) {
          e.armed = true;
          e.fuseTimer += dt;
          if (Math.sin(e.fuseTimer * 26) > 0) e.hitFlash = 0.05; // rapid warning flicker
          if (e.fuseTimer >= BOMBER_ARM_TIME) {
            e.alive = false;
            spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#ff8a3d", 26, 260, 0.6);
            screenShake = Math.max(screenShake, 10);
            sfx.hit();
            vibrate([20, 30, 40]);
            const pdx = (player.x + player.w / 2) - (e.x + e.w / 2);
            const pdy = (player.y + player.h / 2) - (e.y + e.h / 2);
            if (Math.hypot(pdx, pdy) < BOMBER_EXPLOSION_RADIUS) damagePlayer(BOMBER_EXPLOSION_DAMAGE, false);
            registerKill(SCORE_ENEMY, e.x + e.w / 2, e.y, "#ff8a3d");
            continue;
          }
        } else if (bdist > BOMBER_DISARM_RANGE && e.armed) {
          // stepped/pushed out of range in time — fuse cancels
          e.armed = false;
          e.fuseTimer = 0;
        }
      } else if (e.type === "trapper") {
        const tdx = (player.x + player.w / 2) - (e.x + e.w / 2);
        if (Math.abs(tdx) < TRAPPER_FLEE_RANGE) {
          // flee: keep moving away from the player, staying within its patrol bounds
          e.dir = tdx > 0 ? -1 : 1;
          e.x += e.dir * e.speed * dt;
        } else {
          e.x += e.dir * e.speed * 0.3 * dt;
        }
        if (e.x < e.w0) { e.x = e.w0; e.dir = 1; }
        if (e.x > e.w1) { e.x = e.w1; e.dir = -1; }
        e.dropTimer -= dt;
        if (e.dropTimer <= 0 && e.dropsLeft > 0 && Math.abs(tdx) < TRAPPER_FLEE_RANGE) {
          e.dropTimer = TRAPPER_DROP_INTERVAL;
          e.dropsLeft--;
          level.traps.push({ x: e.x + e.w / 2 - 13, y: e.y + e.h - 14, w: 26, h: 14 });
          spawnParticles(e.x + e.w / 2, e.y + e.h - 8, "#ff2f5b", 8, 80, 0.3);
        }
      } else if (e.type === "thief") {
        const pcx = player.x + player.w / 2, pcy = player.y + player.h / 2;
        const ecx = e.x + e.w / 2, ecy = e.y + e.h / 2;
        const dx = pcx - ecx, dy = pcy - ecy;
        const dist = Math.hypot(dx, dy) || 1;

        if (e.hasStolenBlast) {
          // it's got what it came for — pure evasion from now on, at a
          // wider range and a bit faster, until the player kills it.
          e.state = "flee";
          const fx = -dx / dist, fy = -dy / dist;
          e.x = clamp(e.x + fx * THIEF_FLEE_SPEED * dt, e.w0, e.w1);
          e.y = clamp(e.y + fy * THIEF_FLEE_SPEED * 0.5 * dt, e.y - 4, e.y + 4);
          e.dir = fx >= 0 ? 1 : -1;
        } else if (e.telegraph > 0) {
          // wind-up before the dash: stands still and visibly charges
          // (see drawEnemy) so an alert player can react/dodge/attack first
          e.telegraph -= dt;
          if (e.telegraph <= 0) {
            // "learning": the more dashes that have actually landed, the
            // further ahead it leads its target — a thief that's stolen
            // once before reads the player's movement better next time.
            e.predictTime = Math.min(0.15 + e.dashesLanded * 0.06, 0.4);
            const targetX = pcx + player.vx * e.predictTime;
            const targetY = pcy + player.vy * e.predictTime * 0.4;
            const ddx = targetX - ecx, ddy = targetY - ecy;
            const dd = Math.hypot(ddx, ddy) || 1;
            e.dashVX = (ddx / dd) * THIEF_DASH_SPEED;
            e.dashVY = (ddy / dd) * THIEF_DASH_SPEED;
            e.dashTimer = 0.45; // dash duration
            e.state = "dash";
            e.dashesAttempted++;
            spawnParticles(ecx, ecy, "#ffcf5c", 10, 160, 0.25);
          }
        } else if (e.state === "dash") {
          e.dashTimer -= dt;
          e.x += e.dashVX * dt;
          e.y += e.dashVY * dt;
          e.dir = e.dashVX >= 0 ? 1 : -1;
          spawnStreak(ecx, ecy, "#ffcf5c", Math.sign(e.dashVX) || 1, 0, 200, 0.16, 12);
          if (e.dashTimer <= 0 || e.x < e.w0 - 40 || e.x > e.w1 + 40) {
            e.state = "patrol";
            e.x = clamp(e.x, e.w0, e.w1);
            e.dashTimer = rand(1.2, 2.0);
          }
        } else {
          // patrol/stalk: keeps roughly THIEF_KEEP_DIST away from the
          // player instead of walking into melee range like a normal enemy
          if (dist < THIEF_KEEP_DIST) {
            e.x = clamp(e.x - (dx / dist) * e.speed * dt, e.w0, e.w1);
          } else if (dist < THIEF_TRIGGER_DIST) {
            e.x = clamp(e.x + (dx / dist) * (e.speed * 0.3) * dt, e.w0, e.w1);
          } else {
            e.x += e.dir * (e.speed * 0.5) * dt;
            if (e.x < e.w0) { e.x = e.w0; e.dir = 1; }
            if (e.x > e.w1) { e.x = e.w1; e.dir = -1; }
          }
          e.dir = dx >= 0 ? 1 : -1;
          e.dashTimer -= dt;
          if (e.dashTimer <= 0 && dist < THIEF_TRIGGER_DIST) {
            e.telegraph = 0.35; // clear wind-up window before it commits
          }
        }

        // contact while dashing (not just standing near the player) is
        // what actually lands the steal — a passive graze while patrolling
        // does not
        if (e.state === "dash" && !e.hasStolenBlast && !player.blastStolen && aabb(player, e)) {
          player.blastStolen = true;
          e.hasStolenBlast = true;
          e.dashesLanded++;
          e.dashVX = 0; e.dashVY = 0;
          spawnParticles(pcx, pcy, "#ffcf5c", 22, 260, 0.5);
          spawnFloatText(pcx, player.y - 30, "السارق سرق البلاست!", "#ffcf5c");
          sfx.hurt();
          vibrate([30, 40, 60]);
        }
      } else if (e.type === "mirror") {
        const delayed = getPlayerHistoryAt(mirrorClock - MIRROR_DELAY);
        if (delayed && Math.abs(delayed.vx) > 5) e.dir = delayed.vx > 0 ? 1 : -1;
        e.x += e.dir * e.speed * dt;
        if (e.x < e.w0) { e.x = e.w0; e.dir = 1; }
        if (e.x > e.w1) { e.x = e.w1; e.dir = -1; }
        // echo a blast the player fired MIRROR_DELAY seconds ago — cosmetic
        // only (it stays grounded), just a visible "it copied that too" beat
        while (e.nextBlastCheckIdx < blastPulseEvents.length &&
               blastPulseEvents[e.nextBlastCheckIdx] + MIRROR_DELAY <= mirrorClock) {
          spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#7fe0ff", 12, 160, 0.3);
          e.nextBlastCheckIdx++;
        }
      } else if (e.type === "fast") {
        e.flipTimer -= dt;
        e.x += e.dir * e.speed * dt;
        if (e.x < e.w0 || e.x > e.w1 || e.flipTimer <= 0) {
          e.dir *= -1;
          e.x = clamp(e.x, e.w0, e.w1);
          e.flipTimer = rand(0.4, 1.1);
        }
      } else if (e.type === "chaser") {
        if (e.panicTime > 0) {
          e.panicTime -= dt;
          e.x = clamp(e.x + e.panicVX * dt, e.w0, e.w1);
        } else {
          const dx = (player.x + player.w / 2) - (e.x + e.w / 2);
          if (Math.abs(dx) < e.aggroRange) {
            e.dir = dx > 0 ? 1 : -1;
            e.x += e.dir * e.speed * dt;
          } else {
            e.x += e.dir * (e.speed * 0.4) * dt;
          }
          e.x = clamp(e.x, e.w0, e.w1);
        }
      } else if (e.type === "flyer") {
        e.t += dt;
        e.x += Math.sin(e.t * 1.3) * e.speed * dt * 0.6;
        e.y = e.baseY + Math.sin(e.t * 2) * 40;
        // occasionally dive toward player
        if (Math.sin(e.t * 0.5) > 0.96) {
          e.y += Math.sign((player.y) - e.y) * 60 * dt;
        }
      } else if (e.type === "shooter") {
        e.x += e.dir * e.speed * dt;
        if (e.x < e.w0) { e.x = e.w0; e.dir = 1; }
        if (e.x > e.w1) { e.x = e.w1; e.dir = -1; }
        e.attackTimer -= dt;
        const distToPlayer = Math.hypot((player.x + player.w / 2) - (e.x + e.w / 2), (player.y + player.h / 2) - (e.y + e.h / 2));
        if (e.attackTimer <= 0 && distToPlayer < e.range) {
          e.attackTimer = rand(1.4, 2.2);
          const angle = Math.atan2((player.y + player.h / 2) - (e.y + e.h / 2), (player.x + player.w / 2) - (e.x + e.w / 2));
          projectiles.push({
            x: e.x + e.w / 2, y: e.y + e.h / 2,
            vx: Math.cos(angle) * 300, vy: Math.sin(angle) * 300,
            life: 2.2, friendly: false, r: 8
          });
          spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#5cff8a", 6, 100, 0.2);
          sfx.hit();
        }
      } else if (e.type === "elite") {
        if (e.telegraph > 0) {
          e.telegraph -= dt;
          if (e.telegraph <= 0) {
            e.chargeVX = Math.sign(player.x - e.x) * 260;
            e.chargeTime = 0.9;
          }
        } else if (e.chargeVX !== 0) {
          e.x += e.chargeVX * dt;
          e.x = clamp(e.x, e.w0, e.w1);
          e.chargeTime -= dt;
          if (e.chargeTime <= 0 || e.x <= e.w0 || e.x >= e.w1) e.chargeVX = 0;
        } else {
          e.x += e.dir * e.speed * dt;
          if (e.x < e.w0) { e.x = e.w0; e.dir = 1; }
          if (e.x > e.w1) { e.x = e.w1; e.dir = -1; }
          e.attackTimer -= dt;
          if (e.attackTimer <= 0 && Math.abs(player.x - e.x) < 400) {
            // Legendary AI: once it's taken a couple of blast hits, an elite
            // reacts noticeably faster (shorter telegraph) when the player
            // is currently approaching from whichever side it's mostly been
            // hit from — it's learned where the danger usually comes from.
            let telegraphTime = 0.5;
            if (e.hitSides) {
              const totalHits = e.hitSides.left + e.hitSides.right;
              if (totalHits >= 2) {
                const attackingFromLeft = player.x < e.x;
                const learnedSide = e.hitSides.left > e.hitSides.right ? "left" : "right";
                if ((attackingFromLeft && learnedSide === "left") || (!attackingFromLeft && learnedSide === "right")) {
                  telegraphTime = 0.35;
                }
              }
            }
            e.telegraph = telegraphTime;
            e.attackTimer = rand(1.8, 2.6);
            spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#ff2f5b", 10, 100, 0.4);
          }
        }
      } else if (e.type === "vacuum") {
        e.t += dt;
        const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
        const dx = ex - (player.x + player.w / 2), dy = ey - (player.y + player.h / 2);
        const dist = Math.hypot(dx, dy);
        if (dist < VACUUM_RANGE && dist > 4) {
          const pull = VACUUM_PULL_FORCE * (1 - dist / VACUUM_RANGE);
          player.vx += (dx / dist) * pull * dt;
          player.vy += (dy / dist) * pull * dt * 0.6;
          if (Math.sin(e.t * 8) > 0.7) spawnParticles(player.x + player.w / 2, player.y + player.h / 2, "#c65cff", 1, 40, 0.2);
        }
      }

      if (aabb(player, e)) damagePlayer(e.damage, false);
    }
  }

  function bossPhaseFromPct(pct) {
    if (pct > 0.8) return 1;
    if (pct > 0.6) return 2;
    if (pct > 0.4) return 3;
    if (pct > 0.2) return 4;
    return 5;
  }
  const BOSS_PHASE_PATTERNS = {
    1: ["burst"],
    2: ["burst", "charge"],
    3: ["burst", "charge", "slam"],
    4: ["burst", "charge", "slam", "spiral"],
    5: ["burst", "charge", "slam", "spiral", "barrage", "recoilSlam"]
  };
  const BOSS_PHASE_TAUNT = {
    1: "الزعيم",
    2: "الزعيم يتحمس!",
    3: "الزعيم يتشدد!",
    4: "الزعيم غاضب!",
    5: "الزعيم مستشاط غضبًا!"
  };

  function updateBoss(dt) {
    const b = level.boss;
    if (!b.alive) return;
    b.hitFlash = Math.max(0, b.hitFlash - dt);
    b.timer += dt;
    if (!b.stats) b.stats = { grounded: 0, airborne: 0, dashUses: 0, recentPatterns: [] };
    // PHASE 13 — passive behavior sampling: just accumulating simple,
    // already-available state (grounded vs airborne time) over the fight.
    if (player.onGround) b.stats.grounded += dt; else b.stats.airborne += dt;

    const hpPct = b.health / b.maxHealth;
    const wasPhase = b.phase;
    b.phase = bossPhaseFromPct(hpPct);
    b.enraged = b.phase >= 5;
    if (b.phase !== wasPhase) {
      sfx.phase();
      vibrate([30, 40, 30, 40, 60]);
      flashScreen("rgba(255,47,91,0.35)", 0.5);
      const nameEl = document.getElementById("bossName");
      const phaseEl = document.getElementById("bossPhaseText");
      if (nameEl) {
        nameEl.classList.toggle("enraged", b.phase >= 4);
        nameEl.textContent = BOSS_PHASE_TAUNT[b.phase] || "الزعيم";
      }
      if (phaseEl) phaseEl.textContent = `المرحلة القتالية ${b.phase}/5`;
      spawnParticles(b.x + b.w / 2, b.y + b.h / 2, "#ff2f5b", 24, 220, 0.6);
    }

    b.y = b.baseY + Math.sin(b.timer * 1.5) * 26;

    // combo enrage: a hot streak of kills right before/during the boss fight
    // makes the boss meaner too — real risk/reward for chaining combos here
    const comboEnrage = 1 + Math.min(comboCount, COMBO_MAX_TIER) * 0.05;

    if ((b.pattern === "charge" || b.pattern === "recoilSlam") && b.telegraph > 0) {
      // holding still while telegraphing
      b.telegraph -= dt;
      if (b.telegraph <= 0) {
        const mul = b.pattern === "recoilSlam" ? 1.45 : 1;
        b.dashVX = Math.sign(player.x - b.x) * (520 + (1 - hpPct) * 260) * comboEnrage * mul;
      }
    } else if ((b.pattern === "charge" || b.pattern === "recoilSlam") && b.dashVX !== 0) {
      b.x += b.dashVX * dt;
      b.x = clamp(b.x, level.length - 940, level.length - 40);
      if (b.pattern === "recoilSlam" && Math.random() < 0.6) {
        spawnStreak(b.x + b.w / 2 - Math.sign(b.dashVX) * b.w * 0.4, b.y + b.h / 2, "#ff2f5b", -Math.sign(b.dashVX), 0, 300, 0.2, 22);
      }
      if (Math.abs(b.dashVX) < 10 || b.timer > b._chargeEnd) {
        if (b.pattern === "recoilSlam") {
          // slams into the ground at the end of the dash — a shockwave in
          // both directions, mirroring the player's own Air Blast impact
          shockwaves.push({ x: b.x + b.w / 2, y: GROUND_Y, vx: 300, w: 20, h: 40, life: 1.2, dir: -1 });
          shockwaves.push({ x: b.x + b.w / 2, y: GROUND_Y, vx: 300, w: 20, h: 40, life: 1.2, dir: 1 });
          screenShake = 10;
        }
        b.dashVX = 0;
      }
    } else {
      const dx = player.x - b.x;
      const dist = Math.abs(dx);
      const chaseSpeed = (55 + (1 - hpPct) * 90) * comboEnrage;
      if (dist > 260) b.x += Math.sign(dx) * chaseSpeed * dt;
      else if (dist < 160) b.x -= Math.sign(dx) * chaseSpeed * dt;
      b.x = clamp(b.x, level.length - 940, level.length - 40);
    }

    b.attackTimer -= dt / comboEnrage;
    if (b.attackTimer <= 0 && b.dashVX === 0 && b.telegraph <= 0) {
      chooseBossPattern(b, hpPct);
    }

    if (aabb(player, b)) damagePlayer(22, false);
    updateBossUI();
  }

  function chooseBossPattern(b, hpPct) {
    const options = BOSS_PHASE_PATTERNS[b.phase] || ["burst"];

    // PHASE 13 — fair, telegraph-based adaptation: this only re-weights
    // the odds between patterns that already exist and are already
    // telegraphed the same way regardless of who's chosen. No instant
    // attacks, no new patterns, no reading player input directly — just
    // simple behavior stats gathered passively during the fight.
    if (!b.stats) b.stats = { grounded: 0, airborne: 0, dashUses: 0, recentPatterns: [] };
    const st = b.stats;
    const totalGrounded = st.grounded + st.airborne;
    const airRatio = totalGrounded > 0 ? st.airborne / totalGrounded : 0.5;

    const weights = options.map((opt) => {
      let w = 1;
      // Player camps in the air a lot -> patterns that pressure airspace
      // get somewhat more likely, so hugging the sky stops being a free pass.
      if (airRatio > 0.65 && (opt === "spiral" || opt === "burst" || opt === "barrage")) w *= 1.6;
      // Player stays grounded a lot -> ground-pressure patterns get somewhat
      // more likely, for the same reason in reverse.
      if (airRatio < 0.35 && (opt === "charge" || opt === "slam" || opt === "recoilSlam")) w *= 1.6;
      // Spamming Air Blast nonstop (pure evasion) -> volley patterns that
      // fill more of the space get a bit more likely.
      if (st.dashUses > 8 && (opt === "burst" || opt === "barrage")) w *= 1.3;
      // Repeating the same pattern back-to-back gets predictable and easy
      // to read — damp it down so the fight stays varied, not because the
      // player did anything wrong, just so the boss doesn't get stale.
      const recentCount = st.recentPatterns.filter((p) => p === opt).length;
      if (recentCount >= 2) w *= 0.35;
      else if (recentCount === 1) w *= 0.75;
      return w;
    });

    const totalW = weights.reduce((a, w) => a + w, 0);
    let r = rand(0, totalW);
    let pick = options[options.length - 1];
    for (let i = 0; i < options.length; i++) {
      if (r < weights[i]) { pick = options[i]; break; }
      r -= weights[i];
    }
    st.recentPatterns.push(pick);
    if (st.recentPatterns.length > 4) st.recentPatterns.shift();

    b.pattern = pick;

    if (pick === "burst") {
      const burst = hpPct < 0.4 ? 5 : 3;
      const genAtSchedule = levelGen;
      for (let i = 0; i < burst; i++) {
        setTimeout(() => {
          if (genAtSchedule !== levelGen) return; // level was reloaded/restarted meanwhile — drop stale attack
          if (!b.alive) return;
          const angle = Math.atan2((player.y + player.h / 2) - (b.y + b.h / 2), player.x - b.x) + rand(-0.15, 0.15);
          projectiles.push({
            x: b.x, y: b.y + b.h / 2,
            vx: Math.cos(angle) * 360, vy: Math.sin(angle) * 360,
            life: 3, friendly: false, r: 10
          });
        }, i * 150);
      }
      b.attackTimer = hpPct < 0.33 ? 1.0 : 1.6;
    } else if (pick === "charge") {
      b.telegraph = 0.6;
      b._chargeEnd = b.timer + 0.6 + 0.8;
      spawnParticles(b.x + b.w / 2, b.y + b.h / 2, "#ff2f5b", 14, 120, 0.5);
      b.attackTimer = hpPct < 0.33 ? 1.6 : 2.2;
    } else if (pick === "recoilSlam") {
      // The boss's own version of the player's Air Blast: a visible jet
      // bursts from its rear during the telegraph, then it rockets forward
      // faster than a normal charge and slams the ground at the end.
      b.telegraph = 0.5;
      b._chargeEnd = b.timer + 0.5 + 0.7;
      const jetDir = -Math.sign(player.x - b.x || 1);
      spawnParticles(b.x + b.w / 2 + jetDir * b.w * 0.4, b.y + b.h / 2, "#ff2f5b", 20, 200, 0.5);
      sfx.bossHit();
      b.attackTimer = 2.0;
    } else if (pick === "slam") {
      spawnParticles(b.x + b.w / 2, b.y + b.h, "#ffd166", 20, 200, 0.5);
      shockwaves.push({ x: b.x + b.w / 2, y: GROUND_Y, vx: 260, w: 20, h: 40, life: 1.6, dir: -1 });
      shockwaves.push({ x: b.x + b.w / 2, y: GROUND_Y, vx: 260, w: 20, h: 40, life: 1.6, dir: 1 });
      screenShake = 12;
      b.attackTimer = hpPct < 0.33 ? 1.3 : 1.9;
    } else if (pick === "spiral") {
      // phase 4+: a full ring of projectiles the player must dodge or gap through
      const ringCount = 12;
      spawnParticles(b.x + b.w / 2, b.y + b.h / 2, "#c65cff", 16, 160, 0.4);
      sfx.bossHit();
      for (let i = 0; i < ringCount; i++) {
        const angle = (Math.PI * 2 * i) / ringCount;
        projectiles.push({
          x: b.x + b.w / 2, y: b.y + b.h / 2,
          vx: Math.cos(angle) * 260, vy: Math.sin(angle) * 260,
          life: 2.6, friendly: false, r: 9
        });
      }
      b.attackTimer = 2.4;
    } else if (pick === "barrage") {
      // phase 5 finisher: rapid multi-angle volleys, the boss's most dangerous pattern
      const genAtSchedule = levelGen;
      const rounds = 4;
      for (let r = 0; r < rounds; r++) {
        setTimeout(() => {
          if (genAtSchedule !== levelGen || !b.alive) return;
          for (let i = -1; i <= 1; i++) {
            const angle = Math.atan2((player.y + player.h / 2) - (b.y + b.h / 2), player.x - b.x) + i * 0.28;
            projectiles.push({
              x: b.x, y: b.y + b.h / 2,
              vx: Math.cos(angle) * 420, vy: Math.sin(angle) * 420,
              life: 2.4, friendly: false, r: 9
            });
          }
          spawnParticles(b.x, b.y + b.h / 2, "#ff2f5b", 8, 140, 0.25);
        }, r * 180);
      }
      screenShake = 8;
      b.attackTimer = 2.8;
    }
  }

  function updateShockwaves(dt) {
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const s = shockwaves[i];
      s.x += s.vx * s.dir * dt;
      s.life -= dt;
      if (aabb(player, { x: s.x - s.w / 2, y: s.y - s.h, w: s.w, h: s.h })) {
        damagePlayer(18, false);
      }
      if (s.life <= 0) shockwaves.splice(i, 1);
    }
  }

  function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.life -= dt;
      let remove = pr.life <= 0;

      if (pr.friendly) {
        if (mp.active && mp.mode === "versus" && mp.roundActive && player2.connected) {
          if (Math.hypot(pr.x - (player2.x + player2.w / 2), pr.y - (player2.y + player2.h / 2)) < pr.r + 18) {
            const dmg = pr.dmg || PULSE_DAMAGE;
            MP.sendCtrl({ t: "hit", dmg });
            player2.health = Math.max(0, player2.health - dmg);
            spawnParticles(pr.x, pr.y, "#fff3d0", 6, 140, 0.2);
            sfx.hit();
            projectiles.splice(i, 1);
            continue;
          }
        }
        // PHASE 1 (FFA/Team): same bullet-hit check, generalized over
        // every remote player instead of the single player2 mirror.
        if (mp.active && (mp.mode === "ffa" || mp.mode === "team") && mp.ffaAlive) {
          let hitSomeone = false;
          for (const id of Object.keys(remotePlayers)) {
            const rp = remotePlayers[id];
            if (!rp.alive || !rp.connected) continue;
            if (mp.mode === "team" && rp.team === myFfaTeam) continue;
            if (Math.hypot(pr.x - (rp.x + PLAYER_W / 2), pr.y - (rp.y + PLAYER_H / 2)) < pr.r + 18) {
              const dmg = pr.dmg || PULSE_DAMAGE;
              sendFfaHit(id, dmg);
              rp.health = Math.max(0, rp.health - dmg);
              spawnParticles(pr.x, pr.y, "#fff3d0", 6, 140, 0.2);
              sfx.hit();
              hitSomeone = true;
              break;
            }
          }
          if (hitSomeone) { projectiles.splice(i, 1); continue; }
        }
        for (let ei = 0; ei < level.enemies.length; ei++) {
          const e = level.enemies[ei];
          if (!e.alive) continue;
          if (Math.hypot(pr.x - (e.x + e.w / 2), pr.y - (e.y + e.h / 2)) < pr.r + 18) {
            // shielded enemies ignore bullet damage entirely until their
            // shield is broken by an Air Blast hit (see tryAirBlast)
            if (e.type === "shield" && e.shielded) {
              spawnParticles(pr.x, pr.y, "#7fe0ff", 8, 120, 0.2);
              sfx.hit();
              remove = true;
              break;
            }
            // Cloner: the machine gun can't actually kill it. The first
            // hit splits it into two smaller, weaker copies (canSplit
            // false, so they can't split again); after that, bullets just
            // bounce off — only a direct close-range Air Blast (see
            // tryAirBlast) finishes it or its clones off.
            if (e.type === "cloner") {
              spawnParticles(pr.x, pr.y, "#5cffb0", 6, 120, 0.2);
              sfx.hit();
              remove = true;
              if (e.canSplit) {
                e.alive = false;
                const childHealth = Math.max(15, Math.round(e.maxHealth * 0.5));
                for (const side of [-1, 1]) {
                  const cx2 = clamp(e.x + side * (e.w * 0.6), e.w0, e.w1);
                  level.enemies.push({
                    x: cx2, y: e.y + 6, w: e.w * 0.7, h: e.h * 0.7,
                    w0: e.w0, w1: e.w1,
                    speed: e.speed * 1.15, dir: side,
                    health: childHealth, maxHealth: childHealth,
                    damage: e.damage, alive: true, type: "cloner", hitFlash: 0.15,
                    canSplit: false
                  });
                }
                spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#5cffb0", 16, 200, 0.4);
              }
              break;
            }
            // fixedHits enemies (THE HELL waves) always die after a fixed
            // number of hits, regardless of the player's actual weapon
            // damage/upgrades — 1 hit = -1, no more no less.
            const dmgDealt = (e.fixedHits ? 1 : (pr.dmg || PULSE_DAMAGE));
            // PHASE 3 (co-op): the guest predicts the hit locally for instant
            // feedback but isn't authoritative — tell the host, whose copy
            // of level.enemies is the real one (see the "enemyHit" handler).
            if (mp.active && mp.mode === "coop" && mp.coopTransport === "room" && !ffaIsHost) {
              sendRoomCoopEnemyHit(ei, dmgDealt);
            } else if (mp.active && mp.mode === "coop" && mp.coopTransport !== "room" && !MP.isHost()) {
              MP.sendCtrl({ t: "enemyHit", i: ei, dmg: dmgDealt });
            }
            e.health -= dmgDealt;
            e.hitFlash = 0.15;
            if (e.showPhaseLabel && e.health > 0) {
              spawnFloatText(e.x + e.w / 2, e.y - 14, `فيز ${e.health}/${e.maxHealth}`, e.isLevel26Boss ? "#c98cff" : "#ffd166");
            }
            // knockback: nudge the enemy back along the bullet's travel direction
            const push = Math.sign(pr.vx) * 10;
            const lo = e.w0 !== undefined ? e.w0 : -Infinity;
            const hi = e.w1 !== undefined ? e.w1 : Infinity;
            e.x = clamp(e.x + push, lo, hi);
            spawnParticles(pr.x, pr.y, "#fff3d0", 6, 140, 0.2);
            sfx.hit();
            remove = true;
            if (e.health <= 0) {
              e.alive = false;
              spawnParticles(e.x + e.w / 2, e.y + e.h / 2, "#ff9142", 16, 220, 0.5);
              const pts = e.type === "elite" ? SCORE_ELITE : SCORE_ENEMY;
              registerKill(pts, e.x + e.w / 2, e.y, "#ff9142");
              reclaimBlastIfStolenBy(e);
            }
            break;
          }
        }
        if (level.boss && level.boss.alive) {
          const b = level.boss;
          if (aabbCircle(pr, b)) {
            const dmg = pr.dmg || PULSE_DAMAGE;
            if (mp.active && mp.mode === "bossrush" && !ffaIsHost) {
              // Guest: optimistic local prediction only (instant hit
              // feedback) — host owns the real fight and the kill/next-
              // boss progression, corrected by its next broadcast.
              sendBossRushHit(dmg);
              b.health = Math.max(0, b.health - dmg);
              b.hitFlash = 0.15;
              spawnParticles(pr.x, pr.y, "#fff3d0", 6, 140, 0.2);
              sfx.bossHit();
              remove = true;
              updateBossUI();
            } else {
              b.health -= dmg;
              b.hitFlash = 0.15;
              spawnParticles(pr.x, pr.y, "#fff3d0", 6, 140, 0.2);
              sfx.bossHit();
              remove = true;
              if (b.health <= 0) {
                b.alive = false;
                spawnParticles(b.x + b.w / 2, b.y + b.h / 2, "#ffd166", 46, 320, 0.9);
                screenShake = 16;
                flashScreen("rgba(255,209,102,0.7)", 0.7);
                addScore(SCORE_BOSS, b.x + b.w / 2, b.y, `+${SCORE_BOSS}`, "#ffd166");
                if (mp.active && mp.mode === "bossrush") {
                  handleBossRushKill();
                } else {
                  const genAtDeath = levelGen;
                  setTimeout(() => { if (genAtDeath === levelGen) triggerLevelComplete(); }, 550);
                }
              }
              updateBossUI();
            }
          }
        }
        if (pr.y < -50 || pr.y > VH + 200) remove = true;
      } else {
        if (Math.hypot(pr.x - (player.x + player.w / 2), pr.y - (player.y + player.h / 2)) < pr.r + 16) {
          damagePlayer(12, false);
          remove = true;
        }
      }
      if (remove) projectiles.splice(i, 1);
    }
  }

  function aabbCircle(circle, box) {
    const cx = clamp(circle.x, box.x, box.x + box.w);
    const cy = clamp(circle.y, box.y, box.y + box.h);
    return Math.hypot(circle.x - cx, circle.y - cy) < circle.r;
  }

  // ---------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------
  function drawBackground() {
    const hue = (level && level.theme) ? level.theme.hue : 210;
    const grad = ctx.createLinearGradient(0, 0, 0, VH);
    grad.addColorStop(0, `hsl(${hue}, 55%, 12%)`);
    grad.addColorStop(1, `hsl(${hue - 10}, 45%, 5%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, VW, VH);

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    for (let i = 0; i < 40; i++) {
      const px = (i * 137 - camera.x * 0.3) % (VW + 100);
      const py = (i * 71) % (VH - 100);
      ctx.fillRect(((px % (VW + 100)) + (VW + 100)) % (VW + 100), py, 2, 2);
    }
  }

  function drawPlatform(p) {
    const sx = p.x - camera.x;
    if (sx + p.w < 0 || sx > VW) return;
    if (p.type === "ground") {
      ctx.fillStyle = "#1b2a3a";
      ctx.fillRect(sx, p.y, p.w, 20);
      ctx.fillStyle = "#0e1622";
      ctx.fillRect(sx, p.y + 20, p.w, p.h - 20);
      ctx.fillStyle = "#2fe0ff";
      ctx.fillRect(sx, p.y, p.w, 3);
    } else if (p.type === "secret") {
      ctx.fillStyle = "rgba(255,224,102,0.85)";
      ctx.fillRect(sx, p.y, p.w, p.h);
      ctx.strokeStyle = "#ffd166";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(sx, p.y, p.w, p.h);
      ctx.setLineDash([]);
    } else if (p.type === "moving") {
      ctx.fillStyle = "#3a2a55";
      ctx.fillRect(sx, p.y, p.w, p.h);
      ctx.fillStyle = "#c65cff";
      ctx.fillRect(sx, p.y, p.w, 3);
    } else {
      ctx.fillStyle = "#2a3f55";
      ctx.fillRect(sx, p.y, p.w, p.h);
      ctx.fillStyle = "#6fe9ff";
      ctx.fillRect(sx, p.y, p.w, 3);
    }
  }

  function drawTrap(t) {
    const sx = t.x - camera.x;
    if (sx + t.w < 0 || sx > VW) return;
    ctx.fillStyle = "#ff2f5b";
    ctx.beginPath();
    ctx.moveTo(sx, t.y + t.h);
    ctx.lineTo(sx + t.w / 2, t.y);
    ctx.lineTo(sx + t.w, t.y + t.h);
    ctx.closePath();
    ctx.fill();
  }

  function drawGem(g) {
    if (g.collected) return;
    const sx = g.x - camera.x;
    if (sx < -30 || sx > VW + 30) return;
    const bob = Math.sin(performance.now() / 300 + g.x) * 4;
    ctx.save();
    ctx.translate(sx, g.y + bob);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = g.secret ? "#ffd166" : "#7fe0ff";
    ctx.shadowColor = g.secret ? "#ffd166" : "#7fe0ff";
    ctx.shadowBlur = 10;
    ctx.fillRect(-g.r, -g.r, g.r * 2, g.r * 2);
    ctx.restore();
  }

  const POWERUP_ICONS = { shield: "🛡️", rapid: "🔫", overcharge: "💥" };
  function drawPowerup(p) {
    if (p.collected) return;
    const sx = p.x - camera.x;
    if (sx < -30 || sx > VW + 30) return;
    const bob = Math.sin(performance.now() / 260 + p.x) * 5;
    const color = POWERUP_COLORS[p.type];
    ctx.save();
    ctx.translate(sx, p.y + bob);
    ctx.beginPath();
    ctx.arc(0, 0, p.r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(POWERUP_ICONS[p.type] || "?", 0, 1);
    ctx.restore();
  }

  function drawGoal() {
    if (level.boss || !level.goal) return;
    const g = level.goal;
    const sx = g.x - camera.x;
    if (sx + g.w < -50 || sx > VW + 50) return;
    ctx.fillStyle = "#ffd166";
    ctx.fillRect(sx, g.y, 6, g.h);
    ctx.beginPath();
    ctx.moveTo(sx + 6, g.y);
    ctx.lineTo(sx + 40, g.y + 14);
    ctx.lineTo(sx + 6, g.y + 28);
    ctx.closePath();
    ctx.fill();
  }

  function drawAimIndicator() {
    if (state !== STATE.PLAYING) return;
    if (!joystick.active && player.blastCooldown <= 0.35) return;
    const cx = player.x - camera.x + player.w / 2;
    const cy = player.y + player.h / 2;
    let dx = joystick.aimDx, dy = joystick.aimDy;
    if (dy > 0.5) dy = -Math.abs(dy); // preview the auto-correction
    dx = -dx; dy = -dy; // the line shows the actual Blast/recoil push, which is opposite the stick's aim direction
    const len = 46;
    const tx = cx + dx * len;
    const ty = cy + dy * len;

    ctx.save();
    ctx.globalAlpha = player.blastCooldown > 0 ? 0.35 : 0.85;
    ctx.strokeStyle = "#7fe0ff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    // arrow head
    const ang = Math.atan2(ty - cy, tx - cx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 10 * Math.cos(ang - 0.4), ty - 10 * Math.sin(ang - 0.4));
    ctx.lineTo(tx - 10 * Math.cos(ang + 0.4), ty - 10 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = "#7fe0ff";
    ctx.fill();

    // circle at tip
    ctx.beginPath();
    ctx.arc(tx, ty, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "#cfeeff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawPlayer() {
    const sx = player.x - camera.x;
    const flashing = player.invuln > 0 && Math.floor(player.invuln * 12) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = flashing ? 0.4 : 1;

    // PHASE 7 — the Hunter is visibly marked (red pulsing ring) at all
    // times, on every client, including their own screen: no stealth, the
    // visibility itself is the "telegraph" the spec asks for.
    if (mp.active && mp.mode === "hunted" && mp.huntedRole === "hunter") {
      const pulse = 6 + Math.sin(performance.now() / 150) * 3;
      ctx.strokeStyle = "rgba(255,92,122,0.85)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx + player.w / 2, player.y + player.h / 2, player.w / 2 + pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (player.blastFx > 0) {
      ctx.fillStyle = "rgba(127,224,255,0.35)";
      ctx.beginPath();
      ctx.arc(sx + player.w / 2, player.y + player.h / 2, 30 + (0.28 - player.blastFx) * 60, 0, Math.PI * 2);
      ctx.fill();
    }

    // Small thick "nozzle" mark showing where the air is actually blasting
    // from — sits on the exhaust side (opposite the direction the player is
    // being pushed), in front of or behind the player depending on aim, and
    // fades in/out with the current thrust so it only shows while blasting.
    if (player.blastEase > 0) {
      const nax = player.blastDirX, nay = player.blastDirY; // stripe/nozzle now points opposite the analog stick, same as the recoil push
      const ang = Math.atan2(nay, nax);
      const ncx = sx + player.w / 2 + nax * (player.w / 2 + 9);
      const ncy = player.y + player.h / 2 + nay * (player.h / 2 + 9);
      ctx.save();
      ctx.translate(ncx, ncy);
      ctx.rotate(ang);
      ctx.fillStyle = `rgba(191,232,255,${(0.35 + 0.5 * player.blastEase).toFixed(2)})`;
      ctx.fillRect(-11, -4, 22, 8);
      ctx.restore();
    }

    // PHASE 3 (co-op): a downed player is drawn flattened/greyed-out and
    // lying down, so a teammate can spot them at a glance across the arena.
    if (player.down) {
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = "#7a8a94";
      ctx.fillRect(sx - 6, player.y + player.h - 14, player.w + 12, 14);
      ctx.fillStyle = "#ff5c7a";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("SOS", sx + player.w / 2, player.y - 10);
    } else {
      ctx.fillStyle = saveData.goldSkinActive ? "#ffd166" : "#2fe0ff";
      ctx.fillRect(sx, player.y, player.w, player.h);
      ctx.fillStyle = "#0a2530";
      ctx.fillRect(sx + (player.facing > 0 ? player.w - 10 : 2), player.y + 8, 8, 8);
    }

    if (player.shieldTime > 0) {
      ctx.strokeStyle = "#6fe9ff";
      ctx.shadowColor = "#6fe9ff";
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx + player.w / 2, player.y + player.h / 2, player.w * 0.8, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (player.rapidTime > 0 || player.overchargeTime > 0) {
      ctx.fillStyle = player.overchargeTime > 0 ? "#ff8a3d" : "#ffd166";
      ctx.beginPath();
      ctx.arc(sx + player.w / 2, player.y - 12, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    drawEmoteBubble(sx + player.w / 2, player.y, localEmoteIcon, localEmoteUntil);
  }

  // The remote peer's avatar — same silhouette as the local player but
  // tinted differently so the two are never confused on screen.
  function drawPlayer2() {
    const sx = player2.x - camera.x;
    if (sx + player2.w < -30 || sx > VW + 30) return; // off-screen, skip
    const flashing = player2.invuln > 0 && Math.floor(player2.invuln * 12) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = flashing ? 0.4 : 1;

    if (player2.blastFx > 0) {
      ctx.fillStyle = "rgba(255,142,94,0.35)";
      ctx.beginPath();
      ctx.arc(sx + player2.w / 2, player2.y + player2.h / 2, 30 + (0.28 - player2.blastFx) * 60, 0, Math.PI * 2);
      ctx.fill();
    }

    if (player2.down) {
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = "#7a8a94";
      ctx.fillRect(sx - 6, player2.y + player2.h - 14, player2.w + 12, 14);
      ctx.fillStyle = "#ff5c7a";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("SOS", sx + player2.w / 2, player2.y - 10);
    } else {
      ctx.fillStyle = "#ff8a3d";
      ctx.fillRect(sx, player2.y, player2.w, player2.h);
      ctx.fillStyle = "#3a1c05";
      ctx.fillRect(sx + (player2.facing > 0 ? player2.w - 10 : 2), player2.y + 8, 8, 8);
    }

    ctx.restore();
    drawEmoteBubble(sx + player2.w / 2, player2.y, peerEmoteIcon, peerEmoteUntil);
  }

  // Small floating emoji bubble above a player's head, active for a
  // couple of seconds after mpSendEmote()/an incoming "emote" ctrl msg.
  function drawEmoteBubble(centerX, topY, icon, untilTs) {
    if (!icon) return;
    const now = performance.now();
    if (now > untilTs) return;
    const remaining = untilTs - now;
    const fade = remaining < 300 ? remaining / 300 : 1;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.font = "22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(10,15,25,0.55)";
    ctx.beginPath();
    ctx.arc(centerX, topY - 26, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(icon, centerX, topY - 26);
    ctx.restore();
  }

  function drawEnemy(e) {
    if (!e.alive) return;
    const sx = e.x - camera.x;
    if (sx + e.w < -30 || sx > VW + 30) return;
    let color = "#ff5c7a";
    if (e.type === "flyer") color = "#c65cff";
    else if (e.type === "fast") color = "#ffd166";
    else if (e.type === "chaser") color = "#ff8a3d";
    else if (e.type === "shooter") color = "#5cff8a";
    else if (e.type === "shield") color = "#3fa9ff";
    else if (e.type === "vacuum") color = "#c65cff";
    else if (e.type === "bomber") color = (e.armed && Math.sin(e.fuseTimer * 26) > 0) ? "#ffffff" : "#ff3b1f";
    else if (e.type === "cloner") color = e.canSplit ? "#5cffb0" : "#2fae7f";
    else if (e.type === "trapper") color = "#ffb84d";
    else if (e.type === "thief") color = e.hasStolenBlast ? "#6fe9ff" : (e.telegraph > 0 ? "#ffffff" : "#ffcf5c");
    else if (e.type === "elite") color = e.telegraph > 0 ? "#ffffff" : (e.isHellBoss ? "#ff3b1f" : "#7b1fd6");
    ctx.fillStyle = e.hitFlash > 0 ? "#ffffff" : color;
    ctx.fillRect(sx, e.y, e.w, e.h);
    if (e.type === "thief" && e.hasStolenBlast) {
      // carrying the stolen Air Blast: a pulsing cyan ring so it reads at
      // a glance as "the one you need to kill", from anywhere on screen
      ctx.save();
      ctx.strokeStyle = "rgba(111,233,255,0.6)";
      ctx.shadowColor = "#6fe9ff";
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 5, e.y - 5, e.w + 10, e.h + 10);
      ctx.restore();
    }
    if (e.type === "bomber" && e.armed) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,59,31,0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx + e.w / 2, e.y + e.h / 2, BOMBER_FUSE_RANGE * (e.fuseTimer / BOMBER_ARM_TIME), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (e.type === "vacuum") {
      ctx.save();
      ctx.strokeStyle = "rgba(198,92,255,0.35)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx + e.w / 2, e.y + e.h / 2, VACUUM_RANGE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (e.type === "shield" && e.shielded) {
      ctx.save();
      ctx.strokeStyle = "#bfeeff";
      ctx.shadowColor = "#7fe0ff";
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 4, e.y - 4, e.w + 8, e.h + 8);
      ctx.restore();
    }
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(sx, e.y - 8, e.w, 4);
    ctx.fillStyle = "#ff9142";
    ctx.fillRect(sx, e.y - 8, e.w * clamp(e.health / e.maxHealth, 0, 1), 4);
  }

  function drawBoss() {
    const b = level.boss;
    if (!b || !b.alive) return;
    const sx = b.x - camera.x;
    const phaseColors = { 1: "#7b1fd6", 2: "#9a2fd0", 3: "#c22fa8", 4: "#e02f70", 5: "#ff2f5b" };
    let color = phaseColors[b.phase] || "#7b1fd6";
    if (b.telegraph > 0) color = "#ffffff";
    ctx.fillStyle = b.hitFlash > 0 ? "#ffffff" : color;
    ctx.fillRect(sx, b.y, b.w, b.h);
    ctx.fillStyle = "#ffd166";
    ctx.fillRect(sx + b.w * 0.3, b.y + b.h * 0.25, b.w * 0.4, b.h * 0.18);
  }

  function drawShockwaves() {
    for (const s of shockwaves) {
      const sx = s.x - camera.x;
      ctx.fillStyle = "rgba(255,209,102,0.8)";
      ctx.fillRect(sx - s.w / 2, s.y - s.h, s.w, s.h);
    }
  }

  function drawProjectiles() {
    for (const pr of projectiles) {
      const sx = pr.x - camera.x;
      if (pr.friendly) {
        // bullet tracer: a short bright streak pointing along its travel direction
        const ang = Math.atan2(pr.vy, pr.vx);
        ctx.save();
        ctx.translate(sx, pr.y);
        ctx.rotate(ang);
        const grad = ctx.createLinearGradient(-14, 0, 4, 0);
        grad.addColorStop(0, "rgba(255,207,92,0)");
        grad.addColorStop(1, "#fff3d0");
        ctx.fillStyle = grad;
        ctx.fillRect(-14, -1.5, 18, 3);
        ctx.fillStyle = "#fff3d0";
        ctx.beginPath();
        ctx.arc(3, 0, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = "#ff5c7a";
        ctx.beginPath();
        ctx.arc(sx, pr.y, pr.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function render() {
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scaleFactor, scaleFactor);
    ctx.beginPath();
    ctx.rect(0, 0, VW, VH);
    ctx.clip();

    let shakeX = 0, shakeY = 0;
    if (screenShake > 0) { shakeX = rand(-screenShake, screenShake); shakeY = rand(-screenShake, screenShake); }
    ctx.save();
    ctx.translate(shakeX, shakeY);

    drawBackground();

    if (level) {
      for (const p of level.platforms) drawPlatform(p);
      for (const t of level.traps) drawTrap(t);
      for (const g of level.gems) drawGem(g);
      if (level.powerups) for (const p of level.powerups) drawPowerup(p);
      drawGoal();
      drawShockwaves();
      for (const e of level.enemies) drawEnemy(e);
      drawBoss();
      drawProjectiles();
      drawParticles();
      drawAimIndicator();
      if (!mp.active) drawGhost(); // PHASE 11 — visual only, single-player levels
      drawPlayer();
      if (mp.active && player2.connected) drawPlayer2();
      if (mp.active && (mp.mode === "ffa" || mp.mode === "team" || mp.mode === "bossrush" || mp.mode === "hunted" || (mp.mode === "coop" && mp.coopTransport === "room"))) drawRemotePlayers();
      if (mp.active && mp.mode === "race") drawRacePlayers();
    }

    ctx.restore();
    ctx.restore();
  }

  // ---------------------------------------------------------
  // PHASE 15 — debug panel refresh (own timer, ~4/s — never touches
  // gameplay state, purely reads it for display)
  // ---------------------------------------------------------
  function updateDebugPanel(dt) {
    if (!netDebugPanel) return;
    debugFrameCount++;
    debugFpsAccum += dt;
    if (debugFpsAccum >= 0.5) { debugFps = Math.round(debugFrameCount / debugFpsAccum); debugFrameCount = 0; debugFpsAccum = 0; }
    debugTick++;
    debugRefreshAccum += dt;
    if (debugRefreshAccum < 0.25) return;
    debugRefreshAccum = 0;

    const isRoomMode = mp.active && (mp.mode === "ffa" || mp.mode === "team" || mp.mode === "race" || mp.mode === "bossrush" || mp.mode === "hunted" || (mp.mode === "coop" && mp.coopTransport === "room"));
    const isDuelCoop = mp.active && (mp.mode === "versus" || (mp.mode === "coop" && mp.coopTransport !== "room"));

    let connCount = "-";
    if (isRoomMode) {
      // +1 counts this client itself alongside its connected room peers.
      const peerCount = ffaIsHost && MPRoomNet.hostConnectedPeerIds ? MPRoomNet.hostConnectedPeerIds().length : Object.keys(remotePlayers).length;
      connCount = 1 + peerCount;
    } else if (isDuelCoop) {
      connCount = player2.connected ? 2 : 1;
    }

    let ping = "-";
    if (isDuelCoop) {
      const p = MP.getPing();
      ping = p === null ? "..." : Math.round(p) + "ms";
    }

    const lines = [
      `DEBUG  fps:${debugFps}  tick:${debugTick}`,
      `mode: ${mp.active ? mp.mode : "single"}`,
      `role: ${mp.active ? (isRoomMode ? (ffaIsHost ? "host" : "client") : (mp.role || "-")) : "-"}`,
      `status: ${mp.active ? mp.status : "-"}`,
      `players: ${connCount}`,
      `ping: ${ping}`,
      `room: ${debugRoomId || "-"}`,
      `seed: ${debugLevelSeed !== null && debugLevelSeed !== undefined ? debugLevelSeed : "-"}`
    ];
    netDebugPanel.textContent = lines.join("\n");
  }

  // ---------------------------------------------------------
  // MAIN LOOP
  // ---------------------------------------------------------
  function loop(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    update(dt);
    render();
    if (DEBUG) updateDebugPanel(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  showScreen("menuScreen");

  // Bridge for mp-lobby.js (FFA/Team use mp-room-net.js directly, a
  // separate module from mp.js's Duel/Co-op connection — mp-lobby.js
  // can't reach into this closure otherwise, so it calls this instead).
  window.ABH_startRoomMatch = function (info) {
    if (info.mode === "race") startRoomRaceMatch(info);
    else if (info.mode === "bossrush") startRoomBossRushMatch(info);
    else if (info.mode === "hunted") startRoomHuntedMatch(info);
    else if (info.mode === "coop") startRoomCoopMatch(info);
    else startRoomPvpMatch(info);
  };

  document.getElementById("infoBtn").addEventListener("click", () => {
    document.getElementById("menuScreen").classList.add("hidden");
    document.getElementById("infoScreen").classList.remove("hidden");
  });
  document.getElementById("closeInfoBtn").addEventListener("click", () => {
    document.getElementById("infoScreen").classList.add("hidden");
    document.getElementById("menuScreen").classList.remove("hidden");
  });
})();

// PWA: register the external service worker (index.html / style.css /
// game.js / manifest.json / icons) so the game also works offline.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

