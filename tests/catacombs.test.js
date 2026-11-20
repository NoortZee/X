'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function fixture(matches = 1, attachFailure = false) {
    const hooks = []; let detached = 0;
    class P {
        constructor(n) { this.n = n; }
        add(n) { return new P(this.n + n); }
        sub(p) { return new P(this.n - p.n); }
        toString() { return '0x' + this.n.toString(16); }
        readPointer() { return new P(0); }
        readU8() { return 3; } // deliberately invalid flag
    }
    const context = vm.createContext({
        Process: { pointerSize: 8, findModuleByName: () => ({
            enumerateRanges: () => [{ base: new P(4096), size: 4096 }],
        }) },
        Memory: { scanSync: () => Array.from({ length: matches }, (_, i) => ({ address: new P(4096 + i) })) },
        Interceptor: { attach(address, callbacks) {
            if (attachFailure && hooks.length === 2) throw new Error('attach failed');
            hooks.push(callbacks); return { detach() { detached++; } };
        } }, rpc: { exports: {} },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'catacombs/agent.js'), 'utf8'), context);
    return { context, rpc: context.rpc.exports, hooks, detached: () => detached, pointer: () => new P(100) };
}
test('opt-in hooks, idempotent start, report and complete cleanup', () => {
    const f = fixture();
    assert.equal(f.hooks.length, 0);
    assert.equal(f.rpc.install().enabled, true);
    f.rpc.install();
    assert.equal(f.hooks.length, 8);
    assert.equal(f.rpc.report().events.length, 1);
    f.rpc.stop(); f.rpc.stop();
    assert.equal(f.detached(), 8);
});
for (const matches of [0, 2]) test('reject nonunique signatures: ' + matches, () => {
    const f = fixture(matches);
    assert.throws(() => f.rpc.install(), /expected 1 match/);
    assert.equal(f.rpc.status().enabled, false);
    assert.equal(f.hooks.length, 0);
});
test('partial attach failure detaches installed hooks', () => {
    const f = fixture(1, true);
    assert.throws(() => f.rpc.install(), /attach failed/);
    assert.equal(f.detached(), 2);
});
test('invalid runtime field disables the entire module and records reason', () => {
    const f = fixture(); f.rpc.install();
    f.hooks[2].onEnter([f.pointer()]);
    assert.equal(f.rpc.status().enabled, false);
    assert.match(f.rpc.status().last_error, /invalid skull active/);
    assert.equal(f.detached(), 8);
});
test('read-only implementation never writes memory or invokes game functions', () => {
    const source = fs.readFileSync(path.join(root, 'catacombs/agent.js'), 'utf8');
    assert.doesNotMatch(source, /\.write\w*\(|NativeFunction|Interceptor\.(replace|replaceFast)|Memory\.(patchCode|protect)/);
});
test('event buffer remains bounded during frequent request observations', () => {
    const f = fixture(); f.rpc.install();
    for (let i = 0; i < 1500; i++) f.hooks[4].onEnter([]);
    assert.equal(f.rpc.report().events.length, 1000);
    assert.equal(f.rpc.status().counters.requests, 1500);
});
test('runtime failure leaves callbacks inert until explicitly restarted', () => {
    const f = fixture(); f.rpc.install();
    f.hooks[2].onEnter([f.pointer()]);
    const before = f.rpc.report().events.length;
    f.hooks[4].onEnter([]);
    assert.equal(f.rpc.report().events.length, before);
    assert.equal(f.rpc.install().enabled, true);
});

test('replay_update signature matches supplied file and runtime bytes, including rel32 wildcards', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8'), context);
    const pattern = vm.runInContext('MEMORY_LAYOUT.catacombs.signatures.replay_update', context)
        .split(/\s+/);
    // User-supplied runtime dump at module_base + 0x13EF310; also matches file .text.
    const dump = (
        '55 48 89 e5 41 57 41 56 41 55 41 54 53 48 83 ec 18 ' +
        '48 89 fb e8 97 9f 00 00 48 8b bb 60 01 00 00 ' +
        '48 8b 07 ff 90 e8 00 00 00 4c 8b bb 38 01 00 00 ' +
        '41 8b 4f 20 85 c9 0f 88 80 00 00 00 49 c7 c4 ff ' +
        'ff ff ff eb 3b 66 66 2e 0f 1f 84 00 00 00 00 00 ' +
        'e8 ab 75 b3 00 48 89 c7 4c 89 f6 e8 b0 75 b3 00');
    const bytes = Buffer.from(dump.replace(/\s+/g, ''), 'hex');
    function matches(bytes) {
        return bytes.length >= pattern.length && pattern.every((token, i) =>
            token === '??' || parseInt(token, 16) === bytes[i]);
    }
    assert.equal(matches(bytes), true);
    const relocatedCall = Buffer.from(bytes);
    relocatedCall.fill(0xAA, 21, 25);
    assert.equal(matches(relocatedCall), true);
    const oldWrongInstruction = Buffer.from(bytes);
    oldWrongInstruction[27] = 0x83;
    assert.equal(matches(oldWrongInstruction), false);
});

