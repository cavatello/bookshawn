#!/usr/bin/env node
/**
 * check-worker.js — verify a deployed Worker end to end.
 *
 *   node dev/check-worker.js https://agp-cal.<sub>.workers.dev
 *
 * Checks reachability, response shape, CORS for the Pages origin, and that no
 * event detail comes back. Takes no credentials — it only talks to your Worker.
 */

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const ORIGIN = process.argv[3] || "https://cavatello.github.io";
const TZ = "America/Los_Angeles";

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
let failed = 0;
const ok = (m) => console.log(`  ${g("PASS")}  ${m}`);
const bad = (m, fix) => {
  failed++;
  console.log(`  ${r("FAIL")}  ${m}`);
  if (fix) console.log(dim(fix.split("\n").map((l) => "        " + l).join("\n")));
};

if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.log("\nUsage: node dev/check-worker.js https://agp-cal.<sub>.workers.dev\n");
  process.exit(1);
}

(async () => {
  console.log(`\nChecking ${BASE}\n` + "-".repeat(52));

  const start = new Date();
  const end = new Date(Date.now() + 7 * 86400000);
  const url = `${BASE}/freebusy?start=${encodeURIComponent(start.toISOString())}` +
              `&end=${encodeURIComponent(end.toISOString())}`;

  let res, body;
  try {
    res = await fetch(url, { headers: { origin: ORIGIN, accept: "application/json" } });
    body = await res.text();
  } catch (err) {
    bad("could not reach the Worker: " + err.message,
      "Deployed? Run: npx wrangler deployments list\n" +
      "Check the URL printed by `wrangler deploy`.");
    process.exit(1);
  }
  ok(`reachable (HTTP ${res.status})`);

  if (res.status !== 200) {
    // Order matters, and patterns must be specific: "The OAuth client was not
    // found" contains "not found", so a loose /not found/ pattern here would
    // mis-diagnose an auth failure as a wrong URL path.
    const hints = [
      [/OAuth client was not found/i,
        "GOOGLE_CLIENT_ID is missing or wrong on the Worker.\nCheck:  npx wrangler secret list\nIf the three names aren't exactly GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,\nGOOGLE_REFRESH_TOKEN, the values went on the command line by mistake.\nRun `npx wrangler secret put NAME` alone, then paste at the prompt."],
      [/invalid_grant/i,
        "Refresh token is dead. Consent screen External+Testing expires\ntokens after 7 days — set User Type to Internal and re-issue."],
      [/invalid_client|Unauthorized/i,
        "GOOGLE_CLIENT_SECRET does not match GOOGLE_CLIENT_ID.\n" +
        "Google says 'Unauthorized' here when the secret is wrong or belongs to a\n" +
        "different (often deleted) OAuth client. Copy the secret again from\n" +
        "Console -> Credentials -> your client -> and re-run:\n" +
        "  npx wrangler secret put GOOGLE_CLIENT_SECRET"],
      [/Cannot read calendar/i,
        "CALENDAR_ID in wrangler.toml doesn't match a readable calendar."],
      [/unauthorized_client/i,
        "Create a 'Web application' OAuth client, not Desktop or Service Account."],
      [/Calendar read failed: 403/i,
        "Enable the Google Calendar API for this Cloud project."],
      [/^\{"error":"Not found"\}$/,
        "Wrong path. It is /freebusy, lowercase."],
    ];
    const hit = hints.find(([re]) => re.test(body));
    bad(`Worker returned ${res.status}: ${body.slice(0, 200)}`, hit ? hit[1] : null);
    console.log(dim("\n        Live logs: cd worker && npx wrangler tail\n"));
    process.exit(1);
  }

  let j;
  try { j = JSON.parse(body); }
  catch { bad("response is not JSON: " + body.slice(0, 120)); process.exit(1); }

  if (!Array.isArray(j.busy)) bad("no `busy` array in the response");
  else ok("response has the expected shape");

  if (j.timeZone === TZ) ok(`timeZone is ${TZ}`);
  else bad(`timeZone is ${j.timeZone}, expected ${TZ}`,
    "Set PRACTICE_TZ in wrangler.toml and redeploy.");

  const leak = body.match(/summary|description|attendee|location|9083\d|creator/i);
  if (leak) bad(`response contains event detail near "${leak[0]}" — STOP`,
    "The Worker should call freeBusy, never events.list.");
  else ok("timestamps only — no titles, attendees, or codes");

  const acao = res.headers.get("access-control-allow-origin");
  if (!acao) bad("no access-control-allow-origin header",
    "The browser will block this. Set ALLOWED_ORIGIN in wrangler.toml, redeploy.");
  else if (acao === "*" || acao === ORIGIN) ok(`CORS allows ${ORIGIN}`);
  else bad(`CORS allows "${acao}" but the page will load from "${ORIGIN}"`,
    `Set ALLOWED_ORIGIN = "${ORIGIN}" in wrangler.toml and redeploy.`);

  // Preflight, which the browser sends before a cross-origin GET with headers.
  try {
    const pre = await fetch(url, { method: "OPTIONS", headers: { origin: ORIGIN } });
    if (pre.status === 204 || pre.status === 200) ok("OPTIONS preflight answered");
    else bad(`OPTIONS returned ${pre.status}, expected 204`);
  } catch { bad("OPTIONS preflight failed"); }

  console.log("-".repeat(52));
  console.log(`\n  ${j.busy.length} busy range(s) in the next 7 days\n`);
  const f = (s) => new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(s));
  j.busy.slice(0, 10).forEach((b) => console.log(`    ${f(b.start)}  ->  ${f(b.end)}`));
  if (j.busy.length > 10) console.log(`    ... and ${j.busy.length - 10} more`);

  if (j.busy.length === 0) {
    console.log(`\n  ${r("Zero busy ranges.")} If your week isn't actually empty:`);
    console.log("    - events may be marked Free rather than Busy");
    console.log("    - sessions may live on a calendar not listed in CALENDAR_ID");
  }

  console.log(failed
    ? `\n  ${r(failed + " check(s) failed")} — fix before pointing the page at this.\n`
    : `\n  ${g("Worker is good.")} Put this in index.html:\n\n    apiBase: "${BASE}",\n`);
  process.exit(failed ? 1 : 0);
})();
