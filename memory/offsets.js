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
        sequence_probe: { builder: 0xE54DA0, snapshots: 32, nodes: 64,
            state_counts: 0x148, state_payload: 0xD8, state_phase: 0x138,
            // Read-only level inventory: same record column used by pickup accounting.
            record_root: 0x128, record_stride: 0x50, record_type: 0x48, record_id: 0x20,
            record_rarity: 0x44, record_limit: 4096, record_ids: 64, candy_type: 0x2D,
            level_columns: [0x128, 0x148], level_scan_ms: 250, level_samples: 8,
            level_sample_ms: 5000,
            signature: [0x55,0x48,0x89,0xe5,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xec,0xd8,0x04,0x00,0x00] },
        all_gold: { descriptor_factory: 0x1604540, caller: 0x14DA4A4, rarity_map: 0x2183AA0,
            key: 4, value: 4, type: 0x2D, flags: 0x10, lookup_flag: 0x800, rarity_key: 0x44,
            signature: [0x55,0x48,0x89,0xe5,0x41,0x57,0x41,0x56,0x53,0x48,0x83,0xec,0x28,0x8b,0x47,0x48] },
        wall_pass: { enabled: false, pattern: '66 66 d5 41', original: 26.67499923706,
            patched: -3.00000691414, tolerance: 0.0001, max_scan_bytes: 33554432, max_matches: 64,
            // Lua neighbours validate the unique block. Third=false marks observation-only legacy fields.
            neighbours: [[0x8, 2.20000004768], [0x20, 31300], [0x64, 40], [0x68, 35.21099853516], [0x108, 12, false]] },
        speed_test: { enabled: true, offset: 0x8, multiplier: 1, baseline: 2.20000004768 },
        // Initial underground descent disabled: finish regression reported; keep prior no-fall mode.
        altitude_test: { auto_rise: true, up: 1920, velocity: 8, timeout_ms: 6000, expiry_ms: 5000, tolerance: 4 },
        no_fall: { enabled: true, underground: false, down: 64, descent_vy: 2, descent_timeout_ms: 2000 },
        mask_test: { enabled: true, value: 4, category: 2, group: 0, allowed_masks: [65533, 1, 4] },
        fixture_probe: { enabled: true, fixture_head: 0x70, next: 0x8, owner: 0x10,
            category: 0x34, mask: 0x36, group: 0x38, limit: 8, candies: 3, symbols: 4 },
        spawn_gold: { rarity: 4, expiry_ms: 5000, factory: 0x15EEA70, attach: 0x15E9700,
            body_factory: 0x15EEED0, object_setter: 0x1DCB070, array_set: 0x1092110, signatures: [{"rva": 22997616, "bytes": [85, 72, 137, 229, 65, 87, 65, 86, 83, 80, 65, 137, 254, 191, 248, 1, 0, 0, 232, 121, 126, 147, 0, 72, 137, 195, 72, 141, 120, 8, 69, 49, 255, 186, 240, 1, 0, 0, 49, 246, 232, 35, 125, 147, 0, 199, 67, 8, 1, 0, 0, 0, 15, 87, 192, 15, 17, 131, 200, 0, 0, 0, 15, 17]}, {"rva": 22976256, "bytes": [85, 72, 137, 229, 65, 86, 83, 72, 131, 236, 16, 73, 137, 246, 72, 137, 251, 72, 139, 7, 15, 41, 69, 224, 255, 144, 8, 3, 0, 0, 72, 137, 131, 152, 1, 0, 0, 72, 133, 192, 116, 53, 72, 137, 199, 232, 254, 197, 2, 0, 15, 40, 77, 224, 15, 92, 200, 15, 19, 139, 192, 1, 0, 0]}, {"rva": 22998736, "bytes": [85, 72, 137, 229, 65, 87, 65, 86, 83, 72, 131, 236, 72, 15, 41, 69, 160, 73, 137, 247, 73, 137, 254, 191, 128, 0, 0, 0, 232, 111, 119, 147, 0, 72, 137, 195, 72, 137, 199, 232, 132, 142, 2, 0, 73, 139, 119, 8, 72, 139, 3, 72, 137, 223, 15, 40, 69, 160, 255, 80, 104, 65, 139, 134]}, {"rva": 17375504, "bytes": [85, 72, 137, 229, 65, 87, 65, 86, 65, 85, 65, 84, 83, 80, 73, 137, 215, 73, 137, 246, 72, 137, 251, 72, 57, 87, 24, 118, 6, 76, 139, 99, 16, 235, 68, 72, 139, 123, 16, 72, 139, 67, 48, 73, 141, 12, 7, 77, 141, 44, 7, 73, 255, 197, 72, 141, 52, 205, 8, 0, 0, 0, 232, 125]}, {"rva": 24269328, "bytes": [85, 72, 137, 229, 65, 87, 65, 86, 65, 85, 65, 84, 83, 72, 131, 236, 24, 72, 137, 251, 72, 137, 126, 16, 76, 139, 119, 32, 72, 139, 71, 40, 73, 57, 198, 115, 15, 73, 137, 54, 73, 131, 198, 8, 77, 137, 247, 233, 188, 0, 0, 0, 72, 141, 123, 24, 76, 139, 7, 77, 41, 198, 77, 137]}] },
        spawn_probe: { expiry_ms: 5000, instructions: 256, attach_slot: 0x300, body_factory_slot: 0x308, attach_bytes: 768,
            body_parent: 0x10, parent_world: 0x8,
            observe_attach: true, attach_rva: 0x15E9700, observation_limit: 8,
            attach_prefix: [0x55, 0x48, 0x89, 0xE5, 0x41, 0x56, 0x53, 0x48, 0x83, 0xEC, 0x10, 0x49, 0x89, 0xF6, 0x48, 0x89, 0xFB, 0x48, 0x8B, 0x07],
            array_name: '6ZArrayI12KTGameObjectE', refcount: 0x8, array_high: 0x20,
            array_live: 0x28, array_growth: 0x30, array_policy: 0x38, free_samples: 16,
            candidates: {
            register_body_candidate: { rva: 0x1725210, bytes: 1536 },
            init_candidate: { rva: 0x15E90D0, bytes: 1536 },
            factory_candidate: { rva: 0x15EEA70, bytes: 768 },
            wrapper_candidate: { rva: 0x15FB8A0, bytes: 384 },
            array_push_candidate: { rva: 0x1092110, bytes: 768 } } },
        diagnostics: false,
        auto_teleport: { enabled: true, delay_ms: 300, interval_ms: 20, rarities: [1, 2, 3, 4], events: 80 },
        profile: '2.84.2 live candidates; not automatic game version detection',
        signature: '55 48 89 E5 41 57 41 56 41 55 41 54 53 48 83 EC 18 48 89 FB F3 0F 11 45 D4 E8 ?? ?? ?? ?? 48 8B 7B 50 48 85 FF 74 0B 48 8B 07 F3 0F 10 45 D4 FF 50 78',
        state: { world: 0x40, objects: 0x68, paused: 0x88, phase: 0x138 },
        world: { hero: 0x18 },
        object: { x: 0x34, y: 0x38, body: 0x198, image: 0x1A0, flag_a: 0x1A8, flag_b: 0x1A9 },
        hero_body: { physics: 0x20 },
        lifecycle_probe: { candidates: { position_wrapper_candidate: 0x1618980,
            destroy_candidate: 0x1615CB0, create_candidate: 0x1617DE0 }, direct_calls_per_root: 4,
            create_bytes: 1536, create_instructions: 512 },
        physics_extra: { sweep_x_candidate: 0x28, sweep_y_candidate: 0x2C, world_candidate: 0x58 },
        candy_body_probe: { physics_candidate: 0x20, scale: 100, tolerance: 0.05,
            body_name: '20EndlessMazeCandyBody', direct_calls: 8 },
        candy: { name: '16EndlessMazeCandy', rarity: 0x1F0 },
        teleport_white: { stored_x: 0x38, stored_y: 0x3C, world: 0x58, owner: 0xB8,
            lock: 0x19298, lock_mask: 2, tolerance: 0.05, signatures: [
            { rva: 0x1615cb0, bytes: [72, 139, 119, 32, 72, 133, 246, 116, 54, 85, 72, 137, 229, 65, 86, 83, 72, 137, 251, 76, 139, 118, 88, 76, 137, 247, 232, 65, 29, 19, 0, 72, 199, 67, 32, 0, 0, 0, 0, 242, 15, 16, 67, 56, 72, 139, 3, 72, 139, 64, 104, 72, 137, 223, 76, 137, 246, 91, 65, 94, 93, 255, 224, 195] },
            { rva: 0x1617de0, bytes: [85, 72, 137, 229, 65, 87, 65, 86, 65, 85, 65, 84, 83, 72, 129, 236, 168, 0, 0, 0, 15, 41, 133, 48, 255, 255, 255, 72, 137, 117, 200, 72, 137, 251, 15, 19, 71, 56, 15, 87] },
            { rva: 0x1747a10, bytes: [246, 135, 152, 146, 1, 0, 2, 15, 133, 20, 1, 0, 0, 85, 72, 137, 229, 65, 87, 65, 86, 65, 85, 65, 84, 83, 80, 72, 137, 243, 73, 137, 254, 76, 139, 190, 128, 0, 0, 0] },
        ] },
        move_white: { ahead: 24, direction: 0x9C, rarity: 1, expiry_ms: 5000,
            state_name: '20EndlessMazePlayState', hero_name: '4Hero',
            hero_body_name: '8HeroBody',
            setter_bytes: [0x48, 0x89, 0xF8, 0x0F, 0x13, 0x47, 0x34, 0xC3] },
        method_probe: {
            // Byte offsets from object vptr, not _ZTV header. Roles are hypotheses.
            object_methods: { slot2_candidate: 0x10, position_set_candidate: 0x238,
                position_get_candidate: 0x268 },
            body_methods: { slot0: 0, slot1: 8, slot2: 0x10, slot3: 0x18, recreate_candidate: 0x68 },
            targets: 40, bytes: 384, instructions: 128,
        },
        array: { data: 0x10, slots: 0x18 },
        rtti: { vptr: 0, typeinfo: -8, name: 8 },
        limits: { sample_ms: 500, slots: 1024, declared_slots: 16384,
            events: 1000, history: 120, name_bytes: 128, methods: 4 },
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
