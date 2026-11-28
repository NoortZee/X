// Хук Response_RivalDungeon: снимки данных соперников.
// История изменений и совместимость: docs/CHANGELOG.md.
'use strict';

let MODULE_BASE = null;
let MODULE_SIZE = 0;
const MODULE_NAME = MEMORY_LAYOUT.module_name;
// Протокол: по каким полям обёртки видно, что тап скипа принят и что начался
// заход в базу. Нужно, чтобы не тапать вслепую по таймеру (см. stones/mod.rs).
const PROTO = MEMORY_LAYOUT.protocol;
const PROTO_SIGNATURES = PROTO.signatures;
const PROTO_FALLBACK = PROTO.fallback;
const PROTO_WRAPPER = PROTO.request_wrapper;
const PROTO_VTABLE = PROTO.vtable;
const RIVAL_PARSE_AOB = MEMORY_LAYOUT.stones.parser_aob;
const RIVAL_PARSE_FALLBACK = MEMORY_LAYOUT.stones.parser_fallback;
const RIVAL_FIELDS = MEMORY_LAYOUT.stones.rival_fields;
const RIVAL_N_ITEMS_OFF = MEMORY_LAYOUT.stones.rival_n_items;
const RIVAL_ITEMS_PTR_OFF = MEMORY_LAYOUT.stones.rival_items_ptr;
const ITEM_FIELDS = MEMORY_LAYOUT.stones.item_fields;
const ITEM_STRIDE = MEMORY_LAYOUT.stones.item_stride;
const ITEM_FIRST_PTR = MEMORY_LAYOUT.stones.item_first_ptr;

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
let _hooks = [];

// sanity-check первых N rival_update
const SANITY_CHECK_FIRST_N = 5;
let _sanity_checks_done = 0;
let _sanity_suspect_count = 0;
let _sanity_invalid_reported = false;

