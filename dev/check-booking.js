#!/usr/bin/env node
/**
 * check-booking.js — prove the booking path works, email included.
 *
 *   node dev/check-booking.js https://agp-cal.<sub>.workers.dev you@example.com
 *
 * Books a real slot on your real calendar and asks Google to email a real
 * invite, because that is the only way to know it works. Use an address you
 * can check. It prints the event link so you can delete it afterwards.
 *
 * Also exercises the guards: a slot outside your hours, a wrong duration, and
 * a double-book of the slot it just took — all of which must be refused.
 */

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const EMAIL = process.argv[3];
// "virtual" or "inperson" (default). Virtual is the one that proves what
// VIRTUAL_LOCATION is actually set to — Meet, Zoom, or nothing.
const MODE = String(process.argv[4] || "inperson").toLowerCase() === "virtual" ? "virtual" : "inperson";
const TZ = "America/Los_Angeles";

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
let failed = 0;
const ok = (m) => console.log(`  ${g("PASS")}  ${m}`);
const bad = (m, d) => { failed++; console.log(`  ${r("FAIL")}  ${m}`); if (d) console.log(dim("        " + d)); };

if (!BASE || !EMAIL || !EMAIL.includes("@")) {
  console.log("\nUsage: node dev/check-booking.js https://agp-cal.<sub>.workers.dev you@example.com [virtual|inperson]\n");
  console.log(dim("  Use an inbox you can actually read — the point is to confirm the email arrives.\n"));
  process.exit(1);
}

const post = async (body) => {
  const res = await fetch(BASE + "/book", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://cavatello.github.io" },
    body: JSON.stringify(body),
  });
  let j; try { j = await res.json(); } catch { j = { error: "non-JSON response" }; }
  return { status: res.status, j };
};

