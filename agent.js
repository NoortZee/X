// agent.js — TAS agent for King of Thieves 2.84.1 x86_64
// Запись + форс физического состояния тела (полноценный TAS).
// ------------------------------------------------------------

const MODULE_NAME = 'libthieves.so';
const libModule = Process.findModuleByName(MODULE_NAME);
if (libModule === null) {
    send({ type: 'fatal', msg: MODULE_NAME + ' not loaded' });
    throw new Error(MODULE_NAME + ' not loaded');
}

const MODULE_BASE = libModule.base;
const MODULE_SIZE = libModule.size;
send({ type: 'module_base', name: MODULE_NAME, base: MODULE_BASE.toString(), size: MODULE_SIZE });

const FRAME_FUNC = MODULE_BASE.add(0x1609A40);

const ADDR = {
    UNFREEZE:        MODULE_BASE.add(0x13F0AE0),
    UNFREEZE_ATTACK: MODULE_BASE.add(0x13D1B70),
    JUMP:            MODULE_BASE.add(0x1608F20),
};

const VTABLE = {
    HERO_BODY:    MODULE_BASE.add(0x2049048),
    PLAY_STATE:   MODULE_BASE.add(0x1FF95E8),
    ATTACK_STATE: MODULE_BASE.add(0x1FF54C8),
};

const BODY = {
    FLAGS:     0x04,
    XF_PX:     0x0C,
    XF_PY:     0x10,
    XF_QS:     0x14,
    XF_QC:     0x18,
    SW_C0X:    0x24,
    SW_C0Y:    0x28,
    SW_CX:     0x2C,
    SW_CY:     0x30,
    SW_A0:     0x34,
    SW_A:      0x38,
    SW_ALPHA0: 0x3C,
    VX:        0x40,
    VY:        0x44,
    AV:        0x48,
};

const FPS_LOG_EVERY_N_FRAMES = 60;
const JUMP_DEFER_MAX_FRAMES  = 20;
const PROGRESS_LOG_EVERY_MS  = 1000;

// ------------------------------------------------------------
// BODY STATE
// ------------------------------------------------------------

function readBodyState(bodyPtr) {
    if (!bodyPtr || bodyPtr.isNull()) return null;
    if (!Process.findRangeByAddress(bodyPtr)) return null;
    try {
        const px  = bodyPtr.add(BODY.XF_PX).readFloat();
        const py  = bodyPtr.add(BODY.XF_PY).readFloat();
        const ang = bodyPtr.add(BODY.SW_A).readFloat();
        const vx  = bodyPtr.add(BODY.VX).readFloat();
        const vy  = bodyPtr.add(BODY.VY).readFloat();
        const av  = bodyPtr.add(BODY.AV).readFloat();

        if (!isFinite(px)  || Math.abs(px)  > 1e5) return null;
        if (!isFinite(py)  || Math.abs(py)  > 1e5) return null;
        if (!isFinite(ang) || Math.abs(ang) > 1e3) return null;
        if (!isFinite(vx)  || Math.abs(vx)  > 1e4) return null;
        if (!isFinite(vy)  || Math.abs(vy)  > 1e4) return null;
        if (!isFinite(av)  || Math.abs(av)  > 1e4) return null;

        return { px, py, ang, vx, vy, av };
    } catch (_) { return null; }
}

function writeBodyState(bodyPtr, rec) {
    if (!bodyPtr || bodyPtr.isNull() || !rec) return false;
    if (!Process.findRangeByAddress(bodyPtr)) return false;
    try {
        const s = Math.sin(rec.ang);
        const c = Math.cos(rec.ang);

        bodyPtr.add(BODY.XF_PX).writeFloat(rec.px);
        bodyPtr.add(BODY.XF_PY).writeFloat(rec.py);
        bodyPtr.add(BODY.XF_QS).writeFloat(s);
        bodyPtr.add(BODY.XF_QC).writeFloat(c);

        bodyPtr.add(BODY.SW_C0X).writeFloat(rec.px);
        bodyPtr.add(BODY.SW_C0Y).writeFloat(rec.py);
        bodyPtr.add(BODY.SW_CX).writeFloat(rec.px);
        bodyPtr.add(BODY.SW_CY).writeFloat(rec.py);
        bodyPtr.add(BODY.SW_A0).writeFloat(rec.ang);
        bodyPtr.add(BODY.SW_A).writeFloat(rec.ang);
        bodyPtr.add(BODY.SW_ALPHA0).writeFloat(0);

        bodyPtr.add(BODY.VX).writeFloat(rec.vx);
        bodyPtr.add(BODY.VY).writeFloat(rec.vy);
        bodyPtr.add(BODY.AV).writeFloat(rec.av);

        try {
            const f = bodyPtr.add(BODY.FLAGS).readU32();
            bodyPtr.add(BODY.FLAGS).writeU32(f | 2);
        } catch (_) {}
        return true;
    } catch (_) { return false; }
}

