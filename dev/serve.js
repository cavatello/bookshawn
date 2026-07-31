const http = require('http');
const fs = require('fs');
const path = require('path');

// Mock busy blocks, set by the test via /__setbusy
let BUSY = [];
let LASTBOOK = null;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,accept',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  if (u.pathname === '/api/freebusy') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      timeZone: 'America/Los_Angeles', busy: BUSY, generatedAt: new Date().toISOString(),
    }));
  }
  if (u.pathname === '/api/book' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      LASTBOOK = JSON.parse(b);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, htmlLink: 'https://calendar.google.com/x', invited: true,
        location: LASTBOOK.mode === 'virtual'
          ? 'https://agoodplace.zoom.us/my/shawnwalters'
          : '667 Lytton Ave, Suite 9, Palo Alto, CA 94301 (mock)' }));
    });
  }
  if (u.pathname === '/api/fail') {
    res.writeHead(500, cors); return res.end('boom');
  }
  if (u.pathname === '/__setbusy') {
    BUSY = JSON.parse(decodeURIComponent(u.searchParams.get('v')));
    res.writeHead(200, cors); return res.end('ok');
  }
  if (u.pathname === '/__lastbook') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify(LASTBOOK));
  }

  const ROOT = path.join(__dirname, '..');
  // /blank/ serves index.html with apiBase emptied, so the suite can exercise
  // the never-configured path without the page firing a real cross-origin
  // request at the deployed Worker (which logs a CORS error and muddies test 1).
  // weekview points at the live Worker; blank it for tests the same way.
  if (u.pathname === '/weekview/blank' || u.pathname === '/weekview/blank/') {
    let h = fs.readFileSync(path.join(ROOT, 'weekview', 'index.html'), 'utf8');
    h = h.replace(/apiBase:\s*"[^"]*"/, 'apiBase: "' + (process.env.MOCK_API || '/api') + '"');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(h);
  }

  if (u.pathname === '/blank' || u.pathname === '/blank/') {
    let h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    h = h.replace(/apiBase:\s*"[^"]*"/, 'apiBase: ""');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(h);
  }

  let p = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(p);
  const ct = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }[ext] || 'text/plain';
  res.writeHead(200, { 'content-type': ct });
  res.end(fs.readFileSync(p));
});
const PORT = Number(process.env.PORT || 8099);
server.listen(PORT, () => console.log('up on ' + PORT));
