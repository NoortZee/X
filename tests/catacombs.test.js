'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function fixture(matches = 1, production = false, underground = false, autoRise = false, observeAttach = false) {
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
        writeS32(n) { writes.push([this.n,n]); memory.set(this.n,n); }
        writePointer(p) { writes.push([this.n,p.n]); memory.set(this.n,p.n); }
        readU64() { return { toString: () => String(this.value()) }; }
        readU16() { return this.value(); }
        readS16() { const n = this.value(); return n > 32767 ? n - 65536 : n; }
        readFloat() { return this.value(); }
        writeU16(n) { writes.push([this.n,n]); memory.set(this.n,n); }
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
    vm.runInContext((production ? fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8').replace(/underground: (?:true|false)/, 'underground: ' + underground).replace('auto_rise: true', 'auto_rise: ' + autoRise).replace('up: 1920', autoRise ? 'up: 1920' : 'up: 768').replace('timeout_ms: 6000', autoRise ? 'timeout_ms: 6000' : 'timeout_ms: 3000') : fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8').replace('no_fall: { enabled: true', 'no_fall: { enabled: false').replace('speed_test: { enabled: true', 'speed_test: { enabled: false').replace('mask_test: { enabled: true', 'mask_test: { enabled: false').replace('wall_pass: { enabled: false', 'wall_pass: { enabled: true').replace('diagnostics: false', 'diagnostics: true').replace('auto_teleport: { enabled: true', 'auto_teleport: { enabled: false')) .replace('observe_attach: true', 'observe_attach: ' + observeAttach) + '\n' +
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
    assert.equal((s.match(/\.writeFloat\(/g) || []).length, 18);
    const core=s.replace(/function convertGoldDescriptor[\s\S]*?(?=function enableAllGold)/,'').replace(/function fullGoldPlan[\s\S]*?(?=function performGold)/,'')
        .replace(/object\.add\(0x184\)\.writeS32\(fullPlan.id\);/,'');
    assert.doesNotMatch(core, /\.write(?:Pointer|S32|U8|ByteArray)\(/);
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


function movementFixture(production = false, underground = false, autoRise = false) {
    const f = fixture(1, production, underground, autoRise);
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

function teleportFixture(production = false, underground = false, autoRise = false) {
    const f = movementFixture(production, underground, autoRise);
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

function autoFixture(underground = false, autoRise = false) {
    const f = teleportFixture(true, underground, autoRise);
    f.c.testTime = 1000;
    vm.runInContext('Date.now = () => testTime', f.c);
    return f;
}
test('production report is compact and automation waits 300ms then moves once per object', () => {
    const f = autoFixture(); f.leave();
    assert.equal(f.nativeCalls(),0);
    f.c.testTime = 1299; f.leave(); assert.equal(f.nativeCalls(),0);
    f.c.testTime = 1300; f.leave(); assert.equal(f.nativeCalls(),1);
    f.c.testTime = 2000; f.leave(); assert.equal(f.nativeCalls(),1);
    const r = f.rpc.report(); assert.equal(r.compact,true);
    assert.equal(r.method_code,undefined); assert.equal(r.history,undefined);
    assert.equal(r.auto_run.moved,1); assert.equal(r.method_code_retained,0);
    assert.ok(JSON.stringify(r).length < 10000);
});
test('automatic teleport covers all four rarities, pauses and defers locked world', () => {
    for (const rarity of [1,2,3,4]) {
        const f=autoFixture(); f.memory.set(0x31F0,rarity); f.leave();
        f.c.testTime=1300; f.memory.set(0x1088,1); f.leave(); assert.equal(f.nativeCalls(),0);
        f.memory.set(0x1088,0); f.memory.set(0xF000+0x19298,2); f.leave(); assert.equal(f.nativeCalls(),0);
        f.memory.set(0xF000+0x19298,0); f.leave(); assert.equal(f.nativeCalls(),1);
        assert.equal(f.rpc.status().last_move.rarity,rarity);
    }
});
test('auto halts after validation failure and rearms only on observed level phase transition',()=>{
    const f=autoFixture(); f.leave(); f.c.testTime=1300;
    f.memory.set(0xE0B8,0); f.leave(); assert.equal(f.rpc.status().auto_run.halted,true);
    f.memory.set(0xE0B8,0x16000); f.c.testTime=2000; f.leave(); assert.equal(f.nativeCalls(),0);
    f.memory.set(0x1138,0); f.leave(); assert.equal(f.rpc.status().auto_run,null);
    f.memory.set(0x1138,1); f.leave(); f.c.testTime=2300; f.leave(); assert.equal(f.nativeCalls(),1);
    f.rpc.stop(); f.c.testTime=4000; f.leave(); assert.equal(f.nativeCalls(),1);
});
test('auto handles multiple Candy objects across updates, not one session-only teleport',()=>{
    const f=autoFixture();
    f.identity(0x4000,0x8100,0x9100,0xA100,'16EndlessMazeCandy');
    f.identity(0x17000,0xB000,0xC000,0xD000,'20EndlessMazeCandyBody');
    for(const [p,v] of [[0x2808,0x4000],[0x4034,40],[0x4038,60],[0x41F0,3],
        [0x4198,0x17000],[0x17020,0x18000],[0x17038,40],[0x1703C,60],
        [0x18000,0],[0x1800C,0.4],[0x18010,0.6],[0x18040,0],[0x18044,0],
        [0x18038,0],[0x18048,0],[0x180A8,1],[0x180B8,0x17000],[0x18058,0xF000]]) f.memory.set(p,v);
    let calls=0;
    f.c.NativeFunction=function(){return body=>{
        calls++;
        const physics=f.memory.get(body.n+0x20);
        f.memory.set(physics+0xC,f.memory.get(body.n+0x38)/100);
        f.memory.set(physics+0x10,f.memory.get(body.n+0x3C)/100);
    };};
    f.leave(); f.c.testTime=1300; f.leave(); assert.equal(calls,1);
    f.leave(); assert.equal(calls,1);
    f.c.testTime=1320; f.leave(); assert.equal(calls,2);
    f.c.testTime=1400; f.leave(); assert.equal(calls,2);
    assert.equal(f.rpc.status().auto_run.moved,2);
    assert.throws(()=>f.rpc.teleportWhite(),/automatic teleport enabled/);
});

function wallFixture(count = 1, mismatch = false, production = false) {
    const f = fixture(1, production);
    const mod=f.c.Process.findModuleByName();
    mod.enumerateRanges=()=>[{base:f.pointer(0x200000),size:0x100000}];
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0x200000),size:0x100000,protection:'rw-'});
    f.c.Memory.scanSync=()=>Array.from({length:count},(_,i)=>({address:f.pointer(0x250000+i*0x200)}));
    const neighbours=vm.runInContext('MEMORY_LAYOUT.catacombs.wall_pass.neighbours',f.c);
    for(let i=0;i<count;i++) {
        const base=0x250000+i*0x200;f.memory.set(base,26.67499923706);
        for(const [off,value] of neighbours) f.memory.set(base+off,value);
    }
    if(mismatch)f.memory.set(0x250008,999);
    f.c.wallTestState=f.pointer(0x1000);
    return f;
}
test('Lua wall parameter applies only to unique validated block and restores original on stop',()=>{
    const f=wallFixture(); vm.runInContext('enableWalls(wallTestState)',f.c);
    assert.equal(f.rpc.status().wall_pass.status,'applied');
    assert.equal(f.memory.get(0x250000),-3.00000691414);
    assert.equal(f.memory.get(0x250008),2.20000004768); // no speed/reward modification
    vm.runInContext('enableWalls(wallTestState)',f.c);assert.equal(f.writes.length,1);
    f.rpc.stop(); assert.equal(f.memory.get(0x250000),26.67499923706);
    assert.equal(f.rpc.status().wall_pass.status,'restored');
});
test('wall mode refuses missing, ambiguous or mismatching parameter block',()=>{
    for(const [count,mismatch] of [[0,false],[2,false],[1,true]]) {
        const f=wallFixture(count,mismatch);vm.runInContext('enableWalls(wallTestState)',f.c);
        assert.equal(f.rpc.status().wall_pass.status,'unavailable');assert.equal(f.writes.length,0);
    }
});
test('wall restoration does not overwrite external edits',()=>{
    const f=wallFixture();vm.runInContext('enableWalls(wallTestState)',f.c);
    f.memory.set(0x250000,123);f.rpc.stop();
    assert.equal(f.memory.get(0x250000),123);assert.equal(f.rpc.status().wall_pass.status,'restore_failed');
});
test('wall result survives inactive level and auto-event eviction, retries next observed level',()=>{
    const f=wallFixture(0);
    vm.runInContext('enableWalls(wallTestState)',f.c);
    const first=f.rpc.status().wall_pass;
    assert.equal(first.status,'unavailable');assert.equal(first.ranges,1);
    assert.equal(first.scanned_bytes,0x100000);assert.equal(first.raw_matches,0);
    f.memory.set(0x1138,2);
    vm.runInContext(`
        // Enable auto scheduling just for this direct phase-reset check.
        restoreWalls('level inactive'); if (wallState) wallState.active = false;
        for (let i=0;i<1100;i++) event('auto_teleport_result',{success:true});
    `,f.c);
    assert.equal(f.rpc.status().wall_pass.status,'unavailable');
    assert.ok(f.rpc.status().wall_events.some(e=>e.kind==='wall_pass_unavailable'));
    vm.runInContext('enableWalls(wallTestState)',f.c);
    assert.notEqual(f.rpc.status().wall_pass,first);
});
test('wall candidate report includes actual neighbouring values on mismatch without writes',()=>{
    const f=wallFixture(1,true);vm.runInContext('enableWalls(wallTestState)',f.c);
    const r=f.rpc.status().wall_pass;
    assert.equal(r.raw_matches,1);assert.equal(r.matches,0);
    assert.equal(r.candidates[0].neighbours[0].actual,999);
    assert.equal(f.writes.length,0);
});
test('production no longer applies legacy wall parameter',()=>{
    const f=autoFixture(); f.leave(); f.c.testTime=1300; f.leave();
    assert.equal(f.rpc.status().wall_pass,null);
    f.memory.set(0x1138,2); f.leave();
    assert.equal(f.rpc.status().wall_pass,null);
    assert.equal(f.rpc.report().wall_events.length,0);
});
test('live 2.84.2 collectable-offset mismatch is observational, not a wall write veto',()=>{
    const f=wallFixture();f.memory.set(0x250108,0.19099999964237213);
    vm.runInContext('enableWalls(wallTestState)',f.c);
    const r=f.rpc.status().wall_pass;
    assert.equal(r.status,'applied');assert.equal(r.matches,1);
    assert.equal(r.readback,-3.00000691414);
    const observation=r.candidates[0].neighbours.find(n=>n.offset===0x108);
    assert.equal(observation.required,false);assert.equal(observation.actual,0.19099999964237213);
    assert.equal(f.memory.get(0x250108),0.19099999964237213);
    f.rpc.stop();assert.equal(f.memory.get(0x250000),26.67499923706);
});
test('each of four required Lua neighbours still vetoes writes independently',()=>{
    for(const off of [0x8,0x20,0x64,0x68]) {
        const f=wallFixture();f.memory.set(0x250000+off,999);
        vm.runInContext('enableWalls(wallTestState)',f.c);
        assert.equal(f.rpc.status().wall_pass.status,'unavailable');assert.equal(f.writes.length,0);
    }
});

test('fixture probe reads bounded chain, unsigned masks and signed group without writes',()=>{
    const f=fixture(); f.c.physicsTest=f.pointer(0x10000);
    for (const [p,v] of [[0x10070,0x11000],[0x11010,0x10000],[0x11034,2],
        [0x11036,65535],[0x11038,65535],[0x11008,0]]) f.memory.set(p,v);
    const r=vm.runInContext('fixtureChain(physicsTest)',f.c);
    assert.equal(r.complete,true);assert.equal(r.fixtures[0].category,2);
    assert.equal(r.fixtures[0].mask,65535);assert.equal(r.fixtures[0].group,-1);
    assert.equal(f.writes.length,0);
    f.memory.set(0x11008,0x11000);
    assert.match(vm.runInContext('fixtureChain(physicsTest)',f.c).error,/cycle/);
    f.memory.set(0x11010,0x999);
    assert.match(vm.runInContext('fixtureChain(physicsTest)',f.c).error,/owner mismatch/);
});
test('fixture probe caps chain traversal at eight fixtures',()=>{
    const f=fixture();f.c.physicsTest=f.pointer(0x10000);f.memory.set(0x10070,0x11000);
    for(let i=0;i<9;i++) {
        const address=0x11000+i*0x100;
        for(const [off,v] of [[0x10,0x10000],[0x34,2],[0x36,65535],[0x38,0],[8,address+0x100]])f.memory.set(address+off,v);
    }
    const r=vm.runInContext('fixtureChain(physicsTest)',f.c);
    assert.equal(r.fixtures.length,8);assert.equal(r.truncated,true);assert.equal(r.complete,false);
});
test('filter export discovery is cached, reports no ABI guarantee and does not call native',()=>{
    const f=fixture();let enumerations=0;
    f.c.Process.findModuleByName().enumerateExports=()=>{
        enumerations++;return [{type:'function',name:'_ZN9b2Fixture8RefilterEv',address:f.pointer(0x240000)}];
    };
    vm.runInContext('probeFilterSymbols(); probeFilterSymbols()',f.c);
    assert.equal(enumerations,1);
    const found=vm.runInContext('filterSymbols',f.c);
    assert.equal(found.candidates.length,1);assert.equal(found.candidates[0].candidate_only,true);
    assert.equal(f.writes.length,0);
});
test('compact dump retains most recent active fixture observation after level exit',()=>{
    const f=autoFixture();f.force();f.tick();
    assert.equal(f.rpc.report().fixture_probe.read_only,true);
    const time=f.rpc.report().fixture_probe.time;
    f.memory.set(0x1138,2);f.c.testTime+=1000;f.force();f.tick();
    assert.equal(f.rpc.report().fixture_probe.time,time);
    assert.ok(JSON.stringify(f.rpc.report()).length<20000);
});

function maskFixture(underground = false, autoRise = false) {
    const f=autoFixture(underground, autoRise);
    f.memory.set(0x6020,0x20000);f.memory.set(0x20058,0xF000);f.memory.set(0x20070,0x21000);
    for(let i=0;i<5;i++) {
        const a=0x21000+i*0x100;
        for(const [off,v] of [[0x10,0x20000],[0x34,2],[0x36,i===4?1:65533],[0x38,0],[8,i===4?0:a+0x100]])f.memory.set(a+off,v);
    }
    return f;
}
test('explicit mask=4 experiment changes all five fixtures once, stop restores individual masks',()=>{
    const f=maskFixture();f.leave();
    assert.equal(f.rpc.status().hero_mask_test.status,'applied');
    assert.equal(f.rpc.status().hero_mask_test.count,5);
    for(let i=0;i<5;i++)assert.equal(f.memory.get(0x21036+i*0x100),4);
    f.leave();assert.equal(f.writes.length,5);
    f.rpc.stop();assert.equal(f.rpc.status().hero_mask_test.status,'restored');
    for(let i=0;i<5;i++)assert.equal(f.memory.get(0x21036+i*0x100),i===4?1:65533);
});
test('mask experiment refuses lock, unexpected group and invalid owner without writes',()=>{
    for(const [address,value] of [[0xF000+0x19298,2],[0x21038,1],[0x21010,0]]) {
        const f=maskFixture();f.memory.set(address,value);f.leave();
        assert.equal(f.rpc.status().hero_mask_test.status,'failed');assert.equal(f.writes.length,0);
    }
});
test('mask restore refuses changed Hero physics instead of touching old fixture pointers',()=>{
    const f=maskFixture();f.leave();f.memory.set(0x6020,0);f.rpc.stop();
    assert.equal(f.rpc.status().hero_mask_test.status,'restore_failed');assert.equal(f.writes.length,5);
});
test('mask partial failure attempts restoration without retrying application',()=>{
    const f=maskFixture();const proto=Object.getPrototypeOf(f.pointer(0));const write=proto.writeU16;
    proto.writeU16=function(n){if(this.n===0x21236 && n===4)throw Error('write fault');return write.call(this,n);};
    f.leave();assert.equal(f.rpc.status().hero_mask_test.status,'restored');
    assert.equal(f.memory.get(0x21036),65533);assert.equal(f.memory.get(0x21136),65533);
    const count=f.writes.length;f.leave();assert.equal(f.writes.length,count);
});

test('normal speed configuration uses multiplier one and preserves baseline',()=>{
    const f=wallFixture(1,false,true);
    vm.runInContext('applySpeed(wallTestState)',f.c);
    const r=f.rpc.status().speed_test;
    assert.equal(r.status,'applied');assert.equal(r.multiplier,1);
    assert.ok(Math.abs(f.memory.get(0x250008)-2.2)<0.0001);
    assert.equal(f.memory.get(0x250000),26.67499923706);
    assert.equal(f.writes.length,1);
    vm.runInContext('applySpeed(wallTestState)',f.c);assert.equal(f.writes.length,1);
    f.rpc.stop();assert.equal(f.memory.get(0x250008),2.20000004768);
    assert.equal(f.rpc.status().speed_test.status,'restored');
});
test('speed config search refuses missing, ambiguous or bad required neighbours',()=>{
    for(const [count,mismatch] of [[0,false],[2,false],[1,true]]) {
        const f=wallFixture(count,mismatch,true);vm.runInContext('applySpeed(wallTestState)',f.c);
        assert.equal(f.rpc.status().speed_test.status,'unavailable');assert.equal(f.writes.length,0);
    }
});
test('speed restores on inactive phase and rearms next level, not during pause',()=>{
    const f=wallFixture(1,false,true);f.memory.set(0x1088,1);
    vm.runInContext('applySpeed(wallTestState)',f.c);assert.equal(f.writes.length,0);
    f.memory.set(0x1088,0);vm.runInContext('applySpeed(wallTestState)',f.c);
    f.memory.set(0x1138,2);vm.runInContext('applySpeed(wallTestState)',f.c);
    assert.equal(f.rpc.status().speed_test.status,'restored');
    assert.equal(f.memory.get(0x250008),2.20000004768);
    f.memory.set(0x1138,1);vm.runInContext('applySpeed(wallTestState)',f.c);
    assert.equal(f.rpc.status().speed_test.status,'applied');
});
test('speed restore does not overwrite external modifications',()=>{
    const f=wallFixture(1,false,true);vm.runInContext('applySpeed(wallTestState)',f.c);
    f.memory.set(0x250008,7);f.rpc.stop();
    assert.equal(f.memory.get(0x250008),7);assert.equal(f.rpc.status().speed_test.status,'restore_failed');
});

test('physics readback accepts observed large-coordinate float32 roundoff, not actual displacement',()=>{
    const f=fixture();
    f.c.targetTest={x:74045.4453125,y:1599779.25};
    f.c.readbackTest={x:74045.44067382812,y:1599779.19921875};
    let r=vm.runInContext('physicsPositionCheck(targetTest,readbackTest)',f.c);
    assert.equal(r.matches,true);assert.ok(r.error.y>0.05);assert.ok(r.tolerance.y<0.5);
    f.c.readbackTest.y+=5;r=vm.runInContext('physicsPositionCheck(targetTest,readbackTest)',f.c);
    assert.equal(r.matches,false);
    f.c.readbackTest.y=NaN;
    assert.throws(()=>vm.runInContext('physicsPositionCheck(targetTest,readbackTest)',f.c),/non-finite/);
});
test('physics precision check retains tight bounds near origin and handles negative coordinates',()=>{
    const f=fixture();
    for (const sign of [1,-1]) {
        f.c.targetTest={x:sign*20,y:sign*30};f.c.readbackTest={x:sign*20.01,y:sign*30.01};
        const r=vm.runInContext('physicsPositionCheck(targetTest,readbackTest)',f.c);
        assert.equal(r.matches,true);assert.ok(r.tolerance.x<0.051);
        f.c.readbackTest.x+=1;assert.equal(vm.runInContext('physicsPositionCheck(targetTest,readbackTest)',f.c).matches,false);
    }
});
test('automatic series does not halt on float32 roundoff at live large Y',()=>{
    const f=autoFixture();f.memory.set(0x5034,74021.4453125);f.memory.set(0x5038,1599779.25);
    f.c.NativeFunction=function(){return body=>{
        const p=f.memory.get(body.n+0x20);
        f.memory.set(p+0xC,Math.fround(f.memory.get(body.n+0x38)/100));
        f.memory.set(p+0x10,Math.fround(f.memory.get(body.n+0x3C)/100));
    };};
    f.leave();f.c.testTime=1300;f.leave();
    assert.equal(f.rpc.status().auto_run.halted,false);
    assert.equal(f.rpc.status().auto_run.moved,1);
    assert.equal(f.rpc.status().last_move.position_check.matches,true);
});

function noFallFixture(underground = false, autoRise = false) {
    const f=maskFixture(underground, autoRise);
    f.memory.set(0x20000,2);f.memory.set(0x200A8,1);f.memory.set(0x20044,20);
    return f;
}
test('no-fall disables gravity/vertical velocity, restores gravity but not stale falling speed',()=>{
    const f=noFallFixture();f.leave();
    assert.equal(f.memory.get(0x200A8),0);assert.equal(f.memory.get(0x20044),0);
    assert.equal(f.rpc.status().no_fall.status,'active');
    f.memory.set(0x20044,5);f.tick();assert.equal(f.memory.get(0x20044),0);
    f.memory.set(0x20044,-5);f.leave();assert.equal(f.memory.get(0x20044),0);
    f.rpc.stop();assert.equal(f.memory.get(0x200A8),1);assert.equal(f.memory.get(0x20044),0);
    assert.equal(f.rpc.status().no_fall.status,'restored');
});
test('no-fall restores gravity on phase exit and avoids locked-world writes',()=>{
    const f=noFallFixture();f.leave();f.memory.set(0x1138,2);f.leave();
    assert.equal(f.memory.get(0x200A8),1);
    const locked=noFallFixture();locked.memory.set(0xF000+0x19298,2);locked.leave();
    assert.equal(locked.memory.get(0x200A8),1);assert.equal(locked.memory.get(0x20044),20);
});
test('no-fall restore refuses stale Hero and externally changed gravity',()=>{
    for(const [address,value] of [[0x6020,0],[0x200A8,2]]) {
        const f=noFallFixture();f.leave();f.memory.set(address,value);f.rpc.stop();
        assert.equal(f.rpc.status().no_fall.status,'restore_failed');
        if(address===0x200A8)assert.equal(f.memory.get(address),2);
    }
});

test('underground descent uses positive VY to a fixed start+64 target, then stops without accumulating offset',()=>{
    const f=noFallFixture(true);f.leave();
    assert.equal(f.rpc.status().no_fall.target_y,664);
    assert.equal(f.memory.get(0x20044),2);
    f.memory.set(0x5038,632);f.tick();f.leave();
    assert.equal(f.rpc.status().no_fall.target_y,664);assert.equal(f.memory.get(0x20044),2);
    f.memory.set(0x5038,665);f.tick();f.leave();
    assert.equal(f.memory.get(0x20044),0);assert.equal(f.rpc.status().no_fall.descent,'complete');
    f.memory.set(0x5038,670);f.leave();assert.equal(f.rpc.status().no_fall.target_y,664);
    assert.equal(f.memory.get(0x20044),0);
    assert.ok(!f.writes.some(([p])=>p===0x5038 || p===0x20010));
});
test('underground descent times out without retry, and stop clears forced vertical speed',()=>{
    const f=noFallFixture(true);f.leave();f.c.testTime=3001;f.leave();
    assert.equal(f.rpc.status().no_fall.descent,'timed_out');assert.equal(f.memory.get(0x20044),0);
    f.c.testTime=4000;f.leave();assert.equal(f.memory.get(0x20044),0);
    const stopped=noFallFixture(true);stopped.leave();assert.equal(stopped.memory.get(0x20044),2);
    stopped.rpc.stop();assert.equal(stopped.memory.get(0x20044),0);assert.equal(stopped.memory.get(0x200A8),1);
});


test('shipped configuration disables underground descent while preserving no-fall, speed and masks',()=>{
    const profile=fs.readFileSync(path.join(root,'memory/offsets.js'),'utf8');
    const values=vm.runInNewContext(profile+'; ({fall: MEMORY_LAYOUT.catacombs.no_fall, mask: MEMORY_LAYOUT.catacombs.mask_test.enabled, speed: MEMORY_LAYOUT.catacombs.speed_test.multiplier, auto: MEMORY_LAYOUT.catacombs.auto_teleport.enabled})');
    assert.equal(values.fall.underground,false);
    assert.equal(values.fall.enabled,true);
    assert.equal(values.mask,true);assert.equal(values.speed,1);assert.equal(values.auto,true);
});

test('manual above queues upward velocity and return-height uses original altitude without cumulative offset',()=>{
    const f=noFallFixture();f.leave();f.force();f.tick();
    assert.throws(()=>f.rpc.returnHeight(),/above/);
    f.rpc.above();assert.equal(f.memory.get(0x20044),0);f.leave();
    assert.equal(f.memory.get(0x20044),-8);assert.equal(f.rpc.status().no_fall.altitude.target_y,-168);
    f.memory.set(0x5038,-168);f.tick();f.leave();
    assert.equal(f.memory.get(0x20044),0);assert.equal(f.rpc.status().no_fall.altitude.status,'reached');
    f.rpc.above();f.leave();assert.equal(f.rpc.status().no_fall.altitude.target_y,-168);
    f.rpc.returnHeight();f.leave();assert.equal(f.memory.get(0x20044),8);
    assert.equal(f.rpc.status().no_fall.altitude.target_y,600);
    f.memory.set(0x5038,600);f.tick();f.leave();assert.equal(f.memory.get(0x20044),0);
});
test('manual altitude timeout stops velocity, stop clears pending, no automatic rise',()=>{
    const f=noFallFixture();f.leave();f.force();f.tick();
    assert.equal(f.rpc.status().no_fall.altitude,undefined);
    f.rpc.above();f.leave();f.c.testTime=4001;f.leave();
    assert.equal(f.rpc.status().no_fall.altitude.status,'timed_out');assert.equal(f.memory.get(0x20044),0);
    f.force();f.tick();f.rpc.above();f.rpc.stop();assert.equal(f.rpc.status().altitude_pending,null);
});

test('auto-rise waits for active Hero then targets 30 cells up without above command or expiry',()=>{
    const f=noFallFixture(false,true);
    f.memory.set(0x1138,0);f.leave();assert.equal(f.rpc.status().no_fall,null);
    assert.equal(f.rpc.status().auto_rise_enabled,true);
    f.c.testTime=60000;f.memory.set(0x1138,1);f.leave();
    assert.equal(f.rpc.status().no_fall.altitude.mode,'auto_above');
    assert.equal(f.rpc.status().no_fall.altitude.target_y,600-1920);
    assert.equal(f.memory.get(0x20044),-8);
    f.memory.set(0x5038,500);f.leave();assert.equal(f.rpc.status().no_fall.altitude.target_y,-1320);
});
test('auto-rise stops on arrival, stays stopped, and manual return-height does not rearm ascent',()=>{
    const f=noFallFixture(false,true);f.leave();f.force();f.tick();
    f.memory.set(0x5038,-1320);f.leave();
    assert.equal(f.memory.get(0x20044),0);assert.equal(f.rpc.status().no_fall.altitude.status,'reached');
    f.rpc.returnHeight();f.leave();assert.equal(f.rpc.status().no_fall.altitude.target_y,600);
    f.memory.set(0x5038,600);f.leave();f.leave();
    assert.equal(f.memory.get(0x20044),0);assert.equal(f.rpc.status().no_fall.altitude.mode,'return');
});
test('auto-rise times out once and rearms after observed inactive phase, not every frame',()=>{
    const f=noFallFixture(false,true);f.leave();f.c.testTime=7001;f.leave();
    assert.equal(f.rpc.status().no_fall.altitude.status,'timed_out');
    f.leave();assert.equal(f.memory.get(0x20044),0);
    f.memory.set(0x1138,2);f.leave();f.memory.set(0x1138,1);f.leave();
    assert.equal(f.rpc.status().no_fall.altitude.status,'moving');assert.equal(f.memory.get(0x20044),-8);
});
test('shipped profile arms automatic 30-cell rise and sufficient timeout',()=>{
    const profile=fs.readFileSync(path.join(root,'memory/offsets.js'),'utf8');
    const config=vm.runInNewContext(profile+'; MEMORY_LAYOUT.catacombs.altitude_test');
    assert.equal(config.auto_rise,true);assert.equal(config.up,30*64);
    assert.ok(config.timeout_ms>config.up/100/config.velocity*1000);
});

test('spawn probe is opt-in, queued read-only capture of five ASLR-relative candidates',()=>{
    const f=fixture();
    assert.throws(()=>f.rpc.spawnProbe(),/active Catacombs/);
    f.rpc.install();f.tick();assert.equal(f.rpc.report().spawn_probe,null);
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0x100000),size:0x3000000,protection:'r-x'});
    f.c.Instruction={parse:()=>({size:1,mnemonic:'ret',opStr:''})};
    f.c.NativeFunction=function(){throw Error('probe must not call native');};
    f.rpc.spawnProbe();assert.equal(f.rpc.report().spawn_probe,null);
    assert.throws(()=>f.rpc.spawnProbe(),/already queued/);
    f.leave();const r=f.rpc.report().spawn_probe;
    assert.equal(r.status,'captured');assert.equal(r.read_only,true);assert.equal(r.spawn_enabled,false);
    assert.equal(r.abi_verified,false);assert.equal(Object.keys(r.candidates).length,5);
    assert.equal(r.candidates.factory_candidate.target.rva,'0x15eea70');
    assert.equal(r.candidates.wrapper_candidate.target.rva,'0x15fb8a0');
    assert.equal(r.candidates.array_push_candidate.target.rva,'0x1092110');
    assert.equal(r.candidates.factory_candidate.code.window_bytes,768);
    assert.equal(r.candidates.wrapper_candidate.code.window_bytes,384);
    assert.equal(r.candidates.array_push_candidate.code.instructions.length,256);
    assert.equal(f.writes.length,0);
    f.memory.clear();assert.equal(f.rpc.report().spawn_probe,r);
});
test('spawn probe cancels on stop and refuses stale or inactive state before code capture',()=>{
    for(const kind of ['stop','expired','state','inactive']) {
        const f=fixture();f.rpc.install();f.tick();f.rpc.spawnProbe();
        if(kind==='stop'){f.rpc.stop();assert.equal(f.rpc.status().spawn_probe_pending,null);continue;}
        if(kind==='expired')vm.runInContext('pendingSpawnProbe.time -= 6000',f.c);
        if(kind==='state')vm.runInContext('pendingSpawnProbe.state = "other"',f.c);
        if(kind==='inactive')f.memory.set(0x1138,2);
        f.leave();assert.equal(f.rpc.report().spawn_probe.status,'failed');assert.equal(f.writes.length,0);
    }
});

