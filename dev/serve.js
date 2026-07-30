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
      res.end(JSON.stringify({ ok: true, htmlLink: 'https://calendar.google.com/x' }));
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
  let p = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(p);
  const ct = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
  res.writeHead(200, { 'content-type': ct });
  res.end(fs.readFileSync(p));
});
server.listen(8099, () => console.log('up on 8099'));
