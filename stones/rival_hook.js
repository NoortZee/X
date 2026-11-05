// rival_hook.js — хукает Response_RivalDungeon (v2.84.1 x86_64).
// v5:
//   * AOB-скан парсера вместо жёсткого 0xF680D0.
//     36-байтовый префикс уникален (32-байтовый матчит 17 других
//     KTProtocol-парсеров с одинаковым прологом). Fallback —
//     захардкоженный RIVAL_PARSE_FALLBACK = 0xF680D0.
//   * Отсылаем { type: 'rival_aob', method: 'AOB'|'FALLBACK',
//     addr, offset } — видно, каким путём разрешилось.
//
// v4:
//   * СНИМОК В onLeave (объект RivalDungeon временный — Clear/free
//     случаются сразу после парсера).
//   * Журнал _rivals (последние 50), getRivalsLog().
//   * stones сортируются по slot.
//   * readAt() только для отладки.
'use strict';

let MODULE_BASE = null;
let MODULE_SIZE = 0;
const MODULE_NAME = 'libthieves.so';

// Response_RivalDungeon::Parse — 36-байтовый уникальный префикс.
// Обрати внимание: `sub rsp, 0x88` = 48 81 EC 88 00 00 00 (imm32),
// не 48 83 EC 88 (imm8).
const RIVAL_PARSE_AOB =
'55 48 89 E5 41 57 41 56 41 55 41 54 53 48 81 EC 88 00 00 00 ' +
'49 89 F6 49 89 FF 48 8D 47 08 48 89 45 B0 48 8D';

// Fallback для случая, если AOB не нашёлся (v2.84.1 RVA).
const RIVAL_PARSE_FALLBACK = 0xF680D0;

function _init() {
    let m = null;
    for (let i = 0; i < 100; i++) {
        try { m = Process.findModuleByName(MODULE_NAME); } catch (e) {}
        if (m) break;
        try { Thread.sleep(0.1); } catch (_) {}
    }
    if (!m) throw new Error(MODULE_NAME + ' not loaded');
    MODULE_BASE = m.base;
    MODULE_SIZE = m.size;
    send({ type: 'ready', base: MODULE_BASE.toString(),
        size: MODULE_SIZE });
}
try { _init(); } catch (e) { send({ type: 'fatal', msg: String(e) }); }

const RIVALS_LOG_MAX = 50;
let _rival_seq = 0;
let _rivals = [];
let _last_rival_addr = null;
let _hooks = [];

function _readItem(addr) {
    const out = { addr: addr.toString() };
    try {
        const raw = new Uint8Array(addr.readByteArray(0x28));
        out.raw_hex = Array.from(raw).map(x =>
        x.toString(16).padStart(2, '0')).join(' ');
    } catch (_) { out.raw_hex = null; }
    // NOTE: +0x18 — это "rating" в терминах нашего UI (крупное число,
    // по отчёту 2.84.1 семантически id камня). +0x24 — мелкое (1–5),
    // по отчёту "rating/level". Фильтры stones.py используют +0x18.
    try { out.rating = addr.add(0x18).readS32(); } catch (_) { out.rating = null; }
    try { out.slot   = addr.add(0x1c).readS32(); } catch (_) { out.slot = null; }
    try { out.flag   = addr.add(0x20).readU8();  } catch (_) { out.flag = null; }
    try { out.cnt    = addr.add(0x24).readS32(); } catch (_) { out.cnt = null; }
    return out;
}

