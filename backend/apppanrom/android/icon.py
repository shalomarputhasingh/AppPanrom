"""App icon validation. Only PNG is accepted, parsed by hand (no image library needed)."""
from __future__ import annotations

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_ICON_BYTES = 512_000
MIN_SIDE, MAX_SIDE = 192, 1024


class IconError(ValueError):
    pass


def validate_png_icon(data: bytes) -> tuple[int, int]:
    """Returns (width, height) or raises IconError with a user-facing message."""
    if len(data) > MAX_ICON_BYTES:
        raise IconError(f"Icon is larger than {MAX_ICON_BYTES // 1000} KB.")
    if len(data) < 33 or not data.startswith(PNG_SIGNATURE):
        raise IconError("Icon must be a PNG image.")
    length, ctype = struct.unpack(">I4s", data[8:16])
    if ctype != b"IHDR" or length != 13:
        raise IconError("Icon is not a valid PNG (missing header).")
    ihdr = data[16:29]
    if struct.unpack(">I", data[29:33])[0] != zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF:
        raise IconError("Icon is not a valid PNG (corrupt header).")
    width, height = struct.unpack(">II", ihdr[:8])
    if width != height:
        raise IconError(f"Icon must be square (it is {width}x{height}).")
    if not MIN_SIDE <= width <= MAX_SIDE:
        raise IconError(f"Icon must be between {MIN_SIDE}x{MIN_SIDE} and {MAX_SIDE}x{MAX_SIDE} pixels (it is {width}x{height}).")
    if not data.rstrip(b"\x00").endswith(b"IEND\xaeB`\x82"):
        raise IconError("Icon is not a valid PNG (truncated).")
    return width, height