function spawnArrayFixture() {
    const f=fixture();
    f.identity(0x2000,0x8500,0x9500,0xA500,'6ZArrayI12KTGameObjectE');
    for(const [p,v] of [[0x2020,0],[0x2028,1],[0x2030,32],[0x2038,0],[0x3008,2],[0x8400,0x260000]])f.memory.set(p,v);
    f.c.spawnState=f.pointer(0x1000);
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0x100000),size:0x3000000,protection:'r-x'});
    f.c.Instruction={parse:()=>({size:1,mnemonic:'ret',opStr:''})};
    return f;
}
test('spawn array probe separates capacity, high index and live count and resolves current Candy attach slot',()=>{
    const f=spawnArrayFixture();
    const r=vm.runInContext('inspectSpawnArray(spawnState)',f.c);
    assert.equal(r.capacity,2);assert.equal(r.highest_index,0);assert.equal(r.live_counter,1);
    assert.equal(r.observed_live,1);assert.equal(r.live_counter_matches,true);assert.equal(r.growth,32);
    assert.equal(r.free_slots_sample.join(','),'1');assert.equal(r.candy_count,1);
    assert.equal(r.sample_candy.refcount,2);assert.equal(r.sample_candy.attach_method.vptr_byte_offset,0x300);
    assert.equal(r.sample_candy.attach_method.target.address,'0x260000');
    assert.equal(r.sample_candy.attach_method.code.window_bytes,768);assert.equal(f.writes.length,0);
});
test('spawn array probe accepts empty allocated array and makes no append-index guess',()=>{
    const f=spawnArrayFixture();f.memory.set(0x2800,0);f.memory.set(0x2020,-1);f.memory.set(0x2028,0);
    const r=vm.runInContext('inspectSpawnArray(spawnState)',f.c);
    assert.equal(r.highest_index,-1);assert.equal(r.observed_live,0);assert.equal(r.sample_candy,null);
    assert.match(r.note,/No live Candy/);assert.equal(r.free_slots_sample.length,2);assert.equal(f.writes.length,0);
});
test('spawn metadata rejects unsafe u64, oversized capacity and wrong RTTI',()=>{
    for(const [address,value] of [[0x2018,'18446744073709551615'],[0x2018,1025],[0x2000,0]]) {
        const f=spawnArrayFixture();f.memory.set(address,value);
        assert.throws(()=>vm.runInContext('inspectSpawnArray(spawnState)',f.c));assert.equal(f.writes.length,0);
    }
});
test('queued probe includes init and live array snapshot but report never rereads object pointers',()=>{
    const f=spawnArrayFixture();f.rpc.install();f.tick();f.rpc.spawnProbe();f.leave();
    const r=f.rpc.report().spawn_probe;
    assert.equal(r.candidates.init_candidate.target.rva,'0x15e90d0');
    assert.equal(r.candidates.init_candidate.code.window_bytes,1536);
    assert.equal(r.array.sample_candy.attach_method.target.rva,'0x160000');
    f.memory.clear();assert.equal(f.rpc.report().spawn_probe,r);assert.equal(f.writes.length,0);
});
test('early live Candy evidence survives collection without reusing historical pointers',()=>{
    const f=spawnArrayFixture();f.rpc.install();f.tick();
    f.memory.set(0x2800,0);f.memory.set(0x2028,0);
    f.rpc.spawnProbe();f.leave();const r=f.rpc.report().spawn_probe;
    assert.equal(r.array.sample_candy,null);
    assert.equal(r.early_array.array.sample_candy.address,'0x3000');
    assert.match(r.early_array.warning,/Historical evidence/);
    assert.equal(f.writes.length,0);
});

