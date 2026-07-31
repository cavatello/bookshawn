/* Tests for weekview/ — the internal two-week planner.
   Run:  node dev/test-weekview.js      (needs dev/serve.js on BASE) */

function loadPlaywright() {
  for (const t of ["playwright", "playwright-core"]) { try { return require(t); } catch (e) {} }
  try {
    const root = require("child_process")
      .execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return require(root + "/playwright");
  } catch (e) {}
  try { return require("/home/claude/.npm-global/lib/node_modules/playwright"); } catch (e) {}
  return null;
}
const _pw = loadPlaywright();
if (!_pw) {
  console.log("\n  Playwright isn't installed here, so these tests were skipped.\n");
  process.exit(2);
}
const { chromium } = _pw;

const BASE = process.env.BASE || 'http://localhost:8099';
const PAGE = BASE + '/weekview/blank/';
let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (extra ? ' :: ' + extra : '')); }
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  // The sandbox this is authored in proxies TLS and blocks fonts.googleapis.com.
  // That's an environment artifact, not a page fault — ignore only that.
  const envNoise = t => /ERR_CERT_AUTHORITY_INVALID|fonts\.googleapis|fonts\.gstatic/.test(t);
  page.on('console', m => {
    if (m.type() === 'error' && !envNoise(m.text())) errs.push(m.text().slice(0, 120));
  });

  // Known busy blocks so the subtraction is checkable, not incidental.
  await page.goto(BASE + '/__setbusy?v=' + encodeURIComponent(JSON.stringify([])));
  await page.goto(PAGE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  console.log('\n[1] Structure');
  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  ok('noindex set',
    (await page.getAttribute('meta[name="robots"]', 'content') || '').includes('noindex'));
  ok('two week sections', (await page.locator('.wk').count()) === 2);
  ok('fourteen day cells', (await page.locator('.d').count()) === 14);
  ok('four filters', (await page.locator('.f').count()) === 4);
  ok('both selected by default',
    (await page.getAttribute('.f[data-f="both"]', 'aria-pressed')) === 'true');
  ok('links back to the booking page',
    (await page.getAttribute('.top a', 'href')) === '../');

  console.log('\n[2] Weeks start on Sunday');
  // One cell reads "Today" instead of its weekday, so compare position-wise
  // and allow exactly one substitution.
  const dows = await page.evaluate(() =>
    [...document.querySelectorAll('#d0 .d-dow')].map(e => e.textContent));
  const want = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const swapped = dows.filter((d, i) => d !== want[i]);
  ok('first week runs Sun..Sat',
    dows.length === 7 && swapped.length <= 1 && swapped.every(d => d === 'Today'),
    JSON.stringify(dows));
  const dows1 = await page.evaluate(() =>
    [...document.querySelectorAll('#d1 .d-dow')].map(e => e.textContent));
  ok('second week also Sun..Sat',
    JSON.stringify(dows1) === JSON.stringify(want), JSON.stringify(dows1));
  ok('exactly one cell is marked today',
    (await page.locator('.d.today').count()) === 1);
  ok('today says so in words', /today/i.test(await page.textContent('.d.today .d-dow')));
  ok('second week starts 7 days after the first', await page.evaluate(() =>
    Math.round((dayAt(7) - dayAt(0)) / 86400000) === 7));

  console.log('\n[3] Live status');
  ok('reports live', (await page.getAttribute('#note', 'class')).includes('live'),
    await page.textContent('#noteText'));

  console.log('\n[4] Filters');
  const counts = {};
  for (const f of ['both', 'virtual', 'inperson', 'allvirtual']) {
    await page.click(`.f[data-f="${f}"]`);
    await page.waitForTimeout(250);
    counts[f] = await page.locator('.d .c').count();
    ok(`${f} selected`, (await page.getAttribute(`.f[data-f="${f}"]`, 'aria-pressed')) === 'true');
  }
  ok('both equals virtual + in person',
    counts.both === counts.virtual + counts.inperson,
    `both=${counts.both} v=${counts.virtual} p=${counts.inperson}`);
  ok('virtual filter shows only sage chips', await (async () => {
    await page.click('.f[data-f="virtual"]'); await page.waitForTimeout(250);
    return (await page.locator('.d .c.p').count()) === 0 && (await page.locator('.d .c.v').count()) > 0;
  })());
  ok('in-person filter shows only forest chips', await (async () => {
    await page.click('.f[data-f="inperson"]'); await page.waitForTimeout(250);
    return (await page.locator('.d .c.v').count()) === 0 && (await page.locator('.d .c.p').count()) > 0;
  })());

  console.log('\n[4b] All as virtual');
  await page.click('.f[data-f="allvirtual"]'); await page.waitForTimeout(300);
  ok('offers every open hour, same total as Both',
    counts.allvirtual === counts.both, `allvirtual=${counts.allvirtual} both=${counts.both}`);
  ok('offers more than the virtual windows alone',
    counts.allvirtual > counts.virtual, `${counts.allvirtual} vs ${counts.virtual}`);
  ok('every chip reads as virtual',
    (await page.locator('.d .c.p').count()) === 0 &&
    (await page.locator('.d .c.v').count()) === counts.allvirtual);
  {
    const t = await page.evaluate(() => plainText());
    ok('output is a flat list, no type headings',
      !/Virtual: /.test(t) && !/In person: /.test(t), t.slice(0, 80));
    ok('footer says everything is virtual', /All virtual\. /.test(t), t.slice(-70));
    // The in-person hours must actually appear, or the option does nothing.
    ok('in-person hours are present in the list', await page.evaluate(() => {
      const body = plainText();
      // Wednesday in-person starts at 7:00 AM; virtual Wednesday starts at 3 PM.
      return /Wed[^\n]*7:00 AM/.test(body);
    }), t.split('\n').find(l => /Wed/.test(l)) || '');
  }
  await page.click('.f[data-f="both"]'); await page.waitForTimeout(250);

  console.log('\n[5] No 24-hour notice on this page');
  const noFloor = await page.evaluate(() => CONFIG.minNoticeHrs === 0);
  ok('minNoticeHrs is 0', noFloor);
  ok('nothing offered in the past', await page.evaluate(() => {
    for (let n = 0; n < 14; n++)
      for (const s of slotsFor(dayAt(n))) if (s.start < Date.now()) return false;
    return true;
  }));

  console.log('\n[6] Copy text');
  await page.click('.f[data-f="both"]'); await page.waitForTimeout(300);
  const txt = await page.evaluate(() => plainText());
  ok('text is generated', txt.length > 20, txt.slice(0, 60));
  ok('states the timezone', /All times Pacific/.test(txt));
  ok('states session length', /53 minutes/.test(txt));
  ok('groups times under Virtual / In person headings',
    /Virtual: /.test(txt) && /In person: /.test(txt), txt.slice(0, 120));
  ok('type labels are bold in the preview', await page.evaluate(() => {
    const bs = [...document.querySelectorAll('#txt b')].map(b => b.textContent);
    return bs.length > 0 && bs.every(t => t === 'Virtual:' || t === 'In person:');
  }), await page.evaluate(() => [...document.querySelectorAll('#txt b')].map(b=>b.textContent).join('|')));
  ok('bold is real markup, not asterisks', !/\*/.test(txt));
  ok('one block per day with openings', await page.evaluate(() => {
    const body = plainText();
    const blocks = body.split('\n\n').filter(b => !/^All times/.test(b));
    const days = [...document.querySelectorAll('.d')].filter(d => d.querySelector('.c')).length;
    return blocks.length === days;
  }));
  ok('every listed time appears under the right heading', await page.evaluate(() => {
    const body = plainText();
    for (const block of body.split('\n\n')) {
      if (/^All times/.test(block)) continue;
      const lines = block.split('\n');
      const day = lines[0];
      for (const l of lines.slice(1)) {
        const m = l.match(/^ {2}(Virtual|In person): (.+)$/);
        if (!m) return false;
        const want = m[1] === 'Virtual' ? 'virtual' : 'inperson';
        const times = m[2].split(', ');
        // cross-check against the grid: that day must hold these exact times in that mode
        const cell = [...document.querySelectorAll('.d')].find(d =>
          d.querySelector('.c') &&
          day.includes(d.querySelector('.d-num').textContent));
        if (!cell) return false;
        const cls = want === 'virtual' ? 'v' : 'p';
        const grid = [...cell.querySelectorAll('.c.' + cls)].map(e => e.textContent);
        if (JSON.stringify(grid) !== JSON.stringify(times)) return false;
      }
    }
    return true;
  }), txt.split('\n\n')[0]);

  console.log('\n[6b] Single-filter output collapses');
  await page.click('.f[data-f="virtual"]'); await page.waitForTimeout(300);
  const vtxt = await page.evaluate(() => plainText());
  ok('no repeated headings when one type is selected',
    !/Virtual: /.test(vtxt) && !/In person: /.test(vtxt), vtxt.slice(0, 80));
  ok('states the type once at the end', /All virtual\./.test(vtxt), vtxt.slice(-70));
  await page.click('.f[data-f="inperson"]'); await page.waitForTimeout(300);
  ok('in-person footer says so', /All in person\./.test(await page.evaluate(() => plainText())));
  await page.click('.f[data-f="both"]'); await page.waitForTimeout(300);

  console.log('\n[6c] Clipboard carries both flavours');
  {
    // Grant clipboard access so we can read back what Copy actually wrote.
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('.f[data-f="both"]'); await page.waitForTimeout(300);
    await page.click('#copy'); await page.waitForTimeout(500);
    ok('button confirms the copy', /Copied/.test(await page.textContent('#copy')));
    const flavours = await page.evaluate(async () => {
      try {
        const items = await navigator.clipboard.read();
        const types = items.flatMap(i => i.types);
        const html = types.includes('text/html')
          ? await (await items.find(i => i.types.includes('text/html')).getType('text/html')).text() : '';
        const plain = types.includes('text/plain')
          ? await (await items.find(i => i.types.includes('text/plain')).getType('text/plain')).text() : '';
        return { types, html, plain };
      } catch (e) { return { error: String(e) }; }
    });
    if (flavours.error) {
      ok('clipboard readable in this browser', false, flavours.error);
    } else {
      ok('clipboard holds an html flavour', flavours.types.includes('text/html'), flavours.types.join(','));
      ok('clipboard holds a plain flavour', flavours.types.includes('text/plain'), flavours.types.join(','));
      ok('html flavour bolds the type labels',
        /<b>Virtual:<\/b>/.test(flavours.html) && /<b>In person:<\/b>/.test(flavours.html),
        flavours.html.slice(0, 140));
      ok('plain flavour has no markup',
        !/<[a-z]/i.test(flavours.plain) && /Virtual: /.test(flavours.plain),
        flavours.plain.slice(0, 100));
      ok('plain flavour keeps the day grouping',
        /\n\n/.test(flavours.plain), JSON.stringify(flavours.plain.slice(0, 80)));
    }
  }

  console.log('\n[6d] Directions block');
  {
    const dt = await page.innerText('#dir');
    ok('shows the address', /667 Lytton Ave, Suite 9, Palo Alto/.test(dt), dt.slice(0, 60));
    ok('lists all five arrival notes',
      (await page.locator('#dir li').count()) === 5,
      String(await page.locator('#dir li').count()));
    ok('address is bold', (await page.locator('#dir b').count()) >= 1);
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('#dir a')].map(a => a.href));
    ok('links to Google Maps', hrefs.some(h => /google\.com\/maps\/search/.test(h)), hrefs.join(' '));
    ok('links to Apple Maps', hrefs.some(h => /maps\.apple\.com/.test(h)));
    ok('phone is a tel: link', hrefs.some(h => h === 'tel:9715142190'), hrefs.join(' '));
    ok('map links carry the office address',
      hrefs.filter(h => /maps/.test(h)).every(h => /667%20Lytton/.test(h)));

    await page.click('#copyDir'); await page.waitForTimeout(500);
    ok('copy button confirms', /Copied/.test(await page.textContent('#copyDir')));
    const fl = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const h = await (await items.find(i => i.types.includes('text/html')).getType('text/html')).text();
      const t = await (await items.find(i => i.types.includes('text/plain')).getType('text/plain')).text();
      return { h, t };
    });
    ok('html flavour keeps the map links as links',
      /<a href="https:\/\/www\.google\.com\/maps/.test(fl.h) &&
      /<a href="https:\/\/maps\.apple\.com/.test(fl.h), fl.h.slice(0, 120));
    ok('html flavour keeps the bullet list', /<ul>/.test(fl.h) && /<li>/.test(fl.h));
    ok('plain flavour has no markup, but keeps the urls',
      !/<[a-z]/i.test(fl.t) &&
      /Google Maps: https:\/\//.test(fl.t) &&
      /Apple Maps:  https:\/\//.test(fl.t), fl.t.slice(0, 120));
    ok('plain flavour uses dashes for the notes', /\n- Look for a red-shingled/.test(fl.t));
    ok('plain flavour ends with the phone number', /971-514-2190\.$/.test(fl.t.trim()));
  }

  console.log('\n[7] Busy subtraction');
  const before = await page.locator('.d .c').count();
  const firstSlot = await page.evaluate(() => {
    for (let n = 0; n < 14; n++) { const s = slotsFor(dayAt(n)); if (s.length) return s[0]; }
    return null;
  });
  ok('there is a slot to block', firstSlot !== null);
  if (firstSlot) {
    await page.goto(BASE + '/__setbusy?v=' + encodeURIComponent(JSON.stringify(
      [{ start: new Date(firstSlot.start).toISOString(), end: new Date(firstSlot.end).toISOString() }])));
    await page.goto(PAGE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const after = await page.locator('.d .c').count();
    ok('a busy block removes exactly one slot', after === before - 1, `${before} -> ${after}`);
  }

  console.log('\n[8] Calendar unreachable fails closed');
  const p2 = await ctx.newPage();
  await p2.goto(BASE + '/weekview/blank/', { waitUntil: 'networkidle' });
  // Wait for the first load to settle, otherwise it can resolve after the
  // failure below and the generation guard is what we'd be testing by accident.
  await p2.waitForFunction(() => state.status === 'live', null, { timeout: 8000 });
  await p2.evaluate(() => { CONFIG.apiBase = 'http://localhost:1/nope'; load(); });
  await p2.waitForFunction(() => state.status === 'error', null, { timeout: 8000 });
  await p2.waitForTimeout(300);
  ok('shows an error note', (await p2.getAttribute('#note', 'class')).includes('bad'));
  ok('offers no slots at all', (await p2.locator('.d .c').count()) === 0);
  ok('copy text says so, rather than inventing times',
    /No openings/.test(await p2.evaluate(() => plainText())), (await p2.evaluate(() => plainText())).slice(0, 60));

  console.log('\n[9] Responsive');
  for (const [w, h, label] of [[390, 844, 'iPhone'], [768, 1024, 'iPad'], [1440, 900, 'desktop']]) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, timezoneId: 'America/Los_Angeles' });
    const p3 = await c.newPage();
    const e3 = [];
    p3.on('pageerror', e => { if (!envNoise(e.message)) e3.push(e.message); });
    await p3.goto(PAGE, { waitUntil: 'networkidle' });
    await p3.waitForTimeout(900);
    const sw = await p3.evaluate(() => document.documentElement.scrollWidth);
    ok(`${label}: no horizontal scroll`, sw <= w + 1, `${sw} > ${w}`);
    ok(`${label}: no errors`, e3.length === 0, e3[0]);
    const small = await p3.evaluate(() => [...document.querySelectorAll('button')]
      .filter(el => el.offsetParent && el.getBoundingClientRect().height < 44).length);
    ok(`${label}: buttons >= 44px`, small === 0, String(small));
    await c.close();
  }

  await browser.close();
  console.log('\n' + '='.repeat(46));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})();
