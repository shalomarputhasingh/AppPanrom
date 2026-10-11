"""The web-request proxy used by the Studio preview (api_get / api_post ...): SSRF rules, limits and a real TLS round trip."""
import http.client
import http.server
import json
import shutil
import ssl
import subprocess
import threading

import pytest
from fastapi.testclient import TestClient

from apppanrom.main import create_app
from apppanrom.proxy import MAX_RESPONSE, ProxyConfig, ProxyError, split_url
from conftest import make_settings


# ---------------------------------------------------------------- URL rules
@pytest.mark.parametrize("url", [
    "http://example.com/", "ftp://example.com/", "file:///etc/passwd", "//example.com", "example.com", "",
    "https://user:pw@example.com/", "https://user@example.com/", "https://example.com/#frag", "https://",
    "https://exa mple.com/", "https://example.com/\n", "https://example.com:99999/", "javascript:alert(1)",
    "https://" + "a" * 2100 + ".com/",
])
def test_bad_urls_are_refused(url):
    with pytest.raises(ProxyError):
        split_url(url)


def test_good_url_parts():
    assert split_url("https://api.example.com/v1/x?a=1&b=2") == ("api.example.com", 443, "/v1/x?a=1&b=2")
    assert split_url("HTTPS://Example.com:8443") == ("example.com", 8443, "/")


@pytest.mark.parametrize("addr", [
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::", "192.0.2.1", "198.51.100.7",
])
def test_non_public_addresses_are_blocked(addr):
    cfg = ProxyConfig(resolver=lambda h, p: [addr])
    with pytest.raises(ProxyError, match="not on the public internet"):
        cfg.pick_address("evil.example.com", 443)