test('spawn array probe resolves body creator from current Candy slot +0x308',()=>{
    const f=spawnArrayFixture();f.memory.set(0x8408,0x270000);
    const r=vm.runInContext('inspectSpawnArray(spawnState)',f.c);
    assert.equal(r.sample_candy.body_factory_method.vptr_byte_offset,0x308);
    assert.equal(r.sample_candy.body_factory_method.target.address,'0x270000');
    assert.equal(r.sample_candy.body_factory_method.code.window_bytes,768);
    assert.equal(f.writes.length,0);
});
test('guarded attach observer captures actual arguments only from live Candy calls and caps records',()=>{
    const f=fixture(1,false,false,false,true);
    const config=vm.runInContext('C.spawn_probe',f.c);
    config.attach_prefix.forEach((byte,i)=>f.memory.set(0x100000+config.attach_rva+i,byte));
    f.identity(0x4000,0x8600,0x9600,0xA600,'12TestParent');f.memory.set(0x8600,0x280000);
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0x100000),size:0x3000000,protection:'r-x'});
    f.c.Instruction={parse:()=>({size:1,mnemonic:'ret',opStr:''})};
    let observer, detached=0;
    f.c.Interceptor.attach=(target,cb)=>{assert.equal(target.toString(),'0x16e9700');observer=cb;return{detach(){detached++;}};};
    vm.runInContext('enabled=true; installAttachObserver(Process.findModuleByName(MEMORY_LAYOUT.module_name))',f.c);
    for(let i=0;i<12;i++) {
        const context={returnAddress:f.pointer(0x290000)};
        observer.onEnter.call(context,[f.pointer(0x3000),f.pointer(0x4000)]);
        observer.onLeave.call(context);
    }
    const records=vm.runInContext('attachObservations',f.c);
    assert.equal(records.length,8);assert.equal(records[0].parent_argument.address,'0x4000');
    assert.equal(records[0].parent_first_method.target.address,'0x280000');
    assert.equal(records[0].body_after.null,true);assert.equal(f.writes.length,0);
    f.rpc.stop();assert.equal(detached,1);
});
test('attach observer refuses code signature mismatch without attaching hook',()=>{
    const f=fixture(1,false,false,false,true);let attached=0;
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0x100000),size:0x3000000,protection:'r-x'});
    f.c.Interceptor.attach=()=>{attached++;};
    vm.runInContext('installAttachObserver(Process.findModuleByName(MEMORY_LAYOUT.module_name))',f.c);
    assert.equal(f.rpc.status().attach_observer.status,'unavailable');assert.equal(attached,0);
    assert.match(f.rpc.status().attach_observer.error,/signature mismatch/);
});

