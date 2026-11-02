import pytest
from orchestrator import find_anchor, build_plan, resolve_tap


def _ev(name, frame, snap=None):
    return {"name": name, "frame": frame, "snap": snap or {}}


def test_find_anchor_prefers_first_hero_update():
    evs = [_ev("unfreeze", 10), _ev("first_hero_update", 20)]
    bodies = [{"frame": 21}, {"frame": 22}]
    assert find_anchor(evs, bodies) == ("first_hero_update", 20)


def test_find_anchor_falls_back_to_body():
    evs = [_ev("unfreeze", 10)]
    bodies = [{"frame": 11}]
    assert find_anchor(evs, bodies) == ("first_body_frame", 11)


def test_find_anchor_falls_back_to_unfreeze():
    evs = [_ev("unfreeze_attack", 5)]
    assert find_anchor(evs, []) == ("unfreeze", 5)


def test_find_anchor_none():
    assert find_anchor([], []) == (None, None)


def test_build_plan_orders_by_frame_and_computes_deltas():
    evs = [
        _ev("jump", 100, {"state_a0": 0}),
        _ev("jump", 40,  {"state_a0": 0}),
        _ev("unfreeze", 10),
    ]
    plan = build_plan(evs, anchor_rec_frame=20)
    assert [p["rec_frame"] for p in plan] == [40, 100]
    assert plan[0]["frame_delta"] == 20
    assert plan[1]["frame_delta"] == 80
    assert plan[0]["idx"] == 0 and plan[1]["idx"] == 1


def test_build_plan_never_negative_delta():
    evs = [_ev("jump", 5)]
    plan = build_plan(evs, anchor_rec_frame=10)
    assert plan[0]["frame_delta"] == 0


def test_resolve_tap_explicit():
    cfg = {"tap": {"position": "explicit", "x": 100, "y": 200}}
    assert resolve_tap(cfg) == (100, 200)


def test_resolve_tap_center_lower_third():
    cfg = {"tap": {"position": "center_lower_third",
                   "screen_width": 1080, "screen_height": 1920}}
    assert resolve_tap(cfg) == (540, 1280)
