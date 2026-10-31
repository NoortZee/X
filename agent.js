// agent.js — TAS agent for King of Thieves 2.84.1 x86_64
// v3.5: только pure input replay. Force и temporal полностью удалены.
//       Jumps привязаны к номеру кадра, физика не модифицируется,
//       libc time-хуки в play не ставятся (иначе FPS падает до ~10).
// ------------------------------------------------------------

'use strict';

const VERSION = 3;

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
    GRAVITY:   0xA8,
    BODY_SIZE: 0x200,
};

const BODY_FIELDS = ['px', 'py', 'ang', 'vx', 'vy', 'av'];

// ------------------------------------------------------------
// Frida 17 API shim
// ------------------------------------------------------------
function findExport(moduleName, exportName) {
    try {
        const m = Process.getModuleByName(moduleName);
        if (m) {
            const a = m.findExportByName(exportName);
            if (a) return a;
        }
    } catch (_) {}
    try { return Module.findGlobalExportByName(exportName); } catch (_) {}
    return null;
}

// ------------------------------------------------------------
// БИТОВЫЕ ХЕЛПЕРЫ (zero-sign нормализация)
// ------------------------------------------------------------

const _f32buf = new ArrayBuffer(4);
const _f32view = new Float32Array(_f32buf);
const _u32view = new Uint32Array(_f32buf);

function f32Bits(x) {
    _f32view[0] = x;
    let u = _u32view[0] >>> 0;
    if (u === 0x80000000) u = 0;
    return u;
}

function fnv1a32(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

// ------------------------------------------------------------
// ВРЕМЯ (наносекунды через syscall) — используется только для диагностики
// ------------------------------------------------------------

const CLOCK_MONOTONIC = 1;
const _SYS_clock_gettime_x86_64 = 228;
const _tsBuf = Memory.alloc(16);
let _syscallFn = null;
try {
    const sa = findExport('libc.so', 'syscall');
    if (sa) _syscallFn = new NativeFunction(sa, 'long', ['long', '...']);
} catch (_) {}

function nowNs() {
    if (_syscallFn) {
        try {
            _syscallFn(_SYS_clock_gettime_x86_64, CLOCK_MONOTONIC, _tsBuf);
            const sec = _tsBuf.readS64();
            const nsec = _tsBuf.add(8).readS64();
            return Number(sec) * 1e9 + Number(nsec);
        } catch (_) {}
    }
    return Date.now() * 1e6;
}

// ------------------------------------------------------------
// BODY STATE (read-only)
// ------------------------------------------------------------

function isReadablePtr(p) {
    if (p === null || p === undefined) return false;
    if (p.isNull && p.isNull()) return false;
    return Process.findRangeByAddress(p) !== null;
}

function _nz(v) { return v === 0 ? 0 : v; }   // -0.0 → +0.0

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
        return {
            px: _nz(px), py: _nz(py), ang: _nz(ang),
            vx: _nz(vx), vy: _nz(vy), av: _nz(av),
        };
    } catch (_) { return null; }
}

function heroBodyBytes(bodyPtr) {
    if (!bodyPtr || bodyPtr.isNull() || !Process.findRangeByAddress(bodyPtr)) return null;
    try {
        const buf = bodyPtr.readByteArray(BODY.BODY_SIZE);
        if (!buf) return null;
        return new Uint8Array(buf);
    } catch (_) { return null; }
}

function heroBodyHash(bodyPtr) {
    const b = heroBodyBytes(bodyPtr);
    if (!b) return null;
    return fnv1a32(b);
}

// ------------------------------------------------------------
// HERO STRICT CHECK
// ------------------------------------------------------------

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
    try { grav = body.add(BODY.GRAVITY).readFloat(); } catch (_) { return false; }
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
// LIBC HOOKS (RNG + TIME) — разделены, чтобы не ронять FPS в play
// ------------------------------------------------------------

const _libcHooks = {
    rng:  new Set(),
    time: new Set(),
    rngInstalled:  false,
    timeInstalled: false,
    rngHandles:  [],
    timeHandles: [],
};