test('collect_request uses the distinguishing 117-byte prefix from the supplied runtime dump', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8'), context);
    const pattern = vm.runInContext('MEMORY_LAYOUT.catacombs.signatures.collect_request', context)
        .split(/\s+/);
    const bytes = Buffer.from((
        '55 48 89 e5 41 57 41 56 41 54 53 48 81 ec b0 04 ' +
        '00 00 41 89 d7 48 89 f3 49 89 fe 48 8d bd 30 fb ' +
        'ff ff e8 e9 58 0c 00 bf 20 00 00 00 e8 df 7f 0d ' +
        '01 49 89 c4 48 89 c7 e8 24 ef 09 00 80 8d 52 fb ' +
        'ff ff 02 c7 45 dc 0f 00 00 00 48 8b bd c0 fb ff ' +
        'ff 48 85 ff 74 06 48 8b 07 ff 50 08 80 8d 41 fb ' +
        'ff ff 20 4c 89 a5 c0 fb ff ff 41 80 4c 24 10 01 ' +
        '45 89 7c 24 18 48 8d b5 30 fb ff ff 4c 89 f7 48 ' +
        '89 da 31 c9 e8 27 93 ff ff 48 8d bd 30 fb ff ff ' +
        'e8 5b 59 0c 00 48 81 c4 b0 04 00 00 5b 41 5c 41 ' +
        '5e 41 5f 5d c3').replace(/\s+/g, ''), 'hex');
    function matches(buffer) {
        return buffer.length >= pattern.length && pattern.every((token, i) =>
            token === '??' || parseInt(token, 16) === buffer[i]);
    }
    assert.equal(pattern.length, 117);
    assert.equal(matches(bytes), true);
    const relocated = Buffer.from(bytes);
    for (const offset of [35, 45, 56]) relocated.fill(0xAA, offset, offset + 4);
    assert.equal(matches(relocated), true);
    // Same old 44-byte prefix, different request-specific trailing instruction.
    const otherBuilder = Buffer.from(bytes);
    otherBuilder[116] = 0x1C;
    assert.equal(matches(otherBuilder), false);
    assert.equal(matches(bytes.subarray(0, 44)), false);
});


test('entry counters survive candidate field validation failure', () => {
    const f = fixture(); f.rpc.install();
    f.hooks[2].onEnter([f.pointer()]);
    assert.equal(f.rpc.status().counters.death_skull_update, 1);
    assert.equal(f.rpc.status().counters.replay_update, 0);
    assert.equal(f.rpc.status().enabled, false);
});

test('control hook counts every call but bounds identity samples and tolerates RTTI failure', () => {
    const f = fixture(); f.rpc.install();
    for (let i = 0; i < 20; i++) f.hooks[5].onEnter([f.pointer()]);
    const status = f.rpc.status();
    assert.equal(status.counters.hero_control, 20);
    assert.equal(status.enabled, true);
    assert.equal(status.last_hero.object, '0x64');
    assert.ok(status.last_hero.rtti_error);
    assert.equal(f.rpc.report().events.filter(e => e.kind === 'hero_control').length, 1);
    f.rpc.stop();
    f.hooks[5].onEnter([f.pointer()]);
    assert.equal(f.rpc.status().counters.hero_control, 20);
});

