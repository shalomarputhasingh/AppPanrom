"""Server-side proxy for the Studio preview's web requests (api_get / api_post / api_put / api_delete).

The preview iframe is sandboxed and cannot (and should not) call arbitrary hosts itself, so it asks the Studio, which asks
this module. The same rules are implemented natively in the Android shell (MainActivity / NativeBridge).

Rules (every one is covered by tests/test_proxy.py):
* https:// only, no credentials in the URL, no fragments, length <= 2048.
* The host is resolved here and EVERY address must be public (no loopback, private, link-local, CGNAT, multicast,
  unspecified, ULA, documentation ranges). The connection is then made to that exact IP (with SNI + certificate
  verification for the original host name), so a DNS answer cannot change between the check and the connection.
* Redirects are never followed (the response is returned as-is); no cookies, no custom headers, no user credentials.
* Request body <= 64 KB JSON, response <= 256 KB of JSON/text, 10 s total timeout, a global rate limit.
* Failures are returned as {"error": "..."} (never a stack trace, never the resolved IP).

`allow_private` and `ca_file` exist for local testing / corporate CAs (APPANROM_PROXY_ALLOW_PRIVATE, APPANROM_PROXY_CA_FILE);
both are off by default and `allow_private` is documented as unsafe.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import threading
import time
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlsplit

MAX_URL = 2048
MAX_BODY = 64_000
MAX_RESPONSE = 256_000
METHODS = {"GET", "POST", "PUT", "DELETE"}


class ProxyError(Exception):
    """A request the proxy refuses or cannot complete; the message is safe to show to the app's user."""


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return _is_public(ip.ipv4_mapped)
        if ip.sixtofour is not None and not _is_public(ip.sixtofour):
            return False
    return ip.is_global and not ip.is_multicast


def split_url(url: str) -> tuple[str, int, str]:
    """Validates the URL and returns (host, port, path-with-query)."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL:
        raise ProxyError("The URL is empty or too long.")
    if any(ch <= " " or ch == "\x7f" for ch in url):
        raise ProxyError("The URL contains spaces or control characters.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise ProxyError("The URL is not valid.") from None
    if parts.scheme.lower() != "https":
        raise ProxyError("Only https:// URLs are allowed.")
    if not parts.hostname:
        raise ProxyError("The URL has no host name.")
    if parts.username is not None or parts.password is not None:
        raise ProxyError("User names and passwords in URLs are not allowed.")
    if parts.fragment:
        raise ProxyError("The URL must not contain a #fragment.")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return parts.hostname, port or 443, path


Resolver = Callable[[str, int], list[str]]


def system_resolver(host: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise ProxyError("The host name could not be found.") from None
    seen: list[str] = []
    for info in infos:
        addr = info[4][0]
        if addr not in seen:
            seen.append(addr)
    return seen


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS connection that connects to a fixed, already-validated IP but verifies the certificate for `host`."""

    def __init__(self, host: str, ip: str, port: int, context: ssl.SSLContext, timeout: float):
        super().__init__(host, port, timeout=timeout, context=context)
        self._ip = ip

    def connect(self) -> None:
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)  # type: ignore[attr-defined]


@dataclass
class ProxyConfig:
    allow_private: bool = False
    ca_file: str | None = None
    timeout: float = 10.0
    per_minute: int = 120
    resolver: Resolver = system_resolver
    # (host, ip, port, timeout) -> connection; replaced by tests
    connect: Callable[[str, str, int, float], http.client.HTTPSConnection] | None = None
    clock: Callable[[], float] = time.monotonic
    _stamps: list[float] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def _context(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context(cafile=self.ca_file) if self.ca_file else ssl.create_default_context()
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        return ctx

    def _rate_ok(self) -> bool:
        with self._lock:
            now = self.clock()
            self._stamps = [t for t in self._stamps if now - t < 60]
            if len(self._stamps) >= self.per_minute:
                return False
            self._stamps.append(now)
            return True

    def pick_address(self, host: str, port: int) -> str:
        try:
            literal = [str(ipaddress.ip_address(host))]
        except ValueError:
            literal = None
        addrs = literal or self.resolver(host, port)
        if not addrs:
            raise ProxyError("The host name could not be found.")
        if not self.allow_private:
            for a in addrs:
                try:
                    ip = ipaddress.ip_address(a)
                except ValueError:
                    raise ProxyError("The host resolved to an invalid address.") from None
                if not _is_public(ip):
                    raise ProxyError("That address is not on the public internet, so the request was blocked.")
        return addrs[0]

    def fetch(self, method: str, url: str, body: str | None) -> dict:
        """Returns {"status": int, "text": str} or raises ProxyError."""
        method = (method or "").upper()
        if method not in METHODS:
            raise ProxyError("Unsupported request method.")
        if method in ("GET", "DELETE") and body is not None:
            raise ProxyError(f"{method} requests cannot have a body.")
        if body is not None and len(body.encode("utf-8")) > MAX_BODY:
            raise ProxyError("The request body is too large.")
        host, port, path = split_url(url)
        if not self._rate_ok():
            raise ProxyError("Too many web requests; wait a moment.")
        ip = self.pick_address(host, port)
        conn = None
        try:
            conn = (self.connect or self._default_connect)(host, ip, port, self.timeout)
            headers = {"User-Agent": "AppPanrom-Preview/1", "Accept": "application/json, text/plain;q=0.9, */*;q=0.1",
                       "Connection": "close"}
            payload = None
            if body is not None:
                headers["Content-Type"] = "application/json"
                payload = body.encode("utf-8")
            conn.request(method, path, body=payload, headers=headers)
            resp = conn.getresponse()
            ctype = (resp.getheader("Content-Type") or "").split(";")[0].strip().lower()
            raw = resp.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ProxyError("The response is too large (more than 256 KB).")
            if raw and not (ctype.startswith("text/") or ctype.endswith("json") or ctype.endswith("+json") or ctype in ("", "application/xml")):
                raise ProxyError(f"The response type '{ctype[:60]}' is not supported; only JSON and text.")
            return {"status": resp.status, "text": raw.decode("utf-8", errors="replace")}
        except ProxyError:
            raise
        except ssl.SSLCertVerificationError:
            raise ProxyError("The server's certificate could not be verified.") from None
        except (TimeoutError, socket.timeout):
            raise ProxyError("The request timed out.") from None
        except (OSError, http.client.HTTPException):
            raise ProxyError("The request failed (could not connect or the connection broke).") from None
        finally:
            if conn is not None:
                conn.close()

    def _default_connect(self, host: str, ip: str, port: int, timeout: float) -> http.client.HTTPSConnection:
        return _PinnedHTTPS(host, ip, port, self._context(), timeout)

    def run(self, method: str, url: str, body: str | None) -> dict:
        """Never raises: the result is {"status", "text", "error"} so the app's handler always gets an answer."""
        try:
            out = self.fetch(method, url, body)
            return {"status": out["status"], "text": out["text"], "error": ""}
        except ProxyError as e:
            return {"status": 0, "text": "", "error": str(e)}