function _readItem(addr) {
    const out = { addr: addr.toString() };
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
// Read-only дамп ответа сервера (диагностика состава данных для реплеев).
// Только чтение по offsets и send(): ничего не пишет в игру и не отправляет
// запросов. Включается RPC setRaw(true), по умолчанию выключен.
// ------------------------------------------------------------
const PROBE = MEMORY_LAYOUT.stones.rival_probe;
const DUNGEON = MEMORY_LAYOUT.protocol.dungeon;
let RAW_MODE = false;

function _win(p, from, count) {
    const s32 = [];
    const hex = [];
    for (let i = 0; i < count; i++) {
        try {
            const v = p.add(from + i * 4).readU32();
            s32.push(v | 0);
            hex.push(('00000000' + v.toString(16)).slice(-8));
        } catch (e) {
            s32.push(null);
            hex.push('????????');
        }
    }
    return { from: '0x' + from.toString(16), s32: s32, hex: hex.join(' ') };
}

function _hexOf(bytes) {
    return Array.prototype.map.call(new Uint8Array(bytes), function (b) {
        return ('0' + b.toString(16)).slice(-2);
    }).join('');
}

// Поле wire-типа 2 внутри сообщения: раскладка std::string в этой сборке не
// совпала ни с длинной формой libc++, ни с SSO, поэтому дамп показывает и
// сырые 24 байта поля, и содержимое по каждому из трёх указателей. Так имя или
// uuid видно без угадывания раскладки.
function _stdString(p, off) {
    const out = { off: '0x' + off.toString(16), hex: null, probes: [] };
    try {
        const raw = p.add(off).readByteArray(PROBE.string_hex);
        if (raw) out.hex = _hexOf(raw);
    } catch (e) {}
    for (let slot = 0; slot < 3; slot++) {
        let target = null;
        try {
            target = p.add(off + slot * 8).readPointer();
        } catch (e) { continue; }
        if (!target || target.isNull()) continue;
        const probe = { slot: slot, addr: target.toString() };
        try {
            const bytes = target.readByteArray(PROBE.string_ptr_bytes);
            if (bytes) {
                probe.hex = _hexOf(bytes);
                const text = target.readUtf8String(PROBE.string_ptr_bytes);
                if (text) probe.text = text.replace(/\u0000[\s\S]*$/, '');
            }
        } catch (e) { probe.err = 'unreadable'; }
        out.probes.push(probe);
    }
    return out;
}

function _obstacleAt(o) {
    const out = { addr: o.toString(), type: null, slot: null, x: null, y: null };
    const read = function (off) {
        try { return o.add(off).readS32(); } catch (e) { return 'ERR'; }
    };
    out.type = read(DUNGEON.obstacles.type);
    out.slot = read(DUNGEON.obstacles.slot);
    out.x = read(DUNGEON.obstacles.x);
    out.y = read(DUNGEON.obstacles.y);
    try { out.win = _win(o, 0x10, DUNGEON.probe.obstacle_dwords); } catch (e) {}
    return out;
}

function _readDungeon(p) {
    const out = { addr: p.toString(), vptr: null, vtable_ok: null };
    try {
        const vptr = p.readPointer();
        out.vptr = vptr.toString();
        out.vtable_ok = vptr.equals(MODULE_BASE.add(DUNGEON.vtable));
    } catch (e) {
        out.err = String(e);
        return out;
    }
    out.header = {};
    for (const key of Object.keys(DUNGEON.header)) {
        try { out.header[key] = p.add(DUNGEON.header[key]).readS32(); }
        catch (e) { out.header[key] = 'ERR'; }
    }
    try { out.win = _win(p, DUNGEON.probe.dwords.from, DUNGEON.probe.dwords.count); } catch (e) {}

    // repeated: count — [field+0x08], таблица указателей — [field+0x10].
    // base/hook.js берёт указатель с rep+0, stones — с rep+8; дамп показывает
    // обе интерпретации, чтобы расхождение закрылось фактом, а не правкой вслепую.
    out.obstacles = [];
    try {
        const n = p.add(DUNGEON.obstacles.count).readS32();
        const rep = p.add(DUNGEON.obstacles.rep).readPointer();
        out.n_obstacles = n;
        out.rep = rep.isNull() ? null : rep.toString();
        if (n >= 0 && n <= DUNGEON.obstacles.max && !rep.isNull()) {
            for (let i = 0; i < n; i++) {
                const entry = { i: i, from_rep0: null, from_rep8: null };
                try {
                    const a = rep.add(i * Process.pointerSize).readPointer();
                    if (!a.isNull()) entry.from_rep0 = _obstacleAt(a);
                } catch (e) { entry.from_rep0 = 'ERR'; }
                try {
                    const b = rep.add(Process.pointerSize + i * Process.pointerSize).readPointer();
                    if (!b.isNull()) entry.from_rep8 = _obstacleAt(b);
                } catch (e) { entry.from_rep8 = 'ERR'; }
                out.obstacles.push(entry);
            }
        }
    } catch (e) {
        out.obstacles_err = String(e);
    }
    return out;
}

function _readRaw(p) {
    const out = { addr: p.toString(), at: Date.now(), vptr: null };
    try { out.vptr = p.readPointer().toString(); } catch (e) {}
    out.scalars = {};
    for (const [off, tag, t] of RIVAL_FIELDS) {
        try {
            const q = p.add(off);
            out.scalars[tag] = (t === 's32') ? q.readS32()
                : (t === 'u8') ? q.readU8()
                : (t === 'f32') ? q.readFloat() : null;
        } catch (e) { out.scalars[tag] = 'ERR'; }
    }
    try { out.win = _win(p, PROBE.dwords.from, PROBE.dwords.count); } catch (e) {}
    out.strings = PROBE.strings.map(function (pair) {
        const s = _stdString(p, pair[0]);
        s.name = pair[1];
        return s;
    });
    out.messages = PROBE.messages.map(function (pair) {
        const m = { name: pair[1], off: '0x' + pair[0].toString(16) };
        try {
            const q = p.add(pair[0]).readPointer();
            m.is_null = q.isNull();
            if (!q.isNull()) {
                m.addr = q.toString();
                m.win = _win(q, 0x10, PROBE.msg_dwords);
            }
        } catch (e) { m.err = String(e); }
        return m;
    });
    out.repeated = PROBE.repeated.map(function (pair) {
        const r = { name: pair[1], off: '0x' + pair[0].toString(16), count: null,
                    rep: null, elems: [] };
        try {
            r.count = p.add(pair[0] + 0x08).readS32();
            const rep = p.add(pair[0] + 0x10).readPointer();
            r.rep = rep.isNull() ? null : rep.toString();
            const n = Math.min(Math.max(r.count | 0, 0), PROBE.max_repeated);
            if (!rep.isNull()) {
                for (let i = 0; i < n; i++) {
                    try {
                        const e = rep.add(Process.pointerSize + i * Process.pointerSize)
                            .readPointer();
                        r.elems.push(e.isNull() ? null : _win(e, 0x10, PROBE.msg_dwords));
                    } catch (e) { r.elems.push('ERR'); }
                }
            }
        } catch (e) { r.err = String(e); }
        return r;
    });
    try {
        const d = p.add(PROBE.dungeon_ptr).readPointer();
        out.dungeon = d.isNull() ? null : _readDungeon(d);
    } catch (e) { out.dungeon_err = String(e); }
    try {
        const snap = _readRival(p);
        out.stones = snap.stones;
        out.total_rating = snap.total_rating;
    } catch (e) { out.stones_err = String(e); }
    return out;
}

// ------------------------------------------------------------
// Хук парсера Dungeon: ловушки, которые реально грузит уровень.
// Предпросмотр соперника и загрузка уровня — разные моменты; какой из них
// считать источником для реплея, решает сравнение двух дампов.
// ------------------------------------------------------------
let _dungeonHook = null;
let _dungeonParses = 0;

function _prologueOk(addr, prologue) {
    const want = String(prologue).trim().toLowerCase().split(/\s+/);
    try {
        const bytes = addr.readByteArray(want.length);
        if (!bytes) return false;
        const got = Array.prototype.map.call(new Uint8Array(bytes), function (b) {
            return ('0' + b.toString(16)).slice(-2);
        });
        for (let i = 0; i < want.length; i++) {
            if (want[i] !== got[i]) return false;
        }
        return true;
    } catch (e) { return false; }
}

function _installDungeonProbe() {
    if (_dungeonHook) return true;
    const spec = MEMORY_LAYOUT.protocol.dungeon.parser;
    const addr = MODULE_BASE.add(spec.rva);
    if (!_prologueOk(addr, spec.prologue)) {
        send({ type: 'err', where: 'dungeon_probe',
               msg: 'пролог не совпал по RVA 0x' + spec.rva.toString(16) + ' — хук не поставлен' });
        return false;
    }
    _dungeonHook = Interceptor.attach(addr, {
        onEnter(args) { this.self = args[0]; },
        onLeave() {
            if (!RAW_MODE) return;
            try {
                const p = this.self;
                if (!p || p.isNull()) return;
                if (!p.readPointer().equals(MODULE_BASE.add(DUNGEON.vtable))) return;
                _dungeonParses++;
                send({ type: 'dungeon_parse', n: _dungeonParses, at: Date.now(),
                       rival_seq: _rival_seq, dungeon: _readDungeon(p) });
            } catch (e) {
                send({ type: 'err', where: 'dungeon_parse', msg: String(e) });
            }
        },
    });
    send({ type: 'dungeon_probe_installed', at: '0x' + spec.rva.toString(16) });
    return true;
}

function _emitRivalRaw(p) {
    if (!RAW_MODE) return;
    try {
        send({ type: 'rival_raw', seq: _rival_seq, raw: _readRaw(p) });
    } catch (e) {
        send({ type: 'err', where: 'rival_raw', msg: String(e) });
    }
}

// Поле N обёртки Request лежит по 0x10 + 8*N (HAS_BITS на 0x10):
// f8 matchmaking 0x50, f10 confirm 0x60, f13 start_attack 0x78, f34 0x120,
// f37 league_rival 0x138. Формула выведена из этих же констант, а не из догадки.
function _wrapField(n) { return 0x10 + 8 * n; }

function _emitSubmitRaw(wrapper) {
    if (!RAW_MODE) return;
    // Вся карта обёртки: видно, каким полем клиент шлёт каждый запрос, даже
    // если это не тот запрос, который мы ожидали.
    try {
        send({ type: 'submit_map', at: Date.now(),
               win: _win(wrapper, 0x10, PROBE.wrapper_dwords) });
    } catch (e) {
        send({ type: 'err', where: 'submit_map', msg: String(e) });
    }
    const fields = [
        [PROTO_WRAPPER.FIELD10_CONFIRM, 'confirm_dungeon'],
        [PROTO_WRAPPER.START_ATTACK, 'start_attack'],
        [PROTO_WRAPPER.ATTEMPT_STARTED, 'attempt_started'],
        [PROTO_WRAPPER.MATCHMAKING, 'matchmaking'],
        [PROTO_WRAPPER.LEAGUE_RIVAL, 'league_rival'],
        [PROTO_WRAPPER.FIELD30_DELTA, 'change_dungeon_object'],
        [_wrapField(11), 'singleplayer_attack_result'],
        [_wrapField(12), 'multiplayer_attack_result'],
    ];
    for (const pair of fields) {
        let q = null;
        try { q = wrapper.add(pair[0]).readPointer(); } catch (e) { continue; }
        if (!q || q.isNull()) continue;
        const msg = { type: 'submit_raw', field: pair[1],
                      off: '0x' + pair[0].toString(16), at: q.toString(), vptr: null };
        try { msg.vptr = q.readPointer().toString(); } catch (e) {}
        try { msg.win = _win(q, 0x10, PROBE.submit_dwords); } catch (e) {}
        send(msg);
    }
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
            hint: 'Скорее всего устарели offsets (rival_fields/item_fields в ' +
            'memory/offsets.js) или AOB парсера. Запусти `stones debug` и ' +
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

function installHooksIfNeeded() {
    if (_hooks.length) return true;
    return installHooks();
}

// ------------------------------------------------------------
// Protocol: submit (исходящие запросы)
// ------------------------------------------------------------
function _codeRanges() {
    const out = [];
    const end = MODULE_BASE.add(MODULE_SIZE);
    for (const r of Process.enumerateRanges('r-x')) {
        if (r.base.compare(MODULE_BASE) >= 0 && r.base.compare(end) < 0) out.push(r);
    }
    return out;
}

function _resolveProto(name) {
    const sig = PROTO_SIGNATURES[name];
    try {
        for (const r of _codeRanges()) {
            const hits = Memory.scanSync(r.base, r.size, sig);
            if (hits.length === 1) return hits[0].address;
            if (hits.length > 1) break;
        }
    } catch (e) {
        send({ type: 'err', where: 'proto_scan_' + name, msg: String(e) });
    }
    return MODULE_BASE.add(PROTO_FALLBACK[name]);
}

// send({type:'matchmaking_sent'}) — тап по кнопке next дошёл до игры;
// send({type:'attack_started'}) — начался заход в базу (значит тап улетел не туда).
let PROTO_CTX = null;        // ctx протокольного клиента (берём из submit)
// Обработчик ответа, который панель передаёт вместе с MatchMaking (self+0x200).
// С ним ответ сервера приходит в UI, и экран обновляется сразу, без перезахода.
let PROTO_HANDLER = null;
let PROTO_HANDLER_AT = 0;
const HANDLER_MAX_AGE_MS = 120000;
// Указатель панели соперника (self) и время перехвата: нужен, чтобы попросить
// панель саму отправить «next» — тогда она передаёт свой живой обработчик и
// обновляет экран. Использовать только пока панель на экране (свежий self).
let PANEL_SELF = null;
let PANEL_SELF_AT = 0;
const PANEL_MAX_AGE_MS = 30000;
let LOG_BUILDER = false;     // диагностика: логировать вызовы сборщика MatchMaking

// Подмена аргумента flag у MatchMaking на ОДИН следующий вызов:
//   null — не трогать, 1 — «следующий» (skip), 0 — «текущий» (синхронизация UI).
let FORCE_FLAG = null;
// Окно принудительного флага: все MatchMaking внутри окна получат WINDOW_FLAG.
// Нужно, чтобы «посторонний» запрос не съел одноразовый взвод.
let WINDOW_FLAG = null;
let WINDOW_UNTIL = 0;
let SKIP_QUEUE = [];         // отложенные вызовы skip (исполняем в потоке игры)
let SKIP_HOOKS = [];         // eglSwapBuffers-диспетчер и т.п.
let SKIP_FLAG = 0;           // bool-аргумент MatchMaking (игра передаёт 0)

function _protoCtx() {
    if (PROTO_CTX && !PROTO_CTX.isNull()) return PROTO_CTX;
    // Геттер синглтона создаёт контекст лениво и трогает thread-local состояние,
    // поэтому вызываем его только из потока игры (внутри диспетчера).
    try {
        const getter = MODULE_BASE.add(PROTO_FALLBACK.CTX_GETTER);
        const fn = new NativeFunction(getter, 'pointer', []);
        const ctx = fn();
        if (ctx && !ctx.isNull()) PROTO_CTX = ctx;
        return ctx;
    } catch (e) {
        send({ type: 'err', where: 'ctx_getter', msg: String(e) });
        return null;
    }
}

// Собрать KTProtocol::Request{ GetLeagueRivalDungeon } и отправить самим.
// Клиент строит такой же пакет, когда листает соперников в лиге.
function _sendLeagueRival(ctx) {
    const alloc = new NativeFunction(MODULE_BASE.add(PROTO_FALLBACK.ALLOC), 'pointer', ['uint']);
    const wrapperCtor = new NativeFunction(MODULE_BASE.add(PROTO_FALLBACK.WRAPPER_CTOR), 'void', ['pointer']);
    const msgCtor = new NativeFunction(MODULE_BASE.add(PROTO_FALLBACK.LEAGUE_RIVAL_CTOR), 'void', ['pointer']);
    const submit = new NativeFunction(MODULE_BASE.add(PROTO_FALLBACK.SUBMIT), 'void',
                                      ['pointer', 'pointer', 'pointer', 'int']);
    const handler = _protoHandler();

    const wrapper = alloc(PROTO_WRAPPER.SIZE);
    wrapperCtor(wrapper);
    const msg = alloc(0x28);
    msgCtor(msg);
    wrapper.add(PROTO_WRAPPER.LEAGUE_RIVAL).writePointer(msg);
    const bits = wrapper.add(0x14).readU8();
    wrapper.add(0x14).writeU8(bits | 0x04);   // has-бит поля GetLeagueRivalDungeon
    submit(ctx, wrapper, handler, 0);
    return { wrapper: wrapper.toString(), msg: msg.toString() };
}

// Обработчик панели живёт внутри её объекта; если он «старый», лучше не
// подставлять его (панель могла быть пересоздана).
function _protoHandler() {
    if (!PROTO_HANDLER || PROTO_HANDLER.isNull()) return ptr(0);
    const age = Date.now() - PROTO_HANDLER_AT;
    if (age > HANDLER_MAX_AGE_MS) return ptr(0);
    // Панель могла быть уничтожена: у живого обработчика vptr указывает в модуль.
    try {
        const vptr = PROTO_HANDLER.readPointer();
        const lo = MODULE_BASE, hi = MODULE_BASE.add(MODULE_SIZE);
        if (vptr.compare(lo) < 0 || vptr.compare(hi) >= 0) {
            send({ type: 'handler_dropped', reason: 'vptr вне модуля' });
            PROTO_HANDLER = null;
            return ptr(0);
        }
    } catch (e) {
        PROTO_HANDLER = null;
        return ptr(0);
    }
    return PROTO_HANDLER;
}

function _runSkipJob(job) {
    const ctx = _protoCtx();
    if (!ctx || ctx.isNull()) {
        send({ type: 'skip_result', ok: false, reason: 'no_ctx' });
        return;
    }
    try {
        if (job.kind === 'matchmaking') {
            const builder = MODULE_BASE.add(PROTO_FALLBACK.MATCHMAKING_BUILDER);
            const fn = new NativeFunction(builder, 'void', ['pointer', 'pointer', 'int']);
            // handler НЕ передаём: панель пересоздаёт свой обработчик после каждой
            // смены соперника, и повторное использование даёт SIGSEGV у клиента.
            fn(ctx, ptr(0), job.flag ? 1 : 0);
            send({ type: 'skip_result', ok: true, kind: 'matchmaking', flag: !!job.flag,
                   handler: null });
        } else {
            const r = _sendLeagueRival(ctx);
            send({ type: 'skip_result', ok: true, kind: 'league_rival', at: r });
        }
    } catch (e) {
        send({ type: 'skip_result', ok: false, kind: job.kind, reason: String(e) });
    }
}

// Сборщик MatchMaking трогает thread-local состояние — вызываем его в потоке
// игры (на кадре), а не из потока frida.
function _installSkipDispatcher() {
    if (SKIP_HOOKS.length) return true;
    const egl = Process.findModuleByName('libEGL.so');
    const sym = egl ? egl.findExportByName('eglSwapBuffers') : null;
    if (!sym) {
        send({ type: 'err', where: 'skip_dispatcher', msg: 'eglSwapBuffers не найден' });
        return false;
    }
    SKIP_HOOKS.push(Interceptor.attach(sym, {
        onEnter() {
            if (!SKIP_QUEUE.length) return;
            const job = SKIP_QUEUE.shift();
            _runSkipJob(job);
        },
    }));
    send({ type: 'skip_dispatcher_ready' });
    return true;
}

function _hookMatchmakingBuilder() {
    const builder = MODULE_BASE.add(PROTO_FALLBACK.MATCHMAKING_BUILDER);
    const h = Interceptor.attach(builder, {
        onEnter(args) {
            const caller = this.returnAddress.sub(MODULE_BASE);
            const flag = args[2].toInt32();
            if (LOG_BUILDER) {
                send({ type: 'mm_call', caller: '0x' + caller.toString(16),
                       handler: args[1].isNull() ? null : args[1].toString(),
                       flag: flag, forced: FORCE_FLAG });
            }
            let want = null;
            if (WINDOW_FLAG !== null && Date.now() < WINDOW_UNTIL) {
                want = WINDOW_FLAG;
            } else if (FORCE_FLAG !== null) {
                want = FORCE_FLAG;
                FORCE_FLAG = null;           // одноразовый взвод
            }
            if (want === null) return;
            args[2] = ptr(want);
            send({ type: 'flag_forced', flag: want, window: WINDOW_FLAG !== null && Date.now() < WINDOW_UNTIL });
        },
    });
    _hooks.push(h);
    send({ type: 'mm_builder_hooked', at: builder.sub(MODULE_BASE).toString(16) });
    return true;
}

function _hookSubmit() {
    const submit = _resolveProto('SUBMIT');
    const requestVtable = MODULE_BASE.add(PROTO_VTABLE.REQUEST);
    const h = Interceptor.attach(submit, {
        onEnter(args) {
            try {
                if (!args[0].isNull()) PROTO_CTX = args[0];
                const wrapper = args[1];
                if (wrapper.isNull()) return;
                if (!wrapper.readPointer().equals(requestVtable)) return;
                let mmPtr = null;
                try { mmPtr = wrapper.add(PROTO_WRAPPER.MATCHMAKING).readPointer(); } catch (e) {}
                if (mmPtr && !mmPtr.isNull()) {
                    const h = args[2];
                    if (h && !h.isNull()) {
                        PROTO_HANDLER = h;
                        PROTO_HANDLER_AT = Date.now();
                    }
                }
                if (WATCH_SUBMIT) {
                    const set = [];
                    for (let off = 0x28; off < PROTO_WRAPPER.SIZE; off += 8) {
                        try {
                            if (!wrapper.add(off).readPointer().isNull()) set.push('0x' + off.toString(16));
                        } catch (e) { break; }
                    }
                    let firstTag = null;
                    try { firstTag = wrapper.add(0x14).readU8(); } catch (e) {}
                    let mmFlag = null;
                    try {
                        const mm = wrapper.add(PROTO_WRAPPER.MATCHMAKING).readPointer();
                        if (mm && !mm.isNull()) {
                            mmFlag = { has: mm.add(0x10).readU8(), flag: mm.add(0x18).readU8() };
                        }
                    } catch (e) {}
                    send({ type: 'submit_fields', offsets: set, bits14: firstTag, mm: mmFlag });
                }
                if (!wrapper.add(PROTO_WRAPPER.MATCHMAKING).readPointer().isNull()) {
                    send({ type: 'matchmaking_sent' });
                }
                _emitSubmitRaw(wrapper);
                const attack = wrapper.add(PROTO_WRAPPER.START_ATTACK).readPointer();
                const started = wrapper.add(PROTO_WRAPPER.ATTEMPT_STARTED).readPointer();
                if (!attack.isNull() || !started.isNull()) {
                    send({ type: 'attack_started',
                        field: attack.isNull() ? 'attempt_started' : 'start_attack' });
                }
            } catch (e) {
                send({ type: 'err', where: 'submit_hook', msg: String(e) });
            }
        },
    });
    _hooks.push(h);
    send({ type: 'proto_hooked', submit: submit.sub(MODULE_BASE).toString(16) });
    return true;
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
                                         _rivals.push(snap);
                                         if (_rivals.length > RIVALS_LOG_MAX)
                                             _rivals.shift();

                                         _checkRivalSanity(snap);
                                         _emitRivalRaw(p);

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
    _hookSubmit();
    _hookMatchmakingBuilder();
    return true;
}

function unhookAll() {
    if (_dungeonHook) { try { _dungeonHook.detach(); } catch (_) {} _dungeonHook = null; }
    for (const h of _hooks) { try { h.detach(); } catch (_) {} }
    _hooks.length = 0;
    for (const h of SKIP_HOOKS) { try { h.detach(); } catch (_) {} }
    SKIP_HOOKS.length = 0;
    SKIP_QUEUE.length = 0;
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

function getRivalsSince(sinceSeq) {
    const from = Number(sinceSeq) || 0;
    const rivals = _rivals.filter(r => r.seq > from);
    return { ok: true, seq: _rival_seq, count: rivals.length, rivals };
}

function resetLog() {
    _rivals.length = 0;
    return true;
}

let WATCH_SUBMIT = false;

rpc.exports = {
    moduleBase:     () => MODULE_BASE ? MODULE_BASE.toString() : null,
    /// Диагностика: полный read-only дамп ответов соперника и исходящих
    /// сообщений (ловушки, seed, id подземелья). Включается только явно.
    setRaw: (on) => {
        RAW_MODE = !!on;
        if (RAW_MODE) _installDungeonProbe();
        return RAW_MODE;
    },
    /// Диагностика: логировать поля каждого исходящего KTProtocol::Request.
    watchSubmit: (on) => { WATCH_SUBMIT = !!on; return WATCH_SUBMIT; },
    /// Диагностика: логировать каждый вызов сборщика MatchMaking (кто и с чем зовёт).
    watchBuilder: (on) => { LOG_BUILDER = !!on; return LOG_BUILDER; },
    /// Следующий MatchMaking, отправленный самим клиентом, пойдёт с flag=0:
    /// сервер вернёт ТЕКУЩЕГО соперника, и панель его покажет (обновление UI).
    armSyncCurrent: () => { FORCE_FLAG = 0; return { armed: 0 }; },
    /// То же, но flag=1 (следующий соперник) — на случай, если нужно, чтобы
    /// именно клиент сделал skip (с обновлением экрана).
    armSkipNext: () => { FORCE_FLAG = 1; return { armed: 1 }; },
    disarm: () => { FORCE_FLAG = null; WINDOW_FLAG = null; WINDOW_UNTIL = 0; return true; },
    /// Все MatchMaking в течение ms миллисекунд пойдут с заданным flag.
    /// flag=0 — «текущий соперник»: безопасно (никого не листает).
    armWindow: (flag, ms) => {
        WINDOW_FLAG = Number(flag);
        WINDOW_UNTIL = Date.now() + Math.max(100, Number(ms) || 3000);
        return { flag: WINDOW_FLAG, untilMs: Math.max(100, Number(ms) || 3000) };
    },
    status2: () => ({ armed: FORCE_FLAG, windowFlag: WINDOW_FLAG,
                      windowLeftMs: WINDOW_UNTIL ? Math.max(0, WINDOW_UNTIL - Date.now()) : 0 }),
    /// Запросить следующего соперника игровым вызовом (без тапа phantom).
    sendSkip: (kind) => {
        if (!installHooksIfNeeded()) return { ok: false, reason: 'hooks_not_installed' };
        // 'ui' (по умолчанию) — попросить панель саму отправить next:
        //   живой handler + обновление экрана;
        // 'matchmaking' — прямой вызов сборщика с flag=1 (экран не обновляется);
        // 'league' — собранный руками GetLeagueRivalDungeon.
        const k = (kind === 'league') ? 'league' : 'matchmaking';
        SKIP_QUEUE.push({ kind: k, flag: 1 });
        const disp = _installSkipDispatcher();
        return { ok: disp, queued: SKIP_QUEUE.length, kind: k, dispatcher: disp };
    },
    skipStatus: () => ({
        ctx: PROTO_CTX ? PROTO_CTX.toString() : null,
        handler: (PROTO_HANDLER && !PROTO_HANDLER.isNull()) ? PROTO_HANDLER.toString() : null,
        handlerAgeMs: PROTO_HANDLER_AT ? (Date.now() - PROTO_HANDLER_AT) : null,
        queued: SKIP_QUEUE.length,
        dispatcher: SKIP_HOOKS.length > 0,
        builder: PROTO_FALLBACK.MATCHMAKING_BUILDER.toString(16),
        panel: PANEL_SELF ? PANEL_SELF.toString() : null,
        panelAgeMs: PANEL_SELF_AT ? (Date.now() - PANEL_SELF_AT) : null,
    }),
    installHooks:   () => installHooks(),
    unhookAll:      () => unhookAll(),
    getLastRival:   () => getLastRival(),
    getRivalsLog:   () => getRivalsLog(),
    getRivalsSince: (s) => getRivalsSince(s),
    resetLog:       () => resetLog(),
};