test('control identity uses the object address point without adding a vtable header', () => {
    const f = fixture(); f.rpc.install();
    const name = { add(offset) { return { readU8: () => Buffer.from('8HeroBody\0NEIGHBOUR')[offset] }; } };
    const typeinfo = { toString: () => '0x3000', add(offset) {
        assert.equal(offset, 8); return { readPointer: () => name };
    } };
    const vptr = { toString: () => '0x2000', add(offset) {
        assert.equal(offset, -8); return { readPointer: () => typeinfo };
    } };
    const hero = { toString: () => '0x1000', add(offset) {
        assert.equal(offset, 0); return { readPointer: () => vptr };
    } };
    f.hooks[5].onEnter([hero]);
    const identity = f.rpc.status().last_hero;
    assert.equal(identity.vptr, '0x2000');
    assert.equal(identity.typeinfo, '0x3000');
    assert.equal(identity.rtti_name, '8HeroBody');
    assert.equal(identity.rtti_error, undefined);
});


test('RTTI stops at NUL and rejects unterminated bounded names', () => {
    const f = fixture();
    f.context.namePointer = { add(i) { return { readU8: () => Buffer.from('8HeroBody\0garbage')[i] }; } };
    assert.equal(vm.runInContext('readBoundedName(namePointer)', f.context), '8HeroBody');
    f.context.namePointer = { add() { return { readU8: () => 65 }; } };
    assert.throws(() => vm.runInContext('readBoundedName(namePointer)', f.context), /exceeds limit/);
});

test('traces are module-relative, deduplicated and bounded separately from events', () => {
    const f = fixture(); f.rpc.install();
    let offset = 64;
    const address = () => ({ toString: () => '0x' + offset.toString(16),
        sub: () => ({ toString: () => '0x' + (offset - 16).toString(16) }) });
    f.context.Process.findModuleByAddress = () => ({ name: 'libthieves.so', base: 16 });
    f.context.Backtracer = { ACCURATE: 1, FUZZY: 2 };
    let calls = 0;
    f.context.Thread = { backtrace() { calls++; return Array(24).fill(address()); } };
    vm.runInContext('captureTrace({}, null); captureTrace({}, null)', f.context);
    assert.equal(calls, 1); // time-based sampling
    vm.runInContext('lastTraceSample = null; captureTrace({}, null)', f.context);
    assert.equal(f.rpc.report().traces[0].samples, 2);
    assert.equal(f.rpc.report().traces[0].stack.length, 16);
    assert.equal(f.rpc.report().traces[0].stack[0].rva, '0x30');
    for (offset = 65; offset < 110; offset++)
        vm.runInContext('lastTraceSample = null; captureTrace({}, null)', f.context);
    assert.equal(f.rpc.report().traces.length, 32);
    for (let i = 0; i < 1100; i++) f.hooks[4].onEnter([]);
    assert.equal(f.rpc.report().traces.length, 32);
});

test('backtrace failure is isolated; fuzzy fallback is explicitly labelled', () => {
    const f = fixture(); f.rpc.install();
    f.context.Backtracer = { ACCURATE: 1, FUZZY: 2 };
    f.context.Thread = { backtrace(ctx, method) {
        if (method === 1) throw new Error('unwind failed');
        return [];
    } };
    vm.runInContext('captureTrace({}, null)', f.context);
    assert.equal(f.rpc.report().traces[0].method, 'fuzzy');
    assert.match(f.rpc.report().traces[0].accurate_error, /unwind failed/);
    assert.equal(f.rpc.status().enabled, true);
});

test('hero values use shared body offsets and isolate invalid physics reads', () => {
    const f = fixture();
    let invalid = false;
    f.context.heroPointer = { add(offset) { return {
        readS32: () => offset,
        readPointer: () => ({ toString: () => '0x5000', add(field) {
            return { readFloat: () => invalid ? NaN : field };
        } }),
    }; } };
    const values = vm.runInContext('heroValues(heroPointer)', f.context);
    assert.equal(values.physics.XF_PX, 0x0C);
    assert.equal(values.physics.XF_PY, 0x10);
    assert.equal(values.physics.VX, 0x40);
    assert.equal(values.physics.VY, 0x44);
    assert.equal(values.direction, 0x9C);
    assert.equal(values.read_error, undefined);
    invalid = true;
    assert.match(vm.runInContext('heroValues(heroPointer).read_error', f.context), /non-finite/);
});

