#!/usr/bin/python3
"""Tiny HTTP/CONNECT proxy on the Tailscale IP so tailnet devices can reach
Juno hosts (*.jingmi.com.tw and the Juno ranges) through this Mac's juno-vpn tunnel.
Also serves /proxy.pac so only Juno hosts use the proxy."""
import ipaddress, select, socket, sys, threading
from urllib.parse import urlsplit

LISTEN = (sys.argv[1] if len(sys.argv) > 1 else "100.106.116.2", 8118)
ALLOWED_SUFFIX = ".jingmi.com.tw"
ALLOWED_NETS = [ipaddress.ip_network(n) for n in ("172.27.48.0/20", "172.28.0.0/16", "64.239.109.1/32")]
PAC = (
    "function FindProxyForURL(url, host) {\n"
    "  if (dnsDomainIs(host, '.jingmi.com.tw') || host == 'jingmi.com.tw' ||\n"
    "      shExpMatch(host, '172.27.*') || shExpMatch(host, '172.28.*'))\n"
    "    return 'PROXY %s:%d';\n"
    "  return 'DIRECT';\n"
    "}\n" % LISTEN
).encode()


def allowed(host):
    host = host.strip("[]").lower().rstrip(".")
    if host == ALLOWED_SUFFIX[1:] or host.endswith(ALLOWED_SUFFIX):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in n for n in ALLOWED_NETS)


def pipe(a, b):
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, 600)
            if x or not r:
                return
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    finally:
        a.close()
        b.close()


def handle(c):
    try:
        c.settimeout(30)
        buf = b""
        while b"\r\n\r\n" not in buf:
            d = c.recv(65536)
            if not d:
                return c.close()
            buf += d
            if len(buf) > 65536:
                return c.close()
        head, rest = buf.split(b"\r\n\r\n", 1)
        lines = head.split(b"\r\n")
        method, target, ver = lines[0].decode("latin1").split(" ", 2)
        if method == "GET" and target in ("/proxy.pac", "/wpad.dat"):
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\n"
                      b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(PAC) + PAC)
            return c.close()
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            port = int(port or 443)
        else:
            u = urlsplit(target)
            host, port = u.hostname or "", u.port or 80
            path = (u.path or "/") + ("?" + u.query if u.query else "")
            hdrs = [l for l in lines[1:] if not l.lower().startswith((b"proxy-connection:", b"proxy-authorization:"))]
            rest = ("%s %s %s\r\n" % (method, path, ver)).encode("latin1") + b"\r\n".join(hdrs) + b"\r\n\r\n" + rest
        if not allowed(host):
            c.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            return c.close()
        u = socket.create_connection((host, port), timeout=15)
        u.settimeout(None)
        c.settimeout(None)
        if method == "CONNECT":
            c.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            if rest:
                u.sendall(rest)
        else:
            u.sendall(rest)
        pipe(c, u)
    except Exception as e:
        try:
            c.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        except Exception:
            pass
        c.close()
        print("error:", e, flush=True)


def main():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(LISTEN)
    s.listen(128)
    print("listening on %s:%d" % LISTEN, flush=True)
    while True:
        c, _ = s.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()


if __name__ == "__main__":
    main()