test('no-fall cleanup does not clear spawn diagnostics or invalidate live attach observer status',()=>{
    const f=fixture();
    vm.runInContext(`attachObservationStatus={status:'listening',observed:1};
        attachObservations=[{time:123}];spawnInspection={status:'captured'};
        earlySpawnArray={state:'test'};restoreNoFall('level inactive');`,f.c);
    assert.equal(f.rpc.status().attach_observer.status,'listening');
    assert.equal(f.rpc.report().spawn_probe.status,'captured');
    assert.equal(vm.runInContext('attachObservations.length',f.c),1);
    assert.equal(vm.runInContext('earlySpawnArray.state',f.c),'test');
    f.rpc.install();assert.equal(f.rpc.report().spawn_probe,null);
    assert.equal(vm.runInContext('attachObservations.length',f.c),0);
});
test('registered parent is read as raw structure and corroborated against live physics world',()=>{
    const f=spawnArrayFixture();
    f.identity(0x6000,0x8600,0x9600,0xA600,'20EndlessMazeCandyBody');
    for(const [p,v] of [[0x3198,0x6000],[0x6010,0x7000],[0x6020,0x8000],[0x7008,0x9000],[0x8058,0x9000]])f.memory.set(p,v);
    f.c.candyTest=f.pointer(0x3000);
    let r=vm.runInContext('inspectCandyParent(candyTest)',f.c);
    assert.equal(r.parent,'0x7000');assert.equal(r.world_matches,true);
    f.memory.set(0x7008,0x9990);r=vm.runInContext('inspectCandyParent(candyTest)',f.c);
    assert.equal(r.world_matches,false);assert.equal(f.writes.length,0);
});

function goldFixture() {
    const f=maskFixture();const calls=[];
    f.identity(0x2000,0x8500,0x9500,0xA500,'6ZArrayI12KTGameObjectE');
    f.memory.set(0x6010,0x30000);f.memory.set(0x30008,0xF000);
    const G=vm.runInContext('C.spawn_gold',f.c);
    for(const sig of G.signatures)sig.bytes.forEach((b,i)=>f.memory.set(0x100000+sig.rva+i,b));
    const setterBytes=vm.runInContext('C.move_white.setter_bytes',f.c);
    setterBytes.forEach((b,i)=>f.memory.set(0x100000+G.object_setter+i,b));
    f.c.NativeFunction=function(address,ret,args) {
        if(address.n===0x100000+G.factory)return rarity=>{
            calls.push('factory');assert.equal(rarity,4);assert.equal(ret,'pointer');
            f.identity(0x40000,0x41000,0x42000,0x43000,'16EndlessMazeCandy');
            for(const [p,v] of [[0x401F0,4],[0x40198,0],[0x41300,0x100000+G.attach],
                [0x41308,0x100000+G.body_factory],[0x41238,0x100000+G.object_setter]])f.memory.set(p,v);
            return f.pointer(0x40000);
        };
        if(address.n===0x100000+G.attach)return (object,parent,vector)=>{
            calls.push('attach');assert.equal(object.n,0x40000);assert.equal(parent.n,0x30000);
            assert.equal(JSON.stringify(args),JSON.stringify(['pointer','pointer',['float','float']]));
            f.identity(0x50000,0x51000,0x52000,0x53000,'20EndlessMazeCandyBody');
            for(const [p,v] of [[0x40198,0x50000],[0x50010,0x30000],[0x50020,0x60000],
                [0x60058,0xF000],[0x6000C,Math.fround(vector[0]/100)],[0x60010,Math.fround(vector[1]/100)]])f.memory.set(p,v);
        };
        if(address.n===0x100000+G.array_set)return (array,object,index)=>{
            calls.push('assign');assert.equal(array.n,0x2000);assert.equal(index,1);
            f.memory.set(0x2800+index*8,object.n);
        };
        throw Error('unexpected native '+address);
    };
    // Existing low-level spawn tests isolate the new registration helper; separate tests cover it below.
    vm.runInContext(`originalFullGoldPlan=fullGoldPlan; originalCompleteGoldRegistration=completeGoldRegistration;
        fullGoldPlan=()=>({id:42});completeGoldRegistration=()=>{};`,f.c);
    f.force();f.tick();return {...f,calls};
}
test('one gold spawn is queued and registers full native object in a verified free index',()=>{
    const f=goldFixture();f.rpc.spawnGold();assert.equal(f.calls.length,0);f.leave();
    const r=f.rpc.status().last_spawn_gold;
    assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.registered,true);assert.equal(r.collection_confirmed,false);
    assert.equal(f.calls.join(','),'factory,attach,assign');assert.equal(f.memory.get(0x2808),0x40000);
    assert.equal(f.memory.get(0x40034),524);assert.equal(f.memory.get(0x40038),600);
    assert.throws(()=>f.rpc.spawnGold(),/one spawn attempt/);
});
test('gold spawn refuses world/parent mismatch, full array or altered signatures before any native call',()=>{
    for(const mutate of [f=>f.memory.set(0x30008,0),f=>f.memory.set(0x2808,0x3000),
        f=>f.memory.set(0x100000+0x15EEA70,0x90)]) {
        const f=goldFixture();mutate(f);f.rpc.spawnGold();f.leave();
        assert.equal(f.rpc.status().last_spawn_gold.success,false);assert.equal(f.calls.length,0);
        assert.equal(f.rpc.status().spawn_gold_attempted,false);
    }
});
test('gold native failure is latched with no retry or guessed destructor; stop cancels queued request',()=>{
    const f=goldFixture();f.c.NativeFunction=function(){return ()=>{throw Error('native fault');};};
    f.rpc.spawnGold();f.leave();const r=f.rpc.status().last_spawn_gold;
    assert.equal(r.native_started,true);assert.equal(r.success,false);assert.match(r.warning,/orphan/);
    assert.throws(()=>f.rpc.spawnGold(),/one spawn attempt/);
    const stopped=goldFixture();stopped.rpc.spawnGold();stopped.rpc.stop();assert.equal(stopped.rpc.status().spawn_gold_pending,null);
});

test('gold spawn detaches its own attach observer and flushes before verifying original bytes',()=>{
    const f=goldFixture();
    const sig=vm.runInContext('C.spawn_gold.signatures.find(s=>s.rva===C.spawn_gold.attach)',f.c);
    const code=0x100000+sig.rva;let detached=0,flushed=0;
    f.memory.set(code,0xCC); // simulate Interceptor's installed prologue patch
    f.c.testDetach=()=>{detached++;sig.bytes.forEach((b,i)=>f.memory.set(code+i,b));};
    f.c.Interceptor.flush=()=>{assert.equal(detached,1);flushed++;};
    vm.runInContext("attachObserver={detach:testDetach};attachObservationStatus={status:'listening',observed:8}",f.c);
    f.rpc.spawnGold();f.leave();const r=f.rpc.status().last_spawn_gold;
    assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.attach_observer_detached,true);
    assert.equal(detached,1);assert.equal(flushed,1);assert.equal(f.rpc.status().attach_observer.status,'detached_for_spawn');
    assert.equal(f.calls.join(','),'factory,attach,assign');
});
test('gold spawn still rejects altered original bytes after observer detachment',()=>{
    const f=goldFixture();
    const sig=vm.runInContext('C.spawn_gold.signatures.find(s=>s.rva===C.spawn_gold.attach)',f.c);
    const code=0x100000+sig.rva;
    f.memory.set(code,0xCC);f.memory.set(code+32,0x90);
    f.c.testDetach=()=>{sig.bytes.slice(0,20).forEach((b,i)=>f.memory.set(code+i,b));};
    f.c.Interceptor.flush=()=>{};
    vm.runInContext('attachObserver={detach:testDetach}',f.c);
    f.rpc.spawnGold();f.leave();const r=f.rpc.status().last_spawn_gold;
    assert.equal(r.success,false);assert.equal(r.native_started,false);assert.equal(f.calls.length,0);
    assert.match(r.error,/spawn signature mismatch at 15e9700/);
});

test('spawn attach signature uses pristine pre-observer prologue, not a captured Frida jump',()=>{
    const profile=fs.readFileSync(path.join(root,'memory/offsets.js'),'utf8');
    const cfg=vm.runInNewContext(profile+'; MEMORY_LAYOUT.catacombs');
    const sig=cfg.spawn_gold.signatures.find(s=>s.rva===cfg.spawn_gold.attach);
    assert.equal(sig.bytes.length,64);
    assert.equal(sig.bytes.slice(0,cfg.spawn_probe.attach_prefix.length).join(','),cfg.spawn_probe.attach_prefix.join(','));
    assert.equal(sig.bytes.slice(0,6).join(','),'85,72,137,229,65,86');
});
test('signature refusal includes expected and actual bytes, no factory call',()=>{
    const f=goldFixture();f.memory.set(0x100000+0x15E9700,0xE9);f.rpc.spawnGold();f.leave();
    const r=f.rpc.status().last_spawn_gold;
    assert.equal(r.native_started,false);assert.equal(f.calls.length,0);
    assert.equal(r.signature_mismatch.rva,'0x15e9700');assert.equal(r.signature_mismatch.first_difference,0);
    assert.ok(r.signature_mismatch.expected_hex.startsWith('55 48 89 e5'));
    assert.ok(r.signature_mismatch.actual_hex.startsWith('e9 '));
});