function _readRival(p) {
    const out = { addr: p.toString() };
    for (const [off, tag, t] of [
        [0x88, 'gold',         's32'],
         [0x8c, 'field4',       's32'],
         [0x90, 'player_level', 's32'],
         [0x94, 'field16',      's32'],
         [0x98, 'fraction',     'f32'],
         [0x9c, 'b6',           'u8'],
         [0xa0, 'field21',      's32'],
         [0xa4, 'field22',      's32'],
    ]) {
        try {
            const q = p.add(off);
            if (t === 's32') out[tag] = q.readS32();
            else if (t === 'u8') out[tag] = q.readU8();
            else if (t === 'f32') out[tag] = q.readFloat();
        } catch (_) { out[tag] = 'ERR'; }
    }

    // stones = repeated Item (field 13): count +0x20, rep +0x28
    try {
        const n = p.add(0x20).readS32();
        const rep = p.add(0x28).readPointer();
        out.n_items = n;
        out.stones = [];
        if (n > 0 && n <= 100 && !rep.isNull()) {
            for (let i = 0; i < n; i++) {
                try {
                    const it = rep.add(8 + i * 8).readPointer();
                    if (it.isNull()) {
                        out.stones.push({ i, err: 'null' });
                        continue;
                    }
                    out.stones.push(_readItem(it));
                } catch (e) {
                    out.stones.push({ i, err: String(e) });
                }
            }
        }
    } catch (e) {
        out.n_items = 'ERR:' + e;
        out.stones = [];
    }

    out.stones.sort((a, b) => {
        const sa = (a.slot == null) ? 1e9 : a.slot;
        const sb = (b.slot == null) ? 1e9 : b.slot;
        return sa - sb;
    });

    let total = 0;
    for (const s of out.stones) {
        if (s && !s.err && typeof s.rating === 'number') total += s.rating;
    }
    out.total_rating = total;
    return out;
}

// ------------------------------------------------------------
// Parser resolution
// ------------------------------------------------------------
function _findByAob(sig) {
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

function _resolveRivalParser() {
    const addr = _findByAob(RIVAL_PARSE_AOB);
    if (addr) {
        send({
            type: 'rival_aob',
            method: 'AOB',
            addr: addr.toString(),
             offset: addr.sub(MODULE_BASE).toString(),
        });
        return addr;
    }
    const fb = MODULE_BASE.add(RIVAL_PARSE_FALLBACK);
    send({
        type: 'rival_aob',
        method: 'FALLBACK',
        addr: fb.toString(),
         offset: '0x' + RIVAL_PARSE_FALLBACK.toString(16),
    });
    return fb;
}

// ------------------------------------------------------------
// Hooks
// ------------------------------------------------------------
function installHooks() {
    const target = _resolveRivalParser();
    const h = Interceptor.attach(target, {
        onEnter(args) { this.self = args[0]; },
                                 onLeave() {
                                     try {
                                         const p = this.self;
                                         if (!p || p.isNull()) return;
                                         const snap = _readRival(p);
                                         _rival_seq++;
                                         snap.seq = _rival_seq;
                                         _last_rival_addr = p;
                                         _rivals.push(snap);
                                         if (_rivals.length > RIVALS_LOG_MAX)
                                             _rivals.shift();
                                         send({
                                             type: 'rival_update',
                                             seq: _rival_seq,
                                             gold: snap.gold,
                                             player_level: snap.player_level,
                                             n_items: snap.n_items,
                                             total_rating: snap.total_rating,
                                         });
                                     } catch (e) {
                                         send({
                                             type: 'err',
                                             where: 'onLeave',
                                             msg: String(e),
                                         });
                                     }
                                 }
    });
    _hooks.push(h);
    send({
        type: 'hooked',
        at: target.toString(),
         offset: target.sub(MODULE_BASE).toString(),
    });
    return true;
}

function unhookAll() {
    for (const h of _hooks) { try { h.detach(); } catch (_) {} }
    _hooks.length = 0;
    return true;
}

function getLastRival() {
    if (!_rivals.length)
        return { ok: false, reason: 'no_rival_yet', seq: _rival_seq };
    return { ok: true, ..._rivals[_rivals.length - 1] };
}

function getRivalsLog() {
    return { ok: true, seq: _rival_seq, count: _rivals.length,
        rivals: _rivals.slice() };
}

function readAt(addrStr) {
    return { ok: true, ..._readRival(ptr(addrStr)) };
}

function resetLog() {
    _rivals.length = 0;
    return true;
}

rpc.exports = {
    moduleBase:    () => MODULE_BASE ? MODULE_BASE.toString() : null,
    installHooks:  () => installHooks(),
    unhookAll:     () => unhookAll(),
    getLastRival:  () => getLastRival(),
    getRivalsLog:  () => getRivalsLog(),
    readAt:        (a) => readAt(a),
    resetLog:      () => resetLog(),
};