function installRngHooks() {
    if (_libcHooks.rngInstalled) return;
    _libcHooks.rngInstalled = true;

    for (const name of ['rand', 'random', 'lrand48', 'mrand48', 'drand48']) {
        const a = findExport('libc.so', name);
        if (!a) continue;
        _libcHooks.rng.add(name);
        const h = Interceptor.attach(a, {
            onEnter() { this._fn = name; },
                                     onLeave(ret) {
                                         if (pump._recordRng) {
                                             try {
                                                 const v = ret.toUInt32();
                                                 pump._rngLog.push({ f: pump._frame, fn: name, v });
                                             } catch (_) {}
                                         }
                                         if (pump._replayRng) {
                                             const q = pump._replayRng.get(name);
                                             if (q && q.length > 0) {
                                                 const v = q.shift();
                                                 try { ret.replace(ptr(v)); } catch (_) {}
                                             }
                                         }
                                     }
        });
        _libcHooks.rngHandles.push(h);
        send({ type: 'dbg', where: 'libc_hook', fn: name, kind: 'rng', ok: true });
    }
}

function installTimeHooks() {
    if (_libcHooks.timeInstalled) return;
    _libcHooks.timeInstalled = true;

    for (const name of ['clock_gettime', 'gettimeofday', 'clock_gettime64']) {
        const a = findExport('libc.so', name);
        if (!a) continue;
        _libcHooks.time.add(name);
        const h = Interceptor.attach(a, {
            onEnter(args) {
                this._ts = args[name === 'gettimeofday' ? 0 : 1];
                this._clk = name === 'gettimeofday' ? -1 : args[0].toInt32();
                this._fn = name;
            },
            onLeave(ret) {
                if (pump._recordTime && this._ts && isReadablePtr(this._ts)) {
                    try {
                        let ns;
                        if (this._fn === 'gettimeofday') {
                            const s = this._ts.readS64();
                            const us = this._ts.add(8).readS64();
                            ns = Number(s) * 1e9 + Number(us) * 1000;
                        } else {
                            const s = this._ts.readS64();
                            const nsPart = this._ts.add(8).readS64();
                            ns = Number(s) * 1e9 + Number(nsPart);
                        }
                        pump._timeLog.push({ f: pump._frame, fn: this._fn, clk: this._clk, ns });
                    } catch (_) {}
                }
                if (pump._freezeTime && this._ts && isReadablePtr(this._ts)) {
                    try {
                        const ns = pump._frozenNs;
                        if (this._fn === 'gettimeofday') {
                            this._ts.writeS64(Math.floor(ns / 1e9));
                            this._ts.add(8).writeS64(Math.floor((ns % 1e9) / 1000));
                        } else {
                            this._ts.writeS64(Math.floor(ns / 1e9));
                            this._ts.add(8).writeS64(ns % 1e9);
                        }
                        ret.replace(0);
                    } catch (_) {}
                }
            }
        });
        _libcHooks.timeHandles.push(h);
        send({ type: 'dbg', where: 'libc_hook', fn: name, kind: 'time', ok: true });
    }
}

function detachRngHooks() {
    for (const h of _libcHooks.rngHandles) { try { h.detach(); } catch (_) {} }
    _libcHooks.rngHandles = [];
    _libcHooks.rngInstalled = false;
    _libcHooks.rng.clear();
}

function detachTimeHooks() {
    for (const h of _libcHooks.timeHandles) { try { h.detach(); } catch (_) {} }
    _libcHooks.timeHandles = [];
    _libcHooks.timeInstalled = false;
    _libcHooks.time.clear();
}

