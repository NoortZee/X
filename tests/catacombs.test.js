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
    return { rpc: context.rpc.exports, hooks, detached: () => detached, pointer: () => new P(100) };
}
test('opt-in hooks, idempotent start, report and complete cleanup', () => {
    const f = fixture();
    assert.equal(f.hooks.length, 0);
    assert.equal(f.rpc.install().enabled, true);
    f.rpc.install();
    assert.equal(f.hooks.length, 5);
    assert.equal(f.rpc.report().events.length, 1);
    f.rpc.stop(); f.rpc.stop();
    assert.equal(f.detached(), 5);
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
    assert.equal(f.detached(), 5);
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
