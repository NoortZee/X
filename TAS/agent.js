// TAS agent for King of Thieves x86_64.
// История изменений и совместимость: docs/CHANGELOG.md.
'use strict';

const MODULE_NAME = MEMORY_LAYOUT.module_name;

let libModule = null;
for (let i = 0; i < 100; i++) {
    libModule = Process.findModuleByName(MODULE_NAME);
    if (libModule !== null) break;
    Thread.sleep(0.1);
}
if (libModule === null) {
    send({ type: 'fatal', msg: MODULE_NAME + ' not loaded after 10s' });
    throw new Error(MODULE_NAME + ' not loaded');
}

const MODULE_BASE = libModule.base;
const MODULE_SIZE = libModule.size;
send({ type: 'module_base', name: MODULE_NAME,
    base: MODULE_BASE.toString(), size: MODULE_SIZE });

// ------------------------------------------------------------
// Address resolver
// ------------------------------------------------------------
// Function signatures and relative addresses come from memory/offsets.js.
const SIGS = MEMORY_LAYOUT.tas.signatures;
const FALLBACK = MEMORY_LAYOUT.tas.fallback;
const HERO = MEMORY_LAYOUT.tas.hero;
const PLATFORM = MEMORY_LAYOUT.platform;

const _resolutionLog = [];
function isReadablePtr(p) {
    if (p === null || p === undefined) return false;
    if (p.isNull && p.isNull()) return false;
    return Process.findRangeByAddress(p) !== null;
}
function _scanModule(sig) {
    const ranges = Process.enumerateRanges('r-x');
    for (const r of ranges) {
        if (r.base < MODULE_BASE) continue;
        if (r.base >= MODULE_BASE.add(MODULE_SIZE)) continue;
        try {
            const m = Memory.scanSync(r.base, r.size, sig);
            if (m.length > 0) return m[0].address;
        } catch (_) {}
    }
    return null;
}
function _scanModuleAll(sig) {
    const out = [];
    const ranges = Process.enumerateRanges('r-x');
    for (const r of ranges) {
        if (r.base < MODULE_BASE) continue;
        if (r.base >= MODULE_BASE.add(MODULE_SIZE)) continue;
        try {
            const m = Memory.scanSync(r.base, r.size, sig);
            for (const x of m) out.push(x.address);
        } catch (_) {}
    }
    return out;
}
function _resolveBySig(name) {
    const sig = SIGS[name];
    if (!sig) return null;
    const addr = _scanModule(sig);
    if (addr) _resolutionLog.push({ name, method: 'AOB',
        addr: addr.toString(), offset: addr.sub(MODULE_BASE).toString() });
    return addr;
}
function _resolveByFallback(name) {
    const off = FALLBACK[name];
    if (off === undefined) return null;
    const addr = MODULE_BASE.add(off);
    _resolutionLog.push({ name, method: 'FALLBACK',
        addr: addr.toString(), offset: '0x' + off.toString(16) });
    return addr;
}
function _resolveSimple(name) { return _resolveBySig(name) || _resolveByFallback(name); }

// SMART resolver — поиск функции по AOB. Логика:
//   * 1 матч refined AOB → доверяем (refined AOB уже уникален — хвост
//     `8B 87 B0 00 00 00` отличает HeroBody от FrogBody/BoilerBody)
//   * 0 матчей → fallback на захардкоженный RVA + warning
//   * 2+ матча → выбираем ближайший к expectedOffset (страховка)
function _resolveFrameFuncSmart() {
    const expectedOffset = FALLBACK['FRAME_FUNC'];
    const matches = _scanModuleAll(SIGS['FRAME_FUNC']);

    if (matches.length === 1) {
        _resolutionLog.push({
            name: 'FRAME_FUNC',
            method: 'AOB_UNIQUE',
            addr: matches[0].toString(),
                            offset: matches[0].sub(MODULE_BASE).toString(),
        });
        return matches[0];
    }

    if (matches.length === 0) {
        send({
            type: 'dbg',
            where: 'resolver',
            msg: 'FRAME_FUNC AOB not found → use fallback',
            expected_offset: '0x' + expectedOffset.toString(16),
        });
        return _resolveByFallback('FRAME_FUNC');
    }

    // 2+ matches — выбираем ближайший к expected
    let best = null;
    let bestDist = Infinity;
    const candidates = [];
    for (const a of matches) {
        const off = a.sub(MODULE_BASE).toInt32();
        candidates.push('0x' + (off >>> 0).toString(16));
        const dist = Math.abs(off - expectedOffset);
        if (dist < bestDist) {
            bestDist = dist;
            best = a;
        }
    }
    send({
        type: 'dbg',
        where: 'resolver',
        msg: 'FRAME_FUNC AOB gave multiple matches → pick closest to expected',
        candidates,
        expected_offset: '0x' + expectedOffset.toString(16),
         picked_offset: best.sub(MODULE_BASE).toString(),
    });
    _resolutionLog.push({
        name: 'FRAME_FUNC',
        method: 'AOB_CLOSEST',
        addr: best.toString(),
                        offset: best.sub(MODULE_BASE).toString(),
                        candidates,
    });
    return best;
}

