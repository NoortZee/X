'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function fixture(matches = 1) {
    const memory = new Map(); let callback, detached = 0;
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
    return { c, memory, pointer: n => new P(n), rpc: c.rpc.exports, tick() { callback.onEnter([new P(0x1000)]); },
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
test('no game writes or native game calls', () => {
    const s = fs.readFileSync(path.join(root, 'catacombs/agent.js'), 'utf8');
    assert.doesNotMatch(s, /\.write\w*\(|NativeFunction|Interceptor\.(replace|replaceFast)|Memory\.(patchCode|protect)/);
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
    for (let i = 0; i < 30; i++) {
        f.c.codeTarget = f.pointer(0x200000 + i * 16);
        vm.runInContext('captureMethodCode(codeTarget)', f.c);
    }
    const records = Object.values(f.rpc.report().method_code);
    assert.equal(records.length, 24);
    assert.match(records[0].error, /not in readable executable/);
});