function installLibcHooks() {
    installRngHooks();
    installTimeHooks();
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
    _onLeave: null,

    _lastHero: null,
    _lastHeroFrame: null,

    _detectBodyRecord: false,
    _detectBodyFrames: [],
    _detectBodyHash: new Map(),

    _playbackBodyMap: null,
    _playbackAnchorFrame: null,
    _playbackAnchorRecFrame: null,
    _replayBodyFrames: [],

    _divergences: [],

    _ring: [],
    _ringMax: 60,

    _recordTime: false,
    _timeLog: [],
    _frameNsTimeline: new Map(),
    _recordRng: false,
    _rngLog: [],

    _replayRng: null,
    _freezeTime: false,
    _frozenNs: null,

    _dbgStats: { enter: 0, leave: 0, nullBody: 0, readOk: 0 },

    install() {
        if (pump._installed) { send({ type: 'pump_already' }); return; }
        pump._paused = false;
        pump._budget = -1;
        pump._frame = 0;

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
                pump._dbgStats.enter++;

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
                           t_ns:    detectStartNsVal !== null ? (nowNs() - detectStartNsVal) : 0,
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
                pump._dbgStats.leave++;
                if (!hero || !isReadablePtr(hero)) return;

                let body;
                try { body = hero.add(0x20).readPointer(); } catch (_) { return; }
                if (!isReadablePtr(body)) { pump._dbgStats.nullBody++; return; }

                const rec = readBodyState(body);
                if (!rec) return;
                pump._dbgStats.readOk++;
                rec.frame = pump._frame;

                const snap = heroSnapshot(hero);
                const extra = {
                    a0:  snap.state_a0,
                    b0:  snap.cooldown_b0,
                    g80: snap.ground_80,
                    g84: snap.ground_84,
                };

                pump._ring.push({ frame: pump._frame, ...rec, ...extra });
                if (pump._ring.length > pump._ringMax) pump._ring.shift();

                if (pump._detectBodyRecord) {
                    const full = { ...rec, ...extra };
                    pump._detectBodyFrames.push(full);
                    const h = heroBodyHash(body);
                    if (h !== null) pump._detectBodyHash.set(pump._frame, h);
                }

                // ВАЖНО: сравнение до _onLeave (пользовательский колбэк может дёргать jumpFn,
                // который изменит состояние уже после того, как мы снимем actual).
                if (pump._playbackBodyMap && pump._playbackAnchorFrame !== null) {
                    const recFrame = pump._playbackAnchorRecFrame
                    + (pump._frame - pump._playbackAnchorFrame);
                    const expected = pump._playbackBodyMap.get(recFrame);
                    const actual = { ...rec, ...extra };

                    pump._replayBodyFrames.push({ frame: pump._frame, ...actual });

                    if (expected) {
                        const div = compareBodyBit(actual, expected);
                        if (div) {
                            div.f = pump._frame;
                            div.recFrame = recFrame;
                            div.expected = pickFields(expected);
                            div.actual = pickFields(actual);
                            pump._divergences.push(div);
                        }
                        // Физика НЕ модифицируется — только читаем и сравниваем.
                    }
                }

                // Jump scheduling — ПОСЛЕ сравнения, чтобы мы сняли pre-jump state.
                if (pump._onLeave) {
                    try { pump._onLeave(pump._frame, body, rec, extra); } catch (_) {}
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
    setOnLeave(fn)       { pump._onLeave = fn; },
    clearOnLeave()       { pump._onLeave = null; },

    detectBodyStart() {
        pump._detectBodyFrames = [];
        pump._detectBodyHash = new Map();
        pump._detectBodyRecord = true;
    },
    detectBodyStop()  { pump._detectBodyRecord = false; },
    detectBodyGet()   { return pump._detectBodyFrames; },
    detectBodyHashGet() { return pump._detectBodyHash; },

    setPlaybackBody(framesArray) {
        if (!framesArray || !framesArray.length) { pump._playbackBodyMap = null; return 0; }
        const m = new Map();
        for (const r of framesArray) m.set(r.frame, r);
        pump._playbackBodyMap = m;
        pump._replayBodyFrames = [];
        pump._divergences = [];
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
        pump._replayRng = null;
    },
};

// ------------------------------------------------------------
// ПОЛЕВОЕ СРАВНЕНИЕ
// ------------------------------------------------------------

function pickFields(obj) {
    const out = {};
    for (const k of BODY_FIELDS) out[k] = obj[k];
    for (const k of ['a0', 'b0', 'g80', 'g84']) if (k in obj) out[k] = obj[k];
    return out;
}

function compareBodyBit(actual, expected) {
    const diffs = [];
    for (const k of BODY_FIELDS) {
        if (actual[k] === undefined || expected[k] === undefined) continue;
        const ab = f32Bits(actual[k]);
        const eb = f32Bits(expected[k]);
        if (ab !== eb) {
            if ((ab === 0 && eb === 0x80000000) || (ab === 0x80000000 && eb === 0)) continue;
            diffs.push({ field: k, actual: actual[k], expected: expected[k], aU32: ab, eU32: eb });
        }
    }
    for (const k of ['a0', 'b0', 'g80', 'g84']) {
        if (actual[k] === undefined || expected[k] === undefined) continue;
        if (actual[k] !== expected[k]) {
            diffs.push({ field: k, actual: actual[k], expected: expected[k], int: true });
        }
    }
    return diffs.length ? { diffs } : null;
}

// ------------------------------------------------------------
// DETECT
// ------------------------------------------------------------

let detectRec = false;
let detectEvents = [];
let detectStartWall = null;
let detectStartNsVal = null;
let detectWaitFirstHeroUpdate = false;
let _jumpReturnAddrs = new Map();
let _jumpCallSites = new Set();

function _onFrameRecordTimeline(f) {
    if (!pump._recordTime) return;
    if (detectStartNsVal === null) return;
    pump._frameNsTimeline.set(f, nowNs() - detectStartNsVal);
}

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
                           t_ns:    detectStartNsVal !== null ? (nowNs() - detectStartNsVal) : 0,
                           name:    t.name,
                           thisPtr: thisPtr.toString(),
                           snap:    heroSnapshot(thisPtr),
                };
                try {
                    const vt = thisPtr.readPointer();
                    ev.vt     = vt.toString();
                    ev.vt_rel = vt.sub(MODULE_BASE).toString();
                } catch (_) { ev.vt = null; ev.vt_rel = null; }

                if (t.name === 'jump') {
                    try {
                        ev.returnAddress = this.returnAddress.toString();
                        ev.returnAddressRel = this.returnAddress.sub(MODULE_BASE).toString();
                        _jumpReturnAddrs.set(ev.frame, ev.returnAddressRel);
                        _jumpCallSites.add(ev.returnAddressRel);
                    } catch (_) {}
                }

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
    detectStartNsVal = nowNs();
    detectRec = true;
    detectWaitFirstHeroUpdate = false;
    _jumpReturnAddrs = new Map();
    _jumpCallSites = new Set();

    pump._frameNsTimeline = new Map();
    pump._timeLog = [];
    pump._rngLog = [];
    pump.detectBodyStart();

    pump._recordTime = true;
    pump._recordRng = true;

    pump.setOnFrame(_onFrameRecordTimeline);

    send({ type: 'detect_started', frame: pump.frame(), wall: detectStartWall, ns: detectStartNsVal });
}

