import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';

export function createPreviewServer({
  hostname = 'aria.shaneholloman.dev',
  sitePort = 3000,
  ariaPort = 8791,
  siteOrigin
}: {
  hostname?: string;
  sitePort?: number;
  ariaPort?: number;
  siteOrigin?: string;
}) {
  const authorized = (req: IncomingMessage) => {
    const allowedOrigin =
      req.headers.origin === `https://${hostname}` ||
      (req.url?.startsWith('/aria-api/') && req.headers.origin === 'https://shaneholloman.dev');
    if (req.headers.host !== hostname || (req.headers.origin && !allowedOrigin)) return false;
    // Match Lina Muses' public deployment: the existing Cloudflare Tunnel
    // connects the public hostname to the NAS port. Other NAS apps retain Access.
    const address = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return (
      address === '::1' ||
      address.startsWith('127.') ||
      /^20\.0\.0\.\d+$/.test(address) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(address)
    );
  };
  const target = (req: IncomingMessage) => {
    const api = req.url?.startsWith('/aria-api/');
    const port = api ? ariaPort : sitePort;
    const remote = !api && siteOrigin ? new URL(siteOrigin) : null;
    const headers: OutgoingHttpHeaders = {
      ...req.headers,
      host: remote?.host || `127.0.0.1:${port}`,
      'accept-encoding': 'identity'
    };
    // Access credentials stop here; neither local upstream needs them.
    delete headers['cf-access-jwt-assertion'];
    delete headers.cookie;
    delete headers.authorization;
    return {
      hostname: remote?.hostname || '127.0.0.1',
      port: remote ? remote.port || 443 : port,
      path: api ? req.url!.slice('/aria-api'.length) : req.url,
      method: req.method,
      headers
    };
  };
  const server = http.createServer(async (req, res) => {
    req.url ||= '/';
    res.setHeader('Cache-Control', 'no-store');
    if (!authorized(req)) {
      res.writeHead(403);
      res.end('This service accepts the configured site routes only.');
      return;
    }
    if (siteOrigin && !req.url.startsWith('/aria-api/')) {
      // Preview visits should not emit analytics or CSP reports for the live CV.
      if (
        req.method === 'POST' &&
        ['/_mintlify/api/v1/e', '/_mintlify/api/csp-report'].includes(req.url.split('?')[0])
      ) {
        req.resume();
        res.writeHead(204);
        res.end();
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(405);
        res.end();
        return;
      }
      const files: Record<string, [string, string]> = {
        '/aria-preview.js': ['../aria-preview.js', 'text/javascript'],
        '/aria-preview.css': ['../style.css', 'text/css'],
        '/aria.svg': ['../aria.svg', 'image/svg+xml'],
        '/favicon.svg': ['../favicon.svg', 'image/svg+xml'],
        '/favicon.ico': ['../favicon.svg', 'image/svg+xml']
      };
      const file = files[req.url.split('?')[0]];
      if (file) {
        try {
          const data = await readFile(new URL(file[0], import.meta.url));
          res.writeHead(200, { 'Content-Type': file[1] });
          res.end(req.method === 'HEAD' ? undefined : data);
        } catch {
          res.writeHead(404);
          res.end();
        }
        return;
      }
    }
    const remote = siteOrigin && !req.url.startsWith('/aria-api/');
    const upstream = (remote ? https : http).request(target(req), (response) => {
      if (
        remote &&
        req.method === 'GET' &&
        response.headers['content-type']?.includes('text/html')
      ) {
        // NAS preview uses hosted Mintlify content, with only Aria's local assets added.
        // This avoids running a development server or depending on the Mac.
        const parts: Buffer[] = [];
        let bytes = 0;
        response.on('data', (part) => {
          bytes += part.length;
          if (bytes > 2_000_000) {
            upstream.destroy();
            return;
          }
          parts.push(part);
        });
        response.on('end', () => {
          const html = Buffer.concat(parts)
            .toString()
            .replace(
              '</head>',
              '<link rel="stylesheet" href="/aria-preview.css"><script defer src="/aria-preview.js"></script></head>'
            );
          const headers = { ...response.headers, 'cache-control': 'no-store' };
          delete headers['content-length'];
          delete headers.etag;
          res.writeHead(response.statusCode || 502, headers);
          res.end(html);
        });
        return;
      }
      res.writeHead(response.statusCode || 502, {
        ...response.headers,
        'cache-control': 'no-store'
      });
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('The local preview is offline.');
      } else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    // A completed response may return its upstream socket to the connection
    // pool. Destroy only on an interrupted downstream response.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
  // Preserve Mintlify's development WebSocket through the same protected origin.
  server.on('upgrade', async (req, socket, head) => {
    if (!authorized(req) || siteOrigin || req.url?.startsWith('/aria-api/')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = http.request(target(req));
    upstream.on('upgrade', (response, peer, initial) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n')}\r\n\r\n`
      );
      if (head.length) peer.write(head);
      if (initial.length) socket.write(initial);
      peer.on('error', () => socket.destroy());
      socket.on('error', () => peer.destroy());
      peer.pipe(socket);
      socket.pipe(peer);
      socket.on('close', () => peer.destroy());
    });
    upstream.on('response', (response) => {
      response.resume();
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const siteOrigin = process.env.ARIA_SITE_ORIGIN;
  if (siteOrigin && siteOrigin !== 'https://shaneholloman.dev')
    throw new Error('The NAS preview uses the hosted Shane Holloman CV.');
  const server = createPreviewServer({ siteOrigin });
  server.listen(8792, process.env.ARIA_PREVIEW_BIND || '127.0.0.1', () =>
    console.log('Aria CV service: https://aria.shaneholloman.dev')
  );
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
