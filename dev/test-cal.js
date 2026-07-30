const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');

const BASE = process.env.BASE || 'http://localhost:8099';
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
  ok('pixel therapist in the hero, not the header',
    (await page.locator('.hero-art svg rect').count()) > 100 &&
    (await page.locator('.masthead svg').count()) === 0);
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
  {
    const ics = await page.evaluate(() => icsBlob().text());
    ok('ics carries that same location', /LOCATION:667 Lytton Ave.*\(mock\)/.test(ics));
  }
  ok('confirmation says new vs reschedule', /New session|Rescheduled/.test(await page.textContent('#cKind')));
  ok('confirmation explains what happens next', (await page.textContent('#cNext')).length > 40);
  ok('add-to-calendar button present', await page.locator('#cIcs').isVisible());
  {
    const ics = await page.evaluate(() => icsBlob().text());
    ok('ics is valid and carries the session',
      /BEGIN:VCALENDAR/.test(ics) && /DTSTART:\d{8}T\d{6}Z/.test(ics) &&
      /SUMMARY:Session with Shawn Walters/.test(ics), ics.slice(0, 60));
  }
  await page.click('#cAgain');
  await page.waitForTimeout(400);
  ok('pick-another restores the picker',
    (await page.locator('#confirm').isHidden()) && (await page.locator('#rail').isVisible()));

  const booked = await (await ctx.newPage()).goto(BASE + '/__lastbook').then(r => r.json());
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
  await pm.screenshot({ path: '/home/claude/tt/shot-mobile.png', fullPage: true });

  await page.screenshot({ path: '/home/claude/tt/shot-desktop.png', fullPage: true });

  console.log('\n' + '='.repeat(46));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(46));
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
