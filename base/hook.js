// save base (server logic) — подмена координат в исходящей дельте редактора.
//
// Хук на KTProtocol::Message::SerializeToArray: сообщение уже собрано в буфер,
// но ещё не ушло в сеть. Если это обёртка KTProtocol::Request с заполненным
// полем 30 (ChangeDungeonObject), координаты объекта сдвигаются на заданное
// смещение. Длина varint'а сохраняется (protobuf допускает избыточные байты),
// поэтому размер пакета не меняется.
//
// Смещения и AOB-сигнатуры: memory/offsets.js -> MEMORY_LAYOUT.protocol.
'use strict';

let MODULE_BASE = null;
let MODULE_SIZE = 0;
const MODULE_NAME = MEMORY_LAYOUT.module_name;
const B = MEMORY_LAYOUT.protocol;
const D = B.dungeon;
const CELL_PX = B.grid.CELL_PX;

let ENABLED = false;
let OFFSET_X = 0;
let OFFSET_Y = 0;
let PATCH_COUNT = 0;
let LISTENERS = [];
let FUNCS = {};

// reset: все объекты макета в одну точку — только в памяти клиента, на сервер
// не уходит ничего. Режим держится до `resetOff`: клиент разбирает раскладку
// несколько раз за сессию, и каждый разбор снова собирает объекты в точку
// (снимается явно, чтобы не мешать после проверки).
let RESET_ARMED = false;
let RESET_X = D.default_point.x;
let RESET_Y = D.default_point.y;
let RESET_OBJECTS = 0;
let RESET_EVENTS = 0;
let RESET_LAST = null;
let LAST_DUNGEON = null;
let DUNGEON_HOOKED = false; // стоит ли хук на разборе макета
let PARSE_EVENTS = 0;      // разобрано макетов Dungeon
let PARSE_LAST = null;
// Какая база реально загружена в сцену. Ставится хуком GameScene2::loadDungeon
// и снимается, когда клиент отправил результат забега (ушли с уровня). Это
// отличается от PARSE_LAST: свой данж сервер присылает один раз при старте игры,
// и после входа в него разбора не будет — доверять «последнему разбору» нельзя.
let CURRENT = { source: 'none', reason: 'no_level_loaded' };
let LOAD_EVENTS = 0;       // сколько раз уровень собирался заново
let LEVEL_HOOKED = false;
let TRACE = false;         // печатать каждый разбор (диагностика)

// ------------------------------------------------------------
function _err(where, msg) {
    send({ type: 'err', where: where, msg: String(msg) });
}

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
    send({ type: 'module_ready', base: MODULE_BASE.toString(), size: MODULE_SIZE });
}

// Сканируем только исполняемые диапазоны модуля: в его адресном пространстве
// есть немапленные страницы, и скан «всё подряд» падает с access violation.
function _code_ranges() {
    const out = [];
    const end = MODULE_BASE.add(MODULE_SIZE);
    for (const r of Process.enumerateRanges('r-x')) {
        if (r.base.compare(MODULE_BASE) >= 0 && r.base.compare(end) < 0) out.push(r);
    }
    return out;
}

function _resolve(sig, fallback) {
    try {
        for (const r of _code_ranges()) {
            const hits = Memory.scanSync(r.base, r.size, sig);
            if (hits.length === 1) return hits[0].address;
            if (hits.length > 1) {
                _err('scan', 'сигнатура не уникальна (' + hits.length + ' совпадений), беру RVA');
                break;
            }
        }
    } catch (e) {
        _err('scan', e);
    }
    return MODULE_BASE.add(fallback);
}

function _resolve_all() {
    for (const name of Object.keys(B.signatures)) {
        FUNCS[name] = _resolve(B.signatures[name], B.fallback[name]);
        send({ type: 'aob', fn: name, at: FUNCS[name].toString(),
               offset: '0x' + FUNCS[name].sub(MODULE_BASE).toString(16) });
    }
}