// ------------------------------------------------------------
// PUMP
// ------------------------------------------------------------

const pump = {
    _frame: 0,
    _paused: false,
    _budget: -1,
    _installed: false,
    _onFrame: null,
    _onFirstUpdate: null,
    _lastHero: null,
    _lastHeroFrame: null,

    _detectBodyRecord: false,
    _detectBodyFrames: [],

    _playbackBodyMap: null,
    _playbackAnchorFrame: null,
    _playbackAnchorRecFrame: null,
    _forceStats: { attempted: 0, applied: 0, missed: 0 },

    install() {
        if (pump._installed) { send({ type: 'pump_already' }); return; }

        pump._paused = false;
        pump._budget = -1;
        pump._frame = 0;
        pump._lastHero = null;
        pump._lastHeroFrame = null;

        Interceptor.attach(FRAME_FUNC, {
            onEnter(args) {
                this._hero = args[0];

                let guard = 0;
                while (pump._paused || pump._budget === 0) {
                    Thread.sleep(0.001);
                    if (++guard > 60000) break;
                }
                if (pump._budget > 0) pump._budget--;
                pump._frame++;

                try {
                    pump._lastHero = args[0];
                    pump._lastHeroFrame = pump._frame;
                } catch (_) {}

                if (detectRec && detectWaitFirstHeroUpdate) {
                    try {
                        if (isValidHeroStrict(args[0])) {
                            detectWaitFirstHeroUpdate = false;
                            const ev = {
                                frame:   pump._frame,
                                t_ms:    detectStartWall !== null ? (Date.now() - detectStartWall) : 0,
                           name:    'first_hero_update',
                           thisPtr: args[0].toString(),
                           snap:    heroSnapshot(args[0]),
                            };
                            detectEvents.push(ev);
                            send({ type: 'event', ev });
                        }
                    } catch (_) {}
                }

                if (pump._onFirstUpdate) {
                    try { pump._onFirstUpdate(args[0], pump._frame); } catch (_) {}
                }

                if (pump._onFrame) {
                    try { pump._onFrame(pump._frame); }
                    catch (e) { send({ type: 'onframe_error', msg: String(e) }); }
                }
            },

            onLeave(_retval) {
                const hero = this._hero;
                if (!hero) return;
                if (!isReadablePtr(hero)) return;

                let body = null;
                try { body = hero.add(0x20).readPointer(); } catch (_) { return; }
                if (!isReadablePtr(body)) return;

                if (pump._detectBodyRecord) {
                    const rec = readBodyState(body);
                    if (rec) {
                        rec.frame = pump._frame;
                        pump._detectBodyFrames.push(rec);
                    }
                }

                if (pump._playbackBodyMap && pump._playbackAnchorFrame !== null) {
                    const recFrame = pump._playbackAnchorRecFrame +
                    (pump._frame - pump._playbackAnchorFrame);
                    pump._forceStats.attempted++;
                    const rec = pump._playbackBodyMap.get(recFrame);
                    if (rec) {
                        const ok = writeBodyState(body, rec);
                        if (ok) pump._forceStats.applied++;
                        else    pump._forceStats.missed++;
                    } else {
                        pump._forceStats.missed++;
                    }
                }
            }
        });

        pump._installed = true;
        send({ type: 'pump_installed', func: FRAME_FUNC.toString() });
    },

    resetHero() { pump._lastHero = null; pump._lastHeroFrame = null; },
    reset()     { pump._frame = 0; },
    frame()     { return pump._frame; },
    pause()     { pump._paused = true; },
    resume()    { pump._paused = false; pump._budget = -1; },
    step(n)     { pump._paused = false; pump._budget = n; },
    setOnFrame(fn)       { pump._onFrame = fn; },
    clearOnFrame()       { pump._onFrame = null; },
    setOnFirstUpdate(fn) { pump._onFirstUpdate = fn; },
    clearOnFirstUpdate() { pump._onFirstUpdate = null; },

    detectBodyStart() { pump._detectBodyFrames = []; pump._detectBodyRecord = true; },
    detectBodyStop()  { pump._detectBodyRecord = false; },
    detectBodyGet()   { return pump._detectBodyFrames; },

    setPlaybackBody(framesArray) {
        if (!framesArray || !framesArray.length) {
            pump._playbackBodyMap = null;
            return 0;
        }
        const m = new Map();
        for (const r of framesArray) m.set(r.frame, r);
        pump._playbackBodyMap = m;
        pump._forceStats = { attempted: 0, applied: 0, missed: 0 };
        return m.size;
    },
    setPlaybackAnchor(playbackFrame, recFrame) {
        pump._playbackAnchorFrame = playbackFrame;
        pump._playbackAnchorRecFrame = recFrame;
    },
    clearPlaybackBody() {
        pump._playbackBodyMap = null;
        pump._playbackAnchorFrame = null;
        pump._playbackAnchorRecFrame = null;
    },
    forceStats() { return { ...pump._forceStats }; },
};

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function isReadablePtr(p) {
    if (p === null || p.isNull()) return false;
    return Process.findRangeByAddress(p) !== null;
}