test('PlayState snapshots preserve counters and partial data on candidate read errors', () => {
    const f = fixture(); f.rpc.install();
    for (const index of [6, 7]) {
        for (let i = 0; i < 10; i++) f.hooks[index].onEnter([f.pointer()]);
    }
    const status = f.rpc.status();
    assert.equal(status.counters.play_update, 10);
    assert.equal(status.counters.play_update_heroes, 10);
    assert.equal(status.enabled, true);
    assert.ok(status.last_play_states.play_update.identity.rtti_error);
    assert.equal(status.last_play_states.play_update.flags.paused, 3);
    assert.ok(status.last_play_states.play_update.timer_error);
    assert.equal(f.rpc.report().events.filter(e => e.kind === 'play_update').length, 1);
});

test('PlayState reads actual vptr method addresses without calling them', () => {
    const f = fixture(); f.rpc.install();
    const pointers = new Map([[0x1000, 0x2000], [0x1040, 0x3000], [0x3018, 0x4000],
        [0x1098, 0x5000], [0x10A0, 0], [0x10D0, 0],
        [0x2148, 0x6000], [0x2150, 0x7000]]);
    class Pointer {
        constructor(n) { this.n = n; }
        add(n) { return new Pointer(this.n + n); }
        toString() { return '0x' + this.n.toString(16); }
        isNull() { return this.n === 0; }
        readPointer() {
            if (!pointers.has(this.n)) throw new Error('unmapped candidate');
            return new Pointer(pointers.get(this.n));
        }
        readU8() { return 0; }
        readFloat() { return 1.5; }
        readS32() { return 15; }
    }
    f.hooks[7].onEnter([new Pointer(0x1000)]);
    const sample = f.rpc.status().last_play_states.play_update_heroes;
    assert.equal(sample.pointers.world, '0x3000');
    assert.equal(sample.world_content, '0x4000');
    assert.equal(sample.hero1.object, '0x5000');
    assert.equal(sample.hero2, undefined);
    assert.equal(sample.methods.next_frame.address, '0x6000');
    assert.equal(sample.methods.apply_frame.address, '0x7000');
    assert.equal(sample.timer, 1.5);
    assert.equal(f.rpc.status().enabled, true);
});


test('PlayState entry signatures match supplied disassembly with relocatable operands', () => {
    const f = fixture();
    const fixtures = {'play_update': '55 48 89 e5 41 56 53 48 83 ec 10 80 bf c0 00 00 00 00 74 11 48 8b 07 48 83 c4 10 5b 41 5e 5d ff a0 c0 00 00 00 80 bf c1 00 00 00 00 74 11 48 8b 07 48 83 c4 10 5b 41 5e 5d ff a0 b8 00 00 00', 'play_update_heroes': '55 48 89 e5 41 56 53 48 89 fb 4c 8b b7 98 00 00 00 4d 85 f6 74 1a 48 8d 05 03 70 d2 00 f3 0f 10 00 e8 6a f4 a2 ff 4c 89 f7 89 c6 e8 30 c3 32 00 4c 8b b3 a0 00 00 00'};
    for (const [name, dump] of Object.entries(fixtures)) {
        const pattern = vm.runInContext('C.signatures.' + name, f.context).split(/\s+/);
        const bytes = Buffer.from(dump.replace(/\s/g, ''), 'hex');
        assert.equal(bytes.length, pattern.length);
        assert.ok(pattern.every((token, i) => token === '??' || parseInt(token, 16) === bytes[i]), name);
        const changed = Buffer.from(bytes);
        pattern.forEach((token, i) => { if (token === '??') changed[i] ^= 0xFF; });
        assert.ok(pattern.every((token, i) => token === '??' || parseInt(token, 16) === changed[i]), name);
    }
});
