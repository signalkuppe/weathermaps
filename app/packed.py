"""Formato compatto dei campi per il sito statico (.bin): lo stesso JSON di /api/field, ma le liste di valori diventano
interi a 16 bit. Su GitHub Pages il sito deve stare sotto 1 GB: rispetto al testo JSON i campi pesano circa un terzo.

Struttura del file (little endian):
  uint32  lunghezza dell'intestazione in byte
  ...     intestazione: il JSON del campo, con ogni lista di valori sostituita da {"$q": [inizio, quanti, scala]}
          oppure {"$z": [inizio, quanti, scala]} (vedi sotto)
  ...     zeri fino a un multiplo di 2 byte
  int16[] tutti i valori in fila; valore = intero / scala, -32768 = mancante (null)

"$z": la lista occupa gli stessi 2 byte per valore, ma contiene le differenze fra un valore e il precedente (su 16
bit), a zig-zag (0, -1, 1, -2... -> 0, 1, 2, 3...), prima tutti i byte bassi e poi tutti gli alti. I campi meteo
cambiano poco fra celle vicine: così gzip (che GitHub Pages applica in rete) rende il 20-30% in più sulle griglie
fini. Si usa solo per le liste dove conviene davvero (prova con zlib), le altre restano "$q".

I valori arrivano già arrotondati ai decimali della grandezza: la scala (1, 10, 100) li riporta interi senza perdite.
Se un valore non ci sta in 16 bit con quella scala si scende di un decimale (succede solo per campi fuori dal comune).
Il browser li rimette com'erano in static/app.js (unpackField).
"""
from __future__ import annotations

import json
import math
import struct
import zlib

import numpy as np

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


def _zigzag_planes(ints: np.ndarray) -> bytes:
    """Differenze a 16 bit, zig-zag, byte bassi poi byte alti."""
    d = np.diff(ints.astype(np.int32), prepend=0).astype(np.int16).astype(np.int32)  # con riporto su 16 bit
    zz = ((d << 1) ^ (d >> 15)).astype(np.uint16)
    return (zz & 0xFF).astype(np.uint8).tobytes() + (zz >> 8).astype(np.uint8).tobytes()


def pack(obj: dict) -> bytes:
    chunks: list[bytes] = []
    count = 0

    def walk(x):
        nonlocal count
        if _is_values(x):
            scale = _scale_for(x)
            arr = np.array([np.nan if v is None else v for v in x], dtype=np.float64)
            ok = np.isfinite(arr)
            ints = np.full(len(x), MISSING, dtype=np.int16)
            ints[ok] = np.clip(np.rint(arr[ok] * scale), -32767, 32767).astype(np.int16)
            plain, planes = ints.astype("<i2").tobytes(), _zigzag_planes(ints)
            # la forma a differenze solo se in rete pesa almeno il 5% in meno (liste grandi: sotto, non vale la pena)
            better = len(x) >= 4096 and len(zlib.compress(planes, 6)) < 0.95 * len(zlib.compress(plain, 6))
            start = count
            chunks.append(planes if better else plain)
            count += len(x)
            return {"$z" if better else "$q": [start, len(x), scale]}
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    header = json.dumps(walk(obj), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    pad = (4 + len(header)) % 2
    return struct.pack("<I", len(header)) + header + b"\0" * pad + b"".join(chunks)


def unpack(data: bytes) -> dict:
    """Inverso di pack (per i test; nel browser lo fa unpackField)."""
    (n,) = struct.unpack_from("<I", data, 0)
    header = json.loads(data[4 : 4 + n].decode("utf-8"))
    base = 4 + n + (4 + n) % 2
    count = (len(data) - base) // 2
    ints = struct.unpack_from(f"<{count}h", data, base)

    body = data[base:]

    def walk(x):
        if isinstance(x, dict):
            if set(x) == {"$q"}:
                start, length, scale = x["$q"]
                return [None if v == MISSING else (v / scale if scale != 1 else v) for v in ints[start : start + length]]
            if set(x) == {"$z"}:
                start, length, scale = x["$z"]
                lo = np.frombuffer(body, dtype=np.uint8, count=length, offset=2 * start).astype(np.int32)
                hi = np.frombuffer(body, dtype=np.uint8, count=length, offset=2 * start + length).astype(np.int32)
                zz = lo | (hi << 8)
                vals = np.cumsum((zz >> 1) ^ -(zz & 1)).astype(np.int16).tolist()  # somma con riporto su 16 bit
                return [None if v == MISSING else (v / scale if scale != 1 else v) for v in vals]
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    return walk(header)
