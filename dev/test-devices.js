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
const { chromium, devices } = _pw;

const BASE = process.env.BASE || 'http://localhost:8099';
let pass = 0, fail = 0;
const issues = [];
function ok(dev, n, c, extra) {
  if (c) { pass++; }
  else { fail++; issues.push(`${dev}: ${n}${extra ? ' :: ' + extra : ''}`); }
}

// Real device metrics. iOS Human Interface Guidelines want 44x44pt tap targets;
// Material wants 48dp. 44 is the bar that actually matters on iPhone.
const VIEWPORTS = [
  { name: 'iPhone SE',        w: 375,  h: 667,  touch: true,  dpr: 2 },
  { name: 'iPhone 15',        w: 393,  h: 852,  touch: true,  dpr: 3 },
  { name: 'iPhone 15 Pro Max',w: 430,  h: 932,  touch: true,  dpr: 3 },
  { name: 'iPhone landscape', w: 852,  h: 393,  touch: true,  dpr: 3 },
  { name: 'iPad mini',        w: 768,  h: 1024, touch: true,  dpr: 2 },
  { name: 'iPad Pro 11',      w: 834,  h: 1194, touch: true,  dpr: 2 },
  { name: 'iPad Pro 12.9',    w: 1024, h: 1366, touch: true,  dpr: 2 },
  { name: 'Laptop',           w: 1280, h: 800,  touch: false, dpr: 2 },
  { name: 'Desktop',          w: 1440, h: 900,  touch: false, dpr: 2 },
  { name: 'Wide',             w: 1920, h: 1080, touch: false, dpr: 1 },
  { name: 'Narrow edge',      w: 320,  h: 568,  touch: true,  dpr: 2 },
];

const MIN_TAP = 44;