function isValidHeroStrict(p) {
    if (!p || p.isNull() || !isReadablePtr(p)) return false;
    try { if (!p.and(7).isNull()) return false; } catch (_) { return false; }
    try { if (!p.readPointer().equals(VTABLE.HERO_BODY)) return false; } catch (_) { return false; }
    let body;
    try { body = p.add(0x20).readPointer(); } catch (_) { return false; }
    if (!isReadablePtr(body)) return false;
    try { if (!body.and(7).isNull()) return false; } catch (_) { return false; }
    let bt;
    try { bt = body.readU32(); } catch (_) { return false; }
    if (bt !== 2) return false;
    let grav;
    try { grav = body.add(0xA8).readFloat(); } catch (_) { return false; }
    if (!isFinite(grav) || grav < -100 || grav > 100) return false;
    return true;
}

function heroSnapshot(p) {
    const s = {};
    if (!p || !isReadablePtr(p)) { s.reason = 'unmapped'; return s; }
    try { s.vt_rel      = p.readPointer().sub(MODULE_BASE).toString(); } catch (_) { s.vt_rel      = 'err'; }
    try { s.state_a0    = p.add(0xA0).readS32(); } catch (_) { s.state_a0    = 'err'; }
    try { s.cooldown_b0 = p.add(0xB0).readS32(); } catch (_) { s.cooldown_b0 = 'err'; }
    try { s.ground_80   = p.add(0x80).readS32(); } catch (_) { s.ground_80   = 'err'; }
    try { s.ground_84   = p.add(0x84).readS32(); } catch (_) { s.ground_84   = 'err'; }
    return s;
}

function isEffectiveJump(snap) {
    if (!snap) return false;
    if (typeof snap.state_a0 !== 'number' || (snap.state_a0 & 7) !== 0) return false;
    const g = (typeof snap.ground_80 === 'number' ? snap.ground_80 : 0)
    + (typeof snap.ground_84 === 'number' ? snap.ground_84 : 0);
    return g > 0;
}

// ------------------------------------------------------------
// DETECT
// ------------------------------------------------------------

let detectRec = false;
let detectEvents = [];
let detectStartWall = null;
let detectWaitFirstHeroUpdate = false;

