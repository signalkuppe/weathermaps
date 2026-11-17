"""Compact field format for the static site (.bin): the same JSON as /api/field, but the value lists become 16-bit
integers. On GitHub Pages the site must stay under 1 GB: compared with JSON text the fields weigh about a third.

File layout (little endian):
  uint32  header length in bytes
  ...     header: the field's JSON, with each value list replaced by {"$q": [start, count, scale]}
          or {"$z": [start, count, scale]} (see below)
  ...     zeros up to a multiple of 2 bytes
  int16[] all values in a row; value = integer / scale, -32768 = missing (null)

"$z": the list takes the same 2 bytes per value, but holds the differences between a value and the previous one (on
16 bits), zig-zag encoded (0, -1, 1, -2... -> 0, 1, 2, 3...), first all low bytes and then all high bytes. Weather
fields change little between neighbouring cells: this way gzip (which GitHub Pages applies on the wire) gains 20-30%
more on fine grids. It is used only for lists where it really pays off (tested with zlib); the others stay "$q".

Values arrive already rounded to the field's decimals: the scale (1, 10, 100) turns them into integers losslessly.
If a value does not fit in 16 bits with that scale, one decimal is dropped (only happens for unusual fields).
The browser restores them in static/app.js (unpackField).
"""
from __future__ import annotations

import json
import math
import struct
import zlib

import numpy as np

MISSING = -32768
MIN_LEN = 16  # shorter lists (rare) stay in the JSON


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
    for scale in (100, 10, 1):  # not all integers: the finest scale that fits
        if top * scale <= 32767:
            return scale
    return 1


def _zigzag_planes(ints: np.ndarray) -> bytes:
    """16-bit differences, zig-zag, low bytes then high bytes."""
    d = np.diff(ints.astype(np.int32), prepend=0).astype(np.int16).astype(np.int32)  # with 16-bit wrap-around
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
            # the difference form only if it is at least 5% smaller on the wire (large lists: below that, not worth it)
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
    """Inverse of pack (for the tests; in the browser unpackField does it)."""
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
                vals = np.cumsum((zz >> 1) ^ -(zz & 1)).astype(np.int16).tolist()  # sum with 16-bit wrap-around
                return [None if v == MISSING else (v / scale if scale != 1 else v) for v in vals]
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    return walk(header)
