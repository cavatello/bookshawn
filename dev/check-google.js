#!/usr/bin/env node
/**
 * check-google.js — validate your Google credentials locally, before Cloudflare.
 *
 * Run it from the repo root:
 *
 *   GOOGLE_CLIENT_ID='...' \
 *   GOOGLE_CLIENT_SECRET='...' \
 *   GOOGLE_REFRESH_TOKEN='...' \
 *   node dev/check-google.js
 *
 * Reads from the environment so nothing is typed into a chat window or saved
 * into a file. Prefix each line with a space and most shells keep it out of
 * history too. Nothing is written to disk, and only timestamps are printed.
 *
 * Requires Node 18+ (for built-in fetch).
 */

const CALENDAR_ID = process.env.CALENDAR_ID || "shawn@agoodplacetherapy.com";
const TZ = process.env.PRACTICE_TZ || "America/Los_Angeles";

const ID = process.env.GOOGLE_CLIENT_ID;
const SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH = process.env.GOOGLE_REFRESH_TOKEN;

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (m) => console.log(`  ${g("PASS")}  ${m}`);
const bad = (m, fix) => {
  console.log(`  ${r("FAIL")}  ${m}`);
  if (fix) console.log(dim(fix.split("\n").map((l) => "        " + l).join("\n")));
};

function missing() {
  const gaps = [];
  if (!ID) gaps.push("GOOGLE_CLIENT_ID");
  if (!SECRET) gaps.push("GOOGLE_CLIENT_SECRET");
  if (!REFRESH) gaps.push("GOOGLE_REFRESH_TOKEN");
  return gaps;
}

(async () => {
  console.log("\nChecking Google credentials\n" + "-".repeat(48));

  const gaps = missing();
  if (gaps.length) {
    bad(`not set: ${gaps.join(", ")}`,
      "Set them on the command line, for example:\n" +
      "  GOOGLE_CLIENT_ID='123-abc.apps.googleusercontent.com' \\\n" +
      "  GOOGLE_CLIENT_SECRET='GOCSPX-...' \\\n" +
      "  GOOGLE_REFRESH_TOKEN='1//0g...' \\\n" +
      "  node dev/check-google.js");
    process.exit(1);
  }
  ok("all three values are present");

  // Shape checks catch the most common paste errors without revealing anything.
  if (!/\.apps\.googleusercontent\.com$/.test(ID))
    bad("client ID doesn't end in .apps.googleusercontent.com — likely the wrong field");
  else ok("client ID looks like a Google OAuth client ID");

  if (!REFRESH.startsWith("1//"))
    bad("refresh token doesn't start with 1// — you may have copied the ACCESS token",
      "In the OAuth Playground, the access token starts 'ya29.' and expires in an hour.\n" +
      "You want the refresh token, which starts '1//' and does not expire.");
  else ok("refresh token has the expected shape");

  // 1. Exchange refresh token for an access token.
  let token;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ID, client_secret: SECRET,
        refresh_token: REFRESH, grant_type: "refresh_token",
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      const e = j.error || "";
      const hints = {
        invalid_grant:
          "The refresh token is expired, revoked, or from a different client.\n" +
          "Most common cause: the OAuth consent screen is set to External and left\n" +
          "in 'Testing', which expires refresh tokens after 7 days. Set User Type to\n" +
          "Internal (your Workspace domain allows it), then re-issue the token.",
        invalid_client:
          "Client ID and secret don't match, or the secret was regenerated.\n" +
          "Copy both again from the same OAuth client in Google Cloud Console.",
        unauthorized_client:
          "This client isn't allowed the refresh_token grant. Confirm you created a\n" +
          "'Web application' OAuth client, not a Desktop or Service Account one.",
      };
      bad(`token exchange rejected: ${e} — ${j.error_description || "no detail"}`, hints[e]);
      process.exit(1);
    }
    token = j.access_token;
    ok(`token exchange succeeded (expires in ${j.expires_in}s)`);
    const scopes = (j.scope || "").split(" ").filter(Boolean);
    const need = ["https://www.googleapis.com/auth/calendar.readonly",
                  "https://www.googleapis.com/auth/calendar.events"];
    const have = need.filter((s) => scopes.includes(s) ||
                  scopes.includes("https://www.googleapis.com/auth/calendar"));
    if (have.length === 2) ok("both calendar scopes granted");
    else bad(`only ${have.length}/2 calendar scopes granted`,
      "Re-run the OAuth Playground with BOTH scopes pasted into the custom box:\n" +
      need.join("\n"));
  } catch (err) {
    bad("could not reach oauth2.googleapis.com: " + err.message);
    process.exit(1);
  }

  // 2. Read free/busy for the next 7 days.
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 86400000);
  let busy;
  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        timeMin: now.toISOString(), timeMax: end.toISOString(),
        timeZone: TZ, items: [{ id: CALENDAR_ID }],
      }),
    });
    const j = await res.json();
    if (!res.ok) {
      bad(`freeBusy failed: ${j.error?.message || res.status}`);
      process.exit(1);
    }
    const cal = j.calendars?.[CALENDAR_ID];
    if (!cal) {
      bad(`no results for ${CALENDAR_ID}`,
        "The calendar ID doesn't match any calendar this account can see.\n" +
        "Check spelling, or use the ID from Calendar settings > Integrate calendar.");
      process.exit(1);
    }
    if (cal.errors?.length) {
      const reason = cal.errors[0].reason;
      bad(`calendar error: ${reason}`,
        reason === "notFound"
          ? "That calendar ID doesn't exist for this account."
          : "The authorised account can't read this calendar. Share it with them,\n" +
            "or authorise as the account that owns it.");
      process.exit(1);
    }
    busy = cal.busy || [];
    ok(`read ${CALENDAR_ID}`);
  } catch (err) {
    bad("could not reach the Calendar API: " + err.message);
    process.exit(1);
  }

  // 3. Confirm the response carries no event detail.
  const leaked = JSON.stringify(busy).match(/summary|description|attendee|location/i);
  if (leaked) bad("response contained event detail — stop and investigate");
  else ok("response contains timestamps only, no titles or attendees");

  console.log("-".repeat(48));
  console.log(`\n  ${busy.length} busy range(s) in the next 7 days\n`);
  const f = (s) => new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(s));
  busy.slice(0, 12).forEach((b) => console.log(`    ${f(b.start)}  ->  ${f(b.end)}`));
  if (busy.length > 12) console.log(`    ... and ${busy.length - 12} more`);

  if (busy.length === 0) {
    console.log("\n  " + r("Zero busy ranges is suspicious.") + " If your week isn't actually");
    console.log("  empty, the likely causes are:");
    console.log("    - events marked Free rather than Busy");
    console.log("    - sessions living on a different calendar than " + CALENDAR_ID);
    console.log("  Both are covered in SETUP.md under 'Two things that break this silently'.");
  } else {
    console.log("\n  " + g("Google side is working.") + " Compare the ranges above against");
    console.log("  your calendar. If they match, deploy the Worker with the same three values.");
  }
  console.log();
})();
