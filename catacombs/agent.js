// Bounded diagnostics with an explicit single-object position experiment. All candidate offsets are in memory/offsets.js.
'use strict';
const C = MEMORY_LAYOUT.catacombs;
let hook = null, enabled = false, error = null, moduleInfo = null;
let calls = 0, samples = 0, skipped = 0, lastTime = null, latest = null;
let history = [], events = [], previous = new Map(), previousState = null;
let resolution = null;
let methodCode = new Map();
let lifecycleCode = null;
let autoRun = null;
let autoSeen = new Set();
let wallState = null, wallPatch = null;
let wallEvents = [];
let fixtureReport = null, filterSymbols = null;
let maskTest = null, maskBackup = null;
let speedTest = null, speedBackup = null;
let fallStatus = null, fallBackup = null;
let pendingAltitude = null;
let pendingMove = null, lastMove = null, movesExecuted = 0, mutationAttempted = false, teleportUsed = false;
function event(kind, data) {
    if (kind.startsWith('wall_pass_')) {
        wallEvents.push({ time: Date.now(), kind, ...data });
        if (wallEvents.length > 12) wallEvents.shift();
    }
    events.push({ time: Date.now(), kind, ...data });
    if (events.length > (C.diagnostics ? C.limits.events : C.auto_teleport.events)) events.shift();
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
function captureMethodCode(target, byteLimit = C.method_probe.bytes, instructionLimit = C.method_probe.instructions) {
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
        const length = Math.min(byteLimit, C.lifecycle_probe.create_bytes, available, moduleAvailable);
        if (!Number.isSafeInteger(length) || length <= 0) throw new Error('invalid code window');
        record.window_bytes = length;
        record.hex = Array.from(new Uint8Array(target.readByteArray(length)))
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        let offset = 0;
        while (offset < length && record.instructions.length < Math.min(instructionLimit, C.lifecycle_probe.create_instructions)) {
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
// Read-only candidate: matching HeroBody's +0x20 is not evidence of Candy ABI.
function candyPhysicsProbe(object) {
    return safe(() => {
        const body = object.add(C.object.body).readPointer();
        if (body.isNull()) return { null: true };
        requireClass(body, C.candy_body_probe.body_name);
        const physics = body.add(C.candy_body_probe.physics_candidate).readPointer();
        const out = { candidate_only: true, body: body.toString(), address: physics.toString() };
        if (physics.isNull()) return { ...out, null: true };
        const range = Process.findRangeByAddress(physics);
        if (!range || !range.protection.includes('r')) throw new Error('physics candidate unreadable');
        const B = MEMORY_LAYOUT.tas.body;
        const end = Math.max(...['XF_PX', 'XF_PY', 'VX', 'VY', 'SW_A', 'AV', 'GRAVITY'].map(k => B[k])) + 4;
        if (Number(range.base.add(range.size).sub(physics).toString()) < end)
            throw new Error('physics candidate crosses range');
        out.type = physics.add(B.TYPE).readS32();
        out.fields = {};
        for (const k of ['XF_PX', 'XF_PY', 'VX', 'VY', 'SW_A', 'AV', 'GRAVITY'])
            out.fields[k] = numberAt(physics, B[k]);
        out.extra_candidates = {};
        for (const [key, offset] of Object.entries(C.physics_extra))
            out.extra_candidates[key] = safe(() => key === 'world_candidate'
                ? { address: physics.add(offset).readPointer().toString() }
                : numberAt(physics, offset));
        out.object_position = position(object);
        out.position_matches = Math.abs(out.fields.XF_PX * C.candy_body_probe.scale - out.object_position.x) < C.candy_body_probe.tolerance &&
            Math.abs(out.fields.XF_PY * C.candy_body_probe.scale - out.object_position.y) < C.candy_body_probe.tolerance;
        return out;
    });
}
function bodyCallProbe(body) {
    return safe(() => {
        if (body.isNull()) return { null: true };
        const handler = body.readPointer().add(C.method_probe.body_methods.slot3).readPointer();
        const key = captureMethodCode(handler);
        const record = methodCode.get(key);
        const calls = [];
        // Exactly one level, direct calls only; no arbitrary recursive disassembly.
        for (const ins of (record && record.instructions) || []) {
            if (calls.length >= C.candy_body_probe.direct_calls) break;
            if (ins.mnemonic !== 'call' || !/^0x[0-9a-f]+$/i.test(ins.operands)) continue;
            const target = handler.add(Number(ins.operands) - Number(handler.toString()));
            calls.push({ callsite: ins.address, target: address(target), code_key: captureMethodCode(target) });
        }
        return { candidate_only: true, handler: key, calls };
    });
}
function captureLifecycleCandidates() {
    if (lifecycleCode !== null) return;
    lifecycleCode = safe(() => {
        const m = Process.findModuleByName(MEMORY_LAYOUT.module_name);
        if (!m) throw new Error('game module not loaded');
        const records = {};
        // Capture all three roots first so optional callees cannot exhaust their budget.
        for (const [role, rva] of Object.entries(C.lifecycle_probe.candidates)) {
            if (!Number.isSafeInteger(rva) || rva < 0 || rva >= m.size) {
                records[role] = { error: 'candidate RVA outside game module' }; continue;
            }
            const target = m.base.add(rva);
            records[role] = { candidate_only: true, target: address(target),
                code_key: role === 'create_candidate'
                    ? captureMethodCode(target, C.lifecycle_probe.create_bytes, C.lifecycle_probe.create_instructions)
                    : captureMethodCode(target), calls: [] };
        }
        for (const record of Object.values(records)) {
            let budget = C.lifecycle_probe.direct_calls_per_root;
            const seen = new Set();
            record.call_scan_policy = 'linear prefix until first ret/int3; not full control-flow analysis';
            const code = methodCode.get(record.code_key);
            for (const ins of (code && code.instructions) || []) {
                if (budget <= 0 || ins.mnemonic === 'ret' || ins.mnemonic === 'int3') break;
                if (ins.mnemonic !== 'call' || !/^0x[0-9a-f]+$/i.test(ins.operands)) continue;
                const delta = Number(ins.operands) - Number(m.base.toString());
                if (!Number.isSafeInteger(delta) || delta < 0 || delta >= m.size) continue;
                if (seen.has(delta)) continue;
                seen.add(delta);
                const target = m.base.add(delta);
                record.calls.push({ callsite: ins.address, target: address(target), code_key: captureMethodCode(target) });
                budget--;
            }
        }
        return records;
    });
}
function candySnapshot(p, id) {
    return { ...id, position: position(p),
        physics_candidate: candyPhysicsProbe(p),
        body_handler_calls: safe(() => bodyCallProbe(p.add(C.object.body).readPointer())),
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
function fixtureChain(body) {
    const F = C.fixture_probe;
    const report = { physics: body.toString(), candidate_offsets: true, fixtures: [], complete: false };
    try {
        if (body.isNull()) throw new Error('null physics body');
        let current = body.add(F.fixture_head).readPointer();
        const seen = new Set();
        while (!current.isNull() && report.fixtures.length < F.limit) {
            if (seen.has(current.toString())) throw new Error('fixture cycle');
            seen.add(current.toString());
            const owner = current.add(F.owner).readPointer();
            const entry = { address: current.toString(), owner: owner.toString(), owner_matches: owner.toString() === body.toString() };
            report.fixtures.push(entry);
            if (!entry.owner_matches) throw new Error('fixture owner mismatch; candidate offsets unverified');
            entry.category = current.add(F.category).readU16();
            entry.mask = current.add(F.mask).readU16();
            entry.group = current.add(F.group).readS16();
            current = current.add(F.next).readPointer();
        }
        report.complete = current.isNull();
        report.truncated = !report.complete;
    } catch (e) { report.error = String(e); }
    return report;
}
function speedBlockMatches(base) {
    return Math.abs(base.readFloat() - C.wall_pass.original) <= C.wall_pass.tolerance &&
        C.wall_pass.neighbours.every(([offset, value, required]) => offset === C.speed_test.offset || required === false ||
            Math.abs(numberAt(base, offset) - value) <= C.wall_pass.tolerance);
}
function restoreSpeed(reason) {
    if (!speedBackup) return;
    try {
        const { base, pointer, original, patched } = speedBackup;
        writableFloat(pointer);
        if (!speedBlockMatches(base) || Math.abs(pointer.readFloat() - patched) > C.wall_pass.tolerance)
            throw new Error('speed block changed externally; restore refused');
        pointer.writeFloat(original);
        if (Math.abs(pointer.readFloat() - original) > C.wall_pass.tolerance) throw new Error('speed restore readback failed');
        speedBackup = null; speedTest = { ...speedTest, status: 'restored', reason };
    } catch (e) { speedTest = { ...speedTest, status: 'restore_failed', reason, error: String(e) }; }
    event('speed_restore', { result: speedTest });
}
function applySpeed(state) {
    if (!C.speed_test.enabled) return;
    try {
        if (state.add(C.state.phase).readS32() !== 1) {
            restoreSpeed('level inactive'); if (speedTest) speedTest.active = false; return;
        }
        if (state.add(C.state.paused).readU8() !== 0) return;
        requireClass(state, C.move_white.state_name);
        if (speedTest && speedTest.state === state.toString() && speedTest.active !== false) return;
        if (speedBackup) { restoreSpeed('new state'); if (speedBackup) return; }
        speedTest = { state: state.toString(), active: true, status: 'searching', multiplier: C.speed_test.multiplier };
        const m = Process.findModuleByName(MEMORY_LAYOUT.module_name);
        if (!m) throw new Error('game module missing');
        let scanned = 0, matches = 0; const candidates = new Map();
        for (const range of m.enumerateRanges('rw-')) {
            if ((scanned += range.size) > C.wall_pass.max_scan_bytes) throw new Error('speed scan byte budget');
            for (const match of Memory.scanSync(range.base, range.size, C.wall_pass.pattern)) {
                if (++matches > C.wall_pass.max_matches) throw new Error('speed scan match budget');
                const base = match.address;
                const delta = Number(base.sub(m.base).toString());
                if (delta < 0 || delta + C.speed_test.offset + 4 > m.size) continue;
                if (safe(() => speedBlockMatches(base) && Math.abs(numberAt(base, C.speed_test.offset) - C.speed_test.baseline) <= C.wall_pass.tolerance) === true)
                    candidates.set(base.toString(), base);
            }
        }
        speedTest.matches = candidates.size;
        if (candidates.size !== 1) throw new Error('speed block not unique/found: ' + candidates.size);
        const base = candidates.values().next().value, pointer = base.add(C.speed_test.offset);
        writableFloat(pointer);
        const original = pointer.readFloat(), patched = original * C.speed_test.multiplier;
        if (!Number.isFinite(patched) || patched <= 0) throw new Error('invalid speed multiplier');
        speedBackup = { base, pointer, original, patched }; mutationAttempted = true;
        pointer.writeFloat(patched);
        const readback = pointer.readFloat();
        if (Math.abs(readback - patched) > C.wall_pass.tolerance) throw new Error('speed readback failed');
        speedTest = { ...speedTest, status: 'applied', parameter: address(pointer), original, patched, readback,
            note: 'configuration multiplier; actual movement rate not measured' };
        event('speed_applied', { result: speedTest });
    } catch (e) {
        speedTest = { ...speedTest, state: state.toString(), active: true, status: 'unavailable', error: String(e) };
        if (speedBackup) restoreSpeed('apply failed');
        event('speed_error', { result: speedTest });
    }
}
function heroMaskContext(state) {
    requireClass(state, C.move_white.state_name);
    const hero = state.add(C.state.world).readPointer().add(C.world.hero).readPointer();
    requireClass(hero, C.move_white.hero_name);
    const body = hero.add(C.object.body).readPointer(); requireClass(body, C.move_white.hero_body_name);
    const physics = body.add(C.hero_body.physics).readPointer();
    if (physics.isNull()) throw new Error('null hero physics');
    const world = physics.add(C.teleport_white.world).readPointer();
    if (world.isNull() || (world.add(C.teleport_white.lock).readU8() & C.teleport_white.lock_mask))
        throw new Error('hero physics world locked/null');
    const chain = fixtureChain(physics);
    if (chain.error || !chain.complete || !chain.fixtures.length) throw new Error('hero fixture chain incomplete/invalid');
    return { hero, physics, chain };
}
function restoreHeroMasks(reason) {
    if (!maskBackup) return;
    const backup = maskBackup;
    try {
        // Re-resolve current Hero/fixture chain before touching any saved fixture address.
        const current = heroMaskContext(backup.state);
        if (current.hero.toString() !== backup.hero || current.physics.toString() !== backup.physics)
            throw new Error('hero body changed; saved masks not touched');
        for (const item of backup.items) {
            const fresh = current.chain.fixtures.find(f => f.address === item.pointer.toString());
            if (!fresh || fresh.category !== C.mask_test.category || fresh.group !== C.mask_test.group || (fresh.mask !== C.mask_test.value && fresh.mask !== item.mask))
                throw new Error('fixture changed externally; saved masks not touched');
            writableFloat(item.pointer.add(C.fixture_probe.mask));
        }
        for (const item of backup.items) {
            item.pointer.add(C.fixture_probe.mask).writeU16(item.mask);
            if (item.pointer.add(C.fixture_probe.mask).readU16() !== item.mask) throw new Error('restore mask readback failed');
        }
        maskBackup = null;
        maskTest = { ...maskTest, status: 'restored', reason };
    } catch (e) { maskTest = { ...maskTest, status: 'restore_failed', reason, error: String(e) }; }
    event('hero_mask_restore', { result: maskTest });
}
function restoreNoFall(reason) {
    pendingAltitude = null;
    if (!fallBackup) return;
    try {
        const context = heroMaskContext(fallBackup.state);
        if (context.physics.toString() !== fallBackup.physics || context.hero.toString() !== fallBackup.hero)
            throw new Error('Hero changed; gravity restore refused');
        const gravity = context.physics.add(MEMORY_LAYOUT.tas.body.GRAVITY);
        writableFloat(gravity);
        if (gravity.readFloat() !== 0 && gravity.readFloat() !== fallBackup.gravity)
            throw new Error('gravity changed externally; restore refused');
        const vy = context.physics.add(MEMORY_LAYOUT.tas.body.VY);
        writableFloat(vy); vy.writeFloat(0);
        gravity.writeFloat(fallBackup.gravity);
        fallBackup = null; fallStatus = { ...fallStatus, status: 'restored', reason };
    } catch (e) { fallStatus = { ...fallStatus, status: 'restore_failed', error: String(e), reason }; }
}
function preventFall(state) {
    if (!C.no_fall.enabled) return;
    try {
        if (state.add(C.state.phase).readS32() !== 1) { restoreNoFall('level inactive'); return; }
        if (state.add(C.state.paused).readU8() !== 0) return;
        if (!maskTest || maskTest.status !== 'applied' || maskTest.state !== state.toString()) return;
        const context = heroMaskContext(state), B = MEMORY_LAYOUT.tas.body;
        if (context.physics.add(B.TYPE).readS32() !== B.DYNAMIC_TYPE) throw new Error('Hero physics is not dynamic');
        if (fallBackup && (fallBackup.physics !== context.physics.toString() || fallBackup.state.toString() !== state.toString())) {
            restoreNoFall('Hero changed'); if (fallBackup) return;
        }
        const gravity = context.physics.add(B.GRAVITY), vy = context.physics.add(B.VY);
        writableFloat(gravity); writableFloat(vy);
        const g = numberAt(context.physics, B.GRAVITY), velocity = numberAt(context.physics, B.VY);
        if (!fallBackup) {
            if (g < 0 || g > 10) throw new Error('unexpected gravity scale');
            fallBackup = { state, physics: context.physics.toString(), hero: context.hero.toString(), gravity: g };
            fallStatus = { status: 'active', original_gravity: g, physics: context.physics.toString(),
                note: 'bounded initial descent, then no-fall; no position writes' };
            if (C.no_fall.underground) {
                const y = numberAt(context.hero, C.object.y);
                fallBackup.targetY = y + C.no_fall.down;
                fallBackup.descentStarted = Date.now();
                fallStatus.start_y = y; fallStatus.target_y = fallBackup.targetY;
                fallStatus.descent = 'descending';
            }
        }
        if (C.altitude_test.auto_rise && !fallBackup.autoRiseStarted) {
            const y = numberAt(context.hero, C.object.y);
            fallBackup.autoRiseStarted = true;
            fallBackup.originY = y;
            fallBackup.flight = { target: y - C.altitude_test.up, started: Date.now(), mode: 'auto_above' };
            fallStatus.altitude = { mode: 'auto_above', status: 'moving', origin_y: y, target_y: fallBackup.flight.target };
            fallStatus.descent = 'cancelled_by_auto_altitude';
            event('altitude_auto_started', { origin_y: y, target_y: fallBackup.flight.target });
        }
        mutationAttempted = true;
        if (g !== 0) gravity.writeFloat(0);
        if (pendingAltitude) {
            const request = pendingAltitude; pendingAltitude = null;
            if (request.state !== state.toString() || Date.now() - request.time > C.altitude_test.expiry_ms) {
                fallStatus.altitude_error = 'altitude request stale/state changed';
            } else {
                const y = numberAt(context.hero, C.object.y);
                if (request.mode === 'above' && fallBackup.originY === undefined) fallBackup.originY = y;
                if (fallBackup.originY === undefined) fallStatus.altitude_error = 'use above before return-height';
                else {
                    fallBackup.flight = { target: request.mode === 'above' ? fallBackup.originY - C.altitude_test.up : fallBackup.originY,
                        started: Date.now(), mode: request.mode };
                    fallStatus.altitude = { mode: request.mode, status: 'moving', origin_y: fallBackup.originY,
                        target_y: fallBackup.flight.target };
                    delete fallStatus.altitude_error;
                    fallStatus.descent = 'cancelled_by_manual_altitude';
                }
            }
        }
        let desiredVY = 0;
        if (fallStatus.descent === 'descending') {
            const y = numberAt(context.hero, C.object.y);
            fallStatus.current_y = y;
            if (y >= fallBackup.targetY) fallStatus.descent = 'complete';
            else if (Date.now() - fallBackup.descentStarted > C.no_fall.descent_timeout_ms) {
                fallStatus.descent = 'timed_out';
                fallStatus.descent_warning = 'descent stopped before target; no automatic retry';
            } else desiredVY = C.no_fall.descent_vy;
        }
        if (fallBackup.flight) {
            const flight = fallBackup.flight;
            const y = numberAt(context.hero, C.object.y), delta = flight.target - y;
            fallStatus.altitude.current_y = y;
            if (Math.abs(delta) <= C.altitude_test.tolerance) {
                fallStatus.altitude.status = 'reached'; fallBackup.flight = null;
            } else if (Date.now() - flight.started > C.altitude_test.timeout_ms) {
                fallStatus.altitude.status = 'timed_out'; fallBackup.flight = null;
            } else desiredVY = Math.sign(delta) * Math.min(C.altitude_test.velocity,
                Math.max(0.2, Math.abs(delta) / C.candy_body_probe.scale * 10));
        }
        if (velocity !== desiredVY) vy.writeFloat(desiredVY);
        fallStatus.status = 'active'; delete fallStatus.error;
        fallStatus.gravity = gravity.readFloat(); fallStatus.vy = vy.readFloat();
    } catch (e) { fallStatus = { ...fallStatus, status: 'deferred_or_failed', error: String(e) }; }
}
function applyHeroMasks(state) {
    if (!C.mask_test.enabled) return;
    try {
        if (state.add(C.state.phase).readS32() !== 1) {
            restoreHeroMasks('level inactive');
            if (maskTest) maskTest.active = false;
            return;
        }
        if (state.add(C.state.paused).readU8() !== 0) return;
        if (maskTest && maskTest.state === state.toString() && maskTest.active !== false) return;
        if (maskBackup) { restoreHeroMasks('new state'); if (maskBackup) return; }
        maskTest = { state: state.toString(), active: true, status: 'validating', refilter_called: false };
        const context = heroMaskContext(state);
        const items = context.chain.fixtures.map(f => {
            if (f.category !== C.mask_test.category || f.group !== C.mask_test.group || !C.mask_test.allowed_masks.includes(f.mask))
                throw new Error('unexpected hero filter; no mask writes');
            // Resolve from current chain through Frida pointer, never a hardcoded live address.
            return { address: f.address, mask: f.mask };
        });
        // Rewalk the already validated bounded linked list to retain live NativePointers.
        let fixture = context.physics.add(C.fixture_probe.fixture_head).readPointer();
        for (const item of items) {
            if (fixture.toString() !== item.address) throw new Error('fixture chain changed');
            item.pointer = fixture; writableFloat(fixture.add(C.fixture_probe.mask));
            fixture = fixture.add(C.fixture_probe.next).readPointer();
        }
        maskBackup = { state, hero: context.hero.toString(), physics: context.physics.toString(), items: [] };
        maskTest.before = items.map(i => ({ address: i.address, mask: i.mask }));
        for (const item of items) {
            maskBackup.items.push(item); mutationAttempted = true;
            item.pointer.add(C.fixture_probe.mask).writeU16(C.mask_test.value);
            if (item.pointer.add(C.fixture_probe.mask).readU16() !== C.mask_test.value) throw new Error('mask readback failed');
        }
        maskTest.status = 'applied'; maskTest.count = items.length; maskTest.value = C.mask_test.value;
        event('hero_mask_applied', { result: maskTest });
    } catch (e) {
        maskTest = { ...maskTest, state: state.toString(), active: true, status: 'failed', error: String(e) };
        if (maskBackup) restoreHeroMasks('apply failed');
        event('hero_mask_error', { result: maskTest });
    }
}
function probeFilterSymbols() {
    if (filterSymbols !== null) return;
    filterSymbols = safe(() => {
        const m = Process.findModuleByName(MEMORY_LAYOUT.module_name);
        const found = [];
        // Exports only: no whole-module byte-pattern guessing and no native calls.
        for (const symbol of m.enumerateExports()) {
            if (symbol.type !== 'function' || !/(SetFilterData|Refilter)/.test(symbol.name)) continue;
            const key = captureMethodCode(symbol.address, 128, 32);
            found.push({ name: symbol.name, target: address(symbol.address), code: methodCode.get(key), candidate_only: true });
            if (found.length >= C.fixture_probe.symbols) break;
        }
        return { scope: 'exported symbols only', candidates: found,
            note: 'No export match does not mean the function is absent; no ABI verified.' };
    });
}
function captureFixtureReport(state) {
    if (!C.fixture_probe.enabled || state.add(C.state.phase).readS32() !== 1) return;
    probeFilterSymbols();
    fixtureReport = { time: Date.now(), state: state.toString(), read_only: true,
        filter_functions: filterSymbols, hero: safe(() => {
            const world = state.add(C.state.world).readPointer();
            const hero = world.add(C.world.hero).readPointer(); requireClass(hero, C.move_white.hero_name);
            const body = hero.add(C.object.body).readPointer(); requireClass(body, C.move_white.hero_body_name);
            const physics = body.add(C.hero_body.physics).readPointer();
            return { address: hero.toString(), body: body.toString(), chain: fixtureChain(physics) };
        }), candies: safe(() => {
            const array = state.add(C.state.objects).readPointer();
            const count = array.add(C.array.slots).readS32();
            if (count < 0 || count > C.limits.slots) throw new Error('fixture probe array invalid/too large');
            const data = array.add(C.array.data).readPointer(), result = [];
            for (let i = 0; i < count && result.length < C.fixture_probe.candies; i++) {
                const object = data.add(i * Process.pointerSize).readPointer();
                if (object.isNull()) continue;
                const id = identity(object);
                if (!id.rtti || id.rtti.name !== C.candy.name) continue;
                const body = object.add(C.object.body).readPointer(); requireClass(body, C.candy_body_probe.body_name);
                result.push({ object: object.toString(), rarity: object.add(C.candy.rarity).readS32(),
                    chain: fixtureChain(body.add(C.hero_body.physics).readPointer()) });
            }
            return result;
        }) };
}
function sample(state) {
    if (speedBackup && speedTest) speedTest.current = safe(() => speedBackup.pointer.readFloat());
    if (!C.diagnostics) {
        if (lastTime !== null && Date.now() - lastTime < C.limits.sample_ms) { skipped++; return; }
        lastTime = Date.now(); samples++;
        safe(() => captureFixtureReport(state));
        latest = { time: lastTime, state: { address: state.toString() },
            phase_raw: safe(() => state.add(C.state.phase).readS32()),
            paused_raw: safe(() => state.add(C.state.paused).readU8()) };
        return;
    }
    const now = Date.now();
    const key = state.toString();
    if (lastTime !== null && now - lastTime < C.limits.sample_ms) { skipped++; return; }
    lastTime = now;
    safe(() => captureFixtureReport(state));
    captureLifecycleCandidates();
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
function float32Spacing(value) {
    if (!Number.isFinite(value)) throw new Error('non-finite coordinate');
    const n = Math.abs(value);
    return n === 0 ? Math.pow(2, -149) : Math.pow(2, Math.max(-149, Math.floor(Math.log2(n)) - 23));
}
function physicsPositionCheck(target, readback) {
    const scale = C.candy_body_probe.scale;
    const tolerance = {}, error = {};
    for (const axis of ['x', 'y']) {
        if (!Number.isFinite(target[axis]) || !Number.isFinite(readback[axis])) throw new Error('non-finite physics readback');
        // Object float -> physics float -> object units: allow two physics ULPs + one object ULP.
        tolerance[axis] = C.teleport_white.tolerance +
            2 * float32Spacing(target[axis] / scale) * scale + float32Spacing(target[axis]);
        error[axis] = Math.abs(readback[axis] - target[axis]);
    }
    return { matches: error.x <= tolerance.x && error.y <= tolerance.y, error, tolerance };
}
function teleportCandy(selected, target, result) {
    const T = C.teleport_white;
    const body = selected.add(C.object.body).readPointer();
    requireClass(body, C.candy_body_probe.body_name);
    const probe = candyPhysicsProbe(selected);
    if (probe.error || !probe.position_matches || probe.type !== 0)
        throw new Error('Candy physics candidate failed validation');
    const physics = body.add(C.hero_body.physics).readPointer();
    if (physics.add(T.owner).readPointer().toString() !== body.toString())
        throw new Error('physics owner mismatch');
    const world = physics.add(T.world).readPointer();
    if (world.isNull()) throw new Error('null physics world');
    const m = Process.findModuleByName(MEMORY_LAYOUT.module_name);
    for (const sig of T.signatures) {
        if (!m || sig.rva + sig.bytes.length > m.size) throw new Error('native RVA outside module');
        const code = m.base.add(sig.rva);
        const range = Process.findRangeByAddress(code);
        if (!range || !range.protection.includes('x') || !range.protection.includes('r') ||
            Number(range.base.add(range.size).sub(code).toString()) < sig.bytes.length)
            throw new Error('native code not readable executable');
        const bytes = new Uint8Array(code.readByteArray(sig.bytes.length));
        if (!sig.bytes.every((b, i) => bytes[i] === b)) throw new Error('native signature mismatch');
    }
    const recreate = body.readPointer().add(C.method_probe.body_methods.recreate_candidate).readPointer();
    if (recreate.toString() !== m.base.add(C.lifecycle_probe.candidates.create_candidate).toString())
        throw new Error('unexpected recreate vtable target');
    const x = body.add(T.stored_x), y = body.add(T.stored_y);
    writableFloat(x); writableFloat(y);
    const before = { x: numberAt(body, T.stored_x), y: numberAt(body, T.stored_y) };
    const objectBefore = position(selected);
    if (objectBefore.error || Math.hypot(before.x - objectBefore.x, before.y - objectBefore.y) > T.tolerance)
        throw new Error('stored Body position mismatch');
    const rebuild = new NativeFunction(m.base.add(C.lifecycle_probe.candidates.destroy_candidate), 'void', ['pointer']);
    // Same update callback thread. No deferred setImmediate or assumed physics unlock.
    if (world.add(T.lock).readU8() & T.lock_mask) throw new Error('physics world locked');
    result.body = body.toString(); result.physics_before = physics.toString(); result.stored_before = before;
    result.native_started = false;
    try {
        result.write_attempted = true; mutationAttempted = true; teleportUsed = true;
        x.writeFloat(target.x); y.writeFloat(target.y);
        result.native_started = true;
        rebuild(body); // Deletes AND tail-calls the observed Candy recreate slot. Never call create twice.
    } catch (e) {
        if (!result.native_started)
            result.rollback = safe(() => { x.writeFloat(before.x); y.writeFloat(before.y); return true; });
        else result.warning = 'native started; state uncertain, no automatic rollback or retry';
        throw e;
    }
    const after = body.add(C.hero_body.physics).readPointer();
    result.physics_after = after.toString();
    if (after.isNull()) throw new Error('rebuild returned with null physics body; stop experiment');
    result.physics_readback = { x: numberAt(after, MEMORY_LAYOUT.tas.body.XF_PX) * C.candy_body_probe.scale,
        y: numberAt(after, MEMORY_LAYOUT.tas.body.XF_PY) * C.candy_body_probe.scale };
    result.position_check = physicsPositionCheck(target, result.physics_readback);
    if (!result.position_check.matches)
        throw new Error('rebuilt physics position differs from target; do not retry');
}
function performMove(state) {
    if (!pendingMove) return;
    const request = pendingMove;
    pendingMove = null; // Exactly one attempt; never retry automatically.
    const result = { time: Date.now(), request_time: request.time, success: false,
        collection_confirmed: false, mode: request.mode || 'visual', experiment: request.mode === 'teleport' ? 'native physics rebuild; collection unverified' : 'object coordinates only; Body sync unverified' };
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
        if (request.mode === 'teleport') {
            teleportCandy(selected, target, result);
            result.success = true; movesExecuted++;
            return;
        }
        // Reproduce only the verified two-float object setter; no unknown ABI/native call.
        try {
            mutationAttempted = true;
            xField.writeFloat(target.x);
            yField.writeFloat(target.y);
        } catch (e) {
            result.rollback = safe(() => { xField.writeFloat(before.x); yField.writeFloat(before.y); return true; });
            throw e;
        }
        result.readback = position(selected);
        result.success = true; movesExecuted++;
    } catch (e) { result.error = String(e); }
    finally { lastMove = result; event('move_white_result', result); }
}
function wallBlockMatches(pointer) {
    return C.wall_pass.neighbours.every(([offset, value, required]) =>
        required === false || Math.abs(numberAt(pointer, offset) - value) <= C.wall_pass.tolerance);
}
function restoreWalls(reason) {
    if (!wallPatch) return;
    try {
        const { pointer, original } = wallPatch;
        writableFloat(pointer);
        if (!wallBlockMatches(pointer) || Math.abs(pointer.readFloat() - C.wall_pass.patched) > C.wall_pass.tolerance)
            throw new Error('wall parameter changed externally; refusing stale restore');
        pointer.writeFloat(original);
        wallPatch = null;
        wallState = { ...wallState, status: 'restored', reason };
        event('wall_pass_restored', { reason });
    } catch (e) {
        wallState = { ...wallState, status: 'restore_failed', error: String(e) };
        event('wall_pass_restore_failed', { error: String(e) });
    }
}
function enableWalls(state) {
    if (!C.wall_pass.enabled || (wallState && wallState.active !== false && wallState.state === state.toString())) return;
    if (wallPatch) { restoreWalls('state changed'); if (wallPatch) return; }
    wallState = { state: state.toString(), status: 'searching', active: true, scanned_bytes: 0, ranges: 0, raw_matches: 0, matches: 0, candidates: [], scope: 'game module writable data only' };
    try {
        const module = Process.findModuleByName(MEMORY_LAYOUT.module_name);
        if (!module) throw new Error('game module missing');
        const candidates = new Map(); let scanned = 0, matches = 0;
        for (const range of module.enumerateRanges('rw-')) {
            scanned += range.size; wallState.scanned_bytes = scanned; wallState.ranges++;
            if (scanned > C.wall_pass.max_scan_bytes) throw new Error('wall scan byte budget exceeded');
            for (const match of Memory.scanSync(range.base, range.size, C.wall_pass.pattern)) {
                wallState.raw_matches = ++matches;
                if (matches > C.wall_pass.max_matches) throw new Error('wall scan match budget exceeded');
                const pointer = match.address;
                if (Number(pointer.sub(module.base).toString()) < 0 ||
                    Number(pointer.add(C.wall_pass.neighbours[C.wall_pass.neighbours.length - 1][0] + 4).sub(module.base).toString()) > module.size) continue;
                if (wallState.candidates.length < 6) wallState.candidates.push({
                    parameter: address(pointer), value: safe(() => pointer.readFloat()),
                    neighbours: C.wall_pass.neighbours.map(([offset, expected, required]) => ({ offset, expected, required: required !== false,
                        actual: safe(() => numberAt(pointer, offset)) })) });
                if (safe(() => Math.abs(pointer.readFloat() - C.wall_pass.original) <= C.wall_pass.tolerance && wallBlockMatches(pointer)) === true)
                    candidates.set(pointer.toString(), pointer);
            }
        }
        wallState.matches = candidates.size;
        if (candidates.size !== 1) throw new Error('wall parameter block not unique/found: ' + candidates.size);
        const pointer = candidates.values().next().value;
        writableFloat(pointer);
        const original = pointer.readFloat();
        wallPatch = { pointer, original }; // Retain rollback information even if readback fails.
        mutationAttempted = true;
        pointer.writeFloat(C.wall_pass.patched);
        if (Math.abs(pointer.readFloat() - C.wall_pass.patched) > C.wall_pass.tolerance) throw new Error('wall parameter readback mismatch');
        wallState.status = 'applied'; wallState.parameter = address(pointer);
        wallState.original = original; wallState.patched = C.wall_pass.patched; wallState.readback = pointer.readFloat();
        event('wall_pass_applied', { parameter: wallState.parameter });
    } catch (e) {
        wallState.status = 'unavailable'; wallState.error = String(e);
        if (wallPatch) restoreWalls('apply failed');
        event('wall_pass_unavailable', { error: String(e) });
    }
}
function autoTeleport(state) {
    if (!C.auto_teleport.enabled) return;
    try {
        requireClass(state, C.move_white.state_name);
        const phase = state.add(C.state.phase).readS32();
        if (phase !== 1) { restoreWalls('level inactive'); if (wallState) wallState.active = false; autoRun = null; autoSeen.clear(); return; }
        const now = Date.now();
        if (!autoRun || autoRun.state !== state.toString()) {
            autoSeen.clear();
            autoRun = { state: state.toString(), due: now + C.auto_teleport.delay_ms,
                next: now + C.auto_teleport.delay_ms, attempted: 0, moved: 0, halted: false };
            event('auto_level_armed', { due: autoRun.due });
        }
        if (autoRun.halted || now < autoRun.next || state.add(C.state.paused).readU8() !== 0) return;
        enableWalls(state);
        const world = state.add(C.state.world).readPointer();
        const hero = world.add(C.world.hero).readPointer(); requireClass(hero, C.move_white.hero_name);
        const heroBody = hero.add(C.object.body).readPointer(); requireClass(heroBody, C.move_white.hero_body_name);
        const direction = heroBody.add(C.move_white.direction).readS32();
        if (direction !== 1 && direction !== -1) throw new Error('invalid hero direction');
        const target = { x: numberAt(hero, C.object.x) + direction * C.move_white.ahead, y: numberAt(hero, C.object.y) };
        const array = state.add(C.state.objects).readPointer();
        const count = array.add(C.array.slots).readS32();
        if (count < 0 || count > C.limits.slots) throw new Error('auto array invalid/too large');
        const data = array.add(C.array.data).readPointer();
        for (let i = 0; i < count; i++) {
            const object = data.add(i * Process.pointerSize).readPointer();
            if (object.isNull()) continue;
            const id = identity(object);
            if (!id.rtti || id.rtti.name !== C.candy.name) continue;
            const rarity = object.add(C.candy.rarity).readS32();
            if (!C.auto_teleport.rarities.includes(rarity)) continue;
            const body = object.add(C.object.body).readPointer();
            const key = object.toString() + ':' + body.toString();
            if (autoSeen.has(key)) continue;
            // Locked physics is a deferral, not a failed native attempt.
            requireClass(body, C.candy_body_probe.body_name);
            const physics = body.add(C.hero_body.physics).readPointer();
            const physicsWorld = physics.add(C.teleport_white.world).readPointer();
            if (physicsWorld.add(C.teleport_white.lock).readU8() & C.teleport_white.lock_mask) return;
            autoSeen.add(key); autoRun.attempted++;
            const result = { time: now, mode: 'auto_teleport', object: object.toString(), rarity,
                target, success: false, collection_confirmed: false };
            try { teleportCandy(object, target, result); result.success = true; autoRun.moved++; movesExecuted++; }
            catch (e) { result.error = String(e); autoRun.halted = true; autoRun.error = result.error; }
            lastMove = result; event('auto_teleport_result', result);
            autoRun.next = now + C.auto_teleport.interval_ms;
            return; // At most one native rebuild per update.
        }
    } catch (e) {
        if (!autoRun) autoRun = { state: state.toString(), attempted: 0, moved: 0 };
        autoRun.halted = true; autoRun.error = String(e);
        error = String(e); event('auto_teleport_error', { error });
    }
}
function requestAltitude(mode) {
    if (!enabled || !latest || !C.no_fall.enabled) throw new Error('start module and enter active Catacombs first');
    if (latest.phase_raw !== 1 || Date.now() - latest.time > C.altitude_test.expiry_ms)
        throw new Error('active state snapshot missing/stale');
    if (mode === 'return' && (!fallBackup || fallBackup.originY === undefined)) throw new Error('use above before return-height');
    pendingAltitude = { mode, state: latest.state.address, time: Date.now() };
    return { queued: true, mode, warning: 'Manual vertical velocity test; check no_fall.altitude, return before finish.' };
}
function requestMove(mode = 'visual') {
    if (C.auto_teleport.enabled) throw new Error('automatic teleport enabled; manual moves disabled');
    if (mode === 'teleport' && teleportUsed) throw new Error('teleport already attempted; inspect dump before restarting module');
    if (!enabled || !latest) throw new Error('start module and enter Catacombs first');
    if (pendingMove) throw new Error('move already queued');
    if (Date.now() - latest.time > C.move_white.expiry_ms) throw new Error('state snapshot stale');
    pendingMove = { time: Date.now(), state: latest.state.address, mode };
    event('move_white_queued', pendingMove);
    return { queued: true, warning: 'One common object only; check HUD for actual collection.' };
}
function stop() { restoreNoFall('stop'); restoreSpeed('stop'); restoreHeroMasks('stop'); restoreWalls('stop'); autoRun = null; autoSeen.clear(); pendingMove = null; enabled = false; if (hook) hook.detach(); hook = null; }
function status() { return { enabled, error, calls, samples, skipped, resolution, auto_rise_enabled: C.altitude_test.auto_rise, altitude_offset: C.altitude_test.up, altitude_pending: pendingAltitude, no_fall: fallStatus, speed_test: speedTest, hero_mask_test: maskTest, fixture_probe: fixtureReport, wall_pass: wallState, wall_events: wallEvents.slice(), auto_enabled: C.auto_teleport.enabled, auto_run: autoRun,
    teleport_used: teleportUsed, mutation_attempted: mutationAttempted, move_pending: pendingMove, last_move: lastMove, moves_executed: movesExecuted, method_code_retained: methodCode.size, last_sample_time: latest ? latest.time : null, events_retained: events.length }; }
function install() {
    if (enabled) return status();
    pendingAltitude = null;
    if (!fallBackup) fallStatus = null;
    if (!speedBackup) speedTest = null;
    if (!maskBackup) maskTest = null;
    autoRun = null; autoSeen.clear(); fixtureReport = null; filterSymbols = null;
    if (!wallPatch) { wallState = null; wallEvents = []; }
    error = null; calls = 0; samples = 0; skipped = 0; lastTime = null; latest = null;
    history = []; events = []; previous = new Map(); previousState = null; resolution = null; methodCode = new Map(); lifecycleCode = null;
    pendingMove = null; lastMove = null; movesExecuted = 0; mutationAttempted = false; teleportUsed = false;
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
            preventFall(args[0]);
            try { sample(args[0]); } catch (e) { error = String(e); event('sample_error', { error }); }
        }, onLeave() {
            if (!enabled) return;
            applySpeed(this.updateState);
            applyHeroMasks(this.updateState);
            preventFall(this.updateState);
            if (pendingMove) performMove(this.updateState);
            else autoTeleport(this.updateState);
        } });
        enabled = true; event('enabled', { diagnostic_only: true });
    } catch (e) { stop(); error = String(e); throw e; }
    return status();
}
rpc.exports = {
    install, status, above() { return requestAltitude('above'); }, returnHeight() { return requestAltitude('return'); }, moveWhite() { return requestMove(); }, teleportWhite() { return requestMove('teleport'); }, stop() { stop(); return status(); },
    mark(label) { event('user_mark', { label: String(label).slice(0, 160) }); return status(); },
    report() {
        if (!C.diagnostics) return { schema_version: 3, compact: true, diagnostic_only: !mutationAttempted,
            ...status(), metadata: { time: Date.now(), module: moduleInfo,
                warning: 'Physics readback is not proof of collection; check HUD.' },
            latest, events: events.slice() };
        return { schema_version: 2, diagnostic_only: !mutationAttempted, experimental_position_moves: true, ...status(),
        metadata: { time: Date.now(), process_id: Process.id, arch: Process.arch,
            module: moduleInfo, candidate_profile: C.profile, offsets: C,
            warning: 'Candidate fields, not validated ownership or collection. No server verification inferred.' },
        lifecycle_candidates: lifecycleCode, method_code: Object.fromEntries(methodCode), latest, history: history.slice(), events: events.slice() }; },
};