function detectStop() {
    detectRec = false;
    detectWaitFirstHeroUpdate = false;
    pump.detectBodyStop();
    pump._recordTime = false;
    pump._recordRng = false;
    pump.clearOnFrame();

    const dur = detectStartWall ? (Date.now() - detectStartWall) : 0;
    const bodyFrames = pump._detectBodyFrames;
    const hashCount = pump._detectBodyHash.size;

    send({
        type: 'detect_stopped',
        count: detectEvents.length,
        body_frames: bodyFrames.length,
        body_hashes: hashCount,
        time_samples: pump._timeLog.length,
        rng_samples: pump._rngLog.length,
        duration_ms: dur,
        avg_fps: dur > 0 ? (pump.frame() * 1000 / dur).toFixed(1) : 'n/a',
         jump_callsites: Array.from(_jumpCallSites),
    });
    return detectEvents;
}

function detectGetBodyFrames()        { return pump.detectBodyGet(); }
function detectGetFrameNsTimeline()   {
    if (!pump._frameNsTimeline) return [];
    const out = [];
    for (const [f, ns] of pump._frameNsTimeline) out.push([f, ns]);
    out.sort((a, b) => a[0] - b[0]);
    return out;
}
function detectGetRngLog()  { return pump._rngLog; }
function detectGetTimeLog() { return pump._timeLog; }

// ------------------------------------------------------------
// REPLAY (pure, frame-synced)
// ------------------------------------------------------------

let jumpFn = null;
function ensureJumpFn() {
    if (!jumpFn) jumpFn = new NativeFunction(ADDR.JUMP, 'void', ['pointer']);
}

