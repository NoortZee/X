// Bounded diagnostics with an explicit single-object position experiment. All candidate offsets are in memory/offsets.js.
'use strict';
const C = MEMORY_LAYOUT.catacombs;
let hook = null, enabled = false, error = null, moduleInfo = null;
let calls = 0, samples = 0, skipped = 0, lastTime = null, latest = null;
let history = [], events = [], previous = new Map(), previousState = null;
let resolution = null;
let methodCode = new Map();
let pendingMove = null, lastMove = null, movesExecuted = 0;
function event(kind, data) {
    events.push({ time: Date.now(), kind, ...data });
    if (events.length > C.limits.events) events.shift();
}
function safe(fn) {
    try { return fn(); } catch (e) { return { error: String(e) }; }
}
function address(p) {
    const out = { address: p.toString() };
    const m = Process.findModuleByAddress(p);
    if (m) { out.module = m.name; out.rva = p.sub(m.base).toString(); }
    return out;
}
function nameAt(p) {
    let s = '';
    for (let i = 0; i < C.limits.name_bytes; i++) {
        const b = p.add(i).readU8();
        if (!b) return s;
        if (b < 32 || b > 126) throw new Error('invalid RTTI character');
        s += String.fromCharCode(b);
    }
    throw new Error('unterminated RTTI name');
}
function identity(p) {
    const out = { address: p.toString(), null: p.isNull() };
    if (out.null) return out;
    out.rtti = safe(() => {
        const vp = p.add(C.rtti.vptr).readPointer();
        const ti = vp.add(C.rtti.typeinfo).readPointer();
        return { vptr: address(vp), typeinfo: address(ti), name: nameAt(ti.add(C.rtti.name).readPointer()) };
    });
    return out;
}
function numberAt(p, off) {
    const n = p.add(off).readFloat();
    if (!Number.isFinite(n)) throw new Error('non-finite float at +' + off.toString(16));
    return n;
}
function position(p) { return safe(() => ({ x: numberAt(p, C.object.x), y: numberAt(p, C.object.y) })); }
function link(p, offset) { return safe(() => identity(p.add(offset).readPointer())); }
function methods(p) {
    return safe(() => {
        const vp = p.readPointer();
        return Array.from({ length: C.limits.methods }, (_, i) =>
            safe(() => ({ slot: i, target: address(vp.add(i * Process.pointerSize).readPointer()) })));
    });
}
function captureMethodCode(target) {
    const key = target.toString();
    if (methodCode.has(key)) return key;
    if (methodCode.size >= C.method_probe.targets) return null;
    const record = { target: safe(() => address(target)), instructions: [],
        function_boundary_verified: false, complete_function: false };
    methodCode.set(key, record);
    try {
        const range = Process.findRangeByAddress(target);
        const m = Process.findModuleByAddress(target);
        if (!m || m.name !== MEMORY_LAYOUT.module_name || !range ||
            !range.protection.includes('r') || !range.protection.includes('x'))
            throw new Error('target not in readable executable game module');
        const available = Number(range.base.add(range.size).sub(target).toString());
        const moduleAvailable = Number(m.base.add(m.size).sub(target).toString());
        const length = Math.min(C.method_probe.bytes, available, moduleAvailable);
        if (!Number.isSafeInteger(length) || length <= 0) throw new Error('invalid code window');
        record.window_bytes = length;
        record.hex = Array.from(new Uint8Array(target.readByteArray(length)))
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        let offset = 0;
        while (offset < length && record.instructions.length < C.method_probe.instructions) {
            const ins = Instruction.parse(target.add(offset));
            if (ins.size <= 0 || ins.size > length - offset) break;
            record.instructions.push({ address: address(target.add(offset)), size: ins.size,
                mnemonic: ins.mnemonic, operands: ins.opStr });
            offset += ins.size;
        }
        // Retain a fixed window, not a guessed function body; branch targets may be outside it.
    } catch (e) { record.error = String(e); }
    return key;
}
function methodProbe(object, offsets) {
    return safe(() => {
        if (object.isNull()) return { null: true };
        const vptr = object.readPointer();
        const targets = {};
        for (const [role, offset] of Object.entries(offsets)) {
            targets[role] = safe(() => {
                const pointer = vptr.add(offset).readPointer();
                return { vptr_byte_offset: offset, target: address(pointer),
                    code_key: captureMethodCode(pointer), role_is_candidate: true };
            });
        }
        return targets;
    });
}
function candySnapshot(p, id) {
    return { ...id, position: position(p),
        rarity_raw: safe(() => p.add(C.candy.rarity).readS32()),
        flag_a: safe(() => p.add(C.object.flag_a).readU8()),
        flag_b: safe(() => p.add(C.object.flag_b).readU8()),
        body: link(p, C.object.body), image: link(p, C.object.image),
        virtual_targets: methods(p),
        position_method_candidates: methodProbe(p, C.method_probe.object_methods),
        body_method_candidates: safe(() => methodProbe(p.add(C.object.body).readPointer(), C.method_probe.body_methods)) };
}
function heroGraph(world) {
    return safe(() => {
        const hero = world.add(C.world.hero).readPointer();
        const graph = { hero: identity(hero) };
        if (hero.isNull()) return graph;
        graph.hero.position = position(hero);
        const body = hero.add(C.object.body).readPointer();
        graph.hero_body = identity(body);
        if (body.isNull()) return graph;
        const physics = body.add(C.hero_body.physics).readPointer();
        graph.physics = { address: physics.toString(), fields: {} };
        if (!physics.isNull()) {
            for (const key of ['XF_PX', 'XF_PY', 'VX', 'VY', 'SW_A', 'AV', 'GRAVITY'])
                graph.physics.fields[key] = safe(() => numberAt(physics, MEMORY_LAYOUT.tas.body[key]));
        }
        return graph;
    });
}
function scanObjects(state) {
    const array = state.add(C.state.objects).readPointer();
    const result = { array: identity(array), objects: [], candies: [], classes: {}, rarity_histogram: {}, complete: false };
    if (array.isNull()) throw new Error('null object array');
    const count = array.add(C.array.slots).readS32();
    result.declared_slots = count;
    if (count < 0 || count > C.limits.declared_slots) throw new Error('invalid declared slots: ' + count);
    const data = array.add(C.array.data).readPointer();
    result.data = data.toString();
    if (count && data.isNull()) throw new Error('null array data');
    result.scanned_slots = Math.min(count, C.limits.slots);
    result.truncated = count > C.limits.slots;
    for (let i = 0; i < result.scanned_slots; i++) {
        const item = safe(() => {
            const p = data.add(i * Process.pointerSize).readPointer();
            const id = identity(p);
            if (!p.isNull()) {
                const name = id.rtti.name || '<unresolved>';
                result.classes[name] = (result.classes[name] || 0) + 1;
                if (name === C.candy.name) {
                    const candy = candySnapshot(p, id);
                    result.candies.push(candy);
                    const rarity = typeof candy.rarity_raw === 'number' ? String(candy.rarity_raw) : '<error>';
                    result.rarity_histogram[rarity] = (result.rarity_histogram[rarity] || 0) + 1;
                }
            }
            return { slot: i, ...id, position_candidate: p.isNull() ? null : position(p) };
        });
        result.objects.push(item);
    }
    result.complete = !result.truncated && !result.objects.some(o => o.error || (o.rtti && o.rtti.error));
    return result;
}
function sample(state) {
    const now = Date.now();
    const key = state.toString();
    if (lastTime !== null && now - lastTime < C.limits.sample_ms) { skipped++; return; }
    lastTime = now;
    const snap = { time: now, state: identity(state),
        phase_raw: safe(() => state.add(C.state.phase).readS32()),
        paused_raw: safe(() => state.add(C.state.paused).readU8()),
        world: link(state, C.state.world),
        hero_graph: safe(() => heroGraph(state.add(C.state.world).readPointer())),
        object_graph: safe(() => scanObjects(state)) };
    // Object reads occur only inside the current update callback, never from report RPC.
    const graph = snap.object_graph;
    if (key !== previousState) { previous.clear(); event('state_observed', { state: snap.state }); previousState = key; }
    if (!graph.error) {
        const current = new Map(graph.candies.map(c => [c.address, JSON.stringify(c)]));
        for (const c of graph.candies) {
            if (previous.get(c.address) !== current.get(c.address))
                event(previous.has(c.address) ? 'candy_changed' : 'candy_observed', { candy: c });
        }
        if (graph.complete) {
            for (const p of previous.keys()) if (!current.has(p))
                event('candy_not_in_array', { address: p, interpretation: 'not proof of collection; may be unload or reuse' });
            previous = current;
        }
    }
    latest = snap; samples++;
    history.push({ time: now, state: snap.state, phase_raw: snap.phase_raw,
        hero_graph: snap.hero_graph, classes: graph.classes, rarity_histogram: graph.rarity_histogram,
        candies: graph.candies, error: graph.error, complete: graph.complete });
    if (history.length > C.limits.history) history.shift();
}
function requireClass(p, name) {
    const id = identity(p);
    if (!id.rtti || id.rtti.name !== name) throw new Error('unexpected class; expected ' + name);
}
function writableFloat(p) {
    const range = Process.findRangeByAddress(p);
    if (!range || !range.protection.includes('w') ||
        Number(range.base.add(range.size).sub(p).toString()) < 4)
        throw new Error('position field not writable');
}
function performMove(state) {
    if (!pendingMove) return;
    const request = pendingMove;
    pendingMove = null; // Exactly one attempt; never retry automatically.
    const result = { time: Date.now(), request_time: request.time, success: false,
        collection_confirmed: false, experiment: 'object coordinates only; Body sync unverified' };
    try {
        if (Date.now() - request.time > C.move_white.expiry_ms) throw new Error('request expired');
        if (state.toString() !== request.state) throw new Error('state changed');
        requireClass(state, C.move_white.state_name);
        if (state.add(C.state.phase).readS32() !== 1 || state.add(C.state.paused).readU8() !== 0)
            throw new Error('run is not active');
        const world = state.add(C.state.world).readPointer();
        const hero = world.add(C.world.hero).readPointer();
        requireClass(hero, C.move_white.hero_name);
        const body = hero.add(C.object.body).readPointer();
        requireClass(body, C.move_white.hero_body_name);
        const direction = body.add(C.move_white.direction).readS32();
        if (direction !== 1 && direction !== -1) throw new Error('invalid hero direction');
        const hx = numberAt(hero, C.object.x), hy = numberAt(hero, C.object.y);
        const target = { x: hx + direction * C.move_white.ahead, y: hy };
        const array = state.add(C.state.objects).readPointer();
        const count = array.add(C.array.slots).readS32();
        if (count < 0 || count > C.limits.slots) throw new Error('array invalid or too large for experiment');
        const data = array.add(C.array.data).readPointer();
        let selected = null, distance = Infinity;
        for (let i = 0; i < count; i++) {
            const candidate = data.add(i * Process.pointerSize).readPointer();
            if (candidate.isNull()) continue;
            const id = identity(candidate);
            if (!id.rtti || id.rtti.name !== C.candy.name) continue;
            if (candidate.add(C.candy.rarity).readS32() !== C.move_white.rarity) continue;
            const x = numberAt(candidate, C.object.x), y = numberAt(candidate, C.object.y);
            const d = Math.hypot(x - hx, y - hy);
            if (d < distance) { selected = candidate; distance = d; }
        }
        if (!selected) throw new Error('no common Candy in current array');
        const setter = selected.readPointer().add(C.method_probe.object_methods.position_set_candidate).readPointer();
        const m = Process.findModuleByAddress(setter);
        const range = Process.findRangeByAddress(setter);
        if (!m || m.name !== MEMORY_LAYOUT.module_name || !range || !range.protection.includes('x'))
            throw new Error('unexpected setter location');
        const bytes = new Uint8Array(setter.readByteArray(C.move_white.setter_bytes.length));
        if (!C.move_white.setter_bytes.every((b, i) => bytes[i] === b)) throw new Error('setter bytes changed');
        const xField = selected.add(C.object.x), yField = selected.add(C.object.y);
        writableFloat(xField); writableFloat(yField);
        const before = { x: numberAt(selected, C.object.x), y: numberAt(selected, C.object.y) };
        result.object = selected.toString(); result.before = before; result.target = target;
        // Reproduce only the verified two-float object setter; no unknown ABI/native call.
        try {
            xField.writeFloat(target.x);
            yField.writeFloat(target.y);
        } catch (e) {
            result.rollback = safe(() => { xField.writeFloat(before.x); yField.writeFloat(before.y); return true; });
            throw e;
        }
        result.readback = position(selected);
        result.success = true; movesExecuted++;
    } catch (e) { result.error = String(e); }
    lastMove = result; event('move_white_result', result);
}
function requestMove() {
    if (!enabled || !latest) throw new Error('start module and enter Catacombs first');
    if (pendingMove) throw new Error('move already queued');
    if (Date.now() - latest.time > C.move_white.expiry_ms) throw new Error('state snapshot stale');
    pendingMove = { time: Date.now(), state: latest.state.address };
    event('move_white_queued', pendingMove);
    return { queued: true, warning: 'One common object only; check HUD for actual collection.' };
}
function stop() { pendingMove = null; enabled = false; if (hook) hook.detach(); hook = null; }
function status() { return { enabled, error, calls, samples, skipped, resolution,
    move_pending: pendingMove, last_move: lastMove, moves_executed: movesExecuted, method_code_retained: methodCode.size, last_sample_time: latest ? latest.time : null, events_retained: events.length }; }
