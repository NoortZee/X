// Read-only, bounded observation. All candidate offsets are in memory/offsets.js.
'use strict';
const C = MEMORY_LAYOUT.catacombs;
let hook = null, enabled = false, error = null, moduleInfo = null;
let calls = 0, samples = 0, skipped = 0, lastTime = null, latest = null;
let history = [], events = [], previous = new Map(), previousState = null;
let resolution = null;
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
function candySnapshot(p, id) {
    return { ...id, position: position(p),
        rarity_raw: safe(() => p.add(C.candy.rarity).readS32()),
        flag_a: safe(() => p.add(C.object.flag_a).readU8()),
        flag_b: safe(() => p.add(C.object.flag_b).readU8()),
        body: link(p, C.object.body), image: link(p, C.object.image),
        virtual_targets: methods(p) };
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
function stop() { enabled = false; if (hook) hook.detach(); hook = null; }
function status() { return { enabled, error, calls, samples, skipped, resolution,
    last_sample_time: latest ? latest.time : null, events_retained: events.length }; }
function install() {
    if (enabled) return status();
    error = null; calls = 0; samples = 0; skipped = 0; lastTime = null; latest = null;
    history = []; events = []; previous = new Map(); previousState = null; resolution = null;
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
            try { sample(args[0]); } catch (e) { error = String(e); event('sample_error', { error }); }
        } });
        enabled = true; event('enabled', { diagnostic_only: true });
    } catch (e) { stop(); error = String(e); throw e; }
    return status();
}
rpc.exports = {
    install, status, stop() { stop(); return status(); },
    mark(label) { event('user_mark', { label: String(label).slice(0, 160) }); return status(); },
    report() { return { schema_version: 1, diagnostic_only: true, ...status(),
        metadata: { time: Date.now(), process_id: Process.id, arch: Process.arch,
            module: moduleInfo, candidate_profile: C.profile, offsets: C,
            warning: 'Candidate fields, not validated ownership or collection. No server verification inferred.' },
        latest, history: history.slice(), events: events.slice() }; },
};
