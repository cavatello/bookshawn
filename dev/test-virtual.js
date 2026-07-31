/* Tests for /virtual/ — every working hour offered as a video session.
   Run:  node dev/test-virtual.js      (needs dev/serve.js on BASE) */

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
let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (extra ? ' :: ' + extra : '')); }
};
const envNoise = t => /ERR_CERT_AUTHORITY_INVALID|fonts\.googleapis|fonts\.gstatic/.test(t);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => { if (!envNoise(e.message)) errs.push(e.message); });

  await page.goto(BASE + '/__setbusy?v=' + encodeURIComponent(JSON.stringify([])));
  await page.goto(BASE + '/virtual/blank/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  console.log('\n[1] Shape');
  ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  ok('hidden from search engines', await page.evaluate(() => {
    const c = (document.querySelector('meta[name="robots"]') || {}).content || '';
    return /noindex/.test(c) && /nofollow/.test(c) && /noarchive/.test(c);
  }));
  ok('no session-type picker — everything here is video',
    (await page.locator('#modes').count()) === 0);
  ok('no in-person note', (await page.locator('#modeNote').count()) === 0);
  ok('headline says video', /video session/i.test(await page.textContent('h1')));
  ok('explains it has more than the main page',
    /more here than on my main booking page/i.test(await page.textContent('.hero-dek')));
  ok('mode is anyvirtual', (await page.evaluate(() => state.mode)) === 'anyvirtual');

  console.log('\n[2] It really is the union of both templates');
  const totals = await page.evaluate(() => {
    const sum = m => { let t = 0; for (let d = 0; d <= CONFIG.horizonDays; d++) t += slotsForDay(dayStart(d), m).length; return t; };
    return { v: sum('virtual'), i: sum('inperson'), a: sum('anyvirtual') };
  });
  ok('offers virtual hours plus in-person hours',
    totals.a === totals.v + totals.i, `${totals.v}+${totals.i} != ${totals.a}`);
  ok('offers strictly more than virtual alone', totals.a > totals.v, `${totals.a} vs ${totals.v}`);
  ok('no slot is counted twice', await page.evaluate(() => {
    for (let d = 0; d <= CONFIG.horizonDays; d++) {
      const starts = slotsForDay(dayStart(d), 'anyvirtual').map(s => s.start);
      if (new Set(starts).size !== starts.length) return false;
    }
    return true;
  }));
  ok('every slot falls inside one of the two templates', await page.evaluate(() => {
    const all = AVAILABILITY.virtual.concat(AVAILABILITY.inperson);
    for (let d = 0; d <= CONFIG.horizonDays; d++) {
      const ds = dayStart(d);
      const p = tzParts(new Date(ds), CONFIG.practiceTz);
      for (const s of slotsForDay(ds, 'anyvirtual')) {
        const fits = all.some(w => {
          if (w.day !== p.dow) return false;
          const [sh, sm] = w.start.split(':').map(Number);
          const [eh, em] = w.end.split(':').map(Number);
          return s.start >= wallToEpoch(p.y, p.m, p.d, sh, sm, CONFIG.practiceTz) &&
                 s.end   <= wallToEpoch(p.y, p.m, p.d, eh, em, CONFIG.practiceTz);
        });
        if (!fits) return false;
      }
    }
    return true;
  }));

  console.log('\n[3] Booking');
  const days = page.locator('.rail .day:not(.is-empty)');
  ok('rail offers days', (await days.count()) > 0);
  await days.first().click(); await page.waitForTimeout(250);
  await page.locator('#slots .slot').first().click(); await page.waitForTimeout(250);
  ok('booking panel says Virtual', /Virtual/.test(await page.textContent('#bookWhen')),
    await page.textContent('#bookWhen'));
  await page.fill('#bName', 'Video Person');
  await page.fill('#bEmail', 'v@example.com');
  await page.click('#bSubmit'); await page.waitForTimeout(900);
  ok('confirmation appears', await page.locator('#confirm').isVisible());
  ok('confirmation says Virtual', /Virtual/.test(await page.textContent('#cMode')));
  ok('no directions panel — nobody is coming to the office',
    await page.locator('#arrive').isHidden());
  ok('shows a join link', /zoom|meet|http/i.test(await page.textContent('#cWhereLink')),
    await page.textContent('#cWhereLink'));

  const booked = await (await ctx.newPage()).goto(BASE + '/__lastbook').then(r => r.json());
  // The Worker validates against the union only for this mode. If the page ever
  // sends plain "virtual", in-person hours get rejected on submit.
  ok('POST carries mode anyvirtual', booked.mode === 'anyvirtual', booked.mode);
  ok('POST carries the visitor details',
    booked.name === 'Video Person' && booked.email === 'v@example.com');

  console.log('\n[4] Fails closed like the others');
  const p2 = await ctx.newPage();
  await p2.goto(BASE + '/virtual/blank/');
  await p2.evaluate(() => { CONFIG.apiBase = 'http://localhost:1/nope'; loadBusy(); });
  await p2.waitForTimeout(1200);
  ok('no slots offered when the calendar is unreachable',
    (await p2.locator('#slots .slot').count()) === 0);
  ok('email fallback shown', await p2.locator('#notlive').isVisible());

  console.log('\n[5] Responsive');
  for (const [w, h, label] of [[390, 844, 'iPhone'], [768, 1024, 'iPad'], [1440, 900, 'desktop']]) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, timezoneId: 'America/Los_Angeles' });
    const p3 = await c.newPage();
    const e3 = [];
    p3.on('pageerror', e => { if (!envNoise(e.message)) e3.push(e.message); });
    await p3.goto(BASE + '/virtual/blank/', { waitUntil: 'networkidle' });
    await p3.waitForTimeout(900);
    const sw = await p3.evaluate(() => document.documentElement.scrollWidth);
    ok(`${label}: no horizontal scroll`, sw <= w + 1, `${sw} > ${w}`);
    ok(`${label}: no errors`, e3.length === 0, e3[0]);
    await c.close();
  }

  await browser.close();
  console.log('\n' + '='.repeat(46));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})();
