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
    UNFREEZE: MODULE_BASE.add(0x13F0AE0),
    UNFREEZE_ATTACK: MODULE_BASE.add(0x13D1B70),
    JUMP: MODULE_BASE.add(0x1608F20),
};

const VTABLE = {
    HERO_BODY: MODULE_BASE.add(0x2049048),
    PLAY_STATE: MODULE_BASE.add(0x1FF95E8),
    ATTACK_STATE: MODULE_BASE.add(0x1FF54C8),
};

const FPS_LOG_EVERY_N_FRAMES = 60;
const JUMP_DEFER_MAX_FRAMES = 20;
const PROGRESS_LOG_EVERY_MS = 1000;

// ------------------------------------------------------------
// PUMP
// ------------------------------------------------------------

const pump = {
    _frame: 0,
    _paused: false,
    _budget: -1,
    _installed: false,
    _onFrame: null,
    _lastHero: null,
    _lastHeroFrame: null,

    install() {
        if (pump._installed) {
            send({ type: 'pump_already' });
            return;
        }

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

                if (pump._onFrame) {
                    try {
                        pump._onFrame(pump._frame);
                    } catch (e) {
                        send({ type: 'onframe_error', msg: String(e) });
                    }
                }
            }
        });

        pump._installed = true;
        send({ type: 'pump_installed', func: FRAME_FUNC.toString() });
    },

    resetHero() {
        pump._lastHero = null;
        pump._lastHeroFrame = null;
    },

    reset() {
        pump._frame = 0;
    },

    frame() {
        return pump._frame;
    },

    pause() {
        pump._paused = true;
    },

    resume() {
        pump._paused = false;
        pump._budget = -1;
    },

    step(n) {
        pump._paused = false;
        pump._budget = n;
    },

    setOnFrame(fn) {
        pump._onFrame = fn;
    },

    clearOnFrame() {
        pump._onFrame = null;
    },
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

    try {
        if (!p.and(7).isNull()) return false;
    } catch (_) {
        return false;
    }

    try {
        if (!p.readPointer().equals(VTABLE.HERO_BODY)) return false;
    } catch (_) {
        return false;
    }

    let body;
    try {
        body = p.add(0x20).readPointer();
    } catch (_) {
        return false;
    }

    if (!isReadablePtr(body)) return false;

    try {
        if (!body.and(7).isNull()) return false;
    } catch (_) {
        return false;
    }

    let bt;
    try {
        bt = body.readU32();
    } catch (_) {
        return false;
    }

    if (bt !== 2) return false;

    let grav;
    try {
        grav = body.add(0xA8).readFloat();
    } catch (_) {
        return false;
    }

    if (!isFinite(grav) || grav < -100 || grav > 100) return false;

    return true;
}

function heroSnapshot(p) {
    const s = {};

    if (!p || !isReadablePtr(p)) {
        s.reason = 'unmapped';
        return s;
    }

    try {
        s.vt_rel = p.readPointer().sub(MODULE_BASE).toString();
    } catch (_) {
        s.vt_rel = 'err';
    }

    try {
        s.state_a0 = p.add(0xA0).readS32();
    } catch (_) {
        s.state_a0 = 'err';
    }

    try {
        s.cooldown_b0 = p.add(0xB0).readS32();
    } catch (_) {
        s.cooldown_b0 = 'err';
    }

    try {
        s.ground_80 = p.add(0x80).readS32();
    } catch (_) {
        s.ground_80 = 'err';
    }

    try {
        s.ground_84 = p.add(0x84).readS32();
    } catch (_) {
        s.ground_84 = 'err';
    }

    return s;
}

// ------------------------------------------------------------
// DETECT
// ------------------------------------------------------------

let detectRec = false;
let detectEvents = [];
let detectStartWall = null;