const FRAME_FUNC           = _resolveFrameFuncSmart();
const ADDR_JUMP            = _resolveSimple('JUMP');
const ADDR_UNFREEZE        = _resolveSimple('UNFREEZE');
const ADDR_UNFREEZE_ATTACK = _resolveSimple('UNFREEZE_ATTACK');
const ADDR = { UNFREEZE: ADDR_UNFREEZE, UNFREEZE_ATTACK: ADDR_UNFREEZE_ATTACK, JUMP: ADDR_JUMP };

send({ type: 'resolved', log: _resolutionLog,
    FRAME_FUNC: FRAME_FUNC.toString(),
     JUMP: ADDR.JUMP.toString(),
     UNFREEZE: ADDR.UNFREEZE.toString(),
     UNFREEZE_ATTACK: ADDR.UNFREEZE_ATTACK.toString() });

function findExport(moduleName, exportName) {
    try {
        const m = Process.getModuleByName(moduleName);
        if (m) { const a = m.findExportByName(exportName); if (a) return a; }
    } catch (_) {}
    try { return Module.findGlobalExportByName(exportName); } catch (_) {}
    return null;
}

// ------------------------------------------------------------
// Bit helpers
// ------------------------------------------------------------
const _f32buf  = new ArrayBuffer(4);
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
// Time
// ------------------------------------------------------------
const CLOCK_MONOTONIC = PLATFORM.clock_monotonic;
const _SYS_clock_gettime_x86_64 = PLATFORM.syscall_clock_gettime;
const _tsBuf = Memory.alloc(PLATFORM.time_struct_size);
let _syscallFn = null;
try {
    const sa = findExport(PLATFORM.libc, 'syscall');
    if (sa) _syscallFn = new NativeFunction(sa, 'long', ['long', '...']);
} catch (_) {}
function nowNs() {
    if (_syscallFn) {
        try {
            _syscallFn(_SYS_clock_gettime_x86_64, CLOCK_MONOTONIC, _tsBuf);
            const s = _tsBuf.add(PLATFORM.time_seconds).readS64(), n = _tsBuf.add(PLATFORM.time_subseconds).readS64();
            return Number(s) * 1e9 + Number(n);
        } catch (_) {}
    }
    return Date.now() * 1e6;
}

