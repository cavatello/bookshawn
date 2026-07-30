# Next steps — credentials in hand to live site

You've finished sections 1 and 2 of `SETUP.md`, so you're holding three values:

```
GOOGLE_CLIENT_ID       ...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET   GOCSPX-...
GOOGLE_REFRESH_TOKEN   1//0g...
```

Six steps below, each ending in a checkpoint. **If a checkpoint doesn't match,
stop there** — going on just makes the failure harder to locate. Paste me the
output and we'll fix it.

Nothing below asks you to send me a credential. They go into your terminal only.

---

## Step 0 — Prerequisites

```bash
node --version          # need v18 or higher
git --version
```

`node` under 18 has no built-in `fetch` and both checkers will fail. Install from
nodejs.org if needed.

You also need a **free Cloudflare account**. If you don't have one, sign up at
<https://dash.cloudflare.com/sign-up> now — no card required, and the Workers free
tier is 100,000 requests/day against your likely handful.

Get the repo onto your machine. Open **Terminal** (Cmd+Space, type "terminal"):

```bash
cd ~
git clone https://github.com/cavatello/bookshawn.git
```

That creates `/Users/YOURNAME/bookshawn`. Two locations now matter and they are
different places:

| | Where |
|---|---|
| The repo | `~/bookshawn` — where you just cloned |
| The downloads | `~/Downloads` — where Safari/Chrome put my files |

The files need to move from the second into the first. Download
**`place-files.sh`** along with the rest and let it do it:

```bash
bash ~/Downloads/place-files.sh
```

It finds the repo, copies all ten files into the right subdirectories, deletes the
`test` placeholder, and prints the resulting layout. It handles the case where you
re-downloaded something and your browser saved it as `index (1).html` — it takes
the newest of each and tells you when it did.

Re-running it is safe. If it can't find the repo, pass the path:

```bash
bash ~/Downloads/place-files.sh /path/to/bookshawn
```

To do it by hand instead:

```bash
cd ~/bookshawn
mkdir -p worker dev
cp ~/Downloads/index.html ~/Downloads/SETUP.md ~/Downloads/NEXT-STEPS.md .
cp ~/Downloads/worker.js ~/Downloads/wrangler.toml worker/
cp ~/Downloads/serve.js ~/Downloads/test-cal.js \
   ~/Downloads/check-google.js ~/Downloads/check-worker.js dev/
rm -f test
```

**Checkpoint 0**

```bash
cd ~/bookshawn && ls index.html worker/worker.js worker/wrangler.toml dev/check-google.js
```

All four listed, no "No such file". To see the folder in Finder:

```bash
open ~/bookshawn
```

---

## Step 1 — Test the credentials before Cloudflare

This is the step that saves you an hour. It proves the Google half works while
there's still only one thing that can be wrong.

From the repo root. **Leading space on each line** keeps them out of shell history:

```bash
  GOOGLE_CLIENT_ID='...apps.googleusercontent.com' \
  GOOGLE_CLIENT_SECRET='GOCSPX-...' \
  GOOGLE_REFRESH_TOKEN='1//0g...' \
  node dev/check-google.js
```

**Checkpoint 1** — six PASS lines, then your real busy blocks:

```
  PASS  all three values are present
  PASS  client ID looks like a Google OAuth client ID
  PASS  refresh token has the expected shape
  PASS  token exchange succeeded (expires in 3599s)
  PASS  both calendar scopes granted
  PASS  read shawn@agoodplacetherapy.com
  PASS  response contains timestamps only, no titles or attendees

  14 busy range(s) in the next 7 days
    Thu, Jul 30, 8:00 AM  ->  Thu, Jul 30, 9:00 AM
    ...
```

Compare those ranges against Google Calendar. They should match.

Two ways this goes wrong, both worth catching now:

- **`invalid_grant`** — the consent screen is External and sitting in "Testing", so
  the token already expired. Set User Type to **Internal** and re-issue.
- **Zero busy ranges when your week isn't empty** — events marked Free rather than
  Busy, or sessions on a calendar other than your primary. Don't deploy yet.

---

## Step 2 — Deploy the Worker

```bash
cd worker
npx wrangler login
```

A browser opens; authorise. Then:

```bash
npx wrangler deploy
```

First deploy on a new account asks you to pick a `workers.dev` subdomain — any
name. **Copy the URL it prints.** It looks like:

```
https://agp-cal.YOURNAME.workers.dev
```

Now add the secrets. Deploy came first so the Worker already exists and these
won't stop to ask about creating it:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

Each prompts on a hidden line — paste, press enter. They take effect immediately;
no redeploy needed.

**Checkpoint 2**

```bash
npx wrangler secret list
```

Three entries: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.
Values are never shown — that's correct, not a problem.

---

## Step 3 — Verify the deployed Worker

Back at the repo root:

```bash
cd ..
node dev/check-worker.js https://agp-cal.YOURNAME.workers.dev
```

**Checkpoint 3** — six PASS lines and the same busy ranges you saw in step 1:

```
  PASS  reachable (HTTP 200)
  PASS  response has the expected shape
  PASS  timeZone is America/Los_Angeles
  PASS  timestamps only — no titles, attendees, or codes
  PASS  CORS allows https://cavatello.github.io
  PASS  OPTIONS preflight answered
```

If step 1 passed and this fails, the problem is the deploy, not Google — usually a
secret pasted with a trailing space or newline. Re-run that one `secret put`.

To watch requests live while poking at it: `cd worker && npx wrangler tail`.

---

## Step 4 — Point the page at the Worker

One line in `index.html`, near the top of the `CONFIG` block:

```js
apiBase: "https://agp-cal.YOURNAME.workers.dev",
```

No trailing slash. While you're there, if you have a main site:

```js
siteUrl: "https://www.agoodplacetherapy.com",
```

Leave it `""` and the "Back to site" link stays hidden.

**Checkpoint 4** — test locally before pushing:

```bash
cd dev && node serve.js
```

Open <http://localhost:8099>. You want the green banner reading **"Live from my
calendar — checked …"**, and days matching your real availability.

Amber banner saying booking isn't switched on means `apiBase` didn't take — check
for a typo or a missing comma. Then `Ctrl-C`.

---

## Step 5 — Publish

```bash
cd ..
git add -A
git commit -m "Booking page wired to Google Calendar"
git push
```

On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` → `/ (root)`
→ Save.** First build takes a minute or two.

**Checkpoint 5**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://cavatello.github.io/bookshawn/
```

`200`. A `404` means Pages hasn't finished, or the source branch is wrong.

---

## Step 6 — Confirm it's real

Open <https://cavatello.github.io/bookshawn/> and check three things:

1. Green **"Live from my calendar"** banner, not amber.
2. Pick a day you know is busy — the booked hours should be **absent**.
3. Open Google, create a test event over a slot the page is offering, wait ~90
   seconds, and watch that slot disappear. Delete the event; it comes back.

That third one is the real proof. Once it passes, you're live.

---

## Before you share the link

`SETUP.md` has a section called **"Read this before you take real bookings"** — the
short version is that showing availability moves no personal data, but the booking
*form* collects a name and email under "book a therapy session," which is health
information. Cloudflare doesn't sign a BAA on free plans.

The page is safe to publish today. Read that section before you point clients at
the form.

---

## If you get stuck

Send me:

- which checkpoint failed
- the full output of the checker that failed
- for a Worker problem, output of `cd worker && npx wrangler tail` while you curl it

Both checkers print diagnostics, never secrets, so the output is safe to paste.
