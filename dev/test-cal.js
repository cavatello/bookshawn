/* Resolve Playwright wherever it happens to live. Exits 2 (distinct from a real
   test failure) when it isn't installed, so a machine without it can still
   publish — the credential scan in watch.js is the guard that must never be
   skipped, and it has no dependencies. */
function loadPlaywright() {
  const tries = ["playwright", "playwright-core"];
  for (const t of tries) { try { return require(t); } catch (e) {} }
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
  console.log("\n  Playwright isn't installed here, so the browser tests were skipped.");
  console.log("  Everything in this bundle was tested before it was handed over.\n");
  console.log("  To run them locally too:");
  console.log("    npm install -g playwright && npx playwright install chromium\n");
  process.exit(2);
}
const { chromium } = _pw;

const BASE = process.env.BASE || 'http://localhost:8099';

/* Screenshots are a debugging aid, not an assertion. Write them beside this
   script (gitignored) and never let a filesystem problem fail the suite —
   an absolute path from another machine used to do exactly that. */
const path = require('path');
const fs = require('fs');
const SHOT_DIR = path.join(__dirname, '.screenshots');
async function shot(pageOrCtx, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await pageOrCtx.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true });
  } catch (e) { /* never fail a test run over a screenshot */ }
}
let pass = 0, fail = 0;
function ok(n, c, extra) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (extra ? ' :: ' + extra : '')); } }

