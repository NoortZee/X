"""Unit tests for compareBodyBit-equivalent in Python.

We mirror agent.js's f32Bits + -0.0→+0.0 normalisation so that in-Python
verification matches the agent-side check bit-for-bit.
"""
import struct


def f32_bits(x: float) -> int:
    u = struct.unpack("<I", struct.pack("<f", float(x)))[0]
    if u == 0x80000000:  # normalise -0.0 → +0.0
        u = 0
    return u


def compare_bits(a: dict, b: dict, fields=("px","py","vx","vy","ang","av")) -> list:
    diffs = []
    for k in fields:
        if k not in a or k not in b:
            continue
        ab, eb = f32_bits(a[k]), f32_bits(b[k])
        if ab != eb:
            diffs.append({"field": k, "aU32": ab, "eU32": eb})
    for k in ("a0","b0","g80","g84"):
        if a.get(k) != b.get(k):
            diffs.append({"field": k, "int": True,
                          "actual": a.get(k), "expected": b.get(k)})
    return diffs


def test_zero_equals_neg_zero():
    assert f32_bits(0.0) == f32_bits(-0.0) == 0


def test_simple_equality():
    assert compare_bits({"px": 1.5}, {"px": 1.5}) == []


def test_lsb_diff_is_detected():
    # 1.0 and nextafter(1.0, inf) differ by 1 ULP
    a = {"px": 1.0}
    b = {"px": struct.unpack("<f", struct.pack("<I", 0x3F800001))[0]}
    d = compare_bits(a, b)
    assert len(d) == 1 and d[0]["field"] == "px"
    assert d[0]["aU32"] == 0x3F800000
    assert d[0]["eU32"] == 0x3F800001


def test_int_fields_compared():
    d = compare_bits({"a0": 1, "g80": 0}, {"a0": 2, "g80": 0})
    assert len(d) == 1 and d[0]["field"] == "a0"


def test_frame_error_helper():
    # frame_error = reached - target
    def frame_error(reached, target):
        return reached - target
    assert frame_error(224, 224) == 0
    assert frame_error(225, 224) == 1
    assert frame_error(220, 224) == -4
