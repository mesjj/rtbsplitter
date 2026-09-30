// Adapts the fetch-style API (lib/app.js) to node:http and serves public/ for everything else.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export function nodeHandler(api, { publicDir, trustProxy = false }) {
  // Behind a reverse proxy the real client is the last address it appended to
  // X-Forwarded-For (earlier entries can be spoofed by the client).
  const clientIp = req => {
    if (trustProxy) {
      const last = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (last) return last;
    }
    return req.socket.remoteAddress;
  };

  function serveStatic(req, res) {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    let file = path.normalize(path.join(publicDir, urlPath));
    if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(publicDir, 'index.html');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    if (!req.url.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res);
    }
    // Convert Node's request into a standard Request (body capped above the API's own limit).
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200_000) { res.writeHead(413); return res.end(); }
      chunks.push(chunk);
    }
    const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]])),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await api(request, { clientIp: clientIp(req) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  return (req, res) => handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}
