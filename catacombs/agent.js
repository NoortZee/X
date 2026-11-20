// Read-only Catacombs diagnostics. Candidate layouts: memory/offsets.js.
'use strict';
const C = MEMORY_LAYOUT.catacombs;
let hooks = [];
let enabled = false;
let lastError = null;
let resolutions = {};
let events = [];
let skulls = new Map();
let lastSample = 0;
let counters = {};
let lastHeroSample = null;
let lastHero = null;
function emit(kind, data) {
    events.push({ time: Date.now(), kind, ...data });
    if (events.length > C.limits.events) events.shift();
}
function stop() {
    enabled = false;
    for (const hook of hooks) hook.detach();
    hooks = [];
}
function fail(error) {
    lastError = String(error);
    stop();
    emit('disabled', { reason: lastError });
}
function boundedCount(value) {
    if (!Number.isInteger(value) || value < 0 || value > C.limits.count)
        throw new Error('invalid count: ' + value);
    return value;
}
function resolveAll() {
    const mod = Process.findModuleByName(MEMORY_LAYOUT.module_name);
    if (!mod) throw new Error('game module not loaded');
    const resolved = {};
    for (const [name, pattern] of Object.entries({ ...C.signatures, hero_control: MEMORY_LAYOUT.tas.signatures.FRAME_FUNC })) {
        const matches = new Map();
        for (const range of mod.enumerateRanges('r-x')) {
            for (const match of Memory.scanSync(range.base, range.size, pattern))
                matches.set(match.address.toString(), match.address);
        }
        if (matches.size !== 1) throw new Error(name + ': expected 1 match, found ' + matches.size);
        resolved[name] = matches.values().next().value;
    }
    return resolved;
}
function snapshotState(state) {
    const begin = state.add(C.state.skull_begin).readPointer();
    const end = state.add(C.state.skull_end).readPointer();
    const bytes = Number(end.sub(begin).toString());
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % Process.pointerSize !== 0 ||
        bytes / Process.pointerSize > C.limits.descriptors) throw new Error('invalid skull vector');
    const descriptors = [];
    for (let i = 0; i < bytes / Process.pointerSize; i++) {
        const descriptor = begin.add(i * Process.pointerSize).readPointer();
        const data = descriptor.add(C.descriptor.data).readPointer();
        descriptors.push({ descriptor: descriptor.toString(), data: data.toString(),
            active: data.add(C.descriptor.active).readU8() });
    }
    // Opaque container: do not assume it has std::vector layout.
    return { state: state.toString(), descriptors,
        skull_objects: state.add(C.state.skull_objects).readPointer().toString(),
        level: state.add(C.state.level).readPointer().toString(),
        mode: 'ReplayState candidate; Catacombs not independently confirmed' };
}
function heroIdentity(hero) {
    const identity = { object: hero.toString() };
    try {
        const vptr = hero.add(C.rtti.object_vptr).readPointer();
        identity.vptr = vptr.toString();
        const typeinfo = vptr.add(C.rtti.typeinfo_from_vptr).readPointer();
        identity.typeinfo = typeinfo.toString();
        const name = typeinfo.add(C.rtti.name_from_typeinfo).readPointer();
        identity.rtti_name = name.readCString(C.rtti.max_name_bytes);
    } catch (error) { identity.rtti_error = String(error); }
    return identity;
}
function guard(fn) {
    return function (...args) {
        if (!enabled) return;
        try { return fn.apply(this, args); } catch (error) { fail(error); }
    };
}
function install() {
    if (enabled) return status();
    lastError = null;
    events = []; skulls = new Map(); counters = {}; lastSample = 0;
    resolutions = {}; lastHeroSample = null; lastHero = null;
    try {
        const addresses = resolveAll(); // Validate every signature before attaching any hook.
        resolutions = Object.fromEntries(Object.entries(addresses).map(([k, v]) => [k, v.toString()]));
        function attach(name, callbacks) {
            counters[name] = 0;
            const enter = callbacks.onEnter;
            hooks.push(Interceptor.attach(addresses[name], {
                ...callbacks,
                onEnter(args) {
                    if (!enabled) return;
                    // Count entry before attempting any candidate field reads.
                    counters[name]++;
                    if (enter) return enter.call(this, args);
                },
            }));
        }
        enabled = true;
        attach('replay_update', { onEnter: guard(function (args) {
            counters.frames = (counters.frames || 0) + 1;
            if (Date.now() - lastSample < C.limits.sample_ms) return;
            lastSample = Date.now();
            emit('state', snapshotState(args[0]));
        }) });
        attach('skull_spawn', {
            onEnter: guard(function (args) { this.state = args[0]; }),
            onLeave: guard(function () { skulls.clear(); emit('spawn', snapshotState(this.state)); }),
        });
        attach('death_skull_update', { onEnter: guard(function (args) {
            const skull = args[0];
            const active = skull.add(C.skull.active).readU8();
            if (active !== 0 && active !== 1) throw new Error('invalid skull active byte: ' + active);
            const key = skull.toString();
            if (skulls.get(key) === active) return;
            if (!skulls.has(key) && skulls.size >= C.limits.skulls) skulls.delete(skulls.keys().next().value);
            skulls.set(key, active);
            emit('skull_state', { skull: key, active, vtable: skull.readPointer().toString() });
        }) });
        attach('skull_commit', {
            onEnter: guard(function (args) {
                this.profile = args[0];
                emit('commit_enter', { profile: this.profile.toString(), argument: args[1].toInt32() });
            }),
            onLeave: guard(function () {
                const user = this.profile.add(C.profile.userinfo).readPointer();
                emit('commit_leave', { count: boundedCount(user.add(C.profile.count).readS32()),
                    cap: boundedCount(user.add(C.profile.cap).readS32()) });
            }),
        });
        // Argument semantics not confirmed: record occurrence only, do not decode or modify request.
        attach('collect_request', { onEnter: guard(function () {
            counters.requests = (counters.requests || 0) + 1;
            emit('collect_request', { observed: true });
        }) });
        attach('hero_control', { onEnter: guard(function (args) {
            const now = Date.now();
            if (lastHeroSample !== null && now - lastHeroSample < C.limits.sample_ms) return;
            lastHeroSample = now;
            lastHero = heroIdentity(args[0]);
            emit('hero_control', lastHero);
        }) });
        emit('enabled', { diagnostic_only: true });
    } catch (error) { fail(error); throw error; }
    return status();
}
function status() {
    return { enabled, diagnostic_only: true, last_error: lastError,
        resolutions, counters, last_hero: lastHero, events_retained: events.length, skulls_retained: skulls.size };
}
rpc.exports = {
    install, status,
    stop() { stop(); return status(); },
    report() { return { ...status(), events: events.slice() }; },
};