(async () => {
  console.log(`\nBooking test against ${BASE}\n` + "-".repeat(56));

  // Find a real opening from the Worker's own free/busy view.
  const now = new Date();
  const horizon = new Date(Date.now() + 21 * 86400000);
  let busy = [];
  try {
    const fb = await fetch(`${BASE}/freebusy?start=${now.toISOString()}&end=${horizon.toISOString()}`,
      { headers: { origin: "https://cavatello.github.io" } });
    if (!fb.ok) { bad("free/busy failed — fix that before testing booking"); process.exit(1); }
    busy = (await fb.json()).busy.map((b) => [Date.parse(b.start), Date.parse(b.end)]);
    ok(`read free/busy (${busy.length} ranges)`);
  } catch (e) { bad("could not reach the Worker: " + e.message); process.exit(1); }

  // Mirror of the server-side template. In-person Wednesday 07:00–14:00 is the
  // widest window, so it is the most likely to have something free.
  const off = (d) => -new Date(d).getTimezoneOffset();
  function wall(y, m, d, hh) {
    const naive = Date.UTC(y, m - 1, d, hh, 0, 0);
    const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const pick = (ts) => { const p = {}; f.formatToParts(new Date(ts)).forEach((x) => (p[x.type] = x.value));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ts; };
    let ts = naive - pick(naive); return naive - pick(ts);
  }
  const free = (s, e) => !busy.some(([bs, be]) => s < be && e > bs);

  // Mirrors AVAILABILITY: [weekday, firstHour, lastStartHour].
  const WINDOWS = MODE === "virtual"
    ? [["Mon", 8, 8], ["Tue", 8, 8], ["Tue", 11, 12], ["Wed", 15, 17], ["Fri", 8, 8]]
    : [["Tue", 14, 20], ["Wed", 7, 13], ["Thu", 7, 13], ["Fri", 14, 19]];

  let slot = null;
  for (let n = 2; n <= 20 && !slot; n++) {
    const day = new Date(Date.now() + n * 86400000);
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
    const o = {}; p.formatToParts(day).forEach((x) => (o[x.type] = x.value));
    for (const [dow, from, to] of WINDOWS) {
      if (o.weekday !== dow || slot) continue;
      for (let h = from; h <= to && !slot; h++) {
        const s = wall(+o.year, +o.month, +o.day, h);
        const e = s + 53 * 60000;
        if (s > Date.now() + 26 * 3600000 && free(s, s + 60 * 60000)) slot = { s, e };
      }
    }
  }
  if (!slot) { bad(`no free ${MODE} slot in the next 20 days`, "Try again when you have an opening, or book manually from the page."); process.exit(1); }

  const fmt = (t) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(t));
  console.log(dim(`\n  Booking a ${MODE === "virtual" ? "VIRTUAL" : "IN-PERSON"} session, ${fmt(slot.s)} Pacific\n`));

  const req = {
    start: new Date(slot.s).toISOString(), end: new Date(slot.e).toISOString(),
    mode: MODE, name: "Booking test — delete me", email: EMAIL,
    notes: "Automated test from check-booking.js", kind: "new", viewerTz: TZ,
  };

  const { status, j } = await post(req);
  if (status !== 200 || j.error) { bad(`booking rejected (${status}): ${j.error}`); process.exit(1); }
  ok("booking accepted");

  if (j.invited === true) ok(`Google was asked to email an invite to ${EMAIL}`);
  else if (j.invited === false) bad("SEND_INVITES is off — no email was sent",
    'Set SEND_INVITES = "true" in wrangler.toml and redeploy.');
  else bad("Worker did not report whether it emailed anyone", "Deploy the current worker.js.");

  if (j.htmlLink) ok("event created — link below");
  else bad("no event link returned");

  // What location did the Worker attach? This is what the client sees in the
  // invite, and the only way to confirm VIRTUAL_LOCATION actually deployed.
  const loc = j.location || "";
  console.log(dim(`\n        location: ${loc || "(none)"}\n`));
  if (!loc) {
    bad("Worker attached no location",
      MODE === "virtual"
        ? "VIRTUAL_LOCATION is empty. Set it in wrangler.toml and redeploy."
        : "OFFICE_ADDRESS is empty. Set it in wrangler.toml and redeploy.");
  } else if (MODE === "virtual") {
    if (/zoom\.us/i.test(loc)) ok("virtual sessions use your Zoom room");
    else if (/meet\.google\.com/i.test(loc))
      bad("still handing out Google Meet links",
        'VIRTUAL_LOCATION is still "meet". Set your Zoom URL, then: npx wrangler deploy');
    else ok(`virtual location set to ${loc}`);
  } else {
    if (/Lytton/i.test(loc)) ok("in-person sessions carry the office address");
    else ok(`in-person location set to ${loc}`);
  }

  // Guards
  console.log("\n  Guards:");
  const dbl = await post(req);
  if (dbl.status === 409) ok("double-booking the same slot is refused");
  else bad(`double-book returned ${dbl.status}, expected 409`, JSON.stringify(dbl.j).slice(0, 120));

  const three = wall(2026, 1, 1, 3);
  const outside = await post({ ...req, start: new Date(three).toISOString(), end: new Date(three + 53 * 60000).toISOString() });
  if (outside.status >= 400) ok("a time outside your hours is refused");
  else bad("a 3am booking was accepted — the server-side template check is not working");

  const wrongLen = await post({ ...req, end: new Date(slot.s + 90 * 60000).toISOString() });
  if (wrongLen.status >= 400) ok("a wrong session length is refused");
  else bad("a 90-minute booking was accepted");

  console.log("\n" + "-".repeat(56));
  if (j.htmlLink) {
    console.log("\n  " + (failed ? r("Some checks failed.") : g("Booking path works.")));
    console.log("\n  Now do the two things only you can do:");
    console.log(`    1. Check ${EMAIL} for a calendar invite from Google.`);
    console.log("    2. Delete the test event:");
    console.log(dim("       " + j.htmlLink));
  }
  console.log();
  process.exit(failed ? 1 : 0);
})();
