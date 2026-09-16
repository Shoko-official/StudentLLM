"""Shared bounds for localhost-only StudentLLM sidecars."""

from __future__ import annotations

import ipaddress

MAX_DOCUMENT_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_ASR_UPLOAD_BYTES = 250 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 4096
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
LOCAL_ORIGINS = frozenset({
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
})


def validate_content_length(length: int, maximum: int) -> int:
    if length <= 0:
        raise ValueError("The request body is empty.")
    if length > maximum:
        raise ValueError(f"The request body exceeds the {maximum // (1024 * 1024)} MB limit.")
    return length


def validate_local_host(host: str) -> str:
    normalized = host.strip().lower()
    if normalized == "localhost":
        return host
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError as error:
        raise ValueError("Sidecars must bind to localhost or a loopback address.") from error
    if not address.is_loopback:
        raise ValueError("Sidecars must bind to localhost or a loopback address.")
    return host


def validate_zip_members(members: list[object]) -> None:
    if len(members) > MAX_ARCHIVE_MEMBERS:
        raise ValueError("The document archive contains too many entries.")
    total_size = 0
    for member in members:
        size = getattr(member, "file_size", -1)
        if not isinstance(size, int) or size < 0:
            raise ValueError("The document archive contains an invalid entry.")
        total_size += size
        if total_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ValueError("The expanded document archive exceeds the 100 MB limit.")


def allowed_origin(origin: str | None) -> str | None:
    return origin if origin in LOCAL_ORIGINS else None
