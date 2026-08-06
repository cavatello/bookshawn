const http = require('http');
const fs = require('fs');
const path = require('path');

// Mock busy blocks, set by the test via /__setbusy
let BUSY = [];
// Mock template store, so the admin editor has something to read and write.
const MOCK_TOKEN = process.env.MOCK_ADMIN_TOKEN || 'test-token';
let AVAIL = {
  virtual:  [{day:1,start:"08:00",end:"09:00"},{day:2,start:"08:00",end:"09:00"},
             {day:2,start:"11:00",end:"13:00"},{day:3,start:"15:00",end:"18:00"},
             {day:5,start:"08:00",end:"09:00"}],
  inperson: [{day:2,start:"14:00",end:"21:00"},{day:3,start:"07:00",end:"14:00"},
             {day:4,start:"07:00",end:"14:00"},{day:5,start:"14:00",end:"20:00"}]
};
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
    // The Worker returns the template alongside the busy list, so the pages
    // pick up an admin edit without a deploy. Mirror that here.
    return res.end(JSON.stringify({
      timeZone: 'America/Los_Angeles', busy: BUSY, availability: AVAIL,
      generatedAt: new Date().toISOString(),
    }));
  }
  // Mirrors the Worker: GET is open, PUT needs the token and validates.
  if (u.pathname === '/api/availability' && req.method === 'GET') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ availability: AVAIL, source: 'mock' }));
  }
  if (u.pathname === '/api/availability' && req.method === 'PUT') {
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      if (req.headers['x-admin-token'] !== MOCK_TOKEN) {
        res.writeHead(401, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not authorised' }));
      }
      let v;
      try { v = JSON.parse(b).availability; } catch { v = null; }
      const bad = !v || !Array.isArray(v.virtual) || !Array.isArray(v.inperson) ||
        [...v.virtual, ...v.inperson].some(w =>
          !Number.isInteger(w.day) || w.day < 0 || w.day > 6 ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end) ||
          w.end <= w.start);
      if (bad) {
        res.writeHead(400, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Rejected: bad window' }));
      }
      AVAIL = { virtual: v.virtual, inperson: v.inperson };
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, availability: AVAIL, savedAt: new Date().toISOString() }));
    });
  }

  if (u.pathname === '/api/book' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      LASTBOOK = JSON.parse(b);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, htmlLink: 'https://calendar.google.com/x', invited: true,
        // Mirrors locationFor() in worker.js: anything that isn't in-person is
        // a video session and gets the join link.
        location: LASTBOOK.mode === 'inperson'
          ? '667 Lytton Ave, Suite 9, Palo Alto, CA 94301 (mock)'
          : 'https://agoodplace.zoom.us/my/shawnwalters' }));
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
  if (u.pathname === '/admin/blank' || u.pathname === '/admin/blank/') {
    let h = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
    h = h.replace(/apiBase:\s*"[^"]*"/, 'apiBase: "' + (process.env.MOCK_API || '/api') + '"');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(h);
  }

  if (u.pathname === '/virtual/blank' || u.pathname === '/virtual/blank/') {
    let h = fs.readFileSync(path.join(ROOT, 'virtual', 'index.html'), 'utf8');
    h = h.replace(/apiBase:\s*"[^"]*"/, 'apiBase: "' + (process.env.MOCK_API || '/api') + '"');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(h);
  }

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

  // /blank/ is a virtual path, so relative assets in the page resolve under it
  // (/blank/office.jpg). Fall those through to the real file at the root —
  // otherwise the harness 404s on images the live site serves fine.
  let rel = u.pathname.replace(/^\/(weekview\/|virtual\/|admin\/)?blank\//, '/');

  let p = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(p);
  const ct = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
               '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'text/plain';
  res.writeHead(200, { 'content-type': ct });
  res.end(fs.readFileSync(p));
});
const PORT = Number(process.env.PORT || 8099);
server.listen(PORT, () => console.log('up on ' + PORT));