// У protobuf-парсеров общий пролог, поэтому AOB-сигнатура не уникальна:
// адрес берётся по RVA, но перед хуком сверяется пролог — после апдейта игры
// лучше не хукнуть постороннюю функцию, а честно сказать об этом.
function _by_rva(entry) {
    const want = entry.prologue.split(' ').slice(0, 8);
    let last = null;
    // Сразу после старта игры страницы кода могут быть ещё не готовы: пролог
    // сверяется с несколькими попытками, иначе хук молча не встанет.
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const at = MODULE_BASE.add(entry.rva);
            const head = new Uint8Array(at.readByteArray(want.length));
            let ok = true;
            for (let i = 0; i < want.length; i++) {
                if (head[i] !== parseInt(want[i], 16)) { ok = false; break; }
            }
            if (ok) return at;
            last = 'байты не совпали с прологом';
        } catch (e) {
            last = String(e);
        }
        try { Thread.sleep(0.5); } catch (_) {}
    }
    _err('rva', 'RVA 0x' + entry.rva.toString(16) + ' не подтверждён: ' + last);
    return null;
}

// ------------------------------------------------------------
// reset: макет подземелья -> все объекты в одну точку
// ------------------------------------------------------------
function _isDungeon(ptr) {
    try { return ptr.readPointer().equals(MODULE_BASE.add(D.vtable)); } catch (e) { return false; }
}

// Таблица указателей repeated-поля начинается с rep + pointerSize: rep+0 —
// служебное слово. Проверено живьём на ответе соперника: элемент i лежит по
// rep + 8 + i*8, поэтому прежнее чтение с rep+0 отдавало мусор первым и
// теряло последнюю ловушку.
const REPEATED_FIRST_PTR = Process.pointerSize;

function _obstacles(dungeon) {
    const count = dungeon.add(D.obstacles.count).readS32();
    if (count < 0 || count > D.obstacles.max) return null;
    if (count === 0) return [];
    const rep = dungeon.add(D.obstacles.rep).readPointer();
    if (rep.isNull()) return null;
    const out = [];
    for (let i = 0; i < count; i++) {
        const o = rep.add(REPEATED_FIRST_PTR + i * Process.pointerSize).readPointer();
        if (!o.isNull()) out.push(o);
    }
    return out;
}

