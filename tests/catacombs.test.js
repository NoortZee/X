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