function detectInstall() {
    const targets = [
        { name: 'unfreeze', addr: ADDR.UNFREEZE },
        { name: 'unfreeze_attack', addr: ADDR.UNFREEZE_ATTACK },
        { name: 'jump', addr: ADDR.JUMP },
    ];

    targets.forEach(t => {
        Interceptor.attach(t.addr, {
            onEnter(args) {
                if (!detectRec) return;

                const thisPtr = args[0];

                const ev = {
                    frame: pump.frame(),
                           t_ms: detectStartWall !== null ? (Date.now() - detectStartWall) : 0,
                           name: t.name,
                           thisPtr: thisPtr.toString(),
                           snap: heroSnapshot(thisPtr),
                };

                try {
                    const vt = thisPtr.readPointer();
                    ev.vt = vt.toString();
                    ev.vt_rel = vt.sub(MODULE_BASE).toString();
                } catch (_) {
                    ev.vt = null;
                    ev.vt_rel = null;
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

    send({
        type: 'detect_started',
        frame: pump.frame(),
         wall: detectStartWall
    });
}

function detectStop() {
    detectRec = false;

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
// REPLAY ALL JUMPS FROM UNFREEZE
// ------------------------------------------------------------

let jumpFn = null;

function ensureJumpFn() {
    if (!jumpFn) {
        jumpFn = new NativeFunction(ADDR.JUMP, 'void', ['pointer']);
    }
}

function replayJumpsOnly(events, opts) {
    opts = opts || {};

    ensureJumpFn();
    pump.install();
    pump.clearOnFrame();
    pump.resetHero();

    const allJumps = events
    .filter(e => e.name === 'jump')
    .sort((a, b) => a.frame - b.frame);

    const unfreezeEvent = events
    .filter(e => e.name === 'unfreeze' || e.name === 'unfreeze_attack')
    .sort((a, b) => a.frame - b.frame)[0];

    if (!unfreezeEvent) {
        send({ type: 'jumps_error', msg: 'no unfreeze in log' });
        return;
    }

    if (!allJumps.length) {
        send({ type: 'jumps_error', msg: 'no jumps in log' });
        return;
    }

    // Все прыжки, включая входной, планируем относительно кадра unfreeze.
    const plan = allJumps.map(e => ({
        ev: e,
        frameDelta: Math.max(0, e.frame - unfreezeEvent.frame),
                                    msDelta: Math.max(
                                        0,
                                        ((e.t_ms != null ? e.t_ms : e.frame * 1000 / 60) -
                                        (unfreezeEvent.t_ms != null ? unfreezeEvent.t_ms : unfreezeEvent.frame * 1000 / 60))
                                    ),
    }));

    send({
        type: 'jumps_analysis',
        total_in_log: allJumps.length,
        unfreeze_frame: unfreezeEvent.frame,
        replay_count: plan.length,
        per_jump: plan.map(p => ({
            frame: p.ev.frame,
            frame_delta: p.frameDelta,
            ms_delta: Math.round(p.msDelta),
                                 state_a0: (p.ev.snap || {}).state_a0,
                                 ground_80: (p.ev.snap || {}).ground_80,
                                 ground_84: (p.ev.snap || {}).ground_84,
                                 cooldown_b0: (p.ev.snap || {}).cooldown_b0,
                                 kept: true,
        })),
    });

    send({
        type: 'jumps_plan',
        mode: 'frame_from_unfreeze',
        replay_count: plan.length,
        unfreeze_frame: unfreezeEvent.frame,
        frame_deltas: plan.map(p => p.frameDelta),
         note: 'Все jump-события, включая входной, воспроизводятся автоматически по кадрам от unfreeze.',
    });

    let phase = 'waiting_unfreeze';
    let unfreezeFrame = null;
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

        phase = 'playing';
        unfreezeFrame = pump.frame();
        lastFpsFrame = unfreezeFrame;
        lastFpsWall = Date.now();
        lastProgressLogMs = Date.now();

        send({
            type: 'jumps_armed',
            unfreezeFrame,
            mode: 'frame_from_unfreeze',
            replay_count: total,
            frame_deltas: plan.map(p => p.frameDelta),
             hint: 'Unfreeze пойман. НЕ тапайте: все прыжки будут выполнены автоматически.',
        });
    }

    const h1 = Interceptor.attach(ADDR.UNFREEZE, {
        onEnter() {
            onUnfreeze();
        }
    });

    const h2 = Interceptor.attach(ADDR.UNFREEZE_ATTACK, {
        onEnter() {
            onUnfreeze();
        }
    });

    pump.setOnFrame((f) => {
        if (phase !== 'playing') return;

        if (
            pump._lastHero &&
            pump._lastHeroFrame !== null &&
            pump._lastHeroFrame > unfreezeFrame
        ) {
            if (
                isValidHeroStrict(pump._lastHero) &&
                (heroPtr === null || !heroPtr.equals(pump._lastHero))
            ) {
                heroPtr = pump._lastHero;
                send({
                    type: 'hero_resolved',
                    source: 'pump_lastHero',
                    addr: heroPtr.toString(),
                     frame: f
                });
            }
        }

        if (
            lastFpsFrame !== null &&
            (f - lastFpsFrame) >= FPS_LOG_EVERY_N_FRAMES
        ) {
            const dt = Date.now() - lastFpsWall;
            const fps = dt > 0 ? ((f - lastFpsFrame) * 1000 / dt) : 0;

            send({
                type: 'fps',
                frame: f,
                fps: Number(fps.toFixed(1))
            });

            lastFpsFrame = f;
            lastFpsWall = Date.now();
        }

        if (
            nextIdx < total &&
            lastProgressLogMs !== null &&
            (Date.now() - lastProgressLogMs) >= PROGRESS_LOG_EVERY_MS
        ) {
            lastProgressLogMs = Date.now();

            const targetFrame = unfreezeFrame + plan[nextIdx].frameDelta;

            send({
                type: 'jumps_progress',
                frame: f,
                next_idx: nextIdx,
                target_frame: targetFrame,
                remaining_frames: Math.max(0, targetFrame - f),
                 state_a0: heroPtr ? heroSnapshot(heroPtr).state_a0 : null,
                 ground_80: heroPtr ? heroSnapshot(heroPtr).ground_80 : null,
            });
        }

        if (nextIdx >= total) return;

        const targetFrame = unfreezeFrame + plan[nextIdx].frameDelta;

        if (f < targetFrame) return;

        if (!heroPtr || !isValidHeroStrict(heroPtr)) {
            if (deferFrames < JUMP_DEFER_MAX_FRAMES) {
                deferFrames++;

                if (deferFrames === 1) {
                    send({
                        type: 'jump_deferred',
                        idx: nextIdx,
                        frame: f,
                        target_frame: targetFrame,
                        reason: 'hero not resolved yet'
                    });
                }

                return;
            }

            send({
                type: 'jump_skipped',
                idx: nextIdx,
                frame: f,
                target_frame: targetFrame,
                reason: 'hero invalid'
            });

            nextIdx++;
            skippedCount++;
            deferFrames = 0;
            return;
        }

        const snap = heroSnapshot(heroPtr);
        deferFrames = 0;

        try {
            jumpFn(heroPtr);

            send({
                type: 'jump_fired',
                idx: nextIdx,
                absFrame: f,
                target_frame: targetFrame,
                frame_error: f - targetFrame,
                snap
            });
        } catch (e) {
            send({
                type: 'jump_error',
                idx: nextIdx,
                msg: String(e),
                 snap
            });
        }

        nextIdx++;

        if (nextIdx >= total) {
            phase = 'done';

            try { h1.detach(); } catch (_) {}
            try { h2.detach(); } catch (_) {}
            pump.clearOnFrame();

            send({
                type: 'jumps_done',
                fired: nextIdx - skippedCount,
                skipped: skippedCount,
                total_planned: total
            });
        }
    });

    send({
        type: 'jumps_ready',
        replay_count: total,
        msg: 'Дождитесь unfreeze. НЕ тапайте: входной и все последующие прыжки будут выполнены автоматически.',
    });
}

// ------------------------------------------------------------
// RPC
// ------------------------------------------------------------

rpc.exports = {
    pumpInstall: () => pump.install(),
    pumpFrame: () => pump.frame(),
    pumpReset: () => pump.reset(),
    pumpPause: () => pump.pause(),
    pumpResume: () => pump.resume(),
    pumpStep: (n) => pump.step(n),

    detectInstall: () => detectInstall(),
    detectStart: () => detectStart(),
    detectStop: () => detectStop(),

    replayJumpsOnly: (events, opts) => replayJumpsOnly(events, opts),
};
