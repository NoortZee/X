// Mystic Realm: автозбор колб. Телепортирует реагенты к герою на каждом кадре
// обновления режима — та же механика, что у Candy в catacombs: пишем stored x/y
// в тело и вызываем destroy/rebuild, затем проверяем обратное чтение.
//
// Состояние режима приходит первым аргументом MysticRealmPlayState::update,
// поэтому хук ставится на этот метод (RVA + проверка пролога).
// Раскладка: memory/offsets.js -> MEMORY_LAYOUT.mystic.
'use strict';

const M = MEMORY_LAYOUT.mystic;
const MODULE_NAME = MEMORY_LAYOUT.module_name;

let MODULE = null;
let MODULE_BASE = null;
let HOOK = null;
let ENABLED = false;
let ERROR = null;
let MOVED = 0;
let ATTEMPTS = 0;
let SKIPPED = 0;
let LAST = null;
let NEXT_AT = 0;
let LEVEL = null;
let SEEN = new Set();
let TIMER_TARGET = null;     // если задан — оставшееся время подрезается до него
let REBUILD = null;          // один NativeFunction на весь сеанс: создание дорогое
let REAGENT_VTABLE = null;   // фильтр по vptr вместо чтения имени у каждого объекта
let LAST_TIMER = null;       // последнее прочитанное оставшееся время
let TICKS = 0;
let TICK_MAX_MS = 0;
let TICK_TOTAL_MS = 0;
let MOVE_MAX_MS = 0;
const EVENTS = [];

function event(kind, payload) {
    EVENTS.push(Object.assign({ time: Date.now(), kind: kind }, payload || {}));
    while (EVENTS.length > M.limits.events) EVENTS.shift();
}

function safe(fn) {
    try { return fn(); } catch (e) { return { error: String(e) }; }
}

function readable(p) {
    const r = Process.findRangeByAddress(p);
    return !!(r && r.protection.indexOf('r') >= 0);
}

function writableFloat(p) {
    const r = Process.findRangeByAddress(p);
    if (!r || r.protection.indexOf('w') < 0 ||
        Number(r.base.add(r.size).sub(p).toString()) < 4)
        throw new Error('поле координаты не записываемо');
}

function num(p, off) {
    const v = p.add(off).readFloat();
    if (!Number.isFinite(v)) throw new Error('не число по +0x' + off.toString(16));
    return v;
}

function rtti(p) {
    try {
        if (!p || p.isNull() || !readable(p)) return null;
        const vp = p.readPointer();
        if (vp.isNull() || !readable(vp.add(-8))) return null;
        const ti = vp.add(-8).readPointer();
        if (ti.isNull()) return null;
        const name = ti.add(8).readPointer().readUtf8String();
        return name ? name.slice(0, 60) : null;
    } catch (e) { return null; }
}

function requireClass(p, name) {
    const got = rtti(p);
    if (got !== name) throw new Error('ожидался класс ' + name + ', получен ' + got);
}

// Функция по RVA: сверяем пролог, но принимаем и трамплин, если по этому
// адресу уже стоит чей-то хук (наш прошлый сеанс или второй агент) — иначе
// установка молча падала бы, и режим просто ничего не делал.
function byRva(entry) {
    const want = entry.prologue.split(' ');
    let last = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const at = MODULE_BASE.add(entry.rva);
            const head = new Uint8Array(at.readByteArray(want.length));
            if (want.every(function (b, i) { return head[i] === parseInt(b, 16); })) return at;
            // E9 rel32 = jmp, FF 25 = jmp [rip+x], E8 = call-хук: функция уже перехвачена.
            if (head[0] === 0xe9 || head[0] === 0xe8 || (head[0] === 0xff && head[1] === 0x25)) {
                event('rva_already_hooked', { rva: entry.rva, head: head[0].toString(16) });
                return at;
            }
            last = 'байты не совпали ни с прологом, ни с трамплином';
        } catch (e) { last = String(e); }
        Thread.sleep(0.5);
    }
    throw new Error('RVA 0x' + entry.rva.toString(16) + ' не подтверждён: ' + last);
}

function float32Spacing(value) {
    const n = Math.abs(value);
    return n === 0 ? Math.pow(2, -149) : Math.pow(2, Math.max(-149, Math.floor(Math.log2(n)) - 23));
}

