#!/usr/bin/env python3
"""Lokaler Dev-Server ohne Caching (nur für die Entwicklung)."""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8517


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler).serve_forever()
