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
    vm.runInContext((production ? fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8').replace(/underground: (?:true|false)/, 'underground: ' + underground).replace('auto_rise: true', 'auto_rise: ' + autoRise).replace('up: 1920', autoRise ? 'up: 1920' : 'up: 768').replace('timeout_ms: 6000', autoRise ? 'timeout_ms: 6000' : 'timeout_ms: 3000') : fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8').replace('no_fall: { enabled: true', 'no_fall: { enabled: false').replace('speed: { enabled: true', 'speed: { enabled: false').replace('mask_test: { enabled: true', 'mask_test: { enabled: false').replace('wall_pass: { enabled: false', 'wall_pass: { enabled: true').replace('diagnostics: false', 'diagnostics: true').replace('auto_teleport: { enabled: true', 'auto_teleport: { enabled: false')) .replace('observe_attach: true', 'observe_attach: ' + observeAttach) + '\n' +
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
    f.rpc.start(1); f.tick();
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
    const f = fixture(n); assert.throws(() => f.rpc.start(1), /expected 1 match/);
    assert.equal(f.rpc.status().enabled, false);
});
test('sampling and bounded histories/events', () => {
    const f = fixture(); f.rpc.start(1); f.tick(); f.tick();
    assert.equal(f.rpc.status().samples, 1);
    for (let i = 0; i < 1250; i++) { f.force(); f.tick(); }
    assert.equal(f.rpc.report().history.length, 120);
    vm.runInContext("for (let i = 0; i < 1100; i++) event('bounded', {})", f.c);
    assert.equal(f.rpc.report().events.length, 1000);
});
test('failed or truncated scan must not imply disappearance', () => {
    const f = fixture(); f.rpc.start(1); f.tick();
    f.memory.delete(0x3000); f.force(); f.tick();
    assert.equal(f.rpc.report().latest.object_graph.complete, false);
    assert.ok(!f.rpc.report().events.some(e => e.kind === 'candy_not_in_array'));
    f.memory.set(0x2018, -1); f.force(); f.tick();
    assert.match(f.rpc.report().latest.object_graph.error, /invalid declared slots/);
    assert.equal(f.rpc.status().enabled, true);
});
test('disappearance is recorded as observation, never credited collection', () => {
    const f = fixture(); f.rpc.start(1); f.tick();
    f.memory.set(0x2800, 0); f.force(); f.tick();
    const e = f.rpc.report().events.find(e => e.kind === 'candy_not_in_array');
    assert.match(e.interpretation, /not proof/);
});
test('report never dereferences a retained pointer', () => {
    const f = fixture(); f.rpc.start(1); f.tick(); f.memory.clear();
    assert.equal(f.rpc.report().latest.object_graph.candies.length, 1);
});
test('only one explicit native rebuild callsite, no patches or non-position writes', () => {
    const s = fs.readFileSync(path.join(root, 'catacombs/agent.js'), 'utf8');
    assert.doesNotMatch(s, /Interceptor\.(replace|replaceFast)|Memory\.(patchCode|protect)/);
    assert.equal((s.match(/\.writeFloat\(/g) || []).length, 12);
    assert.doesNotMatch(s, /\.write(?:Pointer|S32|U8|ByteArray)\(/);
});
test('LIVE hero chain keeps visual coordinates separate from physics', () => {
    const f = fixture();
    for (const [p, v] of [[0x1040, 0x4000], [0x4018, 0x5000], [0x5198, 0x6000], [0x6020, 0x7000],
        [0x5034, 37892], [0x5038, 393], [0x700C, 12], [0x7010, 6], [0x7040, 2.2],
        [0x7044, 0], [0x7038, 0], [0x7048, 0], [0x70A8, 1]]) f.memory.set(p, v);
    f.rpc.start(1); f.tick();
    const graph = f.rpc.report().latest.hero_graph;
    assert.equal(graph.hero.position.x, 37892);
    assert.equal(graph.hero_body.address, '0x6000');
    assert.equal(graph.physics.fields.XF_PX, 12);
    assert.equal(graph.physics.fields.VX, 2.2);
});
test('declared array size is reported when scan is truncated', () => {
    const f = fixture(); f.memory.set(0x2018, 1025); f.rpc.start(1); f.tick();
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
    f.rpc.start(1); f.tick();
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
    f.rpc.start(1); f.tick();
    return f;
}
test('Candy physics candidate is read-only and compares independent physical position', () => {
    const f = fixture();
    f.identity(0x6000, 0x8300, 0x9300, 0xA300, '20EndlessMazeCandyBody');
    for (const [p, v] of [[0x3198, 0x6000], [0x6020, 0x7000], [0x7000, 0],
        [0x700C, 0.12], [0x7010, 0.06], [0x7040, 0], [0x7044, 0],
        [0x7038, 0], [0x7048, 0], [0x70A8, 0]]) f.memory.set(p, v);
    f.c.Process.findRangeByAddress = () => ({ base: f.pointer(0), size: 0x4000000, protection: 'rw-' });
    f.rpc.start(1); f.tick();
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
    f.rpc.start(1); f.tick();
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
    f.rpc.start(1); f.tick();
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
    f.rpc.start(1); f.tick();
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
    f.rpc.start(1); f.tick();
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
test('auto halts after validation failure and rearms only on observed level phase transition',()=>{
    const f=autoFixture(); f.leave(); f.c.testTime=1300;
    f.memory.set(0xE0B8,0); f.leave(); assert.equal(f.rpc.status().auto_run.halted,true);
    f.memory.set(0xE0B8,0x16000); f.c.testTime=2000; f.leave(); assert.equal(f.nativeCalls(),0);
    f.memory.set(0x1138,0); f.leave(); assert.equal(f.rpc.status().auto_run,null);
    f.memory.set(0x1138,1); f.leave(); f.c.testTime=2300; f.leave(); assert.equal(f.nativeCalls(),1);
    f.rpc.stop(); f.c.testTime=4000; f.leave(); assert.equal(f.nativeCalls(),1);
});
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

test('speed config search refuses missing, ambiguous or bad required neighbours',()=>{
    for(const [count,mismatch] of [[0,false],[2,false],[1,true]]) {
        const f=wallFixture(count,mismatch,true);vm.runInContext('applySpeed(wallTestState)',f.c);
        assert.equal(f.rpc.status().speed.status,'unavailable');assert.equal(f.writes.length,0);
    }
});
test('speed restores on inactive phase and rearms next level, not during pause',()=>{
    const f=wallFixture(1,false,true);f.memory.set(0x1088,1);
    vm.runInContext('applySpeed(wallTestState)',f.c);assert.equal(f.writes.length,0);
    f.memory.set(0x1088,0);vm.runInContext('applySpeed(wallTestState)',f.c);
    f.memory.set(0x1138,2);vm.runInContext('applySpeed(wallTestState)',f.c);
    assert.equal(f.rpc.status().speed.status,'restored');
    assert.equal(f.memory.get(0x250008),2.20000004768);
    f.memory.set(0x1138,1);vm.runInContext('applySpeed(wallTestState)',f.c);
    assert.equal(f.rpc.status().speed.status,'applied');
});
test('speed restore does not overwrite external modifications',()=>{
    const f=wallFixture(1,false,true);vm.runInContext('applySpeed(wallTestState)',f.c);
    f.memory.set(0x250008,7);f.rpc.stop();
    assert.equal(f.memory.get(0x250008),7);assert.equal(f.rpc.status().speed.status,'restore_failed');
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

test('spawn metadata rejects unsafe u64, oversized capacity and wrong RTTI',()=>{
    for(const [address,value] of [[0x2018,'18446744073709551615'],[0x2018,1025],[0x2000,0]]) {
        const f=spawnArrayFixture();f.memory.set(address,value);
        assert.throws(()=>vm.runInContext('inspectSpawnArray(spawnState)',f.c));assert.equal(f.writes.length,0);
    }
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

test('no-fall cleanup does not invalidate live attach observer status',()=>{
    const f=fixture();
    vm.runInContext(`attachObservationStatus={status:'listening',observed:1};
        attachObservations=[{time:123}];restoreNoFall('level inactive');`,f.c);
    assert.equal(f.rpc.status().attach_observer.status,'listening');
    assert.equal(vm.runInContext('attachObservations.length',f.c),1);
    f.rpc.start(1);
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
    f.force();f.tick();return {...f,calls};
}
test('spawn attach signature uses pristine pre-observer prologue, not a captured Frida jump',()=>{
    const profile=fs.readFileSync(path.join(root,'memory/offsets.js'),'utf8');
    const cfg=vm.runInNewContext(profile+'; MEMORY_LAYOUT.catacombs');
    const sig=cfg.spawn_gold.signatures.find(s=>s.rva===cfg.spawn_gold.attach);
    assert.equal(sig.bytes.length,64);
    assert.equal(sig.bytes.slice(0,cfg.spawn_probe.attach_prefix.length).join(','),cfg.spawn_probe.attach_prefix.join(','));
    assert.equal(sig.bytes.slice(0,6).join(','),'85,72,137,229,65,86');
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
    f.rpc.start(1); // attach observer through the normal graph scan path
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

test('stage snapshot exposes boundary/continue fields read-only and records changes',()=>{
    const f=fixture();f.rpc.start(1);
    // current=18 (float), lower1, upper21, max20, goal object, continue flag0, phase1
    f.memory.set(0x10F0,18);f.memory.set(0x1178,1);f.memory.set(0x117C,21);
    f.memory.set(0x1180,20);f.memory.set(0x1188,0x7000);f.memory.set(0x1194,0);f.memory.set(0x1190,0);
    const before=f.writes.length;
    f.force();f.tick();
    let st=f.rpc.status().stages.latest;
    assert.equal(st.phase,1);assert.equal(st.current,18);assert.equal(st.upper,21);
    assert.equal(st.max,20);assert.equal(st.goal_object,'0x7000');assert.equal(st.continue_flag,0);
    assert.equal(st.read_only,true);
    // unchanged fields are coalesced; a boundary/flag change is a new history entry
    f.force();f.tick();assert.equal(f.rpc.status().stages.history.length,1);
    f.memory.set(0x117C,22);f.memory.set(0x1194,1);
    f.force();f.tick();
    const s=f.rpc.status().stages;
    assert.equal(s.history.length,2);assert.equal(s.latest.upper,22);assert.equal(s.latest.continue_flag,1);
    assert.equal(s.note.includes('Nothing is modified'),true);
    assert.equal(f.writes.length,before); // observation performs no writes
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
function autoFixture(underground = false, autoRise = false) {
    const f = teleportFixture(true, underground, autoRise);
    f.c.testTime = 1000;
    vm.runInContext('Date.now = () => testTime', f.c);
    return f;
}
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
function spawnArrayFixture() {
    const f=fixture();
    f.identity(0x2000,0x8500,0x9500,0xA500,'6ZArrayI12KTGameObjectE');
    for(const [p,v] of [[0x2020,0],[0x2028,1],[0x2030,32],[0x2038,0],[0x3008,2],[0x8400,0x260000]])f.memory.set(p,v);
    f.c.spawnState=f.pointer(0x1000);
    f.c.Process.findRangeByAddress=()=>({base:f.pointer(0x100000),size:0x3000000,protection:'r-x'});
    f.c.Instruction={parse:()=>({size:1,mnemonic:'ret',opStr:''})};
    return f;
}
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

test('start is the single command surface and validates the speed 1..10',()=>{
    const f=wallFixture(1,false,true);
    for(const bad of [0,11,-1,2.5,'fast'])assert.throws(()=>f.rpc.start(bad),/speed/);
    assert.equal(typeof f.c.install,'undefined'); // internal install is not exposed as a command
    const r=f.rpc.start(4);
    assert.equal(r.enabled,true);assert.equal(r.speed.requested,4);assert.equal(r.speed.multiplier,4);
    // The multiplier is what the physics block receives.
    f.memory.set(0x1088,0);f.memory.set(0x1138,1);
    vm.runInContext('applySpeed(wallTestState)',f.c);
    assert.equal(f.rpc.status().speed.multiplier,4);
    assert.ok(Math.abs(f.memory.get(0x250008)-2.20000004768*4)<1e-6); // float32 storage tolerance
    // stop() restores the character value (asserted by the restore tests above).
    f.rpc.stop();
    // Repeated identical start is idempotent; a different speed reloads the session.
    assert.equal(f.rpc.start(4).enabled,true);
    assert.equal(f.rpc.start(4).speed.unchanged,true);
});
test('speed 1 leaves the character value untouched',()=>{
    const f=wallFixture(1,false,true);
    const before=f.memory.get(0x250008);
    f.rpc.start(1);
    f.memory.set(0x1088,0);f.memory.set(0x1138,1);
    vm.runInContext('applySpeed(wallTestState)',f.c);
    assert.equal(f.memory.get(0x250008),before);
    assert.equal(f.rpc.status().speed.status,'applied');
});
