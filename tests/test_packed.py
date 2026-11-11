"""Formato compatto dei campi del sito statico (app/packed.py)."""
from app import packed


def _field(values, **extra):
    return {"model": "gfs", "var": "t850", "grid": {"nx": 4, "ny": 5}, "max": 15.2, "min": -3.7, "values": values, **extra}


def test_ritorno_identico_con_decimali_e_mancanti():
    values = [11.3, -3.7, None, 0.0, 15.2] * 4
    f = _field(values, extra={"z850": {"values": [1500, 1512, None, 1490] * 5}})
    out = packed.unpack(packed.pack(f))
    assert out["values"] == values
    assert out["extra"]["z850"]["values"] == [1500, 1512, None, 1490] * 5
    assert out["grid"] == {"nx": 4, "ny": 5} and out["max"] == 15.2


def test_componenti_del_vento_e_valori_grandi():
    u = [12.5, -40.1, 0.0, 3.3] * 5
    v = [-1.0, 2.0, None, 80.4] * 5
    zero = [4800, 4950, 30, 0] * 5  # zero termico in metri: interi, scala 1
    out = packed.unpack(packed.pack({"u": u, "v": v, "values": zero}))
    assert out["u"] == u and out["v"] == v and out["values"] == zero


def test_valori_oltre_i_16_bit_perdono_i_decimali():
    big = [350.25, 4000.5, 1.0, 2.0] * 5  # 4000.5 × 10 non ci sta in 16 bit: si arrotonda all'intero
    out = packed.unpack(packed.pack({"values": big}))
    assert all(abs(a - b) <= 0.5 for a, b in zip(out["values"], big))


def test_molto_piu_piccolo_del_json():
    import json

    values = [round(i * 0.37 % 30 - 5, 1) for i in range(2000)]
    f = _field(values)
    assert len(packed.pack(f)) < len(json.dumps(f, separators=(",", ":"))) / 2