test('bounded gold cycle schedules spaced attempts, stops at100 and cannot be rearmed',()=>{
    const f=goldFixture();let time=vm.runInContext("Date.now()",f.c);f.c.Date={now:()=>time};
    f.rpc.spawnGoldCycle();f.leave();
    assert.equal(f.rpc.status().spawn_cycle.registered,1);
    f.leave();assert.equal(f.rpc.status().spawn_cycle.attempted,1);
    // Reuse the mock free slot; real runtime must find a fresh null slot each time.
    for(let i=1;i<100;i++){time+=100;f.memory.set(0x2808,0);f.leave();}
    const c=f.rpc.status().spawn_cycle;
    assert.equal(c.attempted,100);assert.equal(c.registered,100);assert.equal(c.active,false);
    assert.equal(c.reason,'limit reached');f.force();f.tick();assert.throws(()=>f.rpc.spawnGoldCycle(),/fresh module/);
});
test('cycle stops on native error, explicit cancellation, state/phase change and module stop',()=>{
    for(const mode of ['failure','cancel','phase','stop']){
        const f=goldFixture();f.rpc.spawnGoldCycle();
        if(mode==='failure')f.c.NativeFunction=function(){return ()=>{throw Error('fault');};};
        if(mode==='cancel')f.rpc.spawnGoldStop();
        if(mode==='phase')f.memory.set(0x1138,2);
        if(mode==='stop')f.rpc.stop();
        f.leave();assert.equal(f.rpc.status().spawn_cycle.active,false,mode);
        assert.equal(f.rpc.status().spawn_cycle.registered,0,mode);
    }
});

test('gold diagnostic stages survive report and follow membership without reading removed object',()=>{
    const f=goldFixture();f.rpc.spawnGold();f.leave();f.leave();
    let d=f.rpc.report().gold_diagnostics;
    assert.equal(d.spawned.length,1);assert.equal(d.spawned[0].stages.factory.rarity,4);
    assert.equal(d.spawned[0].stages.registered.body.address,'0x50000');
    assert.equal(d.spawned[0].timeline[0].membership,'present');
    f.memory.set(0x2808,0); // Historical address is no longer a valid member.
    vm.runInContext('goldDiagnostics.spawned[0].next=0',f.c);f.leave();
    d=f.rpc.report().gold_diagnostics;
    assert.equal(d.spawned[0].done,true);
    assert.equal(d.spawned[0].timeline.at(-1).membership,'removed_or_slot_reused');
    assert.equal(d.spawned[0].timeline.at(-1).evidence,undefined);
});
test('gold diagnostic stops following historical objects on phase transition',()=>{
    const f=goldFixture();f.rpc.spawnGold();f.leave();f.memory.set(0x1138,2);f.leave();
    const t=f.rpc.report().gold_diagnostics.spawned[0];
    assert.equal(t.done,true);assert.match(t.end,/old pointers not read/);
});

test('contact diagnostics capture verified lambda, column record and both containers without native calls',()=>{
    const f=goldFixture();f.rpc.spawnGold();f.leave();const before=f.calls.length;f.c.ptr=f.pointer;f.memory.set(0x50041,0);
    f.identity(0x70000,0x71000,0x72000,0x73000,'EndlessMazePlayState20addObstaclesInColumn');
    for(const [p,v] of [[0x50070,0x70000],[0x71030,0x100000+0x14DB600],
        [0x70008,0x80000],[0x70010,7],[0x70018,0x40000],[0x80058,0x2000],[0x80068,0x2000],
        [0x80128,0x90000],[0x90020,7],[0x90028,0xA0000],[0x90030,0xA0050],
        [0xA0010,7],[0xA0048,45],[0xA0020,42],[0x40184,42],[0x80110,0xB0000],[0xB0020,7],
        [0xB0028,0xC0000],[0xB0030,0xC0008],[0xC0000,0x40000]]) f.memory.set(p,v);
    const e=vm.runInContext('goldContactEvidence(ptr(0x40000))',f.c);
    assert.equal(e.captures.candy_matches,true);assert.equal(e.records.matches[0].id,42);
    assert.equal(e.column_objects.matches[0].object,'0x40000');
    assert.equal(e.container_58.slots[0],1);assert.equal(e.container_68.slots[0],1);
    assert.equal(f.calls.length,before);
});
test('contact diagnostics refuse unknown callback captures and bound cyclic trees',()=>{
    const f=goldFixture();f.c.ptr=f.pointer;f.rpc.spawnGold();f.leave();f.memory.set(0x50041,0);f.memory.set(0x50070,0);
    assert.equal(vm.runInContext('goldContactEvidence(ptr(0x40000))',f.c).callback_missing,true);
    f.identity(0x70000,0x71000,0x72000,0x73000,'OtherCallback');f.memory.set(0x50070,0x70000);
    f.memory.set(0x71030,0x100000+0x14DB600);
    assert.equal(vm.runInContext('goldContactEvidence(ptr(0x40000))',f.c).captures,undefined);
    f.memory.set(0x80128,0x90000);f.memory.set(0x90020,9);f.memory.set(0x90000,0x90000);
    assert.throws(()=>vm.runInContext('diagnosticColumn(ptr(0x80000),0x128,7,0x50,42)',f.c),/tree cycle/);
});

test('full registration helper installs owned callback, clones record and adds secondary memberships',()=>{
    const f=goldFixture();f.rpc.spawnGold();f.leave();f.c.ptr=f.pointer;
    const base=0x100000;let alloc=0xE0000;const order=[];
    f.c.Memory.alloc=n=>{const p=f.pointer(alloc);alloc+=n+0x100;return p;};
    const plan={source:f.pointer(0x90000),recordNode:f.pointer(0x91000),recordEnd:f.pointer(0x92000),
        objectNode:f.pointer(0x93000),objectEnd:f.pointer(0x94000),array58:f.pointer(0x95000),slot58:0,
        counter:100,id:101,column:19,callbackVptr:f.pointer(0x96000),m:{base:f.pointer(base)}};
    f.memory.set(0x113C,100);f.memory.set(0x91030,0x92000);f.memory.set(0x93030,0x94000);
    f.memory.set(0x95018,1);f.memory.set(0x95010,0x97000);f.memory.set(0x97000,0);f.memory.set(0x96020,base+0x123);
    f.c.plan=plan;f.c.testState=f.pointer(0x1000);f.c.testObject=f.pointer(0x40000);f.c.testBody=f.pointer(0x50000);
    f.c.testAssign=(a,o,i)=>{order.push('assign58');f.memory.set(0x97000,o.n);};
    f.c.NativeFunction=function(p){
        if(p.n===base+0x1618080)return (body,tmp)=>{order.push('callback');
            f.memory.set(0x50070,0x98000);for(const off of [0,8,0x10,0x18])f.memory.set(0x98000+off,f.memory.get(tmp.n+off));};
        if(p.n===base+0x123)return ()=>order.push('destroyTemporary');
        if(p.n===base+0x105B020)return (dst,src)=>{order.push('copy');f.memory.set(dst.n+0x20,f.memory.get(src.n+0x20));};
        if(p.n===base+0x14BCB80)return (vector,local)=>{order.push('pushRecord');
            f.memory.set(0xB0020,f.memory.get(local.n+0x20));
            f.memory.set(0x91028,0xB0000);f.memory.set(0x91030,0xB0050);return f.pointer(0xB0000);};
        if(p.n===base+0x105B0D0)return ()=>order.push('cleanup');
        throw Error('unexpected native');
    };
    vm.runInContext('helperResult={};originalCompleteGoldRegistration(plan,testState,testObject,testBody,testAssign,helperResult)',f.c);
    assert.equal(order.join(','),'callback,destroyTemporary,copy,copy,cleanup,assign58');
    assert.equal(f.memory.get(0x92020),101);assert.equal(f.memory.get(0x113C),101);
    assert.equal(f.memory.get(0x91030),0x92050);assert.equal(f.memory.get(0x94000),0x40000);
    assert.equal(f.memory.get(0x93030),0x94008);
    // Same helper's full-vector branch delegates record ownership to native push_back.
    f.memory.set(0x113C,100);f.memory.set(0x91030,0x92000);f.memory.set(0x93030,0x94000);f.memory.set(0x97000,0);
    plan.recordGrow=true;order.length=0;
    vm.runInContext('helperResult={};originalCompleteGoldRegistration(plan,testState,testObject,testBody,testAssign,helperResult)',f.c);
    assert.equal(order.join(','),'callback,destroyTemporary,copy,pushRecord,cleanup,assign58');
    assert.equal(f.memory.get(0xB0020),101);assert.equal(f.c.helperResult.record_vector_grew,true);
    f.memory.set(0x113C,100);f.memory.set(0x91030,0x92000);f.memory.set(0x93030,0x94000);f.memory.set(0x97000,0);
    plan.reuseCollected=true;plan.id=62;plan.recordFlags=7;
    vm.runInContext('helperResult={};originalCompleteGoldRegistration(plan,testState,testObject,testBody,testAssign,helperResult)',f.c);
    assert.equal(f.memory.get(0xB0020),62);assert.equal(f.memory.get(0x113C),100);

});
test('full registration preflight refuses missing native signatures and cycle command stays disabled',()=>{
    const f=goldFixture();f.c.testState=f.pointer(0x1000);f.c.testArray=f.pointer(0x2000);
    const n=f.calls.length;
    assert.throws(()=>vm.runInContext('originalFullGoldPlan(testState,testArray)',f.c),/full spawn signature/);
    assert.equal(f.calls.length,n);assert.equal(f.rpc.spawnGoldCycle().limit,100);
});

test('gold may be armed before a level and waits for active phase before one native attempt',()=>{
    const f=goldFixture();f.memory.set(0x1138,0);f.force();f.tick();
    const r=f.rpc.spawnGold();assert.equal(r.armed_for_next_level,true);
    f.leave();assert.equal(f.calls.length,0);assert.ok(f.rpc.status().spawn_gold_pending);
    f.memory.set(0x1138,1);f.force();f.tick();f.leave();
    assert.equal(f.rpc.status().last_spawn_gold.success,true);
    assert.equal(f.calls.filter(x=>x==='factory').length,1);
    assert.equal(f.rpc.status().spawn_gold_pending,null);
});
test('armed spawn waits only for absent template, expires or cancels without factory',()=>{
    const f=goldFixture();f.memory.set(0x1138,0);f.force();f.tick();f.rpc.spawnGold();
    vm.runInContext("fullGoldPlan=()=>{throw Error('no live uncollected gold with verified callback/column record');}",f.c);
    f.memory.set(0x1138,1);f.force();f.tick();f.leave();
    assert.equal(f.rpc.status().last_spawn_gold.waiting_for_template,true);assert.equal(f.calls.length,0);
    vm.runInContext('pendingGold.deadline=0',f.c);f.leave();
    assert.equal(f.rpc.status().spawn_gold_pending,null);assert.equal(f.calls.length,0);
});

