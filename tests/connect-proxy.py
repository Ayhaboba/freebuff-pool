#!/usr/bin/env python3
"""Minimal HTTP CONNECT proxy for testing per-account egress.

Logs one line per tunneled host so a test can prove traffic went through it.
"""
import selectors
import socket
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47830


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = client.recv(4096)
            if not chunk:
                return
            request += chunk
            if len(request) > 65536:
                return
        line = request.split(b"\r\n", 1)[0].decode("latin1", "replace")
        parts = line.split()
        if len(parts) < 2 or parts[0].upper() != "CONNECT":
            client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        target = parts[1]
        host, _, port = target.rpartition(":")
        try:
            upstream = socket.create_connection((host, int(port or "443")), timeout=10)
        except OSError as exc:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            print(f"FAIL {target} {exc}", flush=True)
            return
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        print(f"CONNECT {target}", flush=True)

        sel = selectors.DefaultSelector()
        sel.register(client, selectors.EVENT_READ, upstream)
        sel.register(upstream, selectors.EVENT_READ, client)
        try:
            while True:
                for key, _ in sel.select(timeout=30):
                    data = key.fileobj.recv(65536)
                    if not data:
                        return
                    key.data.sendall(data)
        except OSError:
            return
        finally:
            sel.close()
            upstream.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as server:
        print(f"proxy listening on 127.0.0.1:{PORT}", flush=True)
        server.serve_forever()