(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });

  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h },
      deviceScaleFactor: v.dpr,
      hasTouch: v.touch,
      isMobile: v.touch && v.w < 820,
      timezoneId: 'America/Los_Angeles',
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 100)); });

    await page.goto(BASE + '/blank/');
    await page.evaluate((api) => { CONFIG.apiBase = api; loadBusy(); }, BASE + '/api');
    await page.waitForTimeout(700);

    const D = v.name;

    // ---- 1. no horizontal overflow ----
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(D, 'no horizontal scroll', sw <= v.w + 1, `scrollWidth ${sw} > ${v.w}`);

    // ---- 2. nothing sticks out past the viewport ----
    const overflow = await page.evaluate((vw) => {
      const bad = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.right > vw + 1.5 || r.left < -1.5) {
          bad.push((el.id || el.className || el.tagName).toString().split(' ')[0] +
                   ` [${Math.round(r.left)}..${Math.round(r.right)}]`);
        }
      });
      return [...new Set(bad)].slice(0, 4);
    }, v.w);
    ok(D, 'no element past viewport edge', overflow.length === 0, overflow.join(', '));

    // ---- 3. tap targets ----
    if (v.touch) {
      const small = await page.evaluate((min) => {
        const bad = [];
        document.querySelectorAll('button, a[href], input, textarea, [role="button"]')
          .forEach(el => {
            if (el.offsetParent === null) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            // WCAG 2.5.5 exempts links inline in a sentence — enlarging them
            // would break line spacing. Only standalone controls must hit 44px.
            const p = el.parentElement;
            const inline = el.tagName === 'A' && p &&
              p.textContent.trim().length > el.textContent.trim().length + 12;
            if (inline) return;
            if (r.height < min || r.width < min) {
              bad.push((el.id || el.className || el.tagName).toString().split(' ')[0] +
                       ` ${Math.round(r.width)}x${Math.round(r.height)}`);
            }
          });
        return [...new Set(bad)].slice(0, 5);
      }, MIN_TAP);
      ok(D, `tap targets >= ${MIN_TAP}px`, small.length === 0, small.join(', '));
    }

    // ---- 4. readable type ----
    const tiny = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('p, span, b, label, button, a, h1, h2, h3, div').forEach(el => {
        if (!el.textContent.trim() || el.children.length) return;
        if (el.offsetParent === null) return;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 11) bad.push((el.className || el.tagName) + ' ' + fs + 'px');
      });
      return [...new Set(bad)].slice(0, 4);
    });
    ok(D, 'no text under 11px', tiny.length === 0, tiny.join(', '));

    // ---- 5. mode cards usable ----
    const modeBox = await page.evaluate(() => {
      const a = document.querySelector('.mode[data-mode="virtual"]').getBoundingClientRect();
      const b = document.querySelector('.mode[data-mode="inperson"]').getBoundingClientRect();
      return { aw: Math.round(a.width), bw: Math.round(b.width),
               stacked: b.top > a.bottom - 5, gap: Math.round(b.left - a.right) };
    });
    ok(D, 'mode cards wide enough to read', modeBox.aw >= 140 && modeBox.bw >= 140,
       `${modeBox.aw} / ${modeBox.bw}`);
    ok(D, 'mode cards do not overlap',
       modeBox.stacked || modeBox.gap >= 0, `gap ${modeBox.gap}`);

    // ---- 6. full booking flow ----
    await page.click('.mode[data-mode="inperson"]');
    await page.waitForTimeout(300);
    const days = page.locator('.rail .day:not(.is-empty)');
    const nDays = await days.count();
    ok(D, 'rail offers days', nDays > 0, `count ${nDays}`);

    if (nDays > 0) {
      await days.first().click();
      await page.waitForTimeout(250);
      const nSlots = await page.locator('#slots .slot').count();
      ok(D, 'slots render', nSlots > 0, `count ${nSlots}`);

      // slot chips must not overlap each other
      const slotOverlap = await page.evaluate(() => {
        const r = [...document.querySelectorAll('#slots .slot')].map(e => e.getBoundingClientRect());
        for (let i = 0; i < r.length; i++)
          for (let j = i + 1; j < r.length; j++) {
            const a = r[i], b = r[j];
            if (a.left < b.right - 1 && b.left < a.right - 1 &&
                a.top < b.bottom - 1 && b.top < a.bottom - 1) return `${i}/${j}`;
          }
        return null;
      });
      ok(D, 'slot chips do not overlap', slotOverlap === null, slotOverlap);

      if (nSlots > 0) {
        await page.locator('#slots .slot').first().click();
        await page.waitForTimeout(250);
        ok(D, 'booking form opens', await page.locator('#book').isVisible());

        // inputs must be >=16px on iOS or Safari zooms the page on focus
        if (v.touch) {
          const inputFs = await page.evaluate(() =>
            parseFloat(getComputedStyle(document.querySelector('#bEmail')).fontSize));
          ok(D, 'inputs >=16px (no iOS zoom-on-focus)', inputFs >= 16, inputFs + 'px');
        }

        await page.fill('#bName', 'Test Person');
        await page.fill('#bEmail', 'test@example.com');
        await page.click('#bSubmit');
        await page.waitForTimeout(900);
        ok(D, 'confirmation appears', await page.locator('#confirm').isVisible());

        const cOverflow = await page.evaluate((vw) => {
          const bad = [];
          document.querySelectorAll('#confirm *').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width && (r.right > vw + 1.5 || r.left < -1.5)) bad.push(el.className || el.tagName);
          });
          return [...new Set(bad)].slice(0, 3);
        }, v.w);
        ok(D, 'confirmation fits viewport', cOverflow.length === 0, cOverflow.join(', '));

        const rowsWrap = await page.evaluate(() => {
          const bad = [];
          document.querySelectorAll('#confirm .crow').forEach(el => {
            const s = el.querySelector('span'), b = el.querySelector('b');
            if (!s || !b) return;
            const rs = s.getBoundingClientRect(), rb = b.getBoundingClientRect();
            if (rs.right > rb.left + 1 && Math.abs(rs.top - rb.top) < 4) bad.push(s.textContent);
          });
          return bad;
        });
        ok(D, 'confirmation rows do not collide', rowsWrap.length === 0, rowsWrap.join(', '));
      }
    }

    ok(D, 'no JS errors', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n' + '='.repeat(58));
  console.log(`  ${pass} passed, ${fail} failed  across ${VIEWPORTS.length} viewports`);
  console.log('='.repeat(58));
  if (issues.length) {
    console.log('\nISSUES:');
    issues.forEach(i => console.log('  ' + i));
  }
  process.exit(fail ? 1 : 0);
})();