let _activeJumpsHooks = [];

function replayJumpsOnly(events, opts) {
    opts = opts || {};
    const bodyFramesIn = Array.isArray(opts.body_frames) ? opts.body_frames : null;
    const rngLogIn     = Array.isArray(opts.rng_log) ? opts.rng_log : null;

    ensureJumpFn();
    pump.install();
    pump.reset();
    pump.clearOnFrame();
    pump.clearOnFirstUpdate();
    pump.clearOnLeave();
    pump.clearPlaybackBody();
    pump.resetHero();

    // Time-хуки в play не ставим (clock_gettime зовётся сотни раз за кадр,
    // Interceptor-трамплин роняет FPS до ~10). RNG-хуки — только если есть
    // что воспроизводить.
    if (rngLogIn && rngLogIn.length) {
        installRngHooks();
    } else {
        send({ type: 'dbg', where: 'replay',
            msg: 'rng_log absent — libc rng hooks skipped (play stays fast)' });
    }

    const allJumps = events
    .filter(e => e.name === 'jump')
    .sort((a, b) => a.frame - b.frame);
    const unfreezeEvent = events
    .filter(e => e.name === 'unfreeze' || e.name === 'unfreeze_attack')
    .sort((a, b) => a.frame - b.frame)[0];
    const firstHeroUpdate = events.find(e => e.name === 'first_hero_update') || null;
    const firstBodyFrame = (bodyFramesIn && bodyFramesIn.length) ? bodyFramesIn[0].frame : null;

    if (!allJumps.length) { send({ type: 'jumps_error', msg: 'no jumps in log' }); return; }

    let useAnchor, anchorRecFrame, anchorKind;
    if (firstHeroUpdate) {
        useAnchor = true;
        anchorRecFrame = firstHeroUpdate.frame;
        anchorKind     = 'first_hero_update';
    } else if (firstBodyFrame !== null) {
        useAnchor = true;
        anchorRecFrame = firstBodyFrame;
        anchorKind     = 'first_body_frame';
    } else if (unfreezeEvent) {
        useAnchor = false;
        anchorRecFrame = unfreezeEvent.frame;
        anchorKind     = 'unfreeze (fallback)';
    } else {
        send({ type: 'jumps_error', msg: 'no anchor available' });
        return;
    }

    // План прыжков — привязан ТОЛЬКО к номеру кадра. Wall-clock не учитывается.
    const plan = allJumps.map(e => ({
        ev: e,
        frameDelta: Math.max(0, e.frame - anchorRecFrame),
    }));

    let bodyMapSize = 0, bodyRange = null;
    if (bodyFramesIn && bodyFramesIn.length) {
        bodyMapSize = pump.setPlaybackBody(bodyFramesIn);
        const first = bodyFramesIn[0].frame;
        const last  = bodyFramesIn[bodyFramesIn.length - 1].frame;
        bodyRange = { first, last, count: bodyFramesIn.length };
    }

    if (rngLogIn && rngLogIn.length) {
        const byFn = {};
        for (const r of rngLogIn) {
            if (!r.fn) continue;
            if (!byFn[r.fn]) byFn[r.fn] = [];
            byFn[r.fn].push(r.v >>> 0);
        }
        const m = new Map();
        for (const k of Object.keys(byFn)) m.set(k, byFn[k].slice());
        pump._replayRng = m;
    }

    const expectedCallSites = new Set();
    for (const j of allJumps) {
        if (j.returnAddressRel) expectedCallSites.add(j.returnAddressRel);
    }

    send({
        type: 'jumps_analysis',
        total_in_log:      allJumps.length,
        effective_in_log:  allJumps.filter(e => isEffectiveJump(e.snap || {})).length,
         unfreeze_frame:    unfreezeEvent ? unfreezeEvent.frame : null,
         first_hero_update: firstHeroUpdate ? firstHeroUpdate.frame : null,
         first_body_frame:  firstBodyFrame,
         anchor:            anchorKind,
         anchor_rec_frame:  anchorRecFrame,
         body_frames:       bodyRange,
         replay_count:      plan.length,
         expected_callsites: Array.from(expectedCallSites),
         per_jump: plan.map(p => ({
             frame: p.ev.frame,
             frame_delta: p.frameDelta,
             state_a0:    (p.ev.snap || {}).state_a0,
                                  ground_80:   (p.ev.snap || {}).ground_80,
                                  ground_84:   (p.ev.snap || {}).ground_84,
                                  cooldown_b0: (p.ev.snap || {}).cooldown_b0,
                                  effective:   isEffectiveJump(p.ev.snap || {}),
                                  callsite:    p.ev.returnAddressRel || null,
         })),
    });

    send({
        type: 'jumps_plan',
        mode:         anchorKind,
        replay_mode:  'pure (frame-synced)',
         replay_count: plan.length,
         frame_deltas: plan.map(p => p.frameDelta),
         body_verify:  bodyMapSize > 0 ? ('enabled, ' + bodyMapSize + ' recs') : 'disabled',
         rng_restore:  pump._replayRng ? 'enabled' : 'disabled',
         jump_from:    'onLeave',
    });

    const callsiteHits = { entered: 0, matched: 0, mismatched: 0, errors: 0, other: [] };

    // Detach любых «зависших» хуков от предыдущего play.
    for (const h of _activeJumpsHooks) { try { h.detach(); } catch (_) {} }
    _activeJumpsHooks = [];

    let phase = 'waiting_unfreeze';
    let anchorFrame = null;
    let nextIdx = 0;
    let heroPtr = null;
    let deferFrames = 0;
    let skippedCount = 0;
    let lastFpsFrame = null, lastFpsWall = null;
    let lastProgressLogMs = null;
    const total = plan.length;

    const maxFrameDelta = plan.reduce((m, p) => Math.max(m, p.frameDelta), 0);
    const maxPlayFrame  = maxFrameDelta + 600;
    const playStartWall = Date.now();
    const PLAY_WALL_LIMIT_MS = 5 * 60 * 1000;

    const jumpHook = Interceptor.attach(ADDR.JUMP, {
        onEnter() {
            callsiteHits.entered++;
            let rel = null;
            try { rel = this.returnAddress.sub(MODULE_BASE).toString(); }
            catch (e) { callsiteHits.errors++; return; }
            if (expectedCallSites.has(rel)) callsiteHits.matched++;
            else {
                callsiteHits.mismatched++;
                if (callsiteHits.other.length < 8) callsiteHits.other.push(rel);
            }
        }
    });
    _activeJumpsHooks.push(jumpHook);

    function cleanupPlay(reason) {
        if (phase === 'done') return;
        phase = 'done';
        for (const h of _activeJumpsHooks) { try { h.detach(); } catch (_) {} }
        _activeJumpsHooks = [];
        pump.clearOnFrame();
        pump.clearOnFirstUpdate();
        pump.clearOnLeave();
        if (reason) send({ type: 'jumps_timeout', reason, fired: nextIdx, total });
    }

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
                mode: 'unfreeze (fallback)',
                 anchorFrame, anchorRecFrame,
                 replay_count: total,
                 body_verify: bodyMapSize > 0,
                 jump_from: 'onLeave',
            });
        } else {
            send({ type: 'jumps_waiting_first_update',
                note: 'Ждём первый HeroBody::update после unfreeze',
                anchorKind });
        }
    }

    function onFirstUpdate(_hero, frame) {
        if (phase !== 'waiting_first_update' && phase !== 'waiting_unfreeze') return;
        if (!isValidHeroStrict(_hero)) return;
        phase = 'playing';
        anchorFrame = frame;
        heroPtr = _hero;
        if (bodyMapSize > 0) pump.setPlaybackAnchor(anchorFrame, anchorRecFrame);

        send({
            type: 'jumps_armed',
            mode: anchorKind,
            anchorFrame, anchorRecFrame,
            replay_count: total,
            frame_deltas: plan.map(p => p.frameDelta),
             body_verify: bodyMapSize > 0,
             jump_from: 'onLeave',
        });
    }

    const h1 = Interceptor.attach(ADDR.UNFREEZE,        { onEnter() { onUnfreeze(); } });
    const h2 = Interceptor.attach(ADDR.UNFREEZE_ATTACK, { onEnter() { onUnfreeze(); } });
    _activeJumpsHooks.push(h1, h2);

    pump.setOnFirstUpdate(onFirstUpdate);

    // Только fps + progress + watchdog (jumpFn — в _onLeave!)
    pump.setOnFrame((f) => {
        if (phase !== 'done' && (Date.now() - playStartWall) > PLAY_WALL_LIMIT_MS) {
            cleanupPlay('wall_timeout');
            pump.clearPlaybackBody();
            return;
        }

        if (phase !== 'playing') return;

        if (anchorFrame !== null && (f - anchorFrame) > maxPlayFrame) {
            cleanupPlay('frame_timeout');
            pump.clearPlaybackBody();
            return;
        }

        if (lastFpsFrame !== null && (f - lastFpsFrame) >= 60) {
            const dt = Date.now() - lastFpsWall;
            const fps = dt > 0 ? ((f - lastFpsFrame) * 1000 / dt) : 0;
            send({ type: 'fps', frame: f, fps: Number(fps.toFixed(1)) });
            lastFpsFrame = f;
            lastFpsWall = Date.now();
        }

        if (nextIdx < total && lastProgressLogMs !== null &&
            (Date.now() - lastProgressLogMs) >= 1000) {
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
             divergences: pump._divergences.length,
        });
            }
    });

    // Jump firing — из onLeave (после hero.update, чтобы импульс ушёл на СЛЕДУЮЩИЙ кадр)
    pump.setOnLeave((f, _body, _rec, _extra) => {
        if (phase !== 'playing') return;

        // Резолвим hero ОДИН раз (isValidHeroStrict — только пока heroPtr === null).
        if (heroPtr === null
            && pump._lastHero
            && pump._lastHeroFrame !== null
            && pump._lastHeroFrame > anchorFrame) {
            if (isValidHeroStrict(pump._lastHero)) {
                heroPtr = pump._lastHero;
                send({ type: 'hero_resolved', source: 'pump_lastHero',
                    addr: heroPtr.toString(), frame: f });
            }
            }

            if (nextIdx >= total) return;

            const targetFrame = anchorFrame + plan[nextIdx].frameDelta;
        if (f < targetFrame) return;

        if (!heroPtr || !isValidHeroStrict(heroPtr)) {
            if (deferFrames < 20) {
                deferFrames++;
                if (deferFrames === 1) {
                    send({ type: 'jump_deferred', idx: nextIdx, frame: f, target_frame: targetFrame,
                        reason: 'hero not resolved yet' });
                }
                return;
            }
            send({ type: 'jump_skipped', idx: nextIdx, frame: f, target_frame: targetFrame,
                reason: 'hero invalid after 20 frames' });
            nextIdx++; skippedCount++; deferFrames = 0;
        } else {
            const snap = heroSnapshot(heroPtr);
            deferFrames = 0;
            try {
                jumpFn(heroPtr);
                send({ type: 'jump_fired', idx: nextIdx, absFrame: f, target_frame: targetFrame,
                    frame_error: f - targetFrame, snap, from: 'onLeave' });
            } catch (e) {
                send({ type: 'jump_error', idx: nextIdx, msg: String(e), snap });
            }
            nextIdx++;
        }

        if (nextIdx >= total) {
            const verify = buildVerificationReport(bodyFramesIn, anchorRecFrame, anchorFrame);
            const csSnapshot = { ...callsiteHits, other: callsiteHits.other.slice() };
            cleanupPlay();

            send({
                type: 'jumps_done',
                fired: nextIdx - skippedCount,
                skipped: skippedCount,
                total_planned: total,
                verify,
                callsite: csSnapshot,
            });
            if (verify && verify.max_abs_diff_u32 === 0 && verify.divergences === 0) {
                send({ type: 'verify_result', ok: true, msg: 'BIT-EXACT MATCH' });
            } else if (verify) {
                send({ type: 'verify_result', ok: false, verify });
            }
            pump.clearPlaybackBody();
        }
    });

    send({
        type: 'jumps_ready',
        replay_count: total,
        body_verify: bodyMapSize > 0,
        anchor_kind: anchorKind,
        jump_from: 'onLeave',
        msg: useAnchor
        ? 'Тапните ОДИН раз. Anchor = ' + anchorKind + '.'
        : 'Тапните ОДИН раз. Anchor = unfreeze (fallback).',
    });
}