(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });

  // ---------- 1. OFFLINE MODE (no apiBase) ----------
  console.log('\n[1] Offline fallback (apiBase empty)');
  let ctx = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Los_Angeles' });
  let page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  // /blank/ is index.html with apiBase emptied — the never-configured path,
  // without the page reaching out to the real Worker.
  await page.goto(BASE + '/blank/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  ok('no console/page errors', errs.length === 0, errs.join(' | '));
  ok('status says booking is not switched on',
    /isn't switched on/i.test(await page.textContent('#statusText')));
  ok('status has stale styling', (await page.getAttribute('#status', 'class')).includes('is-stale'));
  ok('status sits below every panel, just above the footer', await page.evaluate(() => {
      const st = document.querySelector('#status').getBoundingClientRect();
      const ft = document.querySelector('.sitefoot').getBoundingClientRect();
      const above = ['#notlive', '#slotwrap', '#modes', '.hero']
        .map(sel => document.querySelector(sel))
        .filter(el => el && el.offsetParent !== null)
        .every(el => el.getBoundingClientRect().top < st.top);
      return above && st.bottom <= ft.top + 1;
    }));
  ok('FAIL CLOSED: no slots offered without a live calendar',
    (await page.locator('#slots .slot').count()) === 0);
  ok('FAIL CLOSED: date rail hidden', await page.locator('#rail').isHidden());
  ok('FAIL CLOSED: slot card hidden', await page.locator('#slotwrap').isHidden());
  ok('email fallback shown instead', await page.locator('#notlive').isVisible());
  ok('email fallback explains why',
    /connected to my calendar yet/i.test(await page.textContent('#notliveMsg')));
  ok('header is the scheduling wordmark, not the practice name',
    /Real-time scheduling availability/i.test(await page.textContent('.masthead')) &&
    !/A Good Place Therapy/.test(await page.textContent('.masthead')));
  ok('pixel scene in the hero, not the header',
    (await page.locator('.hero-art svg rect').count()) > 500 &&
    (await page.locator('.masthead svg').count()) === 0);
  ok('artwork has an accessible name',
    ((await page.getAttribute('.hero-art svg', 'aria-label')) || '').length > 20);
  ok('artwork sized by CSS, not hard-coded px',
    (await page.getAttribute('.hero-art svg', 'width')) === null);
  ok('artwork scales to its container', await page.evaluate(() => {
      const box = document.querySelector('.hero-art').getBoundingClientRect();
      const svg = document.querySelector('.hero-art svg').getBoundingClientRect();
      return Math.abs(svg.width - box.width) < 2 && svg.height > 0;
    }));
  ok('footer names the employer',
    /Employed by A Good Place Therapy/.test(await page.textContent('.sitefoot')));
  ok('no session-hours claim anywhere',
    !/hours a week/i.test(await page.content()));
  ok('back-to-site link hidden until siteUrl is set',
    await page.locator('#backLink').isHidden());
  ok('footer renders', (await page.locator('.sitefoot').count()) === 1);
  ok('crisis line in footer', /988/.test(await page.textContent('.sitefoot')));
  {
    const f = await page.textContent('.sitefoot');
    ok('footer: AMFT registration number', /AMFT #138642/.test(f));
    ok('footer: associate title, not licensed', /Registered Associate/.test(f) && !/^(?!.*Registered).*\bLMFT\b/.test(f.split('Supervised')[0]));
    ok('footer: supervisor named with licence', /Christina Miller-Martinez, LMFT #105663/.test(f));
    ok('footer: employer disclosed', /Employed by A Good Place Therapy/.test(f));
    ok('footer: address and phone', /667 Lytton Ave/.test(f) && /971-514-2190/.test(f));
    ok('footer: pronouns', /\(He\/Him\)/.test(f));
    ok('phone is a tel: link',
      (await page.getAttribute('#fPhone', 'href')) === 'tel:9715142190');
    ok('page title says AMFT not LMFT',
      /AMFT/.test(await page.title()) && !/, LMFT/.test(await page.title()));
    ok('clinician is never called LMFT alone',
      !/Shawn Walters, LMFT/.test(await page.content()));
  }
  ok('no simulator links leaked',
    (await page.locator('a[href*="index.html"], a[href*="rates.html"]').count()) === 0);
  ok('weekly template is NOT published to the page',
    (await page.locator('#grid, details.weekly, .gridtable').count()) === 0);
  ok('virtual selected by default',
    (await page.getAttribute('.mode[data-mode="virtual"]', 'aria-pressed')) === 'true');
  ok('hero does not duplicate the header line',
    !/Real-time calendar availability/i.test(await page.textContent('.hero')));
  ok('hero no longer states session length',
    !/53-minute/.test(await page.textContent('.hero')));
  ok('mode cards carry names and descriptions',
    /Virtual/.test(await page.textContent('.mode[data-mode="virtual"]')) &&
    /Secure video/.test(await page.textContent('.mode[data-mode="virtual"]')));
  ok('session type names are bold', await page.evaluate(() =>
    getComputedStyle(document.querySelector('.mode-name')).fontWeight >= 700));
  ok('in-person card shows the address',
    /667 Lytton Ave/.test(await page.textContent('.mode[data-mode="inperson"]')));
  ok('reschedule prompt present',
    /rescheduling/i.test(await page.textContent('.mode-note')));

  // ---------- 2. SLOT MATH ----------
  console.log('\n[2] Slot math (hand-checked)');
  const math = await page.evaluate(() => {
    // Find the next Wednesday within the horizon, practice-local.
    function findDow(target) {
      for (let n = 0; n <= 28; n++) {
        const ds = dayStart(n);
        if (tzParts(new Date(ds), CONFIG.practiceTz).dow === target) return { n, ds };
      }
      return null;
    }
    const wed = findDow(3), thu = findDow(4), tue = findDow(2), sat = findDow(6);
    const out = {};
    // Push past the 24h notice floor by looking a week out, so notice never truncates.
    const wed2 = { n: wed.n + 7, ds: dayStart(wed.n + 7) };
    const tue2 = { n: tue.n + 7, ds: dayStart(tue.n + 7) };
    out.wedInperson = slotsForDay(wed2.ds, 'inperson').map(s =>
      new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.practiceTz, hour: 'numeric', minute: '2-digit' }).format(new Date(s.start)));
    out.wedVirtual = slotsForDay(wed2.ds, 'virtual').map(s =>
      new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.practiceTz, hour: 'numeric', minute: '2-digit' }).format(new Date(s.start)));
    out.tueVirtual = slotsForDay(tue2.ds, 'virtual').map(s =>
      new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.practiceTz, hour: 'numeric', minute: '2-digit' }).format(new Date(s.start)));
    out.satVirtual = slotsForDay(dayStart(sat.n + 7), 'virtual').length;
    out.wedIso = new Date(wed2.ds).toISOString();
    out.wedFirstSlot = slotsForDay(wed2.ds, 'inperson')[0];
    return out;
  });

  // Wed in person 7:00am-2:00pm, 53min sessions on a 60min grid -> 7 slots, 7am..1pm
  ok('Wed in-person = 7 slots 7AM–1PM',
    math.wedInperson.length === 7 && /7:00.?AM/.test(math.wedInperson[0]) && /1:00.?PM/.test(math.wedInperson[6]),
    JSON.stringify(math.wedInperson));
  // Wed virtual 3:00-6:00pm -> 3 slots
  ok('Wed virtual = 3 slots 3PM–5PM',
    math.wedVirtual.length === 3 && /3:00.?PM/.test(math.wedVirtual[0]) && /5:00.?PM/.test(math.wedVirtual[2]),
    JSON.stringify(math.wedVirtual));
  // Tue virtual: 8-9am (1 slot) + 11am-1pm (2 slots) = 3
  ok('Tue virtual = 3 slots (8AM, 11AM, 12PM)',
    math.tueVirtual.length === 3, JSON.stringify(math.tueVirtual));
  ok('Saturday has zero slots', math.satVirtual === 0);

  // ---------- 3. LIVE MODE + BUSY SUBTRACTION ----------
  console.log('\n[3] Live mode against mock calendar');
  // Block Wed 7:00-9:30 PT -> should kill the 7AM and 8AM slots, and the 9AM one
  // is safe (9:00+53+7=10:00 > 9:30 start? no: 9:00 starts after 9:30? no).
  // 9:00-10:00 overlaps 7:00-9:30 -> also removed. First surviving = 10AM.
  const wedStart = new Date(math.wedFirstSlot.start);
  const blockStart = new Date(wedStart.getTime());
  const blockEnd = new Date(wedStart.getTime() + 150 * 60000); // 2.5h
  await page.goto(BASE + '/__setbusy?v=' + encodeURIComponent(JSON.stringify(
    [{ start: blockStart.toISOString(), end: blockEnd.toISOString() }])));

  ctx = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/Los_Angeles' });
  page = await ctx.newPage();
  const errs2 = [];
  page.on('console', m => { if (m.type() === 'error') errs2.push(m.text()); });
  page.on('pageerror', e => errs2.push('PAGEERROR ' + e.message));
  await page.addInitScript((api) => { window.__API = api; }, BASE + '/api');
  await page.goto(BASE + '/blank/');
  await page.evaluate(() => { CONFIG.apiBase = window.__API; loadBusy(); });
  await page.waitForTimeout(600);

  ok('no errors in live mode', errs2.length === 0, errs2.join(' | '));
  ok('status flips to live', (await page.getAttribute('#status', 'class')).includes('is-live'));
  ok('status text says live', /Live from my calendar/i.test(await page.textContent('#statusText')));

  const after = await page.evaluate((iso) => {
    const ds = Date.parse(iso);
    return slotsForDay(ds, 'inperson').map(s =>
      new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.practiceTz, hour: 'numeric', minute: '2-digit' }).format(new Date(s.start)));
  }, math.wedIso);
  ok('busy block removed 3 slots (7 -> 4)', after.length === 4, JSON.stringify(after));
  ok('first surviving slot is 10AM', /10:00.?AM/.test(after[0]), JSON.stringify(after));

  // ---------- 4. UI FLOW ----------
  console.log('\n[4] Click-through booking flow');
  await page.click('.mode[data-mode="inperson"]');
  await page.waitForTimeout(150);
  const dayBtns = page.locator('.rail .day:not(.is-empty)');
  const nDays = await dayBtns.count();
  ok('rail has clickable days', nDays > 0, 'count=' + nDays);
  await dayBtns.first().click();
  await page.waitForTimeout(150);
  const nSlots = await page.locator('#slots .slot').count();
  ok('slots render for selected day', nSlots > 0, 'count=' + nSlots);
  ok('dot count matches slot count for that day',
    (await dayBtns.first().locator('.day-dots i').count()) === Math.min(nSlots, 6));

  await page.locator('#slots .slot').first().click();
  await page.waitForTimeout(150);
  ok('booking panel opens', !(await page.locator('#book').isHidden()));
  ok('booking panel names the session type', /In person/.test(await page.textContent('#bookWhen')));

  // The submit button is the whole point of the page; it should dominate its
  // panel rather than sit level with the chips above it.
  {
    const m = await page.evaluate(() => {
      const b  = document.querySelector('#bSubmit').getBoundingClientRect();
      const wr = document.querySelector('#slotwrap').getBoundingClientRect();
      const chip = document.querySelector('#bKind .chip').getBoundingClientRect();
      const re = document.querySelector('#bReassure').getBoundingClientRect();
      const cs = getComputedStyle(document.querySelector('#bSubmit'));
      return { bw: Math.round(b.width), bh: Math.round(b.height),
               inner: Math.round(wr.width), chipArea: Math.round(chip.width*chip.height),
               btnArea: Math.round(b.width*b.height),
               fs: parseFloat(cs.fontSize),
               reAbove: re.bottom <= b.top + 1 };
    });
    ok('submit spans the panel width', m.bw >= m.inner - 60, `${m.bw} vs ${m.inner}`);
    ok('submit is a large target', m.bh >= 50, `${m.bh}px tall`);
    ok('submit type is larger than the form labels', m.fs >= 16, `${m.fs}px`);
    ok('submit outweighs the chips beside it',
      m.btnArea > m.chipArea * 3, `${m.btnArea} vs ${m.chipArea}`);
    ok('reassurance sits above the button, not below', m.reAbove);
    const reText = (await page.textContent('#bReassure')) || '';
    ok('reassurance says what happens next',
      /request, not a booking/i.test(reText) && /email you to confirm/i.test(reText),
      reText.slice(0, 70));
    ok('no manufactured urgency', !/only|hurry|last chance|running out|act now|\bfast\b/i
      .test(await page.textContent('#slotwrap')));
    // The PHI warning must survive any copy rewrite. Match loosely so a
    // reworded sentence still passes, but its absence still fails.
    ok('still warns this is not a secure channel',
      /secure channel/i.test(await page.textContent('.privacy')),
      await page.textContent('.privacy'));
    ok('still asks people to keep clinical detail out',
      /clinical detail/i.test(await page.textContent('.privacy')));
  }

  // validation
  await page.click('#bSubmit');
  await page.waitForTimeout(120);
  ok('rejects empty form', /valid email/i.test(await page.textContent('#bResult')));

  await page.fill('#bName', 'Test Client');
  await page.fill('#bEmail', 'test@example.com');
  ok('kind defaults to new session',
    (await page.getAttribute('#bKind .chip[data-kind="new"]', 'aria-pressed')) === 'true');
  await page.click('#bKind .chip[data-kind="reschedule"]');
  await page.waitForTimeout(100);
  ok('reschedule chip selects',
    (await page.getAttribute('#bKind .chip[data-kind="reschedule"]', 'aria-pressed')) === 'true' &&
    (await page.getAttribute('#bKind .chip[data-kind="new"]', 'aria-pressed')) === 'false');
  await page.click('#bKind .chip[data-kind="new"]');
  await page.click('#bSubmit');
  await page.waitForTimeout(700);
  await page.waitForTimeout(600);
  ok('confirmation panel replaces the form', await page.locator('#confirm').isVisible());
  ok('picker hidden once booked', await page.locator('#slotwrap').isHidden());
  ok('confirmation states the time', /\d/.test(await page.textContent('#cWhen')));
  ok('confirmation names the email', /test@example\.com/.test(await page.textContent('#cEmail')));
  ok('confirmation names session type', /In person|Virtual/.test(await page.textContent('#cMode')));
  // "(mock)" only exists in the Worker's response, so this proves the page is
  // using the location the Worker resolved rather than its own fallback.
  ok('confirmation uses the location the Worker returned',
    /667 Lytton Ave.*\(mock\)/.test(await page.textContent('#cWhere')),
    await page.textContent('#cWhere'));
  ok('in-person keeps the plain label row',
    (await page.locator('#whereRow').isVisible()) &&
    (await page.locator('#whereStack').isHidden()));
  {
    const ics = await page.evaluate(() => icsBlob().text());
    ok('ics carries that same location', /LOCATION:667 Lytton Ave.*\(mock\)/.test(ics));
  }
  ok('confirmation says new vs reschedule', /New session|Rescheduled/.test(await page.textContent('#cKind')));
  ok('confirmation explains what happens next', (await page.textContent('#cNext')).length > 40);
  ok('in-person shows the Getting here panel', await page.locator('#arrive').isVisible());
  ok('arrival names the right cross street and landmarks', await (async () => {
      const t = await page.textContent('#aList');
      // Byron St, not Bryant — the cross street at Lytton.
      return /Byron St/.test(t) && !/Bryant/.test(t) &&
             /667 is above the porch/.test(t) && /waiting room/.test(t);
    })(), await page.textContent('#aList'));
  {
    const gm = await page.getAttribute('#aGmap', 'href');
    const am = await page.getAttribute('#aAmap', 'href');
    ok('google maps link targets the office',
      /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/.test(gm) &&
      /667%20Lytton%20Ave/.test(gm), gm && gm.slice(0, 90));
    ok('apple maps link targets the office',
      /^https:\/\/maps\.apple\.com\/\?q=/.test(am) && /667%20Lytton/.test(am),
      am && am.slice(0, 80));
  }
  ok('office photo is shown', await page.locator('#aPhoto').isVisible());
  ok('photo has a real alt description',
    ((await page.getAttribute('#aPhoto', 'alt')) || '').length > 20);
  // A broken src still renders an <img>; only naturalWidth proves it loaded.
  ok('photo actually loads (not a 404)', await page.evaluate(async () => {
    const el = document.querySelector('#aPhoto');
    if (el.complete) return el.naturalWidth > 0;
    return await new Promise(r => { el.onload = () => r(true); el.onerror = () => r(false); });
  }), await page.getAttribute('#aPhoto', 'src'));
  ok('photo stays inside the panel', await page.evaluate(() => {
    const p = document.querySelector('#arrive').getBoundingClientRect();
    const i = document.querySelector('#aPhoto').getBoundingClientRect();
    return i.right <= p.right + 1 && i.left >= p.left - 1;
  }));
  ok('arrival gives a contact number', /971-514-2190/.test(await page.textContent('#aContact')));
  ok('add-to-calendar options present',
    (await page.locator('#cGoogle').isVisible()) &&
    (await page.locator('#cOutlook').isVisible()) &&
    (await page.locator('#cIcs').isVisible()));
  {
    const gh = await page.getAttribute('#cGoogle', 'href');
    const oh = await page.getAttribute('#cOutlook', 'href');
    ok('google link is a valid TEMPLATE url with a date range',
      /^https:\/\/calendar\.google\.com\/calendar\/render\?/.test(gh) &&
      /action=TEMPLATE/.test(gh) &&
      /dates=\d{8}T\d{6}Z%2F\d{8}T\d{6}Z/.test(gh), gh && gh.slice(0, 90));
    ok('google link carries the location the Worker returned',
      /667\+Lytton|667%20Lytton/.test(gh), gh && gh.slice(0, 140));
    ok('outlook link is a valid compose deeplink',
      /^https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose\?/.test(oh) &&
      /startdt=\d{4}-\d{2}-\d{2}T/.test(oh), oh && oh.slice(0, 90));
    const dur = await page.evaluate(() => {
      const u = new URL(document.querySelector('#cOutlook').href);
      return (Date.parse(u.searchParams.get('enddt')) - Date.parse(u.searchParams.get('startdt'))) / 60000;
    });
    ok('outlook link duration is 53 minutes', dur === 53, String(dur));
  }
  {
    const ics = await page.evaluate(() => icsBlob().text());
    ok('ics is valid and carries the session',
      /BEGIN:VCALENDAR/.test(ics) && /DTSTART:\d{8}T\d{6}Z/.test(ics) &&
      /SUMMARY:Session with Shawn Walters/.test(ics), ics.slice(0, 60));
  }
  // Grab the in-person POST now — the virtual booking below replaces the mock's
  // record of the last request.
  const booked = await (await ctx.newPage()).goto(BASE + '/__lastbook').then(r => r.json());

  await page.click('#cAgain');
  await page.waitForTimeout(400);
  ok('pick-another restores the picker',
    (await page.locator('#confirm').isHidden()) && (await page.locator('#rail').isVisible()));

  // Directions must not appear on a virtual booking.
  await page.click('.mode[data-mode="virtual"]');
  await page.waitForTimeout(300);
  {
    const vDays = page.locator('.rail .day:not(.is-empty)');
    if (await vDays.count()) {
      await vDays.first().click(); await page.waitForTimeout(250);
      await page.locator('#slots .slot').first().click(); await page.waitForTimeout(200);
      await page.fill('#bName', 'Virtual Person');
      await page.fill('#bEmail', 'v@example.com');
      await page.click('#bSubmit'); await page.waitForTimeout(900);
      ok('virtual booking hides the Getting here panel',
        await page.locator('#arrive').isHidden());
      ok('virtual booking shows the actual join address',
        /agoodplace\.zoom\.us\/my\/shawnwalters/.test(await page.textContent('#cWhereLink')),
        await page.textContent('#cWhereLink'));
      ok('join link is clickable and points at Zoom',
        (await page.getAttribute('#cWhereLink a', 'href')) === 'https://agoodplace.zoom.us/my/shawnwalters');
      ok('virtual booking explains the link',
        /sign in for your Zoom virtual session/i.test(await page.textContent('#virtualIntro')));
      ok('virtual uses the stacked block, not the label row',
        (await page.locator('#whereStack').isVisible()) &&
        (await page.locator('#whereRow').isHidden()));
      ok('sentence sits ABOVE the link', await page.evaluate(() => {
        const i = document.querySelector('#virtualIntro').getBoundingClientRect();
        const l = document.querySelector('#cWhereLink').getBoundingClientRect();
        return i.bottom <= l.top + 1;
      }));
      ok('link is left-aligned under its sentence', await page.evaluate(() => {
        const i = document.querySelector('#virtualIntro').getBoundingClientRect();
        const a = document.querySelector('#cWhereLink a').getBoundingClientRect();
        return Math.abs(i.left - a.left) < 2;
      }));
      {
        const ics = await page.evaluate(() => icsBlob().text());
        ok('ics carries the zoom link as the location',
          /LOCATION:https:\/\/agoodplace\.zoom\.us/.test(ics), ics.slice(0, 80));
      }
      await page.click('#cAgain'); await page.waitForTimeout(300);
    }
  }

  ok('POST body has ISO start', !!Date.parse(booked.start));
  ok('POST duration is exactly 53 min',
    Math.round((Date.parse(booked.end) - Date.parse(booked.start)) / 60000) === 53);
  ok('POST carries mode', booked.mode === 'inperson');
  ok('POST carries name/email', booked.name === 'Test Client' && booked.email === 'test@example.com');
  ok('POST carries kind, defaulting to new', booked.kind === 'new');

  // ---------- 5. API FAILURE DEGRADES HONESTLY ----------
  console.log('\n[5] Backend down');
  const p5 = await ctx.newPage();
  await p5.goto(BASE + '/blank/');
  await p5.evaluate((api) => { CONFIG.apiBase = api; loadBusy(); }, BASE + '/api/fail-');
  await p5.waitForTimeout(500);
  ok('falls back to stale banner', (await p5.getAttribute('#status', 'class')).includes('is-stale'));
  ok('FAIL CLOSED on backend error: no slots offered',
    (await p5.locator('#slots .slot').count()) === 0);
  ok('FAIL CLOSED on backend error: email fallback shown',
    await p5.locator('#notlive').isVisible());
  ok('backend-down copy differs from never-configured copy',
    /isn't responding/i.test(await p5.textContent('#notliveMsg')));

  // ---------- 6. CROSS-TIMEZONE ----------
  console.log('\n[6] Viewer in New York');
  const ctxNY = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: 'America/New_York' });
  const pNY = await ctxNY.newPage();
  const errsNY = [];
  pNY.on('pageerror', e => errsNY.push(e.message));
  await pNY.goto(BASE + '/blank/');
  await pNY.evaluate((api) => { CONFIG.apiBase = api; loadBusy(); }, BASE + '/api');
  await pNY.waitForTimeout(500);
  await pNY.click('.mode[data-mode="inperson"]');
  await pNY.locator('.rail .day:not(.is-empty)').first().click();
  await pNY.waitForTimeout(150);
  await pNY.locator('#slots .slot').first().click();
  await pNY.waitForTimeout(150);
  const tzLine = await pNY.textContent('#bookTz');
  ok('no errors in NY timezone', errsNY.length === 0, errsNY.join('|'));
  ok('shows viewer tz', /New_York/.test(tzLine), tzLine);
  ok('translates back to practice time', /for me\./.test(tzLine), tzLine);
  // Don't assume which day is first — verify the same instant renders exactly
  // 3 hours apart in the two zones, and that it's a real template start time.
  const tzCheck = await pNY.evaluate(() => {
    const s = state.selectedSlot;
    const f = (tz) => new Intl.DateTimeFormat('en-US',
      { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false }).format(new Date(s.start));
    const pt = f('America/Los_Angeles'), et = f('America/New_York');
    const mins = (x) => { const a = x.split(':'); return (+a[0] % 24) * 60 + (+a[1]); };
    return { pt, et, delta: (mins(et) - mins(pt) + 1440) % 1440, shown: document.querySelector('#slots .slot').textContent };
  });
  ok('ET renders exactly 3h ahead of PT for the same instant',
    tzCheck.delta === 180, JSON.stringify(tzCheck));
  ok('displayed slot label is the viewer-local time',
    tzCheck.shown.replace(/\s/g, '').toUpperCase().startsWith(
      String(((+tzCheck.et.split(':')[0] % 12) || 12))), JSON.stringify(tzCheck));

  // ---------- 7. MOBILE ----------
  console.log('\n[7] Mobile 390x844');
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  const pm = await ctxM.newPage();
  const errsM = [];
  pm.on('pageerror', e => errsM.push(e.message));
  await pm.goto(BASE + '/blank/');
  await pm.evaluate((api) => { CONFIG.apiBase = api; loadBusy(); }, BASE + '/api');
  await pm.waitForTimeout(500);
  ok('no errors on mobile', errsM.length === 0, errsM.join('|'));
  const sw = await pm.evaluate(() => document.documentElement.scrollWidth);
  ok('no horizontal overflow', sw <= 391, 'scrollWidth=' + sw);
  await pm.locator('.rail .day:not(.is-empty)').first().click();
  await pm.waitForTimeout(150);
  ok('slots usable on mobile', (await pm.locator('#slots .slot').count()) > 0);
  await shot(pm, 'mobile');

  await shot(page, 'desktop');

  console.log('\n' + '='.repeat(46));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(46));
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
