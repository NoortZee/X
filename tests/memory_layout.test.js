'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const layout = fs.readFileSync(path.join(root, 'memory/offsets.js'), 'utf8');

function loadAgent(file, profile = layout) {
    const reads = [];
    const hooks = [];
    const values = new Map();
    class Pointer {
        constructor(value) { this.value = Number(value); }
        add(offset) { return new Pointer(this.value + offset); }
        sub(other) { return new Pointer(this.value - Number(other)); }
        and(mask) { return new Pointer(this.value & mask); }
        isNull() { return this.value === 0; }
        toInt32() { return this.value | 0; }
        toString() { return '0x' + this.value.toString(16); }
        valueOf() { return this.value; }
        readS32() { reads.push(this.value); return values.get(this.value) || 0; }
        readU8() { return this.readS32(); }
        readU32() { return this.readS32(); }
        readFloat() { return this.readS32(); }
        readPointer() { return new Pointer(this.readS32()); }
    }
    const base = new Pointer(0x100000);
    const context = vm.createContext({
        Process: {
            arch: 'x64',
            findModuleByName: () => ({ base, size: 0x3000000 }),
            enumerateRanges: () => [],
            findRangeByAddress: () => ({}),
            getModuleByName: () => { throw new Error('No libc exports in test'); },
        },
        Module: { findGlobalExportByName: () => null },
        Memory: { alloc: () => new Pointer(0x500000) },
        Interceptor: { attach: (target) => { hooks.push(Number(target)); return { detach() {} }; } },
        Thread: { sleep() {} },
        rpc: { exports: {} }, send() {}, ptr: (value) => new Pointer(value),
    });
    vm.runInContext(profile + '\n;\n' + fs.readFileSync(path.join(root, file), 'utf8'), context);
    return { context, reads, hooks, values, base: Number(base) };
}

test('both complete agents load with the shared layout', () => {
    for (const file of ['TAS/agent.js', 'stones/rival_hook.js']) {
        const { context } = loadAgent(file);
        assert.equal(vm.runInContext('MODULE_NAME', context), 'libthieves.so');
        assert.ok(vm.runInContext('Object.isFrozen(MEMORY_LAYOUT.tas.hero)', context));
        assert.ok(vm.runInContext('Object.isFrozen(MEMORY_LAYOUT.stones.rival_fields[0])', context));
    }
});

test('TAS hook addresses are resolved from the profile, including edited values', () => {
    const profile = layout.replace('JUMP: 0x1611F00', 'JUMP: 0x123456');
    assert.notEqual(profile, layout);
    const agent = loadAgent('TAS/agent.js', profile);
    agent.context.rpc.exports.detectInstall();
    assert.ok(agent.hooks.includes(agent.base + 0x123456));
    assert.ok(!agent.hooks.includes(agent.base + 0x1611F00));
});

test('hero field reads follow an edited offset without modifying the agent', () => {
    const profile = layout.replace('STATE_A0: 0xA0', 'STATE_A0: 0xC0');
    assert.notEqual(profile, layout);
    const agent = loadAgent('TAS/agent.js', profile);
    agent.values.set(0x200000 + 0xC0, 42);
    assert.equal(vm.runInContext('heroSnapshot(ptr(0x200000)).state_a0', agent.context), 42);
    assert.ok(agent.reads.includes(0x200000 + 0xC0));
    assert.ok(!agent.reads.includes(0x200000 + 0xA0));
});

test('stones parser and item reads follow edited profile values', () => {
    const profile = layout.replace('parser_fallback: 0xF680D0', 'parser_fallback: 0x111000')
        .replace('rating: 0x18', 'rating: 0x30');
    const agent = loadAgent('stones/rival_hook.js', profile);
    agent.context.rpc.exports.installHooks();
    assert.deepEqual(agent.hooks, [agent.base + 0x111000]);
    agent.values.set(0x200000 + 0x30, 77);
    assert.equal(vm.runInContext('_readItem(ptr(0x200000), false).rating', agent.context), 77);
});

test('agents do not retain inline numeric field offsets or signature definitions', () => {
    for (const file of ['TAS/agent.js', 'stones/rival_hook.js']) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        assert.doesNotMatch(source, /\.add\(\s*(?:0x[0-9a-f]+|[0-9]+)\s*\)/i);
        assert.doesNotMatch(source, /(?:0x1612a20|0x1611f00|0x13f92c0|0xf680d0)/i);
        assert.doesNotMatch(source, /['"](?:[0-9a-f?]{2} ){8}/i);
    }
});
