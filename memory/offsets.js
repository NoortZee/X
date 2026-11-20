// Shared memory layout for both Frida agents. Loaded from disk by TAS/memory.rs.
// Offsets are relative to module/object bases, not absolute process addresses.
// Compatibility and update instructions: docs/MEMORY.md. History: docs/CHANGELOG.md.
'use strict';

const MEMORY_LAYOUT = {
    game_version: '2.84.1',
    arch: 'x64',
    module_name: 'libthieves.so',
    pointer_alignment_mask: 7,
    tas: {
        signatures: {
            FRAME_FUNC: '48 83 7F 20 00 0F 84 ?? ?? ?? ?? 55 48 89 E5 41 57 41 56 41 55 41 54 53 48 83 EC 18 41 89 F4 48 89 FB 8B 87 B0 00 00 00',
            JUMP: '55 48 89 E5 53 50 48 89 FB E8 ?? ?? ?? ?? 84 C0 74 ?? 48 89 DF 48 83 C4 08 5B 5D E9 ?? ?? ?? ??',
            UNFREEZE: '55 48 89 E5 41 57 41 56 41 54 53 48 89 FB 44 8B B7 B4 00 00 00 F3 0F 10 05 ?? ?? ?? ??',
            UNFREEZE_ATTACK: '55 48 89 E5 53 50 48 89 FB E8 ?? ?? ?? ?? 80 BB 48 01 00 00 00 75 ?? 48 8B BB C8 00 00 00',
        },
        fallback: {
            FRAME_FUNC: 0x1612A20,
            JUMP: 0x1611F00,
            UNFREEZE: 0x13F92C0,
            UNFREEZE_ATTACK: 0x13DA8B0,
        },
        hero: {
            VTABLE: 0x00,
            BODY_PTR: 0x20,
            STATE_A0: 0xA0,
            COOLDOWN_B0: 0xB0,
            GROUND_80: 0x80,
            GROUND_84: 0x84,
        },
        body: {
            TYPE: 0x00,
            DYNAMIC_TYPE: 2,
            XF_PX: 0x0C,
            XF_PY: 0x10,
            SW_A: 0x38,
            VX: 0x40,
            VY: 0x44,
            AV: 0x48,
            GRAVITY: 0xA8,
            BODY_SIZE: 0x200,
        },
    },
    stones: {
        parser_aob: '55 48 89 E5 41 57 41 56 41 55 41 54 53 48 81 EC 88 00 00 00 ' +
            '49 89 F6 49 89 FF 48 8D 47 08 48 89 45 B0 48 8D',
        parser_fallback: 0xF680D0,
        // [offset, output field, read type]
        rival_fields: [
            [0x88, 'gold', 's32'],
            [0x8C, 'field4', 's32'],
            [0x90, 'player_level', 's32'],
            [0x94, 'field16', 's32'],
            [0x98, 'fraction', 'f32'],
            [0x9C, 'b6', 'u8'],
            [0xA0, 'field21', 's32'],
            [0xA4, 'field22', 's32'],
        ],
        rival_n_items: 0x20,
        rival_items_ptr: 0x28,
        item_fields: { rating: 0x18, slot: 0x1C, flag: 0x20, cnt: 0x24 },
        item_size: 0x28,
        item_stride: 8,
        item_first_ptr: 8,
    },
    catacombs: {
        // Candidate profile supplied by static analysis, not runtime verified.
        signatures: {
            replay_update: '55 48 89 E5 41 57 41 56 41 55 41 54 53 48 83 EC 18 48 89 FB E8 ?? ?? ?? ?? 48 8B BB 60 01 00 00',
            skull_spawn: '55 48 89 E5 41 57 41 56 41 55 41 54 53 50 F3 0F 11 45 D4 48 89 FB E8 ?? ?? ?? ?? E8 ?? ?? ?? ?? 48 8B B3 B8 00 00 00 48 89 C7 F3 0F 10 45 D4',
            skull_commit: '55 48 89 E5 41 57 41 56 41 55 41 54 53 50 41 89 F6 48 89 FB 48 8B 87 08 01 00 00 48 85 C0 75 1B',
            collect_request: '55 48 89 E5 41 57 41 56 41 54 53 48 81 EC B0 04 00 00 41 89 D7 48 89 F3 49 89 FE 48 8D BD 30 FB FF FF E8 ?? ?? ?? ?? BF 20 00 00 00',
            death_skull_update: '55 48 89 E5 53 50 48 89 FB E8 ?? ?? ?? ?? 48 85 C0 74 18 C6 83 A9 01 00 00 00 48 89 DF BE 01 00',
        },
        state: { skull_begin: 0x120, skull_end: 0x128, skull_objects: 0x138, level: 0x98 },
        descriptor: { data: 0x18, active: 0x98 },
        skull: { active: 0x1A9 },
        result: { pointer: 0x290, count: 0x20 },
        profile: { userinfo: 0x18, count: 0x148, cap: 0x4B0 },
        limits: { descriptors: 512, events: 1000, skulls: 512, count: 100000, sample_ms: 1000 },
    },
    platform: {
        libc: 'libc.so',
        clock_monotonic: 1,
        syscall_clock_gettime: 228,
        time_struct_size: 16,
        time_seconds: 0,
        time_subseconds: 8,
    },
};

// Agents share a read-only layout within their own Frida script context.
(function freezeLayout(value) {
    for (const child of Object.values(value)) {
        if (child !== null && typeof child === 'object') freezeLayout(child);
    }
    Object.freeze(value);
})(MEMORY_LAYOUT);