function detectInstall() {
    const targets = [
        { name: 'unfreeze',        addr: ADDR.UNFREEZE },
        { name: 'unfreeze_attack', addr: ADDR.UNFREEZE_ATTACK },
        { name: 'jump',            addr: ADDR.JUMP },
    ];

    targets.forEach(t => {
        Interceptor.attach(t.addr, {
            onEnter(args) {
                if (!detectRec) return;
                const thisPtr = args[0];
                const ev = {
                    frame:   pump.frame(),
                           t_ms:    detectStartWall !== null ? (Date.now() - detectStartWall) : 0,
                           name:    t.name,
                           thisPtr: thisPtr.toString(),
                           snap:    heroSnapshot(thisPtr),
                };
                try {
                    const vt = thisPtr.readPointer();
                    ev.vt     = vt.toString();
                    ev.vt_rel = vt.sub(MODULE_BASE).toString();
                } catch (_) { ev.vt = null; ev.vt_rel = null; }

                if (t.name === 'unfreeze' || t.name === 'unfreeze_attack') {
                    detectWaitFirstHeroUpdate = true;
                }

                detectEvents.push(ev);
                send({ type: 'event', ev });
            }
        });
    });

    send({ type: 'detect_installed', n: targets.length });
}

function detectStart() {
    detectEvents = [];
    detectStartWall = Date.now();
    detectRec = true;
    detectWaitFirstHeroUpdate = false;
    pump.detectBodyStart();
    send({ type: 'detect_started', frame: pump.frame(), wall: detectStartWall });
}

function detectStop() {
    detectRec = false;
    detectWaitFirstHeroUpdate = false;
    pump.detectBodyStop();
    const dur = detectStartWall ? (Date.now() - detectStartWall) : 0;
    send({
        type: 'detect_stopped',
        count: detectEvents.length,
        body_frames: pump._detectBodyFrames.length,
        duration_ms: dur,
        avg_fps: dur > 0 ? (pump.frame() * 1000 / dur).toFixed(1) : 'n/a',
    });
    return detectEvents;
}

function detectGetBodyFrames() {
    return pump.detectBodyGet();
}

// ------------------------------------------------------------
// REPLAY
// ------------------------------------------------------------

let jumpFn = null;
function ensureJumpFn() {
    if (!jumpFn) jumpFn = new NativeFunction(ADDR.JUMP, 'void', ['pointer']);
}