@pytest.mark.parametrize("addr", ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"])
def test_public_addresses_pass(addr):
    assert ProxyConfig(resolver=lambda h, p: [addr]).pick_address("x.example.com", 443) == addr


def test_one_private_answer_blocks_the_whole_host_and_literals_are_checked():
    cfg = ProxyConfig(resolver=lambda h, p: ["8.8.8.8", "10.0.0.1"])
    with pytest.raises(ProxyError):
        cfg.pick_address("rebind.example.com", 443)
    with pytest.raises(ProxyError):
        ProxyConfig().pick_address("127.0.0.1", 443)           # IP literal, resolver not even consulted
    with pytest.raises(ProxyError):
        ProxyConfig().pick_address("[::1]".strip("[]"), 443)
    assert ProxyConfig(allow_private=True).pick_address("127.0.0.1", 443) == "127.0.0.1"


# ---------------------------------------------------------------- request behaviour with a fake connection
class FakeResponse:
    def __init__(self, status=200, body=b'{"ok": true}', ctype="application/json"):
        self.status, self._body, self._ctype = status, body, ctype

    def getheader(self, name):
        return self._ctype if name.lower() == "content-type" else None

    def read(self, n=-1):
        return self._body if n < 0 else self._body[:n]


class FakeConn:
    log: list = []

    def __init__(self, host, ip, response):
        self.host, self.ip, self.response, self.closed = host, ip, response, False

    def request(self, method, path, body=None, headers=None):
        FakeConn.log.append({"host": self.host, "ip": self.ip, "method": method, "path": path, "body": body, "headers": headers})

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


def cfg_with(response=None, addrs=("93.184.216.34",), **kw):
    FakeConn.log = []
    return ProxyConfig(resolver=lambda h, p: list(addrs),
                       connect=lambda host, ip, port, timeout: FakeConn(host, ip, response or FakeResponse()), **kw)


def test_get_connects_to_the_validated_ip_and_sends_no_extras():
    cfg = cfg_with()
    out = cfg.run("GET", "https://api.example.com/v1?q=1", None)
    assert out == {"status": 200, "text": '{"ok": true}', "error": ""}
    sent = FakeConn.log[0]
    assert (sent["host"], sent["ip"], sent["method"], sent["path"]) == ("api.example.com", "93.184.216.34", "GET", "/v1?q=1")
    assert set(sent["headers"]) == {"User-Agent", "Accept", "Connection"}     # no cookies, no auth, nothing from the app


def test_post_sends_json_body():
    cfg = cfg_with(FakeResponse(201, b"made", "text/plain"))
    out = cfg.run("POST", "https://api.example.com/x", '{"a":1}')
    assert out["status"] == 201 and out["text"] == "made"
    assert FakeConn.log[0]["body"] == b'{"a":1}' and FakeConn.log[0]["headers"]["Content-Type"] == "application/json"


def test_redirects_are_not_followed():
    cfg = cfg_with(FakeResponse(302, b"", ""))
    out = cfg.run("GET", "https://api.example.com/x", None)
    assert out["status"] == 302 and out["error"] == "" and len(FakeConn.log) == 1


def test_blocked_and_invalid_requests_return_an_error_and_never_connect():
    cfg = cfg_with(addrs=("10.0.0.1",))
    assert "public internet" in cfg.run("GET", "https://intranet.example.com/", None)["error"]
    assert "https" in cfg.run("GET", "http://api.example.com/", None)["error"]
    assert "body" in cfg.run("GET", "https://api.example.com/", "{}")["error"]
    assert "method" in cfg.run("PATCH", "https://api.example.com/", None)["error"]
    assert "too large" in cfg.run("POST", "https://api.example.com/", "x" * 70_000)["error"]
    assert FakeConn.log == []


def test_large_and_binary_responses_are_refused():
    big = cfg_with(FakeResponse(200, b"x" * (MAX_RESPONSE + 5), "text/plain"))
    assert "too large" in big.run("GET", "https://api.example.com/", None)["error"]
    binary = cfg_with(FakeResponse(200, b"\x89PNG", "image/png"))
    assert "not supported" in binary.run("GET", "https://api.example.com/", None)["error"]


def test_connection_failures_become_plain_errors_without_details():
    def boom(host, ip, port, timeout):
        raise OSError("secret internal detail 10.1.2.3")
    cfg = ProxyConfig(resolver=lambda h, p: ["93.184.216.34"], connect=boom)
    out = cfg.run("GET", "https://api.example.com/", None)
    assert out["status"] == 0 and "10.1.2.3" not in out["error"] and "secret" not in out["error"]


def test_rate_limit_resets_after_a_minute():
    now = [0.0]
    cfg = cfg_with(per_minute=3, clock=lambda: now[0])
    results = [cfg.run("GET", "https://api.example.com/", None)["error"] for _ in range(4)]
    assert results[:3] == ["", "", ""] and "Too many" in results[3]
    now[0] = 61
    assert cfg.run("GET", "https://api.example.com/", None)["error"] == ""


def test_endpoint_returns_the_proxy_result_and_validates_the_shape(tmp_path):
    app2 = create_app(make_settings(tmp_path / "b"))
    with TestClient(app2) as c:
        px = app2.state.proxy
        px.resolver = lambda h, p: ["93.184.216.34"]
        px.connect = lambda host, ip, port, timeout: FakeConn(host, ip, FakeResponse(200, b'{"n": 5}'))
        r = c.post("/api/proxy", json={"method": "GET", "url": "https://api.example.com/n"})
        assert r.status_code == 200 and r.json() == {"status": 200, "text": '{"n": 5}', "error": ""}
        r = c.post("/api/proxy", json={"method": "GET", "url": "http://api.example.com/n"})
        assert r.status_code == 200 and "https" in r.json()["error"]
        r = c.post("/api/proxy", json={"method": "PATCH", "url": "https://a.example.com"})
        assert r.status_code == 422
        r = c.post("/api/proxy", json={"method": "GET", "url": "https://127.0.0.1/"})
        assert "public internet" in r.json()["error"]


# ---------------------------------------------------------------- real TLS round trip on loopback
@pytest.fixture
def tls_server(tmp_path):
    if not shutil.which("openssl"):
        pytest.skip("openssl is not installed")
    key, crt = tmp_path / "k.pem", tmp_path / "c.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(crt), "-days", "2",
                    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], check=True, capture_output=True)
    seen = []

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json", extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            seen.append((self.command, self.path, dict(self.headers)))
            if self.path == "/redirect":
                self._send(302, b"", extra={"Location": "https://127.0.0.1:1/"})
            else:
                self._send(200, json.dumps({"path": self.path}).encode())

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            seen.append((self.command, self.path, self.rfile.read(n).decode()))
            self._send(201, b'{"made": true}')

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], str(crt), seen
    srv.shutdown()


def test_real_tls_round_trip_with_pinned_ip_and_verified_certificate(tls_server):
    port, crt, seen = tls_server
    cfg = ProxyConfig(allow_private=True, ca_file=crt, resolver=lambda h, p: ["127.0.0.1"])
    out = cfg.run("GET", f"https://localhost:{port}/hello?x=1", None)
    assert out["error"] == "" and json.loads(out["text"]) == {"path": "/hello?x=1"}
    assert seen[0][2]["Host"] == f"localhost:{port}" and "Cookie" not in seen[0][2] and "Authorization" not in seen[0][2]
    out = cfg.run("POST", f"https://localhost:{port}/p", '{"a":1}')
    assert out["status"] == 201 and seen[1][2] == '{"a":1}'
    assert cfg.run("GET", f"https://localhost:{port}/redirect", None)["status"] == 302     # not followed


def test_untrusted_certificate_is_rejected(tls_server):
    port, _crt, _seen = tls_server
    cfg = ProxyConfig(allow_private=True, resolver=lambda h, p: ["127.0.0.1"])           # system CAs only
    assert "certificate" in cfg.run("GET", f"https://localhost:{port}/", None)["error"]


def test_certificate_for_another_host_name_is_rejected(tls_server):
    port, crt, _seen = tls_server
    cfg = ProxyConfig(allow_private=True, ca_file=crt, resolver=lambda h, p: ["127.0.0.1"])
    assert "certificate" in cfg.run("GET", f"https://not-localhost.example.com:{port}/", None)["error"]