function install() {
    if (enabled) return status();
    error = null; calls = 0; samples = 0; skipped = 0; lastTime = null; latest = null;
    history = []; events = []; previous = new Map(); previousState = null; resolution = null; methodCode = new Map();
    pendingMove = null; lastMove = null; movesExecuted = 0;
    try {
        const m = Process.findModuleByName(MEMORY_LAYOUT.module_name);
        if (!m) throw new Error('game module not loaded');
        moduleInfo = { name: m.name, base: m.base.toString(), size: m.size };
        const matches = new Map();
        for (const r of m.enumerateRanges('r-x'))
            for (const match of Memory.scanSync(r.base, r.size, C.signature)) matches.set(match.address.toString(), match.address);
        if (matches.size !== 1) throw new Error('endless_update: expected 1 match, found ' + matches.size);
        const target = matches.values().next().value;
        resolution = address(target);
        hook = Interceptor.attach(target, { onEnter(args) {
            if (!enabled) return;
            calls++;
            this.updateState = args[0];
            try { sample(args[0]); } catch (e) { error = String(e); event('sample_error', { error }); }
        }, onLeave() {
            if (enabled && pendingMove) performMove(this.updateState);
        } });
        enabled = true; event('enabled', { diagnostic_only: true });
    } catch (e) { stop(); error = String(e); throw e; }
    return status();
}
rpc.exports = {
    install, status, moveWhite: requestMove, stop() { stop(); return status(); },
    mark(label) { event('user_mark', { label: String(label).slice(0, 160) }); return status(); },
    report() { return { schema_version: 2, diagnostic_only: movesExecuted === 0, experimental_position_moves: true, ...status(),
        metadata: { time: Date.now(), process_id: Process.id, arch: Process.arch,
            module: moduleInfo, candidate_profile: C.profile, offsets: C,
            warning: 'Candidate fields, not validated ownership or collection. No server verification inferred.' },
        method_code: Object.fromEntries(methodCode), latest, history: history.slice(), events: events.slice() }; },
};
