"""Compact field format of the static site (app/packed.py)."""
from app import packed


def _field(values, **extra):
    return {"model": "gfs", "var": "t850", "grid": {"nx": 4, "ny": 5}, "max": 15.2, "min": -3.7, "values": values, **extra}


def test_roundtrip_with_decimals_and_missing():
    values = [11.3, -3.7, None, 0.0, 15.2] * 4
    f = _field(values, extra={"z850": {"values": [1500, 1512, None, 1490] * 5}})
    out = packed.unpack(packed.pack(f))
    assert out["values"] == values
    assert out["extra"]["z850"]["values"] == [1500, 1512, None, 1490] * 5
    assert out["grid"] == {"nx": 4, "ny": 5} and out["max"] == 15.2


def test_wind_components_and_large_values():
    u = [12.5, -40.1, 0.0, 3.3] * 5
    v = [-1.0, 2.0, None, 80.4] * 5
    zero = [4800, 4950, 30, 0] * 5  # freezing level in metres: integers, scale 1
    out = packed.unpack(packed.pack({"u": u, "v": v, "values": zero}))
    assert out["u"] == u and out["v"] == v and out["values"] == zero


def test_values_beyond_16_bits_lose_decimals():
    big = [350.25, 4000.5, 1.0, 2.0] * 5  # 4000.5 × 10 does not fit in 16 bits: rounded to an integer
    out = packed.unpack(packed.pack({"values": big}))
    assert all(abs(a - b) <= 0.5 for a, b in zip(out["values"], big))


def test_much_smaller_than_json():
    import json

    values = [round(i * 0.37 % 30 - 5, 1) for i in range(2000)]
    f = _field(values)
    assert len(packed.pack(f)) < len(json.dumps(f, separators=(",", ":"))) / 2


def test_large_smooth_lists_as_differences():
    import math

    nx, ny = 120, 90  # smooth field with a few missing values and a jump: the difference form pays off
    values = [round(10 * math.sin(i % nx / 15) + 5 * math.cos(i // nx / 9), 1) for i in range(nx * ny)]
    values[17] = None
    values[5000] = -300.0
    f = _field(values, u=[float(i % 7) for i in range(20)])
    data = packed.pack(f)
    assert b'"$z"' in data[:400] and b'"$q"' in data[:400]  # the large list as differences, the small one not
    out = packed.unpack(data)
    assert out["values"] == values and out["u"] == f["u"]