function replayJumpsOnly(events, opts) {
    opts = opts || {};
    const bodyFramesIn = Array.isArray(opts.body_frames) ? opts.body_frames : null;

    ensureJumpFn();
    pump.install();
    pump.clearOnFrame();
    pump.clearOnFirstUpdate();
    pump.clearPlaybackBody();
    pump.resetHero();

    const allJumps = events
    .filter(e => e.name === 'jump')
    .sort((a, b) => a.frame - b.frame);

    const unfreezeEvent = events
    .filter(e => e.name === 'unfreeze' || e.name === 'unfreeze_attack')
    .sort((a, b) => a.frame - b.frame)[0];

    const firstHeroUpdate = events.find(e => e.name === 'first_hero_update') || null;

    if (!unfreezeEvent) { send({ type: 'jumps_error', msg: 'no unfreeze in log' }); return; }
    if (!allJumps.length) { send({ type: 'jumps_error', msg: 'no jumps in log' }); return; }

    const candidates = allJumps;

    const useAnchor      = !!firstHeroUpdate;
    const anchorRecFrame = useAnchor ? firstHeroUpdate.frame : unfreezeEvent.frame;
    const anchorRecTms   = useAnchor ? firstHeroUpdate.t_ms  : unfreezeEvent.t_ms;

    const plan = candidates.map(e => ({
        ev: e,
        frameDelta: Math.max(0, e.frame - anchorRecFrame),
                                      msDelta: Math.max(0,
                                                        ((e.t_ms != null ? e.t_ms : e.frame * 1000 / 60) -
                                                        (anchorRecTms != null ? anchorRecTms : anchorRecFrame * 1000 / 60))),
    }));

    let bodyMapSize = 0;
    let bodyRange   = null;
    if (bodyFramesIn && bodyFramesIn.length) {
        bodyMapSize = pump.setPlaybackBody(bodyFramesIn);
        const first = bodyFramesIn[0].frame;
        const last  = bodyFramesIn[bodyFramesIn.length - 1].frame;
        bodyRange = { first, last, count: bodyFramesIn.length };
    }

    send({
        type: 'jumps_analysis',
        total_in_log:      allJumps.length,
        effective_in_log:  allJumps.filter(e => isEffectiveJump(e.snap || {})).length,
         unfreeze_frame:    unfreezeEvent.frame,
         first_hero_update: firstHeroUpdate ? firstHeroUpdate.frame : null,
         anchor:            useAnchor ? 'first_hero_update' : 'unfreeze (fallback)',
         body_frames:       bodyRange,
         replay_count:      plan.length,
         per_jump: plan.map(p => ({
             frame:       p.ev.frame,
             frame_delta: p.frameDelta,
             ms_delta:    Math.round(p.msDelta),
                                  state_a0:    (p.ev.snap || {}).state_a0,
                                  ground_80:   (p.ev.snap || {}).ground_80,
                                  ground_84:   (p.ev.snap || {}).ground_84,
                                  cooldown_b0: (p.ev.snap || {}).cooldown_b0,
                                  effective:   isEffectiveJump(p.ev.snap || {}),
         })),
    });

    send({
        type: 'jumps_plan',
        mode:         useAnchor ? 'from_first_hero_update' : 'from_unfreeze_fallback',
        replay_count: plan.length,
        frame_deltas: plan.map(p => p.frameDelta),
         body_force:   bodyMapSize > 0 ? ('enabled, ' + bodyMapSize + ' recs') : 'disabled (no body_frames)',
         note: useAnchor
         ? 'Anchor: первый HeroBody::update. Все jump воспроизводятся + force body state.'
         : 'Fallback: anchor = unfreeze. Запишите новый лог для точной привязки.',
    });

    let phase = 'waiting_unfreeze';
    let anchorFrame = null;
    let nextIdx = 0;
    let heroPtr = null;
    let deferFrames = 0;
    let skippedCount = 0;
    let lastFpsFrame = null;
    let lastFpsWall = null;
    let lastProgressLogMs = null;

    const total = plan.length;

    function onUnfreeze() {
        if (phase !== 'waiting_unfreeze') return;
        phase = useAnchor ? 'waiting_first_update' : 'playing';
        lastFpsFrame = pump.frame();
        lastFpsWall = Date.now();
        lastProgressLogMs = Date.now();

        if (!useAnchor) {
            anchorFrame = pump.frame();
            if (bodyMapSize > 0) pump.setPlaybackAnchor(anchorFrame, anchorRecFrame);
            send({
                type: 'jumps_armed',
                mode: 'from_unfreeze_fallback',
                anchorFrame: anchorFrame,
                replay_count: total,
                body_force: bodyMapSize > 0,
            });
        } else {
            send({ type: 'jumps_waiting_first_update', note: 'Ждём первый HeroBody::update после unfreeze' });
        }
    }

    function onFirstUpdate(_hero, frame) {
        if (phase !== 'waiting_first_update') return;
        if (!isValidHeroStrict(_hero)) return;
        phase = 'playing';
        anchorFrame = frame;
        heroPtr = _hero;
        if (bodyMapSize > 0) pump.setPlaybackAnchor(anchorFrame, anchorRecFrame);
        send({
            type: 'jumps_armed',
            mode: 'from_first_hero_update',
            anchorFrame: anchorFrame,
            replay_count: total,
            frame_deltas: plan.map(p => p.frameDelta),
             body_force: bodyMapSize > 0,
             body_anchor: bodyMapSize > 0 ? { playback: anchorFrame, recorded: anchorRecFrame } : null,
        });
    }

    const h1 = Interceptor.attach(ADDR.UNFREEZE,        { onEnter() { onUnfreeze(); } });
    const h2 = Interceptor.attach(ADDR.UNFREEZE_ATTACK, { onEnter() { onUnfreeze(); } });

    pump.setOnFirstUpdate(onFirstUpdate);

    pump.setOnFrame((f) => {
        if (phase !== 'playing') return;

        if (pump._lastHero && pump._lastHeroFrame !== null && pump._lastHeroFrame > anchorFrame) {
            if (isValidHeroStrict(pump._lastHero) && (heroPtr === null || !heroPtr.equals(pump._lastHero))) {
                heroPtr = pump._lastHero;
                send({ type: 'hero_resolved', source: 'pump_lastHero', addr: heroPtr.toString(), frame: f });
            }
        }

        if (lastFpsFrame !== null && (f - lastFpsFrame) >= FPS_LOG_EVERY_N_FRAMES) {
            const dt = Date.now() - lastFpsWall;
            const fps = dt > 0 ? ((f - lastFpsFrame) * 1000 / dt) : 0;
            send({ type: 'fps', frame: f, fps: Number(fps.toFixed(1)) });
            lastFpsFrame = f;
            lastFpsWall = Date.now();
        }

        if (nextIdx < total && lastProgressLogMs !== null &&
            (Date.now() - lastProgressLogMs) >= PROGRESS_LOG_EVERY_MS) {
            lastProgressLogMs = Date.now();
        const progressTarget = anchorFrame + plan[nextIdx].frameDelta;
        const snap = heroPtr ? heroSnapshot(heroPtr) : {};
        send({
            type: 'jumps_progress',
            frame: f,
            next_idx: nextIdx,
            target_frame: progressTarget,
            remaining_frames: Math.max(0, progressTarget - f),
             state_a0:  snap.state_a0,
             ground_80: snap.ground_80,
             force_stats: bodyMapSize > 0 ? pump.forceStats() : null,
        });
            }

            if (nextIdx >= total) return;

            const targetFrame = anchorFrame + plan[nextIdx].frameDelta;
        if (f < targetFrame) return;

        if (!heroPtr || !isValidHeroStrict(heroPtr)) {
            if (deferFrames < JUMP_DEFER_MAX_FRAMES) {
                deferFrames++;
                if (deferFrames === 1) {
                    send({ type: 'jump_deferred', idx: nextIdx, frame: f, target_frame: targetFrame,
                        reason: 'hero not resolved yet' });
                }
                return;
            }
            send({ type: 'jump_skipped', idx: nextIdx, frame: f, target_frame: targetFrame,
                reason: 'hero invalid after ' + JUMP_DEFER_MAX_FRAMES + ' frames' });
            nextIdx++; skippedCount++; deferFrames = 0;
        } else {
            const snap = heroSnapshot(heroPtr);
            deferFrames = 0;
            try {
                jumpFn(heroPtr);
                send({ type: 'jump_fired', idx: nextIdx, absFrame: f, target_frame: targetFrame,
                    frame_error: f - targetFrame, snap });
            } catch (e) {
                send({ type: 'jump_error', idx: nextIdx, msg: String(e), snap });
            }
            nextIdx++;
        }

        if (nextIdx >= total) {
            phase = 'done';
            try { h1.detach(); } catch (_) {}
            try { h2.detach(); } catch (_) {}
            pump.clearOnFrame();
            pump.clearOnFirstUpdate();
            pump.clearPlaybackBody();
            send({
                type: 'jumps_done',
                fired: nextIdx - skippedCount,
                skipped: skippedCount,
                total_planned: total,
                force_stats: bodyMapSize > 0 ? pump.forceStats() : null,
            });
        }
    });

    send({
        type: 'jumps_ready',
        replay_count: total,
        body_force: bodyMapSize > 0,
        msg: useAnchor
        ? 'Тапните ОДИН раз. Anchor = first_hero_update. Body force включён.'
        : 'Тапните ОДИН раз. Anchor = unfreeze (fallback).',
    });
}

// ------------------------------------------------------------
// RPC
// ------------------------------------------------------------

rpc.exports = {
    pumpInstall: () => pump.install(),
    pumpFrame:   () => pump.frame(),
    pumpReset:   () => pump.reset(),
    pumpPause:   () => pump.pause(),
    pumpResume:  () => pump.resume(),
    pumpStep:    (n) => pump.step(n),

    detectInstall:       () => detectInstall(),
    detectStart:         () => detectStart(),
    detectStop:          () => detectStop(),
    detectGetBodyFrames: () => detectGetBodyFrames(),

    replayJumpsOnly: (events, opts) => replayJumpsOnly(events, opts),
};