test('full registration cycle can be armed before level and expires without any native attempt',()=>{
    const f=goldFixture();f.memory.set(0x1138,0);f.force();f.tick();
    f.rpc.spawnGoldCycle();assert.equal(f.rpc.status().spawn_cycle.state,null);
    f.leave();assert.equal(f.calls.length,0);
    vm.runInContext('goldCycle.armed_deadline=0',f.c);f.leave();
    assert.equal(f.rpc.status().spawn_cycle.active,false);
    assert.equal(f.rpc.status().spawn_cycle.reason,'level wait expired');assert.equal(f.calls.length,0);
});
test('armed cycle binds active level and blocks auto teleport only while series is active',()=>{
    const f=goldFixture();f.memory.set(0x1138,0);f.force();f.tick();f.rpc.spawnGoldCycle();
    let auto=0;f.c.testAuto=()=>auto++;vm.runInContext('autoTeleport=testAuto',f.c);
    f.leave();assert.equal(auto,0);
    f.memory.set(0x1138,1);f.force();f.tick();f.leave();
    assert.equal(f.rpc.status().spawn_cycle.registered,1);f.leave();assert.equal(auto,0);
    f.rpc.spawnGoldStop();f.leave();assert.equal(auto,1);
});

test('record observer follows ID invalidation after object removal without reading historical Candy',()=>{
    const f=goldFixture();f.c.ptr=n=>f.pointer(Number(n));f.c.testState=f.pointer(0x1000);
    f.memory.set(0x1128,0x90000);f.memory.set(0x90000,0);f.memory.set(0x90008,0);f.memory.set(0x90020,19);f.memory.set(0x90028,0xA0000);f.memory.set(0x90030,0xA0050);
    f.memory.set(0xA0020,-1);f.memory.set(0xA0010,7);
    // Raw mock stores S32 separately; create matching descriptor from its byte reader.
    f.c.testDescriptor=Array.from(new Uint8Array(f.pointer(0xA0000).readByteArray(0x50)));
    vm.runInContext(`goldDiagnostics.spawned=[{state:testState.toString(),time:Date.now(),done:true,
        object:'0xDEAD',body:'0xBAD',record_watch:{column:19,id:107,index:0,descriptor:testDescriptor,next:0,done:false,timeline:[]}}];
        followGoldRecords(testState)`,f.c);
    let w=f.rpc.report().gold_diagnostics.spawned[0].record_watch;
    assert.equal(w.timeline[0].record_id_invalidated,true,JSON.stringify(w));assert.equal(w.timeline[0].credit_confirmed,false);
    f.memory.set(0xA0048,45); // same index replaced by a different descriptor
    vm.runInContext('goldDiagnostics.spawned[0].record_watch.next=0;followGoldRecords(testState)',f.c);
    w=f.rpc.report().gold_diagnostics.spawned[0].record_watch;
    assert.equal(w.timeline[1].descriptor_matches,false);assert.equal(w.timeline[1].record_id_invalidated,false);
    f.memory.set(0x1138,0);vm.runInContext('goldDiagnostics.spawned[0].record_watch.next=0;followGoldRecords(testState)',f.c);
    assert.equal(f.rpc.report().gold_diagnostics.spawned[0].record_watch.done,true);
});

test('pointer vector growth uses native allocator pair, preserves pointers and publishes correct bounds',()=>{
    const f=goldFixture();f.c.ptr=n=>f.pointer(Number(n));
    for(const [p,v] of [[0x90028,0xA0000],[0x90030,0xA0010],[0x90038,0xA0010],[0xA0000,0x1230],[0xA0008,0x4560]])f.memory.set(p,v);
    let frees=0,bytes=0;
    f.c.NativeFunction=function(address){
        if(address.n===0x100000+0x1F26660)return n=>{bytes=n;return f.pointer(0xB0000);};
        if(address.n===0x100000+0x1F26640)return p=>{assert.equal(p.n,0xA0000);frees++;};
        throw Error('unexpected grow native');
    };
    f.c.growNode=f.pointer(0x90000);f.c.growObject=f.pointer(0x7890);f.c.growModule={base:f.pointer(0x100000)};
    vm.runInContext('growResult={};growGoldPointerVector(growNode,growObject,growModule,growResult)',f.c);
    assert.equal(bytes,64);assert.equal(frees,1);
    assert.equal(f.memory.get(0xB0000),0x1230);assert.equal(f.memory.get(0xB0008),0x4560);assert.equal(f.memory.get(0xB0010),0x7890);
    assert.equal(f.memory.get(0x90028),0xB0000);assert.equal(f.memory.get(0x90030),0xB0018);assert.equal(f.memory.get(0x90038),0xB0040);
    f.memory.set(0x90030,0xB0040);f.memory.set(0x90038,0xB0038);
    assert.throws(()=>vm.runInContext('growGoldPointerVector(growNode,growObject,growModule,growResult)',f.c),/bounds invalid/);
});
test('100ms cycle has no burst catchup after delayed update',()=>{
    const f=goldFixture();let time=vm.runInContext('Date.now()',f.c);f.c.Date={now:()=>time};
    f.rpc.spawnGoldCycle();f.leave();assert.equal(f.rpc.status().spawn_cycle.registered,1);
    time+=99;f.leave();assert.equal(f.rpc.status().spawn_cycle.registered,1);
    time+=1;f.memory.set(0x2808,0);f.leave();assert.equal(f.rpc.status().spawn_cycle.registered,2);
    time+=1000;f.memory.set(0x2808,0);f.leave();f.leave();assert.equal(f.rpc.status().spawn_cycle.registered,3);
});

test('reuse ID command is explicit, queued, bounded and does not change the normal cycle',()=>{
    const f=goldFixture();const r=f.rpc.spawnGoldReuse();assert.equal(r.reuse_collected_id,true);
    assert.equal(f.rpc.status().spawn_gold_pending.reuseCollected,true);assert.equal(f.calls.length,0);
    assert.throws(()=>f.rpc.spawnGoldReuse(),/fresh module/);f.rpc.stop();assert.equal(f.rpc.status().spawn_gold_pending,null);
});
test('collected natural ID selector requires invalidated matching record and no active Candy',()=>{
    const f=goldFixture();f.c.ptr=n=>f.pointer(Number(n));f.c.testState=f.pointer(0x1000);
    for(const [p,v]of [[0x3184,10],[0x1058,0x2000],[0x1128,0x90000],[0x90020,19],[0x90028,0xA0000],[0x90030,0xA0050],
        [0xA0010,7],[0xA0020,-1],[0xA0048,45],[0x1110,0xB0000],[0xB0020,19],[0xB0028,0],[0xB0030,0],
        [0x100000+0x202C8E0+0x30,0x100000+0x14DB600]])f.memory.set(p,v);
    const raw=Array.from(new Uint8Array(f.pointer(0xA0000).readByteArray(0x50))).map(v=>v.toString(16).padStart(2,'0')).join(' ');
    f.c.testRaw=raw;
    vm.runInContext(`goldDiagnostics.natural=[{state:'0x1000',object:{rarity:4,id:62,contact:{captures:{context:'0x1000',column:19,candy_matches:true},records:{matches:[{id:62,index:0,flags:7,raw_hex:testRaw}]}}}}]`,f.c);
    assert.equal(vm.runInContext('collectedGoldTemplate(testState).reuseId',f.c),62);
    f.memory.set(0xA0020,62);assert.throws(()=>vm.runInContext('collectedGoldTemplate(testState)',f.c),/no verified collected/);
    f.memory.set(0xA0020,-1);f.memory.set(0xA0048,46);
    assert.throws(()=>vm.runInContext('collectedGoldTemplate(testState)',f.c),/no verified collected/);
});

test('reuse cycle explicitly marks every queued attempt and retains pacing/cancellation',()=>{
    const f=goldFixture();f.c.ptr=n=>f.pointer(Number(n));
    vm.runInContext('collectedGoldTemplate=()=>({reuseId:62});fullGoldPlan=(state,array,reuse)=>{if(!reuse)throw Error("reuse flag missing");return {id:62};}',f.c);
    const start=f.rpc.spawnGoldReuseCycle();assert.equal(start.reuse_collected_id,true);assert.equal(start.limit,100);
    f.leave();assert.equal(f.rpc.status().last_spawn_gold.reused_collected_id,true);
    assert.equal(f.rpc.status().spawn_cycle.registered,1);
    f.rpc.spawnGoldStop();f.leave();assert.equal(f.rpc.status().spawn_cycle.active,false);
    assert.equal(f.calls.filter(c=>c==='factory').length,1);
});
test('reuse cycle refuses missing collected ID before enabling series or native calls',()=>{
    const f=goldFixture();f.c.ptr=n=>f.pointer(Number(n));
    assert.throws(()=>f.rpc.spawnGoldReuseCycle(),/no verified collected/);
    assert.equal(f.rpc.status().spawn_cycle,null);assert.equal(f.calls.length,0);
});

function descriptorGoldFixture(authoredGold=3) {
    const f=goldFixture();const G=vm.runInContext('C.all_gold',f.c);
    // Authored gold count is now the default cap; seed it like a live census would.
    vm.runInContext(`levelCensuses=[{time:Date.now(),state:'0x1000',surviving_total:10,surviving_by_rarity:{1:5,2:1,3:1,4:${authoredGold}}}]`,f.c);
    G.signature.forEach((v,i)=>f.memory.set(0x100000+G.descriptor_factory+i,v));
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0),size:0x4000000,protection:'rwx'});
    for(const [p,v] of [[0x100000+G.rarity_map+8,0x80000],[0x8001C,4],[0x80020,4],
        [0x90048,45],[0x90020,62],[0x90010,7],[0x90044,1]])f.memory.set(p,v);
    let callback,detached=0,flushed=0;
    f.c.Interceptor.attach=(p,cb)=>{assert.equal(p.n,0x100000+G.descriptor_factory);callback=cb;return {detach(){detached++;}};};
    f.c.Interceptor.flush=()=>{flushed++;};
    return {...f,G,enter(caller=G.caller){callback.onEnter.call({returnAddress:f.pointer(0x100000+caller)},[f.pointer(0x90000)]);},detached:()=>detached,flushed:()=>flushed};
}
test('all-gold changes descriptor rarity key/flag before native creation, not IDs or counts',()=>{
    const f=descriptorGoldFixture();assert.equal(f.rpc.allGold().active,true);f.enter();
    assert.equal(f.memory.get(0x90044),4);assert.equal(f.memory.get(0x90010),0x807);assert.equal(f.memory.get(0x90020),62);
    assert.equal(f.rpc.status().all_gold.converted,1);f.enter();assert.equal(f.rpc.status().all_gold.converted,1);
    assert.equal(f.rpc.status().all_gold.seen,2);f.enter(0x123);assert.equal(f.rpc.status().all_gold.skipped_caller,1);
    assert.throws(()=>f.rpc.spawnGold(),/disable all-gold/);
    assert.equal(f.rpc.allGoldOff().active,false);assert.equal(f.detached(),1);assert.equal(f.flushed(),2);
    assert.equal(f.calls.length,0);
});
test('all-gold rejects descriptor signature mismatch before installing hook',()=>{
    const f=descriptorGoldFixture();f.memory.set(0x100000+f.G.descriptor_factory,0x90);
    assert.throws(()=>f.rpc.allGold(),/signature mismatch/);assert.equal(f.rpc.status().all_gold.active,false);
});
test('all-gold fails closed on missing/wrong runtime rarity mapping and does not change record',()=>{
    for(const value of [2,null]) {
        const f=descriptorGoldFixture();if(value===null)f.memory.set(0x100000+f.G.rarity_map+8,0);else f.memory.set(0x80020,value);
        f.rpc.allGold();f.enter();assert.equal(f.memory.get(0x90044),1);assert.equal(f.memory.get(0x90010),7);
        assert.equal(f.rpc.status().all_gold.active,false);assert.ok(f.rpc.status().all_gold.error);
    }
});
test('all-gold leaves non-Candy and retired records unchanged',()=>{
    const f=descriptorGoldFixture();f.rpc.allGold();f.memory.set(0x90048,46);f.enter();
    assert.equal(f.memory.get(0x90044),1);f.memory.set(0x90048,45);f.memory.set(0x90020,-1);f.enter();
    assert.equal(f.memory.get(0x90044),1);assert.equal(f.rpc.status().all_gold.converted,0);
});