function buildVerificationReport(bodyFramesIn, anchorRecFrame, anchorPlaybackFrame) {
    if (!bodyFramesIn || !bodyFramesIn.length) return null;
    const recMap = new Map(bodyFramesIn.map(r => [r.frame, r]));
    const total = pump._replayBodyFrames.length;

    let compared = 0;
    let divergences = 0;
    let maxAbsU32 = 0;
    let firstDiv = null;
    const samples = [];

    for (const rf of pump._replayBodyFrames) {
        const recFrame = anchorRecFrame + (rf.frame - anchorPlaybackFrame);
        const exp = recMap.get(recFrame);
        if (!exp) continue;
        compared++;
        const div = compareBodyBit(rf, exp);
        if (div) {
            divergences++;
            if (!firstDiv) firstDiv = { f: rf.frame, recFrame, diffs: div.diffs };
            for (const d of div.diffs) {
                if (d.int) continue;
                const diff = Math.abs((d.aU32 | 0) - (d.eU32 | 0));
                if (diff > maxAbsU32) maxAbsU32 = diff;
            }
            if (samples.length < 5) samples.push({ f: rf.frame, recFrame, diffs: div.diffs.slice(0, 6) });
        }
    }

    return {
        compared,
        total_replay_frames: total,
        divergences,
        max_abs_diff_u32: maxAbsU32,
        first_divergence: firstDiv,
        samples,
        ring: pump._ring.slice(-5),
    };
}