// FNV-1a 32 по (slot, type, x, y) каждой ловушки: подпись раскладки.
// Одна и та же расстановка -> одна и та же подпись; реплей сверяется по ней,
// потому что f5 (Dungeon.f5) общий у разных баз и сам по себе базу не
// различает.
function fingerprint(traps) {
    let h = 0x811c9dc5;
    for (const t of traps) {
        for (const value of [t.slot, t.type, t.x, t.y]) {
            const v = value | 0;
            for (let i = 0; i < 4; i++) {
                h ^= (v >>> (i * 8)) & 0xff;
                h = Math.imul(h, 0x01000193) >>> 0;
            }
        }
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

// Раскладка базы: seed (f5), mode, ловушки и их подпись. Только чтение.
function layoutOf(dungeon) {
    const out = { seed: null, mode: null, f4: null, traps: [], layout: null };
    if (!dungeon || dungeon.isNull()) return out;
    try { out.seed = dungeon.add(D.header.seed).readS32(); } catch (e) {}
    try { out.mode = dungeon.add(D.header.mode).readS32(); } catch (e) {}
    try { out.f4 = dungeon.add(D.header.f4).readS32(); } catch (e) {}
    const list = _obstacles(dungeon) || [];
    for (const o of list) {
        try {
            out.traps.push({
                slot: o.add(D.obstacles.slot).readS32(),
                type: o.add(D.obstacles.type).readS32(),
                x: o.add(D.obstacles.x).readS32(),
                y: o.add(D.obstacles.y).readS32(),
            });
        } catch (e) {}
    }
    out.layout = fingerprint(out.traps);
    return out;
}

function _moveObjects(dungeon, where) {
    if (dungeon === null || dungeon.isNull() || !_isDungeon(dungeon)) return 0;
    let list;
    try { list = _obstacles(dungeon); } catch (e) { _err('reset', e); return 0; }
    if (list === null) { _err('reset', 'список объектов не разобран (' + where + ')'); return 0; }
    let moved = 0;
    let skipped = 0;
    const samples = [];
    for (const o of list) {
        try {
            const range = Process.findRangeByAddress(o);
            if (!range || range.protection.indexOf('r') < 0) { skipped++; continue; }
            const type = o.add(D.obstacles.type).readS32();
            const slot = o.add(D.obstacles.slot).readS32();
            // Предохранитель: пишем только в то, что похоже на Dungeon_Obstacle,
            // иначе смещения после апдейта испортят постороннюю память.
            if (type < 1 || type > 255 || slot < 0 || slot > D.obstacles.max) { skipped++; continue; }
            if (samples.length < 8) {
                samples.push({ slot: slot, type: type,
                    x: o.add(D.obstacles.x).readS32(), y: o.add(D.obstacles.y).readS32() });
            }
            o.add(D.obstacles.x).writeS32(RESET_X);
            o.add(D.obstacles.y).writeS32(RESET_Y);
            moved++;
        } catch (e) { _err('reset', 'объект: ' + e); }
    }
    if (!moved) return 0;
    RESET_OBJECTS += moved;
    RESET_EVENTS++;
    RESET_LAST = { where: where, count: moved, x: RESET_X, y: RESET_Y, size: list.length,
                   skipped: skipped, samples: samples };
    send({ type: 'reset', where: where, count: moved, total: RESET_OBJECTS,
           x: RESET_X, y: RESET_Y, size: list.length, skipped: skipped, samples: samples });
    return moved;
}

// Краткая сводка по макету — для диагностики и для лога reset.
// Раскладка копируется в обычный объект сразу при разборе. Указатель на Dungeon
// после обработки ответа клиент освобождает — читать по нему позже нельзя
// (vtable уже не тот), а копия живёт сколько нужно.
function _describe(dungeon) {
    try {
        return layoutOf(dungeon);
    } catch (e) { return { error: String(e) }; }
}


// ------------------------------------------------------------
// protobuf (только то, что нужно для дельты)
// ------------------------------------------------------------
function readVarint(buf, off) {
    let v = 0, shift = 0, start = off;
    while (off < buf.length) {
        const b = buf[off++];
        v += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if ((b & 0x80) === 0) return { v, off, start, len: off - start };
    }
    throw new Error('varint: выход за границу буфера');
}

function fields(buf, off, end) {
    const out = [];
    while (off < end) {
        const k = readVarint(buf, off); off = k.off;
        const f = Math.floor(k.v / 8), w = k.v % 8;
        if (w === 0) {
            const v = readVarint(buf, off); off = v.off;
            out.push({ f: f, w: w, value: v.v, voff: v.start, vlen: v.len });
        } else if (w === 2) {
            const ln = readVarint(buf, off); off = ln.off;
            const stop = off + ln.v;
            if (stop > end) throw new Error('вложенное сообщение за границей');
            out.push({ f: f, w: w, len: ln.v, bodyOff: off, bodyEnd: stop });
            off = stop;
        } else {
            throw new Error('неизвестный wire-type ' + w);
        }
    }
    return out;
}

function writeVarintSameLen(buf, off, len, value) {
    const max = Math.pow(2, 7 * len) - 1;
    if (value < 0 || value > max) {
        throw new Error('значение ' + value + ' не влезает в ' + len + ' байт');
    }
    for (let i = 0; i < len; i++) {
        const b = value % 128;
        value = Math.floor(value / 128);
        buf[off + i] = (i === len - 1) ? b : (b | 0x80);
    }
}

// Дельта — маленькое подсообщение {f1: слот, f2: x, f3: y, [f4..f6]}.
function findDelta(buf) {
    const top = fields(buf, 0, buf.length);
    for (let i = 0; i < top.length; i++) {
        const f = top[i];
        if (f.w !== 2 || f.len < 4 || f.len > 40) continue;
        let inner;
        try { inner = fields(buf, f.bodyOff, f.bodyEnd); } catch (e) { continue; }
        if (inner.length < 2 || inner.length > 6) continue;
        if (!inner.every(function (x) { return x.w === 0; })) continue;
        if (inner[0].f !== 1 || inner[1].f !== 2) continue;
        if (inner[0].value > 63 || inner[1].value > 4096) continue;
        return inner;
    }
    return null;
}

// ------------------------------------------------------------
// Уход с уровня: клиент отправляет результат забега. С этого момента «какая
// база загружена» снова неизвестно — до следующего loadDungeon.
function _noteLevelExit(msg) {
    try {
        if (!msg.readPointer().equals(MODULE_BASE.add(B.vtable.REQUEST))) return;
        const single = msg.add(B.request_wrapper.SINGLEPLAYER_RESULT).readPointer();
        const multi = msg.add(B.request_wrapper.MULTIPLAYER_RESULT).readPointer();
        if (single.isNull() && multi.isNull()) return;
        if (CURRENT.source !== 'load') return;
        CURRENT = {
            source: 'none',
            reason: single.isNull() ? 'level_finished_mp' : 'level_finished_sp',
        };
        send({ type: 'level_left', reason: CURRENT.reason });
    } catch (e) {
        // Хук висит на пути сериализации: падать здесь нельзя, только молча
        // пропустить. Диагностика — через статус модуля.
    }
}

function _onSerialize(msg, buf, size) {
    _noteLevelExit(msg);
    if (!ENABLED || (!OFFSET_X && !OFFSET_Y)) return;
    if (size <= 0 || size > 0x10000) return;
    try {
        if (!msg.readPointer().equals(MODULE_BASE.add(B.vtable.REQUEST))) return;
        if (msg.add(B.request_wrapper.FIELD30_DELTA).readPointer().isNull()) return;
    } catch (e) { return; }

    let bytes;
    try { bytes = new Uint8Array(buf.readByteArray(size)); } catch (e) { return; }

    let inner;
    try { inner = findDelta(bytes); } catch (e) { _err('parse', e); return; }
    if (!inner) return;

    const slot = inner[0].value;
    const x = inner[1];
    const y = inner.length > 2 ? inner[2] : null;
    const before = { slot: slot, x: x.value, y: y ? y.value : null };
    try {
        if (OFFSET_X) writeVarintSameLen(bytes, x.voff, x.vlen, x.value + OFFSET_X);
        if (OFFSET_Y && y) writeVarintSameLen(bytes, y.voff, y.vlen, y.value + OFFSET_Y);
    } catch (e) {
        _err('patch', e);
        return;
    }
    try {
        buf.writeByteArray(bytes.buffer);
        PATCH_COUNT++;
        send({
            type: 'patched',
            count: PATCH_COUNT,
            before: before,
            after: { slot: slot, x: before.x + OFFSET_X,
                     y: before.y === null ? null : before.y + OFFSET_Y },
            offset: { x: OFFSET_X, y: OFFSET_Y },
            size: size,
        });
    } catch (e) {
        _err('write', e);
    }
}

// ------------------------------------------------------------
rpc.exports = {
    moduleBase: function () {
        return MODULE_BASE ? MODULE_BASE.toString() : null;
    },
    installHooks: function () {
        if (!MODULE_BASE) return false;
        _resolve_all();
        if (LISTENERS.length) return true;
        const ser = FUNCS.SERIALIZE_TO_ARRAY;
        const listener = Interceptor.attach(ser, {
            onEnter: function (args) {
                this.msg = args[0];
                this.buf = args[1];
                this.size = args[2].toInt32();
            },
            onLeave: function () {
                _onSerialize(this.msg, this.buf, this.size);
            },
        });
        LISTENERS.push(listener);
        send({ type: 'hooked', at: ser.toString() });

        // Макет подземелья: объекты сжимаются сразу на разборе (когда режим
        // вооружён), а последний разобранный Dungeon запоминается, чтобы
        // команда reset сработала и без перезахода в базу.
        const layout = _by_rva(D.parser);
        if (layout) {
            LISTENERS.push(Interceptor.attach(layout, {
                onEnter: function (args) { this.self = args[0]; },
                onLeave: function () {
                    try {
                        if (!_isDungeon(this.self)) return;
                        LAST_DUNGEON = this.self;
                        PARSE_EVENTS++;
                        PARSE_LAST = _describe(this.self);
                        if (TRACE) {
                            send({ type: 'parse', where: 'layout', count: PARSE_EVENTS,
                                   dungeon: PARSE_LAST });
                        }
                        if (RESET_ARMED) _moveObjects(this.self, 'layout');
                    } catch (e) { _err('reset', e); }
                },
            }));
            DUNGEON_HOOKED = true;
            send({ type: 'hooked', at: 'dungeon ' + layout.toString() });
        }

        // Загрузка уровня. Читаем Dungeon прямо в onEnter: объект жив (его только
        // что передали в loadDungeon), а позже клиент его освобождает.
        const load = _by_rva(D.load_dungeon);
        if (load) {
            LISTENERS.push(Interceptor.attach(load, {
                onEnter: function (args) {
                    try {
                        const dungeon = args[1];
                        if (!dungeon || dungeon.isNull()) return;
                        if (!_isDungeon(dungeon)) return;
                        const layout2 = layoutOf(dungeon);
                        LOAD_EVENTS++;
                        CURRENT = {
                            source: 'load',
                            reason: null,
                            dungeon: layout2,
                            at: Date.now(),
                        };
                        send({ type: 'level_loaded', count: LOAD_EVENTS,
                               seed: layout2.seed, layout: layout2.layout,
                               traps: layout2.traps.length });
                    } catch (e) { _err('loadDungeon', e); }
                },
            }));
            LEVEL_HOOKED = true;
            send({ type: 'hooked', at: 'loadDungeon ' + load.toString() });
        }
        return true;
    },
    unhookAll: function () {
        for (const l of LISTENERS) {
            try { l.detach(); } catch (e) {}
        }
        LISTENERS = [];
        ENABLED = false;
        RESET_ARMED = false;
        DUNGEON_HOOKED = false;
        LEVEL_HOOKED = false;
        LAST_DUNGEON = null;
        PARSE_LAST = null;
        CURRENT = { source: 'none', reason: 'hooks_removed' };
        return true;
    },
    setCells: function (cells, dir) {
        const n = Number(cells);
        const step = Math.round(n * CELL_PX);
        const d = String(dir);
        OFFSET_X = 0;
        OFFSET_Y = 0;
        if (d === 'left') OFFSET_X = -step;
        else if (d === 'right') OFFSET_X = step;
        else if (d === 'up') OFFSET_Y = step;
        else if (d === 'down') OFFSET_Y = -step;
        else throw new Error('dir: left/right/up/down');
        ENABLED = (OFFSET_X !== 0 || OFFSET_Y !== 0);
        return { cells: n, cellPx: CELL_PX, dir: d,
                 offset: { x: OFFSET_X, y: OFFSET_Y }, enabled: ENABLED };
    },
    setPixels: function (dx, dy) {
        OFFSET_X = Math.round(Number(dx));
        OFFSET_Y = Math.round(Number(dy));
        ENABLED = (OFFSET_X !== 0 || OFFSET_Y !== 0);
        return { offset: { x: OFFSET_X, y: OFFSET_Y }, enabled: ENABLED };
    },
    enable: function (on) {
        ENABLED = !!on;
        return ENABLED;
    },
    // Включает режим и сразу правит уже разобранный макет (если он есть).
    reset: function (x, y) {
        RESET_X = Math.round(Number(x));
        RESET_Y = Math.round(Number(y));
        RESET_ARMED = true;
        let appliedNow = 0;
        try { appliedNow = _moveObjects(LAST_DUNGEON, 'loaded'); } catch (e) { _err('reset', e); }
        return { armed: true, point: { x: RESET_X, y: RESET_Y }, objects: RESET_OBJECTS,
                 appliedNow: appliedNow };
    },
    trace: function (on) {
        TRACE = !!on;
        return TRACE;
    },
    resetOff: function () {
        RESET_ARMED = false;
        return { armed: false, objects: RESET_OBJECTS, events: RESET_EVENTS };
    },
    // Раскладка последнего разобранного Dungeon: id базы (seed), подпись
    // раскладки и список ловушек. Нужна записи реплея и сверке при play.
    dungeonSnapshot: function () {
        if (CURRENT.source !== 'load' || !CURRENT.dungeon) {
            return { ok: false, reason: CURRENT.reason || 'no_level_loaded',
                     source: CURRENT.source, loads: LOAD_EVENTS, parses: PARSE_EVENTS };
        }
        const d = CURRENT.dungeon;
        return { ok: true, source: 'load', seed: d.seed, mode: d.mode, f4: d.f4,
                 layout: d.layout, traps: d.traps, loads: LOAD_EVENTS,
                 parses: PARSE_EVENTS };
    },
    status: function () {
        return {
            enabled: ENABLED,
            offset: { x: OFFSET_X, y: OFFSET_Y },
            cellPx: CELL_PX,
            arena: { width: B.grid.WIDTH, height: B.grid.HEIGHT },
            patches: PATCH_COUNT,
            hooked: LISTENERS.length > 0,
            reset: { armed: RESET_ARMED, hooked: DUNGEON_HOOKED,
                     point: { x: RESET_X, y: RESET_Y },
                     objects: RESET_OBJECTS, events: RESET_EVENTS, last: RESET_LAST },
            parses: { layout: PARSE_EVENTS, last: PARSE_LAST },
            level: {
                hooked: LEVEL_HOOKED,
                loads: LOAD_EVENTS,
                current: CURRENT.source === 'load'
                    ? { seed: CURRENT.dungeon.seed, layout: CURRENT.dungeon.layout,
                        traps: CURRENT.dungeon.traps.length, at: CURRENT.at }
                    : { source: CURRENT.source, reason: CURRENT.reason },
            },
        };
    },
};

try {
    _init();
} catch (e) {
    _err('init', e);
}