function physicsCheck(target, readback) {
    const T = M.teleport, S = M.physics_position.scale;
    const out = { error: {}, tolerance: {} };
    for (const axis of ['x', 'y']) {
        if (!Number.isFinite(target[axis]) || !Number.isFinite(readback[axis]))
            throw new Error('нечисловое обратное чтение');
        out.tolerance[axis] = T.tolerance + 2 * float32Spacing(target[axis] / S) * S +
            float32Spacing(target[axis]);
        out.error[axis] = Math.abs(readback[axis] - target[axis]);
    }
    out.matches = out.error.x <= out.tolerance.x && out.error.y <= out.tolerance.y;
    return out;
}

// Одна колба: тело -> физика -> world -> запись stored x/y -> destroy/rebuild.
function teleportReagent(object, target) {
    const body = object.add(M.object.body).readPointer();
    requireClass(body, M.body_class);
    const physics = body.add(M.body.physics).readPointer();
    if (physics.isNull()) throw new Error('нет физики у тела');
    if (physics.add(M.body.owner).readPointer().toString() !== body.toString())
        throw new Error('физика принадлежит другому телу');
    const world = physics.add(M.physics_world.world).readPointer();
    if (world.isNull()) throw new Error('нет physics world');
    if (world.add(M.physics_world.lock).readU8() & M.physics_world.lock_mask)
        throw new Error('physics world заблокирован');
    const x = body.add(M.body.stored_x), y = body.add(M.body.stored_y);
    writableFloat(x); writableFloat(y);
    const before = { x: num(body, M.body.stored_x), y: num(body, M.body.stored_y) };
    const objectPos = { x: num(object, M.object.x), y: num(object, M.object.y) };
    const drift = Math.hypot(before.x - objectPos.x, before.y - objectPos.y);
    if (drift > M.teleport.tolerance)
        throw new Error('stored position расходится с объектом на ' + drift.toFixed(3));
    x.writeFloat(target.x);
    y.writeFloat(target.y);
    REBUILD(body);
    const after = body.add(M.body.physics).readPointer();
    if (after.isNull()) throw new Error('после rebuild нет тела физики');
    const readback = {
        x: num(after, M.physics_position.x) * M.physics_position.scale,
        y: num(after, M.physics_position.y) * M.physics_position.scale,
    };
    const check = physicsCheck(target, readback);
    return { body: body.toString(), before: before, after: readback, check: check };
}

// Оставшееся время забега: подрезаем только вниз, чтобы таймер не «оживал».
function clampTimer(state) {
    if (TIMER_TARGET === null) return null;
    const field = state.add(M.state.timer);
    const left = field.readFloat();
    if (!Number.isFinite(left)) return null;
    if (left > TIMER_TARGET) field.writeFloat(TIMER_TARGET);
    return left;
}

function tick(state) {
    if (!ENABLED) {
        // Таймер работает и без автозбора: `mystic timer 5` не требует `mystic`.
        if (TIMER_TARGET !== null) {
            try {
                const left = clampTimer(state);
                if (left !== null) LAST_TIMER = left;
            } catch (e) { ERROR = String(e); }
        }
        return;
    }
    const startedAt = Date.now();
    try {
        const left = clampTimer(state);
        if (left !== null) LAST_TIMER = left;
        if (startedAt < NEXT_AT) return;
        requireClass(state, M.state_class);
        if (state.add(M.state.paused).readU8() !== 0) return;
        const now = startedAt;
        if (LEVEL !== state.toString()) {
            LEVEL = state.toString();
            SEEN = new Set();
            NEXT_AT = now + M.teleport.delay_ms;
            event('level_armed', { state: LEVEL, due: NEXT_AT });
        }
        if (now < NEXT_AT) return;
        const world = state.add(M.state.world).readPointer();
        const hero = world.add(M.world.hero).readPointer();
        requireClass(hero, M.hero_class);
        const heroBody = hero.add(M.object.body).readPointer();
        const direction = heroBody.add(M.hero_body.direction).readS32();
        if (direction !== 1 && direction !== -1) throw new Error('непонятное направление героя: ' + direction);
        const target = {
            x: num(hero, M.object.x) + direction * M.teleport.ahead,
            y: num(hero, M.object.y),
        };
        const array = state.add(M.state.objects).readPointer();
        const count = array.add(M.array.count).readS32();
        const data = array.add(M.array.data).readPointer();
        if (count < 0 || count > M.limits.slots || data.isNull()) throw new Error('битый список объектов: ' + count);
        let checkedClass = false;
        let batchDone = 0;
        for (let i = 0; i < count; i++) {
            const object = data.add(i * Process.pointerSize).readPointer();
            if (object.isNull()) continue;
            // Сравнение vptr на порядок дешевле чтения имени класса у 270 объектов.
            if (!object.readPointer().equals(REAGENT_VTABLE)) continue;
            if (!checkedClass) { requireClass(object, M.reagent_class); checkedClass = true; }
            const body = object.add(M.object.body).readPointer();
            const key = object.toString() + ':' + body.toString();
            if (SEEN.has(key)) continue;
            SEEN.add(key);
            const close = Math.hypot(num(object, M.object.x) - target.x, num(object, M.object.y) - target.y);
            if (close < M.teleport.close_px) continue;
            ATTEMPTS++;
            const moveStarted = Date.now();
            try {
                const result = teleportReagent(object, target);
                MOVE_MAX_MS = Math.max(MOVE_MAX_MS, Date.now() - moveStarted);
                MOVED++;
                LAST = { time: Date.now(), object: object.toString(), rarity: safe(function () {
                    return object.add(M.object.rarity).readS32(); }), target: target,
                    after: result.after, check: result.check, success: true };
                event('teleported', { object: LAST.object, rarity: LAST.rarity, matches: result.check.matches });
            } catch (e) {
                SKIPPED++;
                LAST = { time: Date.now(), object: object.toString(), error: String(e), success: false };
                event('teleport_error', { object: LAST.object, error: LAST.error });
            }
            if (++batchDone >= M.teleport.batch) break;
        }
        NEXT_AT = now + M.teleport.interval_ms;
    } catch (e) {
        ERROR = String(e);
        event('tick_error', { error: ERROR });
    } finally {
        const spent = Date.now() - startedAt;
        if (spent > 0) {
            TICKS++;
            TICK_TOTAL_MS += spent;
            TICK_MAX_MS = Math.max(TICK_MAX_MS, spent);
        }
    }
}

