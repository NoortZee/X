'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function fixture(matches = 1) {
    const memory = new Map(); const writes = []; let callback, detached = 0;
    class P {
        constructor(n) { this.n = n; }
        toString() { return '0x' + this.n.toString(16); }
        add(n) { return new P(this.n + n); }
        sub(p) { return new P(this.n - p.n); }
        isNull() { return !this.n; }
        value() { if (!memory.has(this.n)) throw new Error('unmapped ' + this); return memory.get(this.n); }
        readPointer() { return new P(this.value()); }
        readU8() { return this.value(); }
        readS32() { return this.value(); }
        readFloat() { return this.value(); }
        writeFloat(n) { writes.push([this.n, n]); memory.set(this.n, n); }
        readByteArray(length) { return Uint8Array.from({ length }, (_, i) => memory.get(this.n + i) || 0).buffer; }
    }
    const mod = { name: 'libthieves.so', base: new P(0x100000), size: 0x3000000,
        enumerateRanges: () => [{ base: new P(0x100000), size: 0x3000000 }] };
    const c = vm.createContext({ Process: { id: 42, arch: 'x64', pointerSize: 8,
        findModuleByName: () => mod, findModuleByAddress: () => mod },
        Memory: { scanSync: () => Array.from({ length: matches }, (_, i) => ({ address: new P(0x200000 + i) })) },
        Interceptor: { attach(p, cb) { callback = cb; return { detach() { detached++; } }; } },
        rpc: { exports: {} },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'catacombs/agent.js'), 'utf8'), c);
    function identity(object, vp, ti, text, name) {
        memory.set(object, vp); memory.set(vp - 8, ti); memory.set(ti + 8, text);
        [...Buffer.from(name + '\0')].forEach((b, i) => memory.set(text + i, b));
    }
    identity(0x1000, 0x8000, 0x9000, 0xA000, '20EndlessMazePlayState');
    identity(0x3000, 0x8100, 0x9100, 0xA100, '16EndlessMazeCandy');
    memory.set(0x1068, 0x2000); memory.set(0x2010, 0x2800); memory.set(0x2018, 2);
    memory.set(0x2800, 0x3000); memory.set(0x2808, 0);
    memory.set(0x3034, 12); memory.set(0x3038, 6); memory.set(0x31F0, 4);
    memory.set(0x31A8, 1); memory.set(0x31A9, 1); memory.set(0x3198, 0); memory.set(0x31A0, 0);
    memory.set(0x1040, 0); memory.set(0x1088, 0); memory.set(0x1138, 1);
    return { c, memory, writes, identity, leave() { callback.onLeave(); }, pointer: n => new P(n), rpc: c.rpc.exports, tick() { callback.onEnter([new P(0x1000)]); },
        force() { vm.runInContext('lastTime = null', c); }, detached: () => detached };
}
test('opt-in unique resolution, graph and Candy class/rarity evidence', () => {
    const f = fixture(); assert.equal(f.rpc.status().enabled, false);
    f.rpc.install(); f.tick();
    const r = f.rpc.report();
    assert.equal(r.calls, 1);
    assert.equal(r.latest.state.rtti.name, '20EndlessMazePlayState');
    assert.equal(r.latest.object_graph.classes['16EndlessMazeCandy'], 1);
    assert.equal(r.latest.object_graph.rarity_histogram['4'], 1);
    assert.equal(r.latest.object_graph.candies[0].position.x, 12);
    assert.equal(r.latest.object_graph.objects.length, 2);
    assert.equal(r.latest.object_graph.candies[0].body.null, true);
    assert.equal(r.latest.object_graph.candies[0].rtti.name.includes('\0'), false);
    f.rpc.stop(); f.rpc.stop(); assert.equal(f.detached(), 1);
});
for (const n of [0, 2]) test('reject ambiguous/missing update: ' + n, () => {
    const f = fixture(n); assert.throws(() => f.rpc.install(), /expected 1 match/);
    assert.equal(f.rpc.status().enabled, false);
});
test('sampling, marker and bounded histories/events', () => {
    const f = fixture(); f.rpc.install(); f.tick(); f.tick();
    assert.equal(f.rpc.status().samples, 1);
    f.rpc.mark('picked golden');
    assert.ok(f.rpc.report().events.some(e => e.kind === 'user_mark'));
    for (let i = 0; i < 125; i++) { f.force(); f.tick(); }
    for (let i = 0; i < 1100; i++) f.rpc.mark('test');
    assert.equal(f.rpc.report().history.length, 120);
    assert.equal(f.rpc.report().events.length, 1000);
});
test('failed or truncated scan must not imply disappearance', () => {
    const f = fixture(); f.rpc.install(); f.tick();
    f.memory.delete(0x3000); f.force(); f.tick();
    assert.equal(f.rpc.report().latest.object_graph.complete, false);
    assert.ok(!f.rpc.report().events.some(e => e.kind === 'candy_not_in_array'));
    f.memory.set(0x2018, -1); f.force(); f.tick();
    assert.match(f.rpc.report().latest.object_graph.error, /invalid declared slots/);
    assert.equal(f.rpc.status().enabled, true);
});
test('disappearance is recorded as observation, never credited collection', () => {
    const f = fixture(); f.rpc.install(); f.tick();
    f.memory.set(0x2800, 0); f.force(); f.tick();
    const e = f.rpc.report().events.find(e => e.kind === 'candy_not_in_array');
    assert.match(e.interpretation, /not proof/);
});
test('report never dereferences a retained pointer', () => {
    const f = fixture(); f.rpc.install(); f.tick(); f.memory.clear();
    assert.equal(f.rpc.report().latest.object_graph.candies.length, 1);
});
test('only one explicit native rebuild callsite, no patches or non-position writes', () => {
    const s = fs.readFileSync(path.join(root, 'catacombs/agent.js'), 'utf8');
    assert.doesNotMatch(s, /Interceptor\.(replace|replaceFast)|Memory\.(patchCode|protect)/);
    assert.equal((s.match(/\.writeFloat\(/g) || []).length, 8);
    assert.doesNotMatch(s, /\.write(?:Pointer|S32|U8|ByteArray)\(/);
});
test('LIVE hero chain keeps visual coordinates separate from physics', () => {
    const f = fixture();
    for (const [p, v] of [[0x1040, 0x4000], [0x4018, 0x5000], [0x5198, 0x6000], [0x6020, 0x7000],
        [0x5034, 37892], [0x5038, 393], [0x700C, 12], [0x7010, 6], [0x7040, 2.2],
        [0x7044, 0], [0x7038, 0], [0x7048, 0], [0x70A8, 1]]) f.memory.set(p, v);
    f.rpc.install(); f.tick();
    const graph = f.rpc.report().latest.hero_graph;
    assert.equal(graph.hero.position.x, 37892);
    assert.equal(graph.hero_body.address, '0x6000');
    assert.equal(graph.physics.fields.XF_PX, 12);
    assert.equal(graph.physics.fields.VX, 2.2);
});
test('declared array size is reported when scan is truncated', () => {
    const f = fixture(); f.memory.set(0x2018, 1025); f.rpc.install(); f.tick();
    const graph = f.rpc.report().latest.object_graph;
    assert.equal(graph.declared_slots, 1025);
    assert.equal(graph.scanned_slots, 1024);
    assert.equal(graph.truncated, true);
    assert.equal(graph.complete, false);
});


test('position candidates use byte offsets from vptr without invoking methods', () => {
    const f = fixture();
    f.memory.set(0x8100 + 0x238, 0x200000);
    f.memory.set(0x8100 + 0x268, 0x200100);
    f.rpc.install(); f.tick();
    const candy = f.rpc.report().latest.object_graph.candies[0];
    assert.equal(candy.position_method_candidates.position_set_candidate.target.address, '0x200000');
    assert.equal(candy.position_method_candidates.position_get_candidate.vptr_byte_offset, 0x268);
    assert.equal(candy.position_method_candidates.position_get_candidate.role_is_candidate, true);
    assert.ok(f.rpc.report().method_code['0x200000'].error);
    assert.equal(f.rpc.status().enabled, true);
});

test('method code is bounded, deduplicated, and report uses cached bytes only', () => {
    const f = fixture();
    let reads = 0, decoded = 0;
    f.c.codeTarget = f.pointer(0x200000);
    f.c.codeTarget.readByteArray = length => { reads++; assert.equal(length, 384); return new ArrayBuffer(length); };
    f.c.Process.findRangeByAddress = () => ({ base: f.pointer(0x100000), size: 0x3000000, protection: 'r-x' });
    f.c.Instruction = { parse: () => { decoded++; return { size: 4, mnemonic: 'nop', opStr: '' }; } };
    vm.runInContext('captureMethodCode(codeTarget); captureMethodCode(codeTarget)', f.c);
    const record = f.rpc.report().method_code['0x200000'];
    assert.equal(reads, 1);
    assert.equal(decoded, 96);
    assert.equal(record.instructions.length, 96);
    assert.equal(record.complete_function, false);
    assert.equal(record.function_boundary_verified, false);
    f.memory.clear(); f.rpc.report();
    assert.equal(reads, 1);
});

test('code probe refuses non-executable memory and caps distinct target records', () => {
    const f = fixture();
    f.c.Process.findRangeByAddress = () => ({ protection: 'rw-' });
    for (let i = 0; i < 50; i++) {
        f.c.codeTarget = f.pointer(0x200000 + i * 16);
        vm.runInContext('captureMethodCode(codeTarget)', f.c);
    }
    const records = Object.values(f.rpc.report().method_code);
    assert.equal(records.length, 40);
    assert.match(records[0].error, /not in readable executable/);
});


function movementFixture() {
    const f = fixture();
    f.identity(0x5000, 0x8200, 0x9200, 0xA200, '4Hero');
    f.identity(0x6000, 0x8300, 0x9300, 0xA300, '8HeroBody');
    for (const [p, v] of [[0x1040, 0x4000], [0x4018, 0x5000], [0x5198, 0x6000],
        [0x6020, 0], [0x609C, 1], [0x5034, 500], [0x5038, 600],
        [0x31F0, 1], [0x8338, 0x200000]]) f.memory.set(p, v);
    // Candy vptr + 0x238 = 0x8338.
    [0x48, 0x89, 0xF8, 0x0F, 0x13, 0x47, 0x34, 0xC3]
        .forEach((b, i) => f.memory.set(0x200000 + i, b));
    f.c.Process.findRangeByAddress = () => ({ base: f.pointer(0), size: 0x4000000, protection: 'rwx' });
    f.rpc.install(); f.tick();
    return f;
}
test('move-white is opt-in, queued, one object only, and executed after update', () => {
    const f = movementFixture();
    assert.equal(f.writes.length, 0);
    f.rpc.moveWhite();
    assert.equal(f.writes.length, 0);
    assert.throws(() => f.rpc.moveWhite(), /already queued/);
    f.leave();
    assert.equal(f.rpc.status().last_move.success, true);
    assert.equal(f.rpc.status().last_move.collection_confirmed, false);
    assert.deepEqual(f.writes, [[0x3034, 524], [0x3038, 600]]);
    f.leave(); assert.equal(f.writes.length, 2);
});
test('reject non-common, changed setter, paused run and invalid direction without writes', () => {
    for (const [address, value] of [[0x31F0, 2], [0x200000, 0x90], [0x1088, 1], [0x609C, 0]]) {
        const f = movementFixture(); f.memory.set(address, value); f.rpc.moveWhite(); f.leave();
        assert.equal(f.writes.length, 0);
        assert.equal(f.rpc.status().last_move.success, false);
        assert.ok(f.rpc.status().last_move.error);
    }
});
test('move uses current coordinates and direction, cancels on stop or state change', () => {
    const f = movementFixture(); f.rpc.moveWhite();
    f.memory.set(0x5034, 700); f.memory.set(0x609C, -1); f.leave();
    assert.equal(f.memory.get(0x3034), 676);
    const stopped = movementFixture(); stopped.rpc.moveWhite(); stopped.rpc.stop(); stopped.leave();
    assert.equal(stopped.writes.length, 0);
    const changed = movementFixture(); changed.rpc.moveWhite();
    vm.runInContext('pendingMove.state = "different"', changed.c); changed.leave();
    assert.equal(changed.writes.length, 0);
});
test('expired move request is consumed, not retried', () => {
    const f = movementFixture(); f.rpc.moveWhite();
    vm.runInContext('pendingMove.time -= 6000', f.c); f.leave();
    assert.match(f.rpc.status().last_move.error, /expired/);
    assert.equal(f.rpc.status().move_pending, null);
    assert.equal(f.writes.length, 0);
});
test('failed second coordinate write attempts immediate rollback and reports failure', () => {
    const f = movementFixture();
    const prototype = Object.getPrototypeOf(f.pointer(0));
    const original = prototype.writeFloat;
    prototype.writeFloat = function (value) {
        if (this.n === 0x3038 && value === 600) throw new Error('simulated write failure');
        return original.call(this, value);
    };
    f.rpc.moveWhite(); f.leave();
    assert.equal(f.rpc.status().last_move.success, false);
    assert.equal(f.rpc.status().last_move.rollback, true);
    assert.equal(f.memory.get(0x3034), 12);
    assert.equal(f.memory.get(0x3038), 6);
});

test('Candy physics candidate is read-only and compares independent physical position', () => {
    const f = fixture();
    f.identity(0x6000, 0x8300, 0x9300, 0xA300, '20EndlessMazeCandyBody');
    for (const [p, v] of [[0x3198, 0x6000], [0x6020, 0x7000], [0x7000, 0],
        [0x700C, 0.12], [0x7010, 0.06], [0x7040, 0], [0x7044, 0],
        [0x7038, 0], [0x7048, 0], [0x70A8, 0]]) f.memory.set(p, v);
    f.c.Process.findRangeByAddress = () => ({ base: f.pointer(0), size: 0x4000000, protection: 'rw-' });
    f.rpc.install(); f.tick();
    let candidate = f.rpc.report().latest.object_graph.candies[0].physics_candidate;
    assert.equal(candidate.position_matches, true);
    assert.equal(candidate.candidate_only, true);
    f.memory.set(0x3034, 100); f.force(); f.tick();
    candidate = f.rpc.report().latest.object_graph.candies[0].physics_candidate;
    assert.equal(candidate.position_matches, false);
    assert.equal(candidate.fields.XF_PX, 0.12);
    assert.equal(f.writes.length, 0);
});
test('Candy physics candidate refuses wrong class and inaccessible memory', () => {
    const f = fixture(); f.memory.set(0x3198, 0x6000);
    f.identity(0x6000, 0x8300, 0x9300, 0xA300, '8HeroBody');
    f.rpc.install(); f.tick();
    assert.match(f.rpc.report().latest.object_graph.candies[0].physics_candidate.error, /unexpected class/);
    assert.equal(f.writes.length, 0);
});
test('Body call probe follows only bounded direct calls, never indirect calls', () => {
    const f = fixture();
    f.memory.set(0x6000, 0x8300); f.memory.set(0x8318, 0x200000);
    f.c.bodyPointer = f.pointer(0x6000);
    vm.runInContext(`
        methodCode.set('0x200000', { instructions: [
            { mnemonic: 'call', operands: 'rax' },
            ...Array.from({length: 12}, (_, i) => ({mnemonic: 'call', operands: '0x' + (0x210000 + i).toString(16), address: {address: '0x200010'}}))
        ] });
    `, f.c);
    const result = vm.runInContext('bodyCallProbe(bodyPointer)', f.c);
    assert.equal(result.calls.length, 8);
    assert.equal(result.calls[0].target.address, '0x210000');
    assert.equal(f.writes.length, 0);
});

test('lifecycle candidates are ASLR-relative, cached, and never invoked', () => {
    const f = fixture();
    assert.equal(f.rpc.report().lifecycle_candidates, null);
    f.rpc.install(); f.tick();
    const roots = f.rpc.report().lifecycle_candidates;
    assert.equal(roots.position_wrapper_candidate.target.rva, '0x1618980');
    assert.equal(roots.destroy_candidate.target.address, '0x1715cb0');
    assert.equal(roots.create_candidate.target.rva, '0x1617de0');
    assert.ok(f.rpc.report().method_code[roots.create_candidate.code_key].error);
    f.memory.clear();
    assert.equal(f.rpc.report().lifecycle_candidates, roots);
    assert.equal(f.writes.length, 0);
});
test('physics sweep candidates do not replace the validated transform coordinates', () => {
    const f = fixture();
    f.identity(0x6000, 0x8300, 0x9300, 0xA300, '20EndlessMazeCandyBody');
    for (const [p,v] of [[0x3198,0x6000],[0x6020,0x7000],[0x7000,0],
        [0x700C,0.12],[0x7010,0.06],[0x7040,0],[0x7044,0],[0x7038,0],
        [0x7048,0],[0x70A8,1],[0x7028,123],[0x702C,456],[0x7058,0xA000]]) f.memory.set(p,v);
    f.c.Process.findRangeByAddress = () => ({base:f.pointer(0),size:0x4000000,protection:'rw-'});
    f.rpc.install(); f.tick();
    const physics = f.rpc.report().latest.object_graph.candies[0].physics_candidate;
    assert.equal(physics.position_matches, true);
    assert.equal(physics.extra_candidates.sweep_x_candidate,123);
    assert.equal(physics.extra_candidates.world_candidate.address,'0xa000');
    assert.equal(f.writes.length,0);
});

test('Candy Body +0x68 is resolved from current object vptr, not a fixed target', () => {
    const f = fixture();
    f.identity(0x6000, 0x8300, 0x9300, 0xA300, '20EndlessMazeCandyBody');
    f.memory.set(0x3198, 0x6000); f.memory.set(0x8368, 0x240000);
    f.rpc.install(); f.tick();
    const method = f.rpc.report().latest.object_graph.candies[0].body_method_candidates.recreate_candidate;
    assert.equal(method.vptr_byte_offset, 0x68);
    assert.equal(method.target.address, '0x240000');
    assert.ok(method.code_key);
    assert.equal(f.writes.length, 0);
});

test('lifecycle has independent unique-callee budgets and stops at first return', () => {
    const f = fixture();
    vm.runInContext(`
        captureMethodCode = function(target, bytes, instructions) {
            const key = target.toString();
            if (!methodCode.has(key)) methodCode.set(key, { instructions: [], requested_bytes: bytes, requested_instructions: instructions });
            return key;
        };
    `, f.c);
    for (const rva of [0x1618980, 0x1615CB0, 0x1617DE0]) {
        f.c.root = f.pointer(0x100000 + rva);
        vm.runInContext(`methodCode.set(root.toString(), { instructions: [
            ...Array.from({length: 6}, (_, i) => ({mnemonic:'call', operands:'0x' + (0x200000 + Math.floor(i/2)).toString(16)})),
            {mnemonic:'ret', operands:''}, {mnemonic:'call', operands:'0x299999'}
        ] });`, f.c);
    }
    vm.runInContext('captureLifecycleCandidates()', f.c);
    for (const record of Object.values(f.rpc.report().lifecycle_candidates)) {
        assert.equal(record.calls.length, 3);
        assert.ok(record.calls.every(c => c.target.address !== '0x299999'));
    }
    assert.equal(f.writes.length, 0);
});

test('create root requests extended bounded window', () => {
    const f = fixture();
    vm.runInContext(`captureMethodCode = function(target, bytes, instructions) {
        methodCode.set(target.toString(), {instructions: [], requested_bytes: bytes, requested_instructions: instructions});
        return target.toString();
    }; captureLifecycleCandidates();`, f.c);
    const report = f.rpc.report();
    const code = report.method_code[report.lifecycle_candidates.create_candidate.code_key];
    assert.equal(code.requested_bytes, 1536);
    assert.equal(code.requested_instructions, 512);
});

function teleportFixture() {
    const f = movementFixture();
    f.identity(0x16000, 0xB000, 0xC000, 0xD000, '20EndlessMazeCandyBody');
    for (const [p,v] of [[0x3198,0x16000],[0x16020,0xE000],[0xE000,0],[0xE00C,0.12],
        [0xE010,0.06],[0xE040,0],[0xE044,0],[0xE038,0],[0xE048,0],[0xE0A8,1],
        [0xE0B8,0x16000],[0xE058,0xF000],[0xF000+0x19298,0],[0xB068,0x100000+0x1617DE0],
        [0x16038,12],[0x1603C,6]]) f.memory.set(p,v);
    const sigs = vm.runInContext('MEMORY_LAYOUT.catacombs.teleport_white.signatures',f.c);
    for (const sig of sigs) sig.bytes.forEach((b,i)=>f.memory.set(0x100000+sig.rva+i,b));
    let nativeCalls=0;
    f.c.NativeFunction = function (target, ret, args) {
        assert.equal(target.toString(),'0x1715cb0');
        assert.equal(ret,'void'); assert.equal(args.join(','),'pointer');
        return body => {
            nativeCalls++;
            assert.equal(body.toString(),'0x16000');
            f.memory.set(0xE00C,f.memory.get(0x16038)/100);
            f.memory.set(0xE010,f.memory.get(0x1603C)/100);
        };
    };
    return {...f, nativeCalls:()=>nativeCalls};
}
test('teleport is queued, calls rebuild once with Body*, verifies physics not collection',()=>{
    const f=teleportFixture(); f.rpc.teleportWhite(); assert.equal(f.nativeCalls(),0); f.leave();
    const s=f.rpc.status(); assert.equal(s.last_move.success,true, JSON.stringify(s.last_move));
    assert.equal(s.last_move.collection_confirmed,false); assert.equal(s.last_move.physics_readback.x,524);
    assert.equal(f.nativeCalls(),1); assert.equal(f.memory.get(0x3034),12);
    assert.equal(f.memory.get(0x16038),524); assert.equal(f.memory.get(0x1603C),600);
    assert.equal(f.rpc.report().diagnostic_only,false);
    assert.throws(()=>f.rpc.teleportWhite(),/already attempted/);
    f.leave(); assert.equal(f.nativeCalls(),1);
});
test('teleport refuses locked world, owner mismatch, changed code, wrong recreate target before writes',()=>{
    for (const [p,v] of [[0xF000+0x19298,2],[0xE0B8,0],[0x1715CB0,0x90],[0xB068,0x200000]]) {
        const f=teleportFixture(); f.memory.set(p,v); f.rpc.teleportWhite(); f.leave();
        assert.equal(f.rpc.status().last_move.success,false); assert.ok(f.rpc.status().last_move.error);
        assert.equal(f.nativeCalls(),0); assert.equal(f.writes.length,0);
    }
});
test('native failure is uncertain: no rollback or retry and report no longer read-only',()=>{
    const f=teleportFixture(); f.c.NativeFunction=function(){return ()=>{throw Error('native failed');};};
    f.rpc.teleportWhite();f.leave();const r=f.rpc.status().last_move;
    assert.equal(r.success,false);assert.equal(r.native_started,true);
    assert.match(r.warning,/uncertain/);assert.equal(r.rollback,undefined);
    assert.equal(f.rpc.report().diagnostic_only,false);
    assert.throws(()=>f.rpc.teleportWhite(),/already attempted/);
});