function compareTwoRecordings(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { error: 'both args must be arrays' };
    const mapB = new Map(b.map(r => [r.frame, r]));
    let compared = 0, diffs = 0, maxU32 = 0;
    const samples = [];
    for (const ra of a) {
        const rb = mapB.get(ra.frame);
        if (!rb) continue;
        compared++;
        const div = compareBodyBit(ra, rb);
        if (div) {
            diffs++;
            if (samples.length < 10) samples.push({ f: ra.frame, diffs: div.diffs.slice(0, 6) });
            for (const d of div.diffs) {
                if (d.int) continue;
                const diff = Math.abs((d.aU32 | 0) - (d.eU32 | 0));
                if (diff > maxU32) maxU32 = diff;
            }
        }
    }
    return {
        compared,
        a_len: a.length,
        b_len: b.length,
        diffs,
        max_abs_diff_u32: maxU32,
        samples,
        deterministic: diffs === 0,
    };
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
    pumpDbgStats: () => pump._dbgStats,

    detectInstall:       () => detectInstall(),
    detectStart:         () => detectStart(),
    detectStop:          () => detectStop(),
    detectGetBodyFrames: () => detectGetBodyFrames(),
    detectGetBodyHash:   () => {
        const out = [];
        for (const [f, h] of pump._detectBodyHash) out.push([f, h]);
        return out;
    },
    detectGetFrameNsTimeline: () => detectGetFrameNsTimeline(),
    detectGetRngLog:     () => detectGetRngLog(),
    detectGetTimeLog:    () => detectGetTimeLog(),

    replayJumpsOnly: (events, opts) => replayJumpsOnly(events, opts),

    compareTwoRecordings: (a, b) => compareTwoRecordings(a, b),

    libcHooksInstall: () => {
        installLibcHooks();
        return { rng: Array.from(_libcHooks.rng), time: Array.from(_libcHooks.time) };
    },
    libcHooksDetachRng:  () => { detachRngHooks();  return true; },
    libcHooksDetachTime: () => { detachTimeHooks(); return true; },

    setFreezeTime: (enabled, ns) => {
        pump._freezeTime = !!enabled;
        pump._frozenNs = (ns != null) ? Number(ns) : null;
        if (pump._freezeTime) installTimeHooks();
        else                  detachTimeHooks();
    },
    setReplayRng: (obj) => {
        const m = new Map();
        for (const k of Object.keys(obj || {})) m.set(k, (obj[k] || []).slice());
        pump._replayRng = m;
        installRngHooks();
    },
    clearReplayRng: () => {
        pump._replayRng = null;
    },
};