function status() {
    return {
        enabled: ENABLED,
        error: ERROR,
        level: LEVEL,
        moved: MOVED,
        attempts: ATTEMPTS,
        skipped: SKIPPED,
        seen: SEEN.size,
        last: LAST,
        events: EVENTS.slice(-5),
        hooked: HOOK !== null,
        timer: { target: TIMER_TARGET, left: LAST_TIMER },
        timing: { ticks: TICKS, avg_ms: TICKS ? Math.round(TICK_TOTAL_MS / TICKS) : 0,
                  max_ms: TICK_MAX_MS, move_max_ms: MOVE_MAX_MS },
        profile: 'Mystic Realm 2.84.2 x86_64',
    };
}

function install() {
    if (HOOK) return status();
    ERROR = null;
    const m = Process.findModuleByName(MODULE_NAME);
    if (!m) throw new Error(MODULE_NAME + ' не загружен');
    MODULE = m;
    MODULE_BASE = m.base;
    REAGENT_VTABLE = m.base.add(M.reagent_vtable);
    REBUILD = new NativeFunction(m.base.add(M.destroy), 'void', ['pointer']);
    const update = byRva(M.update);
    HOOK = Interceptor.attach(update, {
        onEnter: function (args) { this.state = args[0]; },
        onLeave: function () { tick(this.state); },
    });
    send({ type: 'hooked', at: update.toString() });
    return status();
}

rpc.exports = {
    start: function () {
        install();  // повторная попытка, если прошлая установка не удалась
        ENABLED = true;
        ERROR = null;
        LEVEL = null;
        SEEN = new Set();
        NEXT_AT = Date.now() + M.teleport.delay_ms;
        event('started', {});
        return status();
    },
    stop: function () {
        ENABLED = false;
        if (HOOK) { try { HOOK.detach(); } catch (e) {} HOOK = null; }
        return status();
    },
    status: status,
    // Подрезать оставшееся время забега до N секунд (0 — снять ограничение).
    // Вместе с таймером включается и автозбор: короткий забег имеет смысл только
    // если колбы успевают собраться.
    setTimer: function (seconds) {
        install();  // без хука таймеру нечего подрезать
        const n = Number(seconds);
        TIMER_TARGET = (n > 0 && Number.isFinite(n)) ? n : null;
        if (TIMER_TARGET !== null && !ENABLED) {
            ENABLED = true;
            ERROR = null;
            LEVEL = null;
            SEEN = new Set();
            NEXT_AT = Date.now();
            event('started_by_timer', { target: TIMER_TARGET });
        }
        return { target: TIMER_TARGET, left: LAST_TIMER, enabled: ENABLED };
    },
    // Диагностика: что сейчас в уровне, без изменений.
    probe: function () {
        return safe(function () {
            return { hooked: HOOK !== null, level: LEVEL, enabled: ENABLED };
        });
    },
};

try {
    install();
} catch (e) {
    ERROR = String(e);
    send({ type: 'error', msg: ERROR });
}
