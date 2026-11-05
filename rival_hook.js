// rival_hook.js — хукает Response_RivalDungeon (0xF680D0).
// v4 fixes:
//   * СНИМОК В onLeave: объект RivalDungeon временный — Clear()/free
//     случаются сразу после парсера. Раньше _readRival(p) вызывался из
//     RPC, и читал уже очищенный объект (нули). Теперь _readRival(p)
//     вызывается СИНХРОННО в onLeave, а getLastRival возвращает снимок.
//   * Журнал _rivals (последние 50 соперников), getRivalsLog() — чтобы
//     видеть всех кандидатов из одного Find a Match.
//   * stones сортируются по slot.
//   * readAt(addr) оставлен для отладки (может вернуть нули — объект
//     мог быть очищен, см. комментарий в функции).
'use strict';

let MODULE_BASE = null;
const MODULE_NAME = 'libthieves.so';

function _init() {
    let m = null;
    for (let i = 0; i < 100; i++) {
        try { m = Process.findModuleByName(MODULE_NAME); } catch (e) {}
        if (m) break;
        try { Thread.sleep(0.1); } catch (_) {}
    }
    if (!m) throw new Error(MODULE_NAME + ' not loaded');
    MODULE_BASE = m.base;
    send({ type: 'ready', base: MODULE_BASE.toString() });
}
try { _init(); } catch (e) { send({ type: 'fatal', msg: String(e) }); }

const RIVALS_LOG_MAX = 50;
let _rival_seq = 0;
let _rivals = [];            // массив снимков (последние 50)
let _last_rival_addr = null; // NativePointer последнего (для readAt debug)
let _hooks = [];

function _readItem(addr) {
    const out = { addr: addr.toString() };
    try {
        const raw = new Uint8Array(addr.readByteArray(0x28));
        out.raw_hex = Array.from(raw).map(x =>
        x.toString(16).padStart(2, '0')).join(' ');
    } catch (_) { out.raw_hex = null; }
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
                    if (it.isNull()) { out.stones.push({ i, err: 'null' }); continue; }
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

    // Сортируем по slot, чтобы порядок в выводе совпадал с тотемом.
    out.stones.sort((a, b) => {
        const sa = (a.slot == null) ? 1e9 : a.slot;
        const sb = (b.slot == null) ? 1e9 : b.slot;
        return sa - sb;
    });

    // total_rating = sum(rating)
    let total = 0;
    for (const s of out.stones) {
        if (s && !s.err && typeof s.rating === 'number') total += s.rating;
    }
    out.total_rating = total;
    return out;
}

function installHooks() {
    const h = Interceptor.attach(MODULE_BASE.add(0xF680D0), {
        onEnter(args) { this.self = args[0]; },
                                 onLeave() {
                                     try {
                                         const p = this.self;
                                         if (!p || p.isNull()) return;
                                         // СНИМОК: читаем всё прямо сейчас, пока объект жив.
                                         const snap = _readRival(p);
                                         _rival_seq++;
                                         snap.seq = _rival_seq;
                                         _last_rival_addr = p;
                                         _rivals.push(snap);
                                         if (_rivals.length > RIVALS_LOG_MAX) _rivals.shift();
                                         send({ type: 'rival_update',
                                             seq: _rival_seq,
                                             gold: snap.gold,
                                             player_level: snap.player_level,
                                             n_items: snap.n_items,
                                             total_rating: snap.total_rating });
                                     } catch (e) {
                                         send({ type: 'err', where: 'onLeave', msg: String(e) });
                                     }
                                 }
    });
    _hooks.push(h);
    send({ type: 'hooked', at: '0xF680D0' });
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

// Debug: прочитать по сырому адресу. ВНИМАНИЕ — после onLeave объект
// может быть уже очищен (Clear/free), поэтому поля могут быть нулями.
// Для реального чтения используйте getLastRival / getRivalsLog —
// там снимок сделан в onLeave, когда объект ещё жив.
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