// ------------------------------------------------------------
// Body state — hot path (1 try/catch, без findRangeByAddress)
// ------------------------------------------------------------
function _nz(v) { return v === 0 ? 0 : v; }
const BODY = MEMORY_LAYOUT.tas.body;
    const BODY_FIELDS = ['px', 'py', 'ang', 'vx', 'vy', 'av'];

    function readBodyState(bodyPtr) {
        if (!bodyPtr || bodyPtr.isNull()) return null;
        try {
            const px  = bodyPtr.add(BODY.XF_PX).readFloat();
            const py  = bodyPtr.add(BODY.XF_PY).readFloat();
            const ang = bodyPtr.add(BODY.SW_A).readFloat();
            const vx  = bodyPtr.add(BODY.VX).readFloat();
            const vy  = bodyPtr.add(BODY.VY).readFloat();
            const av  = bodyPtr.add(BODY.AV).readFloat();
            if (!isFinite(px) || !isFinite(py) || !isFinite(ang)
                || !isFinite(vx) || !isFinite(vy) || !isFinite(av)) return null;
            return { px: _nz(px), py: _nz(py), ang: _nz(ang),
                vx: _nz(vx), vy: _nz(vy), av: _nz(av) };
        } catch (_) { return null; }
    }
    function heroBodyBytes(bodyPtr) {
        if (!bodyPtr || bodyPtr.isNull()) return null;
        try {
            const buf = bodyPtr.readByteArray(BODY.BODY_SIZE);
            return buf ? new Uint8Array(buf) : null;
        } catch (_) { return null; }
    }
    function heroBodyHash(bodyPtr) {
        const b = heroBodyBytes(bodyPtr);
        return b ? fnv1a32(b) : null;
    }
    function isValidHeroStrict(p) {
        if (!p || p.isNull() || !isReadablePtr(p)) return false;
        try { if (!p.and(MEMORY_LAYOUT.pointer_alignment_mask).isNull()) return false; } catch (_) { return false; }
        let body; try { body = p.add(HERO.BODY_PTR).readPointer(); } catch (_) { return false; }
        if (!isReadablePtr(body)) return false;
        try { if (!body.and(MEMORY_LAYOUT.pointer_alignment_mask).isNull()) return false; } catch (_) { return false; }
        let bt; try { bt = body.add(BODY.TYPE).readU32(); } catch (_) { return false; }
        if (bt !== BODY.DYNAMIC_TYPE) return false;
        let grav; try { grav = body.add(BODY.GRAVITY).readFloat(); } catch (_) { return false; }
        return isFinite(grav) && grav > -100 && grav < 100;
    }
    function heroSnapshot(p) {
        if (!p || p.isNull()) return { reason: 'nullptr' };
        try {
            return {
                vt_rel:      p.add(HERO.VTABLE).readPointer().sub(MODULE_BASE).toString(),
                state_a0:    p.add(HERO.STATE_A0).readS32(),
                cooldown_b0: p.add(HERO.COOLDOWN_B0).readS32(),
                ground_80:   p.add(HERO.GROUND_80).readS32(),
                ground_84:   p.add(HERO.GROUND_84).readS32(),
            };
        } catch (_) {
            return { reason: 'unreadable' };
        }
    }
    function pickFields(o) {
        const out = {};
        for (const k of BODY_FIELDS) out[k] = o[k];
        for (const k of ['a0', 'b0', 'g80', 'g84']) if (k in o) out[k] = o[k];
        return out;
    }
    function compareBodyBit(actual, expected) {
        const diffs = [];
        for (const k of BODY_FIELDS) {
            if (actual[k] === undefined || expected[k] === undefined) continue;
            const ab = f32Bits(actual[k]), eb = f32Bits(expected[k]);
            if (ab !== eb) {
                if ((ab === 0 && eb === 0x80000000) || (ab === 0x80000000 && eb === 0)) continue;
                diffs.push({ field: k, actual: actual[k], expected: expected[k], aU32: ab, eU32: eb });
            }
        }
        for (const k of ['a0', 'b0', 'g80', 'g84']) {
            if (actual[k] === undefined || expected[k] === undefined) continue;
            if (actual[k] !== expected[k])
                diffs.push({ field: k, actual: actual[k], expected: expected[k], int: true });
        }
        return diffs.length ? { diffs } : null;
    }

    // ------------------------------------------------------------
    // JUMP monitor
    // ------------------------------------------------------------
    let _jumpTotal = 0;
    const _jumpLog = [];
    const _JUMP_LOG_MAX = 500;
    let _jumpMonitorInstalled = false;

    function installJumpMonitor() {
        if (_jumpMonitorInstalled) return;
        _jumpMonitorInstalled = true;
        Interceptor.attach(ADDR.JUMP, {
            onEnter() {
                _jumpTotal++;
                _jumpLog.push({
                    idx: _jumpTotal,
                    frame: pump._frame,
                    t: Date.now(),
                });
                if (_jumpLog.length > _JUMP_LOG_MAX) _jumpLog.shift();
            }
        });
        send({ type: 'jump_monitor_installed', addr: ADDR.JUMP.toString() });
    }

    // ------------------------------------------------------------
    // Pump
    // ------------------------------------------------------------
    const pump = {
        _frame: 0, _installed: false,
        _onFrame: null, _onFirstUpdate: null, _onLeave: null,
        _lastHero: null, _lastHeroFrame: null,
        _detectBodyRecord: false, _detectBodyFrames: [], _detectBodyHash: new Map(),
        _playbackBodyMap: null, _playbackAnchorFrame: null, _playbackAnchorRecFrame: null,
        _replayBodyFrames: [], _divergences: [],
        _ring: [], _ringMax: 300, _ringActive: false,
        _recordTime: false, _frameNsTimeline: new Map(),
        _dbgStats: { enter: 0, leave: 0, nullBody: 0, readOk: 0 },

        install() {
            if (pump._installed) { send({ type: 'pump_already' }); return; }
            pump._frame = 0;

            Interceptor.attach(FRAME_FUNC, {
                onEnter(args) {
                    this._hero = args[0];

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
                                    frame: pump._frame,
                                    t_ms: detectStartWall !== null ? (Date.now() - detectStartWall) : 0,
                               t_ns: detectStartNsVal !== null ? (nowNs() - detectStartNsVal) : 0,
                               name: 'first_hero_update',
                               thisPtr: args[0].toString(),
                               snap: heroSnapshot(args[0]),
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
                    if (!hero) return;

                    if (!pump._detectBodyRecord
                        && !pump._ringActive
                        && !pump._playbackBodyMap
                        && !pump._onLeave) {
                        return;
                        }

                        let body;
                    try { body = hero.add(HERO.BODY_PTR).readPointer(); } catch (_) { return; }
                    if (!body || body.isNull()) { pump._dbgStats.nullBody++; return; }

                    const rec = readBodyState(body);
                    if (!rec) return;
                    pump._dbgStats.readOk++;
                    rec.frame = pump._frame;

                    const snap = heroSnapshot(hero);
                    const extra = {
                        a0: snap.state_a0, b0: snap.cooldown_b0,
                        g80: snap.ground_80, g84: snap.ground_84,
                    };

                    if (pump._ringActive) {
                        pump._ring.push({
                            frame: pump._frame, px: rec.px, py: rec.py, ang: rec.ang,
                            vx: rec.vx, vy: rec.vy, av: rec.av,
                            a0: extra.a0, b0: extra.b0, g80: extra.g80, g84: extra.g84,
                        });
                        if (pump._ring.length > pump._ringMax) pump._ring.shift();
                    }

                    if (pump._detectBodyRecord) {
                        pump._detectBodyFrames.push({
                            frame: pump._frame,
                            px: rec.px, py: rec.py, ang: rec.ang,
                            vx: rec.vx, vy: rec.vy, av: rec.av,
                            a0: extra.a0, b0: extra.b0, g80: extra.g80, g84: extra.g84,
                        });
                        if (pump._frame % 5 === 0) {
                            const h = heroBodyHash(body);
                            if (h !== null) pump._detectBodyHash.set(pump._frame, h);
                        }
                    }

                    if (pump._playbackBodyMap && pump._playbackAnchorFrame !== null) {
                        const recFrame = pump._playbackAnchorRecFrame
                        + (pump._frame - pump._playbackAnchorFrame);
                        const expected = pump._playbackBodyMap.get(recFrame);
                        const actual = {
                            px: rec.px, py: rec.py, ang: rec.ang,
                            vx: rec.vx, vy: rec.vy, av: rec.av,
                            a0: extra.a0, b0: extra.b0, g80: extra.g80, g84: extra.g84,
                        };
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
                        }
                    }
                    if (pump._onLeave) {
                        try { pump._onLeave(pump._frame, body, rec, extra); } catch (_) {}
                    }
                }
            });

            installJumpMonitor();

            pump._installed = true;
            send({ type: 'pump_installed', mode: 'interceptor',
                func: FRAME_FUNC.toString(),
                 offset: FRAME_FUNC.sub(MODULE_BASE).toString() });
        },

        resetHero() { pump._lastHero = null; pump._lastHeroFrame = null; },
        reset()     { pump._frame = 0; },
        frame()     { return pump._frame; },

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
        detectBodyStop()    { pump._detectBodyRecord = false; },
        detectBodyGet()     { return pump._detectBodyFrames; },

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
            pump._replayBodyFrames = [];
            pump._divergences = [];
        },
    };

    function ringTail(n) { return pump._ring.slice(-Math.max(1, n)); }

    // ------------------------------------------------------------
    // Detect
    // ------------------------------------------------------------
    let detectRec = false;
    let detectEvents = [];
    let detectStartWall = null;
    let detectStartNsVal = null;
    let detectWaitFirstHeroUpdate = false;
    let detectFrameAtStart = 0;
    let _jumpCallSites = new Set();

    function _onFrameRecordTimeline(f) {
        if (!pump._recordTime) return;
        if (detectStartNsVal === null) return;
        if (f % 5 !== 0) return;
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
                        frame: pump.frame(),
                               t_ms: detectStartWall !== null ? (Date.now() - detectStartWall) : 0,
                               t_ns: detectStartNsVal !== null ? (nowNs() - detectStartNsVal) : 0,
                               name: t.name,
                               thisPtr: thisPtr.toString(),
                               snap: heroSnapshot(thisPtr),
                    };
                    try {
                        const vt = thisPtr.add(HERO.VTABLE).readPointer();
                        ev.vt = vt.toString();
                        ev.vt_rel = vt.sub(MODULE_BASE).toString();
                    } catch (_) { ev.vt = null; ev.vt_rel = null; }
                    if (t.name === 'jump') {
                        try {
                            ev.returnAddress = this.returnAddress.toString();
                            ev.returnAddressRel = this.returnAddress.sub(MODULE_BASE).toString();
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
        detectFrameAtStart = pump.frame();
        detectRec = true;
        detectWaitFirstHeroUpdate = false;
        _jumpCallSites = new Set();
        pump._frameNsTimeline = new Map();
        pump.detectBodyStart();
        pump._recordTime = true;
        pump.setOnFrame(_onFrameRecordTimeline);
        send({ type: 'detect_started', frame: pump.frame(),
            wall: detectStartWall, ns: detectStartNsVal,
            frame_at_start: detectFrameAtStart });
    }

    function detectStop() {
        detectRec = false;
        detectWaitFirstHeroUpdate = false;
        pump.detectBodyStop();
        pump._recordTime = false;
        pump.clearOnFrame();
        const dur = detectStartWall ? (Date.now() - detectStartWall) : 0;
        const frames_delta = pump.frame() - detectFrameAtStart;
        send({
            type: 'detect_stopped',
            count: detectEvents.length,
            body_frames: pump._detectBodyFrames.length,
            body_hashes: pump._detectBodyHash.size,
            duration_ms: dur,
            frames_delta: frames_delta,
            avg_fps: dur > 0 ? (frames_delta * 1000 / dur).toFixed(1) : 'n/a',
             jump_callsites: Array.from(_jumpCallSites),
        });
        return detectEvents;
    }

    function detectGetBodyFrames() { return pump.detectBodyGet(); }
    function detectGetFrameNsTimeline() {
        const out = [];
        for (const [f, ns] of pump._frameNsTimeline) out.push([f, ns]);
        out.sort((a, b) => a[0] - b[0]);
        return out;
    }

    // ------------------------------------------------------------
    // Play (NO jumpFn)
    // ------------------------------------------------------------
    let play = { phase: 'idle', anchorFrame: null, anchorRecFrame: null,
        anchorKind: null, plan: [], waitForFirstUpdate: false };
        const _playHooks = [];

        function playSetup(events, opts) {
            opts = opts || {};
            const verifyBody = !!opts.verify_body;
            const bodyFramesIn = Array.isArray(opts.body_frames) ? opts.body_frames : null;

            playStop();
            pump.install();
            pump._ringActive = true;
            pump.reset();
            pump.clearOnFrame();
            pump.clearOnFirstUpdate();
            pump.clearOnLeave();
            pump.clearPlaybackBody();
            pump.resetHero();

            const allJumps = events.filter(e => e.name === 'jump')
            .sort((a, b) => a.frame - b.frame);
            if (!allJumps.length) return { ok: false, error: 'no_jumps' };

            const unfreezeEvent = events
            .filter(e => e.name === 'unfreeze' || e.name === 'unfreeze_attack')
            .sort((a, b) => a.frame - b.frame)[0];
            const firstHeroUpdate = events.find(e => e.name === 'first_hero_update') || null;
            const firstBodyFrame = (bodyFramesIn && bodyFramesIn.length) ? bodyFramesIn[0].frame : null;

            let anchorRecFrame, anchorKind, waitForFirstUpdate;
            if (firstHeroUpdate) {
                anchorRecFrame = firstHeroUpdate.frame;
                anchorKind = 'first_hero_update';
                waitForFirstUpdate = true;
            } else if (firstBodyFrame !== null) {
                anchorRecFrame = firstBodyFrame;
                anchorKind = 'first_body_frame';
                waitForFirstUpdate = false;
            } else if (unfreezeEvent) {
                anchorRecFrame = unfreezeEvent.frame;
                anchorKind = 'unfreeze';
                waitForFirstUpdate = false;
            } else {
                return { ok: false, error: 'no_anchor' };
            }

            const plan = allJumps.map((e, i) => ({
                idx: i,
                rec_frame: e.frame,
                frame_delta: Math.max(0, e.frame - anchorRecFrame),
                                                 snap: e.snap || {},
            }));

            let bodyMapSize = 0;
            if (verifyBody && bodyFramesIn && bodyFramesIn.length) {
                bodyMapSize = pump.setPlaybackBody(bodyFramesIn);
            }

            play = { phase: 'waiting_unfreeze', anchorFrame: null,
                anchorRecFrame, anchorKind, plan, waitForFirstUpdate };

                const onUnfreeze = () => {
                    if (play.phase !== 'waiting_unfreeze') return;
                    if (waitForFirstUpdate) {
                        play.phase = 'waiting_first_update';
                        send({ type: 'play_phase', phase: 'waiting_first_update' });
                        return;
                    }
                    play.phase = 'playing';
                    play.anchorFrame = pump.frame();
                    if (bodyMapSize > 0) pump.setPlaybackAnchor(play.anchorFrame, anchorRecFrame);
                    send({ type: 'play_armed', anchor: play.anchorFrame,
                        anchorRec: anchorRecFrame, kind: anchorKind,
                        count: plan.length, body_verify: bodyMapSize });
                };
                const onFirstUpdate = (hero, f) => {
                    if (play.phase !== 'waiting_first_update') return;
                    if (!isValidHeroStrict(hero)) return;
                    play.phase = 'playing';
                    play.anchorFrame = f;
                    if (bodyMapSize > 0) pump.setPlaybackAnchor(f, anchorRecFrame);
                    send({ type: 'play_armed', anchor: f, anchorRec: anchorRecFrame,
                        kind: anchorKind, count: plan.length, body_verify: bodyMapSize });
                };
                const hU  = Interceptor.attach(ADDR.UNFREEZE,        { onEnter: onUnfreeze });
                const hUA = Interceptor.attach(ADDR.UNFREEZE_ATTACK, { onEnter: onUnfreeze });
                _playHooks.push(hU, hUA);
                pump.setOnFirstUpdate(onFirstUpdate);

                send({ type: 'play_phase', phase: play.phase });
                return { ok: true, anchorKind, anchorRecFrame, plan,
                    waitForFirstUpdate, body_verify: bodyMapSize };
        }

        function playState() {
            return { phase: play.phase, anchor: play.anchorFrame,
                anchorRec: play.anchorRecFrame, kind: play.anchorKind,
                plan: play.plan, frame: pump._frame };
        }
        function playStop() {
            for (const h of _playHooks) { try { h.detach(); } catch (_) {} }
            _playHooks.length = 0;
            pump.clearOnFirstUpdate();
            pump.clearPlaybackBody();
            pump._ringActive = false;
            play.phase = 'idle';
            return { ok: true };
        }
        function playVerify() {
            let compared = 0, divergences = 0, maxU32 = 0, firstDiv = null;
            const samples = [];
            if (pump._playbackBodyMap && pump._playbackAnchorFrame !== null) {
                const recMap = pump._playbackBodyMap;
                for (const rf of pump._replayBodyFrames) {
                    const recFrame = pump._playbackAnchorRecFrame
                    + (rf.frame - pump._playbackAnchorFrame);
                    const exp = recMap.get(recFrame);
                    if (!exp) continue;
                    compared++;
                    const div = compareBodyBit(rf, exp);
                    if (div) {
                        divergences++;
                        if (!firstDiv) firstDiv = { f: rf.frame, recFrame, diffs: div.diffs };
                        for (const d of div.diffs) {
                            if (d.int) continue;
                            const dd = Math.abs((d.aU32 | 0) - (d.eU32 | 0));
                            if (dd > maxU32) maxU32 = dd;
                        }
                        if (samples.length < 5) {
                            samples.push({ f: rf.frame, recFrame, diffs: div.diffs.slice(0, 6) });
                        }
                    }
                }
            }
            return {
                compared, divergences, max_abs_diff_u32: maxU32,
                first_divergence: firstDiv, samples,
                total_replay_frames: pump._replayBodyFrames.length,
            };
        }

        // ------------------------------------------------------------
        // RPC exports
        // ------------------------------------------------------------
        rpc.exports = {
            pumpInstall:        () => pump.install(),

            pumpJumpCount:      () => _jumpTotal,
            pumpJumpLogSince:   (idx) => {
                const from = Number(idx) || 0;
                return _jumpLog.filter(j => j.idx > from);
            },

            detectInstall:            () => detectInstall(),
            detectStart:              () => detectStart(),
            detectStop:               () => detectStop(),
            detectGetBodyFrames:      () => detectGetBodyFrames(),
            detectGetFrameNsTimeline: () => detectGetFrameNsTimeline(),

            ringTail:     (n) => ringTail(n),

            playSetup:  (ev, opts) => playSetup(ev, opts),
            playState:  () => playState(),
            playVerify: () => playVerify(),
            playStop:   () => playStop(),

        };
