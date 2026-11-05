// rival_hook.js — хукает Response_RivalDungeon (v2.84.1 x86_64).
// v6:
//   * Offsets RivalDungeon/Item вынесены в RIVAL_FIELDS / ITEM_FIELDS —
//     при обновлении игры менять только их.
//   * Sanity-check первых 5 rival_update: если данные выглядят мусором
//     (gold вне 0..1e10, level вне 0..1e6, n_items=ERR) — emit
//     'rival_data_suspect'. Если все первые 5 мусорные — emit
//     'rival_data_invalid' с подсказкой про offsets/AOB.
//
// v5:
//   * AOB-скан парсера (36-байтовый уникальный префикс) + fallback.
// v4:
//   * СНИМОК В onLeave; журнал _rivals (50).
'use strict';

let MODULE_BASE = null;
let MODULE_SIZE = 0;
const MODULE_NAME = 'libthieves.so';

const RIVAL_PARSE_AOB =
'55 48 89 E5 41 57 41 56 41 55 41 54 53 48 81 EC 88 00 00 00 ' +
'49 89 F6 49 89 FF 48 8D 47 08 48 89 45 B0 48 8D';

const RIVAL_PARSE_FALLBACK = 0xF680D0;

// ------------------------------------------------------------
// Offsets — единственное место, где их править при обновлении игры
// ------------------------------------------------------------
const RIVAL_FIELDS = [
    // [offset, tag, type]
    [0x88, 'gold',         's32'],
[0x8c, 'field4',       's32'],   // не используется
[0x90, 'player_level', 's32'],
[0x94, 'field16',      's32'],   // не используется
[0x98, 'fraction',     'f32'],
[0x9c, 'b6',           'u8'],
[0xa0, 'field21',      's32'],   // не используется
[0xa4, 'field22',      's32'],   // не используется
];
const RIVAL_N_ITEMS_OFF   = 0x20;  // count repeated field 13
const RIVAL_ITEMS_PTR_OFF = 0x28;  // ptr repeated field 13

const ITEM_FIELDS = {
    // +0x18 — "rating" в терминах UI (крупное число, семантически id камня)
    rating: 0x18,
    slot:   0x1c,
    flag:   0x20,
    cnt:    0x24,
};
const ITEM_SIZE       = 0x28;
const ITEM_STRIDE     = 8;
const ITEM_FIRST_PTR  = 8;

// ------------------------------------------------------------
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

// sanity-check первых N rival_update
const SANITY_CHECK_FIRST_N = 5;
let _sanity_checks_done = 0;
let _sanity_suspect_count = 0;
let _sanity_invalid_reported = false;

function _readItem(addr) {
    const out = { addr: addr.toString() };
    try {
        const raw = new Uint8Array(addr.readByteArray(ITEM_SIZE));
        out.raw_hex = Array.from(raw).map(x =>
        x.toString(16).padStart(2, '0')).join(' ');
    } catch (_) { out.raw_hex = null; }
    try { out.rating = addr.add(ITEM_FIELDS.rating).readS32(); } catch (_) { out.rating = null; }
    try { out.slot   = addr.add(ITEM_FIELDS.slot).readS32();   } catch (_) { out.slot = null; }
    try { out.flag   = addr.add(ITEM_FIELDS.flag).readU8();    } catch (_) { out.flag = null; }
    try { out.cnt    = addr.add(ITEM_FIELDS.cnt).readS32();    } catch (_) { out.cnt = null; }
    return out;
}

function _readRival(p) {
    const out = { addr: p.toString() };
    for (const [off, tag, t] of RIVAL_FIELDS) {
        try {
            const q = p.add(off);
            if (t === 's32') out[tag] = q.readS32();
            else if (t === 'u8') out[tag] = q.readU8();
            else if (t === 'f32') out[tag] = q.readFloat();
        } catch (_) { out[tag] = 'ERR'; }
    }

    try {
        const n = p.add(RIVAL_N_ITEMS_OFF).readS32();
        const rep = p.add(RIVAL_ITEMS_PTR_OFF).readPointer();
        out.n_items = n;
        out.stones = [];
        if (n > 0 && n <= 100 && !rep.isNull()) {
            for (let i = 0; i < n; i++) {
                try {
                    const it = rep.add(ITEM_FIRST_PTR + i * ITEM_STRIDE).readPointer();
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
// Sanity-check
// ------------------------------------------------------------
function _checkRivalSanity(snap) {
    if (_sanity_checks_done >= SANITY_CHECK_FIRST_N) return;
    _sanity_checks_done++;

    const issues = [];

    if (typeof snap.gold !== 'number' || snap.gold < 0 || snap.gold > 1e10) {
        issues.push('gold=' + snap.gold);
    }
    if (typeof snap.player_level !== 'number'
        || snap.player_level < 0 || snap.player_level > 1e6) {
        issues.push('player_level=' + snap.player_level);
        }
        if (snap.n_items === 'ERR' || (typeof snap.n_items === 'string')) {
            issues.push('n_items=' + snap.n_items);
        } else if (typeof snap.n_items !== 'number'
            || snap.n_items < 0 || snap.n_items > 100) {
            issues.push('n_items=' + snap.n_items);
            }

            if (issues.length === 0) return;

            _sanity_suspect_count++;
    send({
        type: 'rival_data_suspect',
        seq: snap.seq,
        issues,
        sample: {
            gold: snap.gold,
            player_level: snap.player_level,
            fraction: snap.fraction,
            n_items: snap.n_items,
        },
    });

    if (_sanity_suspect_count >= SANITY_CHECK_FIRST_N && !_sanity_invalid_reported) {
        _sanity_invalid_reported = true;
        send({
            type: 'rival_data_invalid',
            msg: 'все первые ' + SANITY_CHECK_FIRST_N +
            ' rival_update выглядят как мусор',
            hint: 'Скорее всего устарели offsets (RIVAL_FIELDS/ITEM_FIELDS в ' +
            'rival_hook.js) или AOB парсера. Запусти `stones debug` и ' +
            'посмотри raw_hex первого соперника.',
        });
    }
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

                                         _checkRivalSanity(snap);

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