test('all-gold restores both descriptor fields on interrupted write/readback',()=>{
    const f=descriptorGoldFixture(),prototype=Object.getPrototypeOf(f.pointer(0)),write=prototype.writeS32;
    let failed=false;
    prototype.writeS32=function(n){if(this.n===0x90010&&!failed){failed=true;throw Error('simulated write failure');}return write.call(this,n);};
    f.rpc.allGold();f.enter();assert.equal(f.memory.get(0x90044),1);assert.equal(f.memory.get(0x90010),7);
    assert.equal(f.rpc.status().all_gold.last_failed_record.rollback,true);
    assert.equal(f.rpc.status().all_gold.active,false);
});
test('all-gold rejects readonly descriptor without mutation',()=>{
    const f=descriptorGoldFixture();f.rpc.allGold();
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0),size:0x4000000,protection:'r--'});f.enter();
    assert.equal(f.memory.get(0x90044),1);assert.equal(f.memory.get(0x90010),7);
    assert.match(f.rpc.status().all_gold.error,/not writable/);
});

function sequenceFixture() {
    const f=goldFixture();const S=vm.runInContext('C.sequence_probe',f.c);
    S.signature.forEach((v,i)=>f.memory.set(0x100000+S.builder+i,v));
    for(const [p,v]of [[0x1150,0x90000],[0x1158,2],[0x90000,0],[0x90008,0x91000],[0x9001C,1],[0x90020,11],
        [0x91000,0],[0x91008,0],[0x9101C,4],[0x91020,3]])f.memory.set(p,v);
    let callback,detached=0;
    f.c.Interceptor.attach=(address,cb)=>{assert.equal(address.n,0x100000+S.builder);callback=cb;return {detach(){detached++;}};};
    f.c.Interceptor.flush=()=>{};f.c.sequenceModule={base:f.pointer(0x100000),size:0x3000000};
    return {...f,S,install(){vm.runInContext('installSequenceProbe(sequenceModule)',f.c);},
        invoke(payload=0x10D8){callback.onEnter.call({returnAddress:f.pointer(0x100000+0x14D78E9)},
            [f.pointer(0x80000),f.pointer(payload),f.pointer(1),f.pointer(0x1148),f.pointer(7),f.pointer(0)]);},detached:()=>detached};
}
test('sequence probe captures read-only builder input type/count pairs and actual argument ownership',()=>{
    const f=sequenceFixture();f.install();const before=f.writes.length;f.invoke();
    const p=f.rpc.report().sequence_probe;assert.equal(p.status,'listening');assert.equal(p.calls,1);
    const s=p.snapshots[0];assert.equal(s.owner.state,'0x1000');assert.equal(s.action_arg,1);
    assert.equal(s.separate_int_arg,7);assert.equal(s.counts.positive_count_sum,14);
    assert.equal(s.counts.entries[0].key,1);assert.equal(s.counts.entries[0].count,11);
    assert.equal(s.counts.entries[1].key,4);assert.equal(s.counts.entries[1].count,3);
    assert.equal(f.writes.length,before);assert.equal(f.calls.length,0);
});
test('sequence probe bounds snapshots, skips mismatched payload, retains evidence on stop',()=>{
    const f=sequenceFixture();f.install();for(let i=0;i<40;i++)f.invoke();
    f.invoke(0x9999);let p=f.rpc.status().sequence_probe;
    assert.equal(p.snapshots.length,32);assert.equal(p.skipped,1);
    assert.equal(p.snapshots.at(-1).counts,undefined);f.rpc.stop();
    p=f.rpc.report().sequence_probe;assert.equal(p.status,'stopped');assert.equal(f.detached(),1);
    assert.equal(p.snapshots.length,32);
});
test('sequence probe rejects signature mismatch and safely reports cyclic count tree',()=>{
    const f=sequenceFixture();f.memory.set(0x100000+f.S.builder,0x90);f.install();
    assert.equal(f.rpc.status().sequence_probe.status,'unavailable');
    const g=sequenceFixture();g.install();g.memory.set(0x91008,0x90000);g.invoke();
    assert.match(g.rpc.report().sequence_probe.snapshots[0].counts.error,/cycle/);
    g.memory.set(0x1158,65);g.invoke();assert.match(g.rpc.report().sequence_probe.snapshots.at(-1).counts.error,/budget/);
});

test('sequence probe census lists Candy by rarity from the pickup record column read-only',()=>{
    const f=sequenceFixture();f.install();
    // state+0x128 column tree: node key0x20=0x128, vector at 0x28/0x30, stride0x50.
    for(const [p,v]of [[0x1128,0x92000],[0x92000,0],[0x92008,0],[0x92020,0x128],[0x92028,0xA0000],[0x92030,0xA0190],
        [0xA0010,7],[0xA0020,11],[0xA0044,1],[0xA0048,0x2D],
        [0xA0060,7],[0xA0070,12],[0xA0094,1],[0xA0098,0x2E],
        [0xA00B0,7],[0xA00C0,13],[0xA00E4,4],[0xA00E8,0x2D],
        [0xA0100,7],[0xA0110,14],[0xA0134,4],[0xA0138,0x2D],
        [0xA0150,7],[0xA0160,15],[0xA0184,4],[0xA0188,0x2D]])f.memory.set(p,v);
    const before=f.writes.length;f.invoke();
    const s=f.rpc.report().sequence_probe.snapshots[0];
    assert.equal(s.level.columns['0x128'].present,true);
    assert.deepEqual({...s.level.inventory.rarity_by_key},{1:1,4:3});
    assert.equal(s.level.inventory.candy_total,4);
    assert.equal(s.level.inventory.sample_records.length,4);
    assert.equal(s.level.inventory.sample_records[0].key,0x128);
    assert.equal(s.level.inventory.note.includes('not a server-authoritative'),true);
    assert.equal(f.writes.length,before); // census performs no writes
    f.invoke();assert.equal(f.rpc.status().sequence_probe.snapshots.length,2);
    const t=f.rpc.status().sequence_probe.snapshots;
    assert.equal(t[0].level.inventory.time,t[1].level.inventory.time); // bounded rescan cache, no extra reads
});
test('sequence probe census fails closed on malformed record vectors without breaking capture',()=>{
    const f=sequenceFixture();f.install();
    for(const [p,v]of [[0x1128,0x92000],[0x92000,0],[0x92008,0],[0x92020,0x128],[0x92028,0xA0000],[0x92030,0xA0010]])f.memory.set(p,v);
    f.invoke();assert.match(f.rpc.report().sequence_probe.snapshots[0].level.inventory.error,/vector bounds/);
    f.memory.set(0x92028,0xA0000);f.memory.set(0x92030,0xA0000+0x50*1025);
    f.invoke();assert.match(f.rpc.report().sequence_probe.snapshots.at(-1).level.inventory.error,/budget/);
    assert.deepEqual({...f.rpc.report().sequence_probe.snapshots.at(-1).level.inventory.rarity_by_key},{});
    f.rpc.stop();assert.equal(f.rpc.report().sequence_probe.snapshots.length,2);
});

test('level census records surviving Candy by rarity during active phase without writes',()=>{
    const f=sequenceFixture(); // fixture default phase_raw=1, diagnostics off
    vm.runInContext('install()',f.c); // attach observer through the normal graph scan path
    for(const [p,v]of [[0x1128,0x92000],[0x92000,0],[0x92008,0],[0x92020,0x128],[0x92028,0xA0000],[0x92030,0xA00A0],
        [0xA0010,7],[0xA0020,11],[0xA0044,1],[0xA0048,0x2D],
        [0xA0060,7],[0xA0070,12],[0xA0094,4],[0xA0098,0x2D]])f.memory.set(p,v);
    const before=f.writes.length;
    f.force();f.tick();
    let t=f.rpc.status().level_census;
    assert.equal(t.samples.length,1);assert.deepEqual({...t.samples[0].surviving_by_rarity},{1:1,4:1});
    assert.equal(t.samples[0].surviving_total,2);
    f.force();f.tick();assert.equal(f.rpc.status().level_census.samples.length,1); // 5s throttle
    f.memory.set(0xA0034,1);vm.runInContext('levelCensuses[levelCensuses.length-1].time-=6000',f.c);
    f.force();f.tick();t=f.rpc.status().level_census;
    assert.equal(t.samples.length,2);assert.equal(t.samples[1].surviving_total,2);
    // Phase change is not censused.
    f.memory.set(0x1138,2);f.force();f.tick();
    assert.equal(f.rpc.status().level_census.samples.length,2);
    assert.equal(f.writes.length,before);
});

test('sequence probe captures bounded payload prefix read-only and survives unreadable payload',()=>{
    const f=sequenceFixture();f.install();
    f.memory.set(0x10D8,0xAA);f.memory.set(0x10D9,0xBB);
    const before=f.writes.length;f.invoke();
    const s=f.rpc.report().sequence_probe.snapshots[0];
    assert.equal(s.payload_prefix.length,128);
    assert.ok(s.payload_prefix.bytes.startsWith('aa bb 00'));
    assert.equal(f.writes.length,before);
    // Payload outside any mapped range: capture still succeeds, prefix reports the error only.
    f.c.Process.findRangeByAddress=()=>null;
    f.force();f.invoke(0x9999);
    const last=f.rpc.report().sequence_probe.snapshots.at(-1);
    assert.match(last.payload_prefix.error,/not readable/);
    assert.ok(last.owner.error); // payload prefix is captured even when ownership is not corroborated
});

function surveyFixture() {
    const f=sequenceFixture();
    const M=vm.runInContext('C.manager_survey',f.c);
    f.identity(0x30000,0x31000,0x32000,0x33000,'N11EndlessMaze7ManagerE');
    const d=i=>0x40000+i*0x50;
    f.memory.set(0x30078,0x40000);f.memory.set(0x30080,0x40000+4*0x50);
    for(let i=0;i<4;i++)for(const [off,v] of [[0x11,0],[0x20,0],[0x44,1],[0x48,0x2D]])f.memory.set(d(i)+off,v);
    f.memory.set(d(0)+0x11,0x3F);f.memory.set(d(0)+0x20,7);
    f.memory.set(d(2)+0x44,4);f.memory.set(d(2)+0x20,9);
    f.memory.set(d(3)+0x44,2);
    return {...f,M};
}
test('manager survey reads authored descriptor rarity histogram by explicit address only',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    // Without an address the survey tries strict vtable location, and never guesses an object.
    assert.match(f.rpc.managerSurvey().error,/no vptr layout/);
    const r=f.rpc.managerSurvey('0x30000');
    assert.equal(r.status,'found');assert.equal(r.last.count,4);
    assert.deepEqual({...r.last.rarity_histogram},{'1':2,'2':1,'4':1});
    assert.equal(r.last.gold_descriptors,1);assert.equal(r.last.candy_total,4);
    assert.equal(r.last.candies.find(c=>c.rarity===4).descriptor_id,9);
    assert.equal(r.last.read_only,true);
    assert.equal(f.writes.length,0); // survey never writes
});
test('manager survey refuses wrong class, bad vector bounds and budget without writes',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    f.identity(0x30000,0x31000,0x32000,0x33000,'20EndlessMazePlayState');
    assert.match(f.rpc.managerSurvey('0x30000').error,/unexpected class/);
    const g=surveyFixture();g.c.ptr=n=>g.pointer(Number(n));g.memory.set(0x30080,0x40000+0x50*3+8);
    assert.match(g.rpc.managerSurvey('0x30000').error,/bounds/);
    const h=surveyFixture();h.c.ptr=n=>h.pointer(Number(n));h.memory.set(0x30080,0x40000+h.M.stride*(h.M.max_descriptors+1));
    assert.match(h.rpc.managerSurvey('0x30000').error,/budget/);
    for(const x of [f,g,h])assert.equal(x.writes.length,0);
});
test('mark survey ADDRESS routes to the survey instead of a plain label mark',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    const r=f.rpc.mark('survey 0x30000');
    assert.equal(r.mark,true);assert.equal(r.survey.last.gold_descriptors,1);
    assert.ok(f.rpc.mark('picked golden').events_retained>=1); // plain label still marks
    assert.equal(f.rpc.report().events.some(e=>e.kind==='user_mark'&&e.label==='picked golden'),true);
});

