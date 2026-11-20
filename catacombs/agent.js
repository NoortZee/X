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
let lastTraceSample = null;
let traces = new Map();
let metadata = null;
let playSamples = {};
let lastPlayStates = {};
let lastEndlessSample = null;
let lastEndless = null;
let updateChanges = [];
let collectibleEvents = [];
let collectibleClasses = new Map();
let collectibleTotals = {};
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
function readBoundedName(pointer) {
    let name = '';
    for (let i = 0; i < C.rtti.max_name_bytes; i++) {
        const byte = pointer.add(i).readU8();
        if (byte === 0) return name;
        if (byte < 32 || byte > 126) throw new Error('non-ASCII RTTI name');
        name += String.fromCharCode(byte);
    }
    throw new Error('RTTI name exceeds limit');
}
function describeAddress(address) {
    const result = { address: address.toString() };
    try {
        const module = Process.findModuleByAddress(address);
        if (module) {
            result.module = module.name;
            result.rva = address.sub(module.base).toString();
        }
    } catch (error) { result.error = String(error); }
    return result;
}
function captureTrace(context, returnAddress) {
    const now = Date.now();
    if (lastTraceSample !== null && now - lastTraceSample < C.trace.sample_ms) return;
    lastTraceSample = now;
    let frames;
    let method = 'accurate';
    let accurateError = null;
    try { frames = Thread.backtrace(context, Backtracer.ACCURATE); }
    catch (error) { frames = []; accurateError = String(error); }
    if (frames.length === 0) {
        method = 'fuzzy'; // May contain false positives; never used as automatic hook targets.
        try { frames = Thread.backtrace(context, Backtracer.FUZZY); }
        catch (error) { emit('trace_error', { error: String(error), accurate_error: accurateError }); return; }
    }
    const stack = frames.slice(0, C.trace.frames).map(describeAddress);
    const caller = returnAddress ? describeAddress(returnAddress) : null;
    const key = JSON.stringify({ method, caller, stack });
    const old = traces.get(key);
    if (old) { old.samples++; old.last_seen = now; return; }
    if (traces.size >= C.trace.unique) return;
    const trace = { id: traces.size + 1, method, caller, stack,
        samples: 1, first_seen: now, last_seen: now, accurate_error: accurateError };
    traces.set(key, trace);
    emit('hero_trace', trace);
}
function heroValues(hero) {
    const values = {};
    const H = MEMORY_LAYOUT.tas.hero;
    const B = MEMORY_LAYOUT.tas.body;
    try {
        values.direction = hero.add(H.DIRECTION).readS32();
        values.state = hero.add(H.STATE_A0).readS32();
        values.ground = [hero.add(H.GROUND_80).readS32(), hero.add(H.GROUND_84).readS32()];
        values.walls = [hero.add(H.WALL_LEFT).readS32(), hero.add(H.WALL_RIGHT).readS32()];
        const body = hero.add(H.BODY_PTR).readPointer();
        values.body = body.toString();
        values.physics = {};
        for (const field of ['XF_PX', 'XF_PY', 'VX', 'VY', 'SW_A', 'AV', 'GRAVITY']) {
            const value = body.add(B[field]).readFloat();
            if (!Number.isFinite(value)) throw new Error('non-finite body field: ' + field);
            values.physics[field] = value;
        }
    } catch (error) { values.read_error = String(error); }
    return values;
}
function collectibleEvent(kind, data) {
    const observation = { time: Date.now(), kind, ...data,
        nearby_endless: lastEndless ? { time: lastEndless.time,
            object: lastEndless.identity.object, values: lastEndless.values } : null,
        correlation_is_not_ownership: true };
    collectibleTotals[kind] = (collectibleTotals[kind] || 0) + 1;
    collectibleEvents.push(observation);
    if (collectibleEvents.length > C.collectible_diagnostics.events) collectibleEvents.shift();
    emit(kind, observation);
}
function observeFactoryReturn(result, caller) {
    if (result.isNull()) {
        collectibleEvent('crumb_factory_null', { caller });
        return;
    }
    const identity = heroIdentity(result);
    const key = identity.rtti_name || 'unresolved';
    if (collectibleClasses.has(key)) collectibleClasses.set(key, collectibleClasses.get(key) + 1);
    else if (collectibleClasses.size < C.collectible_diagnostics.classes) collectibleClasses.set(key, 1);
    collectibleEvent('crumb_factory_return', { identity, caller,
        interpretation: 'returned object; factory/class semantics require validation' });
}
function codeDiagnostics() {
    const output = {};
    const config = C.code_diagnostics;
    const module = Process.findModuleByName(MEMORY_LAYOUT.module_name);
    for (const [name, rva] of Object.entries(config.candidates)) {
        const entry = { candidate_rva: '0x' + rva.toString(16),
            boundary_verified: false, instructions: [] };
        output[name] = entry;
        try {
            if (!module || rva < 0 || rva >= module.size) throw new Error('candidate outside module');
            const start = module.base.add(rva);
            const range = Process.findRangeByAddress(start);
            if (!range || !range.protection.includes('r') || !range.protection.includes('x'))
                throw new Error('candidate is not readable executable memory');
            const available = Number(range.base.add(range.size).sub(start).toString());
            const length = Math.min(config.max_bytes, module.size - rva, available);
            if (length <= 0) throw new Error('empty code window');
            entry.address = start.toString();
            entry.window_bytes = length;
            entry.is_complete_function = false;
            entry.bytes = Array.from(new Uint8Array(start.readByteArray(length)))
                .map(byte => byte.toString(16).padStart(2, '0')).join(' ');
            let offset = 0;
            while (offset < length && entry.instructions.length < config.max_instructions) {
                const instruction = Instruction.parse(start.add(offset));
                if (instruction.size <= 0 || instruction.size > length - offset) break;
                entry.instructions.push({ rva: '0x' + (rva + offset).toString(16),
                    size: instruction.size, mnemonic: instruction.mnemonic, operands: instruction.opStr });
                offset += instruction.size;
                // Do not guess function boundaries: retain branches/ret and continue to window limit.
            }
        } catch (error) { entry.error = String(error); }
    }
    return output;
}
function updateProbe(state) {
    // Raw candidate values, not interpreted as health or skull count.
    return { state: state.add(C.endless.state).readS32(),
        field_f4: state.add(C.endless.index_next).readFloat() };
}
function recordUpdateChange(before, after, state, caller) {
    if (before.state === after.state && Object.is(before.field_f4, after.field_f4)) return;
    const event = { object: state.toString(), before, after,
        caller: caller ? describeAddress(caller) : null, time: Date.now(),
        scope: 'changed during update; exact writer not identified' };
    updateChanges.push(event);
    if (updateChanges.length > C.limits.events) updateChanges.shift();
    emit('endless_update_change', event);
}
function endlessSnapshot(state) {
    const layout = C.endless;
    const result = { identity: heroIdentity(state), values: {}, pointers: {}, container: {} };
    function read(target, name, action) {
        try { target[name] = action(); }
        catch (error) { target[name + '_error'] = String(error); }
    }
    for (const name of ['state', 'index_min', 'index_max'])
        read(result.values, name, () => state.add(layout[name]).readS32());
    for (const name of ['timer', 'index_current', 'index_next']) {
        read(result.values, name, () => {
            const value = state.add(layout[name]).readFloat();
            if (!Number.isFinite(value)) throw new Error('non-finite ' + name);
            return value;
        });
    }
    read(result.values, 'recalculate', () => state.add(layout.recalculate).readU8());
    for (const name of ['container', 'related'])
        read(result.pointers, name, () => state.add(layout[name]).readPointer().toString());
    read(result.container, 'header', () => {
        const container = state.add(layout.container).readPointer();
        if (container.isNull()) return { null: true };
        const count = container.add(layout.container_count).readS32();
        result.container.count_raw = count;
        if (count < 0 || count > layout.max_container_count)
            throw new Error('invalid candidate container count: ' + count);
        return { count, array: container.add(layout.container_array).readPointer().toString() };
    });
    // Header only: neither element layout nor relation to collectible skulls is confirmed.
    return result;
}
function playStateSnapshot(state) {
    const fields = C.play_state;
    const sample = { identity: heroIdentity(state), pointers: {}, flags: {}, methods: {} };
    // Read independently: one unknown field must not hide the other observations.
    for (const name of ['world', 'hero1', 'hero2', 'optional']) {
        try {
            const pointer = state.add(fields[name]).readPointer();
            sample.pointers[name] = pointer.toString();
            if (name === 'world' && !pointer.isNull())
                sample.world_content = pointer.add(fields.world_content).readPointer().toString();
            if ((name === 'hero1' || name === 'hero2') && !pointer.isNull())
                sample[name] = heroIdentity(pointer); // Candidate wrappers, not assumed HeroBody.
        } catch (error) { sample[name + '_error'] = String(error); }
    }
    for (const name of ['paused', 'mode1', 'mode2']) {
        try { sample.flags[name] = state.add(fields[name]).readU8(); }
        catch (error) { sample.flags[name + '_error'] = String(error); }
    }
    try {
        const timer = state.add(fields.timer).readFloat();
        if (!Number.isFinite(timer)) throw new Error('non-finite timer');
        sample.timer = timer;
        sample.frame_time = state.add(fields.frame_time).readS32();
    } catch (error) { sample.timer_error = String(error); }
    for (const [name, offset] of Object.entries(fields.methods)) {
        try {
            const vptr = state.add(C.rtti.object_vptr).readPointer();
            sample.methods[name] = describeAddress(vptr.add(offset).readPointer());
        } catch (error) { sample.methods[name] = { error: String(error) }; }
    }
    return sample;
}
function samplePlayState(name, state, caller) {
    const now = Date.now();
    if (playSamples[name] !== undefined && now - playSamples[name] < C.limits.sample_ms) return;
    playSamples[name] = now;
    const sample = { time: now, ...playStateSnapshot(state), caller: caller ? describeAddress(caller) : null };
    lastPlayStates[name] = sample;
    emit(name, sample);
}
function heroIdentity(hero) {
    const identity = { object: hero.toString() };
    try {
        const vptr = hero.add(C.rtti.object_vptr).readPointer();
        identity.vptr = vptr.toString();
        const typeinfo = vptr.add(C.rtti.typeinfo_from_vptr).readPointer();
        identity.typeinfo = typeinfo.toString();
        const name = typeinfo.add(C.rtti.name_from_typeinfo).readPointer();
        identity.rtti_name = readBoundedName(name);
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
    lastTraceSample = null; traces = new Map();
    playSamples = {}; lastPlayStates = {};
    lastEndlessSample = null; lastEndless = null; updateChanges = [];
    collectibleEvents = []; collectibleClasses = new Map(); collectibleTotals = {};
    const gameModule = Process.findModuleByName(MEMORY_LAYOUT.module_name);
    metadata = { captured_at: Date.now(), process_id: Process.id, arch: Process.arch,
        pointer_size: Process.pointerSize, profile_game_version: MEMORY_LAYOUT.game_version,
        profile_version_is_not_runtime_detection: true,
        module: gameModule ? { name: gameModule.name, base: String(gameModule.base), size: gameModule.size } : null };
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
            lastHero = { ...heroIdentity(args[0]), values: heroValues(args[0]) };
            captureTrace(this.context, this.returnAddress);
            emit('hero_control', lastHero);
        }) });
        for (const name of ['play_update', 'play_update_heroes']) {
            attach(name, { onEnter: guard(function (args) {
                samplePlayState(name, args[0], this.returnAddress);
            }) });
        }
        attach('endless_update', { onEnter: guard(function (args) {
            this.endlessState = args[0];
            try { this.beforeUpdate = updateProbe(args[0]); }
            catch (_) { this.beforeUpdate = null; }
            const now = Date.now();
            if (lastEndlessSample !== null && now - lastEndlessSample < C.endless.sample_ms) return;
            lastEndlessSample = now;
            lastEndless = { time: now, ...endlessSnapshot(args[0]),
                caller: this.returnAddress ? describeAddress(this.returnAddress) : null };
            emit('endless_update', lastEndless);
        }), onLeave: guard(function () {
            if (!this.beforeUpdate) return;
            try {
                recordUpdateChange(this.beforeUpdate, updateProbe(this.endlessState),
                    this.endlessState, this.returnAddress);
            } catch (error) { emit('update_probe_error', { error: String(error) }); }
        }) });
        attach('crumb_spawn_candidate', {
            onEnter: guard(function (args) {
                // This is only a candidate spawner owner, not assumed to be a collectible.
                this.crumbSpawnOwner = args[0].toString();
                this.crumbCaller = this.returnAddress ? describeAddress(this.returnAddress) : null;
                collectibleEvent('crumb_spawn_enter', { owner: this.crumbSpawnOwner, caller: this.crumbCaller });
            }),
            onLeave: guard(function () {
                collectibleEvent('crumb_spawn_leave', { owner: this.crumbSpawnOwner, caller: this.crumbCaller });
            }),
        });
        attach('crumb_factory_candidate', {
            onEnter: guard(function () {
                // Do not treat args[0] as this: supplied code appears factory-like.
                this.crumbCaller = this.returnAddress ? describeAddress(this.returnAddress) : null;
            }),
            onLeave: guard(function (result) { observeFactoryReturn(result, this.crumbCaller); }),
        });
        emit('enabled', { diagnostic_only: true });
    } catch (error) { fail(error); throw error; }
    return status();
}
function status() {
    return { enabled, diagnostic_only: true, metadata, traces_retained: traces.size, last_error: lastError,
        resolutions, counters, collectible_totals: collectibleTotals,
        collectible_classes: Object.fromEntries(collectibleClasses),
        collectible_events_retained: collectibleEvents.length, last_hero: lastHero, last_play_states: lastPlayStates, last_endless: lastEndless, events_retained: events.length, skulls_retained: skulls.size };
}
rpc.exports = {
    install, status,
    stop() { stop(); return status(); },
    report() { return { ...status(), traces: Array.from(traces.values()), code_diagnostics: codeDiagnostics(), collectible_events: collectibleEvents.slice(), update_changes: updateChanges.slice(), events: events.slice() }; },
};
