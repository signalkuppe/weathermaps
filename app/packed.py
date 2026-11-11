"""Formato compatto dei campi per il sito statico (.bin): lo stesso JSON di /api/field, ma le liste di valori diventano
interi a 16 bit. Su GitHub Pages il sito deve stare sotto 1 GB: rispetto al testo JSON i campi pesano circa un terzo.

Struttura del file (little endian):
  uint32  lunghezza dell'intestazione in byte
  ...     intestazione: il JSON del campo, con ogni lista di valori sostituita da {"$q": [inizio, quanti, scala]}
  ...     zeri fino a un multiplo di 2 byte
  int16[] tutti i valori in fila; valore = intero / scala, -32768 = mancante (null)

I valori arrivano già arrotondati ai decimali della grandezza: la scala (1, 10, 100) li riporta interi senza perdite.
Se un valore non ci sta in 16 bit con quella scala si scende di un decimale (succede solo per campi fuori dal comune).
Il browser li rimette com'erano in static/app.js (unpackField).
"""
from __future__ import annotations

import json
import math
import struct

MISSING = -32768
MIN_LEN = 16  # liste più corte (rare) restano nel JSON


def _is_values(x) -> bool:
    return (
        isinstance(x, list)
        and len(x) >= MIN_LEN
        and all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool)) for v in x)
    )


def _scale_for(values: list) -> int:
    nums = [v for v in values if v is not None and math.isfinite(v)]
    if not nums:
        return 1
    top = max(abs(v) for v in nums)
    for scale in (100, 10, 1):
        if top * scale > 32767:
            continue
        if all(abs(v * scale - round(v * scale)) < 1e-6 for v in nums):
            return scale
    for scale in (100, 10, 1):  # non tutti interi: la scala più fine che ci sta
        if top * scale <= 32767:
            return scale
    return 1


def pack(obj: dict) -> bytes:
    ints: list[int] = []

    def walk(x):
        if _is_values(x):
            scale = _scale_for(x)
            start = len(ints)
            for v in x:
                if v is None or not math.isfinite(v):
                    ints.append(MISSING)
                else:
                    ints.append(max(-32767, min(32767, round(v * scale))))
            return {"$q": [start, len(x), scale]}
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    header = json.dumps(walk(obj), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    pad = (4 + len(header)) % 2
    return struct.pack("<I", len(header)) + header + b"\0" * pad + struct.pack(f"<{len(ints)}h", *ints)


def unpack(data: bytes) -> dict:
    """Inverso di pack (per i test; nel browser lo fa unpackField)."""
    (n,) = struct.unpack_from("<I", data, 0)
    header = json.loads(data[4 : 4 + n].decode("utf-8"))
    base = 4 + n + (4 + n) % 2
    count = (len(data) - base) // 2
    ints = struct.unpack_from(f"<{count}h", data, base)

    def walk(x):
        if isinstance(x, dict):
            if set(x) == {"$q"}:
                start, length, scale = x["$q"]
                return [None if v == MISSING else (v / scale if scale != 1 else v) for v in ints[start : start + length]]
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    return walk(header)