test('survey label without an address attempts location instead of being rejected',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    const M=vm.runInContext('C.manager_survey',f.c);
    f.memory.set(0x35100,0x777000);
    f.c.Process.enumerateRanges=()=>[{base:f.pointer(0x34000),size:0x2000,protection:'rw-'}];
    f.c.Memory.scanSync=()=>[];
    // Location finds nothing, but the attempt itself is recorded, not silently a plain mark.
    const r=f.rpc.mark('survey');
    assert.equal(r.requested,'locate');
    assert.equal(r.survey.status,'unavailable');
    assert.match(r.survey.error,/no vptr layout|no verified/);
    const locate=f.rpc.report().manager_locate;
    assert.equal(locate.status,'unavailable');assert.match(locate.error,/no vptr layout|no verified/);
    assert.equal(f.rpc.report().events.some(e=>e.kind==='manager_survey_rejected'),false);
    // An explicit address in free wording still routes by address.
    const g=surveyFixture();g.c.ptr=n=>g.pointer(Number(n));
    const byAddress=g.rpc.mark('survey Manager: 0x30000');
    assert.equal(byAddress.requested,'address');assert.equal(byAddress.survey.last.gold_descriptors,1);
    // Plain labels remain plain marks.
    const h=surveyFixture();h.c.ptr=n=>h.pointer(Number(n));
    assert.equal(h.rpc.report().manager_survey.status,'not_run');
    h.rpc.mark('picked golden');
    assert.equal(h.rpc.report().manager_survey.status,'not_run');
});
test('manager auto-locate finds the single verified Manager by vtable and refuses ambiguity',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    const M=vm.runInContext('C.manager_survey',f.c);
    // The candidate object is classifiable: vptr -> vtable, vtable-8 -> typeinfo -> name.
    f.identity(0x35000,0x100000+M.vtable,0x355000,0x356000,'N11EndlessMaze7ManagerE');
    f.memory.set(0x35100,0x777000); // decoy with an unrelated vptr
    // Itanium ABI: vtable-8 holds the typeinfo pointer, typeinfo+8 the name pointer.
    f.memory.set(0x100000+M.vtable-8,0x359000);f.memory.set(0x359000+8,0x35A000);
    [...Buffer.from('N11EndlessMaze7ManagerE\0')].forEach((b,i)=>f.memory.set(0x35A000+i,b));
    f.c.Process.enumerateRanges=()=>[{base:f.pointer(0x34000),size:0x2000,protection:'rw-'}];
    const seenPatterns=[];
    f.c.Memory.scanSync=(base,size,pattern)=>{
        seenPatterns.push(pattern);
        // The fixture heap holds only the candidate below; the pattern itself is checked separately.
        return [{address:f.pointer(0x35000)}];
    };
    // Manager object 0x35000 must carry its own descriptor vector.
    f.memory.set(0x35078,0x40000);f.memory.set(0x35080,0x40000+4*0x50);
    const located=f.rpc.locateManager();
    assert.equal(located.status,'found');assert.equal(located.verified.length,1);
    assert.equal(located.chosen,'0x35000');assert.equal(located.read_only,true);
    assert.match(seenPatterns[0],/^([0-9a-f]{2} ){7}[0-9a-f]{2}$/); // little-endian pointer bytes
    const r=f.rpc.managerSurvey();
    assert.equal(r.status,'found');assert.equal(r.located,true);
    assert.deepEqual({...r.last.rarity_histogram},{'1':2,'2':1,'4':1});
    assert.equal(f.writes.length,0);
});

test('manager location accepts the vtable header layout and keeps both probe results',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    const M=vm.runInContext('C.manager_survey',f.c);
    // Runtime vptr sits 16 bytes after the symbol RVA; object carries that vptr.
    const runtime=0x100000+M.vtable+16;
    f.identity(0x35000,runtime,0x355000,0x356000,'N11EndlessMaze7ManagerE');
    f.c.Process.enumerateRanges=()=>[{base:f.pointer(0x34000),size:0x2000,protection:'rw-'}];
    f.c.Memory.scanSync=()=>[{address:f.pointer(0x35000)}];
    f.memory.set(0x35078,0x40000);f.memory.set(0x35080,0x40000+4*0x50);
    const located=f.rpc.locateManager();
    assert.equal(located.status,'found');
    assert.equal(located.vtable_rva,'0x2026fd8');
    assert.equal(located.vtable_candidates.length,2);
    assert.equal(located.vtable_candidates[1].layout,'runtime vptr after 16-byte vtable header');
    assert.equal(located.vtable_candidates[1].name,'N11EndlessMaze7ManagerE');
    assert.equal(f.writes.length,0);
});

test('manager location verifies during the scan and stops at the first confirmed object',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    const M=vm.runInContext('C.manager_survey',f.c);
    f.identity(0x35000,0x100000+M.vtable,0x355000,0x356000,'N11EndlessMaze7ManagerE');
    f.memory.set(0x35078,0x40000);f.memory.set(0x35080,0x40000+4*0x50);
    f.c.Process.enumerateRanges=()=>[
        {base:f.pointer(0x34000),size:0x1000,protection:'rw-'},
        {base:f.pointer(0x36000),size:0x100000,protection:'rw-'},
        {base:f.pointer(0x400000),size:0x20000000,protection:'rw-'}];
    let scans=0;
    f.c.Memory.scanSync=(base)=>{
        scans++;
        if(base.n===0x34000)return [];                       // empty range: keep going
        if(base.n===0x36000)return [{address:f.pointer(0x35000)}]; // confirmed here
        throw new Error('scan should have stopped before the huge trailing range');
    };
    const located=f.rpc.locateManager();
    assert.equal(located.status,'found');
    assert.equal(scans,2);
    assert.equal(located.stopped_by_budget,false);
    assert.equal(located.scanned_bytes,0x101000);
    // A candidate that does not verify must not be reported as found.
    const g=surveyFixture();g.c.ptr=n=>g.pointer(Number(n));
    g.c.Process.enumerateRanges=()=>[{base:g.pointer(0x34000),size:0x1000,protection:'rw-'}];
    g.c.Memory.scanSync=()=>[{address:g.pointer(0x99000)}];
    const bad=g.rpc.locateManager();
    assert.equal(bad.status,'unavailable');assert.match(bad.error,/no vptr layout|no verified/);
});

test('manager location skips vanished heap ranges and still confirms the manager',()=>{
    const f=surveyFixture();f.c.ptr=n=>f.pointer(Number(n));
    const M=vm.runInContext('C.manager_survey',f.c);
    f.identity(0x35000,0x100000+M.vtable,0x355000,0x356000,'N11EndlessMaze7ManagerE');
    f.memory.set(0x35078,0x40000);f.memory.set(0x35080,0x40000+4*0x50);
    f.c.Process.enumerateRanges=()=>[
        {base:f.pointer(0x34000),size:0x1000,protection:'rw-'},
        {base:f.pointer(0x36000),size:0x800,protection:'rw-'}];
    let scans=0;
    f.c.Memory.scanSync=(base)=>{
        scans++;
        if(base.n===0x34000)throw new Error('access violation accessing 0x34000');
        return [{address:f.pointer(0x35000)}];
    };
    const located=f.rpc.locateManager();
    assert.equal(scans,2);
    assert.equal(located.status,'found');
    assert.equal(located.skipped_ranges,1);
    assert.match(located.skipped_range_samples[0].error,/access violation/);
    assert.equal(located.verified[0].gold,1);
    // Every range failing still reports unavailable, plus the skip evidence.
    const g=surveyFixture();g.c.ptr=n=>g.pointer(Number(n));
    g.c.Process.enumerateRanges=()=>[{base:g.pointer(0x34000),size:0x1000,protection:'rw-'}];
    g.c.Memory.scanSync=()=>{throw new Error('access violation');};
    const bad=g.rpc.locateManager();
    assert.equal(bad.status,'unavailable');assert.ok(bad.error);
});

test('all-gold accepts an explicit conversion cap and stops converting at it',()=>{
    const f=descriptorGoldFixture();
    const r=f.rpc.allGold(2);
    assert.equal(r.active,true);assert.equal(r.limit,2);
    // Same descriptor converted repeatedly still counts once; the cap gates further conversions.
    f.enter();assert.equal(f.rpc.status().all_gold.converted,1);assert.equal(f.rpc.status().all_gold.limit,2);
    f.memory.set(0x90044,1);f.enter(undefined);assert.equal(f.rpc.status().all_gold.converted,2);
    f.memory.set(0x90044,1);f.enter();assert.equal(f.rpc.status().all_gold.converted,2); // cap reached
    assert.equal(f.memory.get(0x90044),1); // untouched beyond the cap
    assert.equal(f.rpc.status().all_gold.active,true); // mode stays on, just stops converting
    assert.throws(()=>f.rpc.allGold(-1),/non-negative/);
    // Default cap is the authored gold count from the census, not unlimited.
    const g=descriptorGoldFixture(5);assert.equal(g.rpc.allGold().limit,5);
});

test('all-gold default cap follows the authored gold count and refuses when unknown',()=>{
    const f=descriptorGoldFixture(3);
    assert.equal(f.rpc.allGold().limit,3);
    // Census wins over nothing; snapshots are the fallback when no census sample exists.
    const g=goldFixture();
    vm.runInContext(`levelCensuses=[];sequenceProbe.snapshots=[{level:{inventory:{rarity_by_key:{'4':7}}}}]`,g.c);
    g.c.Process.findRangeByAddress=()=>({base:g.pointer(0),size:0x4000000,protection:'rwx'});
    const G=vm.runInContext('C.all_gold',g.c);
    G.signature.forEach((v,i)=>g.memory.set(0x100000+G.descriptor_factory+i,v));
    g.c.Interceptor.attach=()=>({detach(){}});g.c.Interceptor.flush=()=>{};
    assert.equal(vm.runInContext('allGoldLimit(undefined)',g.c),7);
    // Unknown authored count must fail closed instead of silently converting everything.
    vm.runInContext('sequenceProbe.snapshots=[]',g.c);
    assert.throws(()=>vm.runInContext('allGoldLimit(undefined)',g.c),/authored gold count unknown/);
    assert.equal(vm.runInContext('allGoldLimit(0)',g.c),0); // explicit override still allowed
});
