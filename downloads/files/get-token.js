#!/usr/bin/env node
/**
 * get-token.js — get a Google refresh token without the OAuth Playground.
 *
 *   GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...' node dev/get-token.js
 *
 * Runs a one-shot local server, walks you through consent in the browser, and
 * prints the refresh token — just the one value, clearly labelled, so there is
 * nothing to pick wrong.
 *
 * It forces access_type=offline and prompt=consent, which is what actually
 * guarantees Google issues a refresh token. The Playground's "Online" setting
 * silently issues none, which is the usual reason this step fails twice.
 *
 * BEFORE RUNNING: add this exact redirect URI to your OAuth client in
 * Google Cloud Console -> Credentials -> your Web application client:
 *
 *     http://localhost:8910
 *
 * Requires Node 18+.
 */

const http = require("http");
const crypto = require("crypto");

const ID = process.env.GOOGLE_CLIENT_ID;
const SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 8910);
const REDIRECT = `http://localhost:${PORT}`;

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

if (!ID || !SECRET) {
  console.log(`\n${r("Set your client ID and secret first:")}\n`);
  console.log(dim("  GOOGLE_CLIENT_ID='...apps.googleusercontent.com' \\"));
  console.log(dim("  GOOGLE_CLIENT_SECRET='GOCSPX-...' \\"));
  console.log(dim("  node dev/get-token.js\n"));
  process.exit(1);
}
if (!/\.apps\.googleusercontent\.com$/.test(ID)) {
  console.log(`\n${r("That client ID looks wrong")} — it should end .apps.googleusercontent.com\n`);
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",   // without this, no refresh token, ever
    prompt: "consent",        // forces a new one even if you authorised before
    state,
  });

const page = (title, body, colour) => `<!DOCTYPE html><meta charset="utf-8">
<title>${title}</title><body style="font-family:system-ui;background:#F2F3ED;color:#1C1E1A;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="max-width:460px;padding:32px;background:#fff;border-radius:12px;
border-left:4px solid ${colour}">
<h2 style="margin:0 0 10px;font-size:18px">${title}</h2>
<p style="margin:0;font-size:14px;line-height:1.6;color:#5D6257">${body}</p></div>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/") { res.writeHead(404).end(); return; }

  const err = u.searchParams.get("error");
  const code = u.searchParams.get("code");

  if (err) {
    res.writeHead(200, { "content-type": "text/html" })
       .end(page("Authorisation declined", "Nothing was changed. You can close this tab.", "#9C4A3C"));
    console.log(`\n  ${r("Declined at the consent screen: " + err)}\n`);
    server.close(); process.exit(1);
  }
  if (!code) { res.writeHead(400).end("no code"); return; }
  if (u.searchParams.get("state") !== state) {
    res.writeHead(400).end("state mismatch");
    console.log(`\n  ${r("State mismatch — ignoring this response.")}\n`);
    return;
  }

  try {
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: ID, client_secret: SECRET,
        redirect_uri: REDIRECT, grant_type: "authorization_code",
      }),
    });
    const j = await tr.json();

    if (!tr.ok) {
      res.writeHead(200, { "content-type": "text/html" })
         .end(page("Exchange failed", "Check the terminal for details.", "#9C4A3C"));
      console.log(`\n  ${r("Token exchange failed: " + (j.error_description || j.error))}`);
      if (j.error === "redirect_uri_mismatch")
        console.log(dim(`\n  Add exactly this to your OAuth client's redirect URIs:\n    ${REDIRECT}\n`));
      server.close(); process.exit(1);
    }

    if (!j.refresh_token) {
      res.writeHead(200, { "content-type": "text/html" })
         .end(page("No refresh token", "Check the terminal.", "#9C4A3C"));
      console.log(`\n  ${r("Google returned no refresh token.")}`);
      console.log(dim("  Revoke this app at https://myaccount.google.com/permissions"));
      console.log(dim("  and run this again.\n"));
      server.close(); process.exit(1);
    }

    res.writeHead(200, { "content-type": "text/html" })
       .end(page("Done", "Your refresh token is in the terminal. You can close this tab.", "#839A79"));

    const scopes = (j.scope || "").split(" ").filter(Boolean);
    const need = SCOPES.filter((s) => !scopes.includes(s) &&
                 !scopes.includes("https://www.googleapis.com/auth/calendar"));

    console.log("\n" + "=".repeat(62));
    console.log(b("  REFRESH TOKEN — this is the value you want"));
    console.log("=".repeat(62) + "\n");
    console.log("  " + g(j.refresh_token) + "\n");
    console.log("=".repeat(62));
    console.log(dim("\n  Starts 1// as expected: " + (j.refresh_token.startsWith("1//") ? "yes" : "NO — unexpected")));
    if (need.length) console.log(r("  Missing scopes: " + need.join(", ")));
    else console.log(dim("  Both calendar scopes granted."));
    console.log(dim("\n  Verify it:\n"));
    console.log(dim("    GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...' \\"));
    console.log(dim("    GOOGLE_REFRESH_TOKEN='<paste above>' \\"));
    console.log(dim("    node ~/bookshawn/dev/check-google.js\n"));
    server.close(); process.exit(0);
  } catch (e) {
    console.log(`\n  ${r("Error: " + e.message)}\n`);
    server.close(); process.exit(1);
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`\n  ${r("Port " + PORT + " is busy.")} Try:  PORT=8911 node dev/get-token.js`);
    console.log(dim("  Remember to add http://localhost:8911 as a redirect URI too.\n"));
  } else console.log(`\n  ${r(e.message)}\n`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n" + "-".repeat(62));
  console.log(b("  First, in Google Cloud Console"));
  console.log("-".repeat(62));
  console.log("\n  Credentials -> your Web application OAuth client ->");
  console.log("  Authorized redirect URIs -> ADD:\n");
  console.log("      " + g(REDIRECT) + "\n");
  console.log(dim("  Save, then wait a few seconds for Google to propagate it.\n"));
  console.log("-".repeat(62));
  console.log(b("  Then open this URL and authorise as shawn@agoodplacetherapy.com"));
  console.log("-".repeat(62) + "\n");
  console.log(authUrl + "\n");
  console.log(dim("  Waiting for you to finish in the browser... (Ctrl-C to cancel)\n"));
});
