// agent.js — TAS agent for King of Thieves 2.84.1 x86_64
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

const FPS_LOG_EVERY_N_FRAMES = 60;
const JUMP_DEFER_MAX_FRAMES  = 20;
const PROGRESS_LOG_EVERY_MS  = 1000;

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

    install() {
        if (pump._installed) { send({ type: 'pump_already' }); return; }

        pump._paused = false;
        pump._budget = -1;
        pump._frame = 0;
        pump._lastHero = null;
        pump._lastHeroFrame = null;

        Interceptor.attach(FRAME_FUNC, {
            onEnter(args) {
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

                // DETECT: первый HeroBody::update после unfreeze
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

                // REPLAY: callback для playback
                if (pump._onFirstUpdate) {
                    try { pump._onFirstUpdate(args[0], pump._frame); } catch (_) {}
                }

                if (pump._onFrame) {
                    try { pump._onFrame(pump._frame); }
                    catch (e) { send({ type: 'onframe_error', msg: String(e) }); }
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
};

// ------------------------------------------------------------
// POINTER HELPERS
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
    try { s.vt_rel    = p.readPointer().sub(MODULE_BASE).toString(); } catch (_) { s.vt_rel    = 'err'; }
    try { s.state_a0  = p.add(0xA0).readS32(); } catch (_) { s.state_a0  = 'err'; }
    try { s.cooldown_b0 = p.add(0xB0).readS32(); } catch (_) { s.cooldown_b0 = 'err'; }
    try { s.ground_80 = p.add(0x80).readS32(); } catch (_) { s.ground_80 = 'err'; }
    try { s.ground_84 = p.add(0x84).readS32(); } catch (_) { s.ground_84 = 'err'; }
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
    send({ type: 'detect_started', frame: pump.frame(), wall: detectStartWall });
}

function detectStop() {
    detectRec = false;
    detectWaitFirstHeroUpdate = false;
    const dur = detectStartWall ? (Date.now() - detectStartWall) : 0;
    send({
        type: 'detect_stopped',
        count: detectEvents.length,
        duration_ms: dur,
        avg_fps: dur > 0 ? (pump.frame() * 1000 / dur).toFixed(1) : 'n/a',
    });
    return detectEvents;
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
    const onlyEffective = !!opts.only_effective;

    ensureJumpFn();
    pump.install();
    pump.clearOnFrame();
    pump.clearOnFirstUpdate();
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

    // Не пропускаем первый jump — это реальный прыжок игрока (игра делает выход из двери через Entrance, не через HeroBody::jump)
    const candidates = allJumps;

    if (onlyEffective) {
        const effective = candidates.filter(e => isEffectiveJump(e.snap || {}));
        send({
            type: 'jumps_filter',
            mode: 'only_effective',
            total: candidates.length,
            effective: effective.length,
        });
        if (!effective.length) {
            send({ type: 'jumps_error', msg: 'нет эффективных прыжков в логе (--only-effective)' });
            return;
        }
    }
    const toReplay = onlyEffective
    ? candidates.filter(e => isEffectiveJump(e.snap || {}))
    : candidates;

    const useAnchor      = !!firstHeroUpdate;
    const anchorRecFrame = useAnchor ? firstHeroUpdate.frame : unfreezeEvent.frame;
    const anchorRecTms   = useAnchor ? firstHeroUpdate.t_ms : unfreezeEvent.t_ms;

    const plan = toReplay.map(e => ({
        ev: e,
        frameDelta: Math.max(0, e.frame - anchorRecFrame),
                                    msDelta: Math.max(0,
                                                      ((e.t_ms != null ? e.t_ms : e.frame * 1000 / 60) -
                                                      (anchorRecTms != null ? anchorRecTms : anchorRecFrame * 1000 / 60))),
    }));

    const totalEffective = allJumps.filter(e => isEffectiveJump(e.snap || {})).length;

    send({
        type: 'jumps_analysis',
        total_in_log:      allJumps.length,
        effective_in_log:  totalEffective,
        entrance_skipped:  false,           // БОЛЬШЕ НЕ ПРОПУСКАЕМ
        unfreeze_frame:    unfreezeEvent.frame,
        first_hero_update: firstHeroUpdate ? firstHeroUpdate.frame : null,
        anchor:            useAnchor ? 'first_hero_update' : 'unfreeze (fallback)',
         mode:              onlyEffective ? 'only_effective' : 'all',
         replay_count:      plan.length,
         per_jump: plan.map(p => ({
             frame:        p.ev.frame,
             frame_delta:  p.frameDelta,
             ms_delta:     Math.round(p.msDelta),
                                  state_a0:     (p.ev.snap || {}).state_a0,
                                  ground_80:    (p.ev.snap || {}).ground_80,
                                  ground_84:    (p.ev.snap || {}).ground_84,
                                  cooldown_b0:  (p.ev.snap || {}).cooldown_b0,
                                  effective:    isEffectiveJump(p.ev.snap || {}),
         })),
    });

    send({
        type: 'jumps_plan',
        mode:         useAnchor ? 'from_first_hero_update' : 'from_unfreeze_fallback',
        replay_count: plan.length,
        frame_deltas: plan.map(p => p.frameDelta),
         note: useAnchor
         ? 'Anchor: первый HeroBody::update после unfreeze. Все jump воспроизводятся в том же порядке.'
         : 'В логе нет first_hero_update. Fallback: anchor = unfreeze. Запишите новый лог для точной привязки.',
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
            send({
                type: 'jumps_armed',
                mode: 'from_unfreeze_fallback',
                anchorFrame: anchorFrame,
                replay_count: total,
                warning: 'В логе нет first_hero_update — точность ниже. Запишите новый лог.',
            });
        } else {
            send({
                type: 'jumps_waiting_first_update',
                note: 'Ждём первый HeroBody::update после unfreeze',
            });
        }
    }

    function onFirstUpdate(_hero, frame) {
        if (phase !== 'waiting_first_update') return;
        if (!isValidHeroStrict(_hero)) return;
        phase = 'playing';
        anchorFrame = frame;
        heroPtr = _hero;
        send({
            type: 'jumps_armed',
            mode: 'from_first_hero_update',
            anchorFrame: anchorFrame,
            replay_count: total,
            frame_deltas: plan.map(p => p.frameDelta),
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
        const targetFrame = anchorFrame + plan[nextIdx].frameDelta;
        const snap = heroPtr ? heroSnapshot(heroPtr) : {};
        send({
            type: 'jumps_progress',
            frame: f,
            next_idx: nextIdx,
            target_frame: targetFrame,
            remaining_frames: Math.max(0, targetFrame - f),
             state_a0:  snap.state_a0,
             ground_80: snap.ground_80,
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
            send({ type: 'jumps_done', fired: nextIdx - skippedCount, skipped: skippedCount,
                total_planned: total });
        }
    });

    send({
        type: 'jumps_ready',
        replay_count: total,
        msg: useAnchor
        ? 'Тапните ОДИН раз. Ждём unfreeze → first HeroBody::update → все jumps по якорю.'
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

    detectInstall: () => detectInstall(),
    detectStart:   () => detectStart(),
    detectStop:    () => detectStop(),

    replayJumpsOnly: (events, opts) => replayJumpsOnly(events, opts),
};
