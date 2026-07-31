# bookshawn — setup

**Until you finish steps 1–4, this page will not offer any times.** That's
deliberate. Without a verified read of your calendar, the weekly template alone
would advertise hours that are already booked — a Tuesday whose template says
2pm–9pm looks like seven openings even when six of them have clients in them.
Rather than show times with a caveat nobody reads, the page hides the picker and
shows an email link instead. `requireLiveCalendar: false` in `CONFIG` turns that
off, but don't.

## Where the files go

The downloads arrive flat. This is the layout to create in `cavatello/bookshawn`:

```
bookshawn/
├── index.html          the booking page  ->  cavatello.github.io/bookshawn/
├── weekview/
│   └── index.html      your two-week planner  ->  /bookshawn/weekview/
├── SETUP.md            this file (reference)
├── NEXT-STEPS.md       follow this one, top to bottom
├── worker/
│   ├── worker.js       deploys to Cloudflare, NOT served by Pages
│   └── wrangler.toml
└── dev/
    ├── watch.js          save a file and it ships (see below)
    ├── serve.js          local test harness
    ├── test-cal.js       94 assertions (booking page)
    ├── test-weekview.js  42 assertions (two-week planner)
    ├── test-devices.js   159 checks across 11 viewports
    ├── get-token.js      issues a Google refresh token
    ├── check-google.js   validates your Google credentials
    ├── check-worker.js   validates the deployed Worker
    ├── check-booking.js  books a real slot end to end
    └── place-files.sh    one-time: moves downloads into this layout
```

Only `index.html` is ever served to visitors. The rest sits in the repo for
reference — and yes, a public repo means anyone can read `worker/`. That's fine:
**no secret is in any of these files.** The three credentials live only in
Cloudflare, set via `wrangler secret put`. If a file in this repo ever contains a
token, something has gone wrong.

You can delete the placeholder `test` file from your first commit.

To set it up:

```bash
git clone https://github.com/cavatello/bookshawn.git
cd bookshawn
git rm test
mkdir -p worker dev
# copy the downloads into place:
#   index.html SETUP.md -> ./
#   worker.js wrangler.toml -> worker/
#   serve.js test-cal.js -> dev/
git add -A && git commit -m "Booking page" && git push
```

Then Settings -> Pages -> Source: Deploy from a branch, `main`, `/ (root)`.

Everything below is what turns the page live. Until then it commits and renders
fine, but shows the email fallback rather than bookable times.

---

## Why there has to be a Worker

GitHub Pages serves static files. There is nowhere to keep a Google credential
that visitors can't read. The two shortcuts both fail:

- **Sign-in in the browser** authenticates *the visitor*, not you. Wrong calendar.
- **A public ICS feed** ships every event title. Yours read `JK - 90837 In Person
  Therapy Session` and `DM - 90791`. That is client initials plus a diagnosis-adjacent
  billing code, published to anyone with the URL. Don't.

The Worker is ~120 lines and free at this volume. It holds the credential and
returns **only start/end pairs** — no titles, no attendees, no codes. Your `BLOCK`
events come back as anonymous busy ranges, which is exactly what the page needs.

---

## 1. Google Cloud — OAuth client

1. <https://console.cloud.google.com> → new project, e.g. `agp-calendar`.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **OAuth consent screen** → User Type: **Internal**.
   Internal is available because `agoodplacetherapy.com` is a Workspace domain, and
   it matters a lot: External apps left in "Testing" get refresh tokens that **expire
   after 7 days**, so your booking page would silently go dark every week. Internal
   tokens don't expire.
4. **Credentials → Create credentials → OAuth client ID** → **Web application**.
   Under *Authorized redirect URIs* add:
   ```
   https://developers.google.com/oauthplayground
   ```
5. Save the **Client ID** and **Client secret**.

## 2. Get a refresh token (once)

1. <https://developers.google.com/oauthplayground>
2. Gear icon (top right) → tick **Use your own OAuth credentials** → paste ID + secret.
3. In *Step 1*, paste both scopes into the "Input your own scopes" box:
   ```
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.events
   ```
   `calendar.readonly` covers free/busy; `calendar.events` lets the Worker write holds.
   Neither grants access to anything outside Calendar.
4. Authorize as **shawn@agoodplacetherapy.com**.
5. *Step 2* → **Exchange authorization code for tokens** → copy the **refresh token**.

Treat that string like a password. It is standing access to your calendar.

## 3a. Test the credentials locally first

Do this before Cloudflare exists. It isolates "are my Google credentials right"
from "is my Worker deployed right", so a failure points at one thing instead of
three. Needs Node 18+.

From the repo root, with a **leading space** on each line so your shell keeps them
out of history:

```bash
  GOOGLE_CLIENT_ID='...apps.googleusercontent.com' \
  GOOGLE_CLIENT_SECRET='GOCSPX-...' \
  GOOGLE_REFRESH_TOKEN='1//0g...' \
  node dev/check-google.js
```

It reads from the environment, writes nothing to disk, and prints only timestamps.
A good run ends with a list of your actual busy blocks for the next 7 days —
compare them against your calendar before going further.

Two shape checks it does up front, because they're the usual paste errors:
- the client ID must end `.apps.googleusercontent.com`
- the refresh token starts `1//`. If yours starts `ya29.` you copied the **access**
  token, which expires in an hour.

**If it reports zero busy ranges and your week isn't empty**, don't deploy yet —
you have one of the two silent failures below (events marked Free, or sessions on
a calendar you didn't list).

## 3b. Deploy the Worker

Deploy first, then add secrets. In that order the Worker already exists, so
`secret put` won't stop to ask whether to create it.

```bash
cd worker
npx wrangler login          # opens a browser; free Cloudflare account is fine
npx wrangler deploy         # prints your URL
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

Secrets take effect immediately — no redeploy needed. Each `secret put` prompts
for the value on a hidden line; paste and press enter.

You'll get a URL like `https://agp-cal.<your-subdomain>.workers.dev`. Check it:

```bash
curl "https://agp-cal.<sub>.workers.dev/freebusy?start=2026-08-01T00:00:00Z&end=2026-08-08T00:00:00Z"
```

Expected: `{"timeZone":"America/Los_Angeles","busy":[{"start":"…","end":"…"}],…}` —
timestamps only. If you see event titles, stop; something is wrong.

### If the curl returns an error

The Worker names the stage that failed, so the message tells you where to look.

| Message contains | Meaning | Fix |
|---|---|---|
| `Google auth failed: invalid_grant` | refresh token dead | Consent screen is External + Testing → tokens die after 7 days. Set User Type to Internal, re-issue. |
| `Google auth failed: invalid_client` | ID/secret mismatch | Re-copy both from the same OAuth client. |
| `Cannot read calendar` | wrong ID, or no access | Check `CALENDAR_ID` in `wrangler.toml`. |
| `Calendar read failed: 403` | Calendar API not enabled | Enable it in the Cloud console for this project. |
| `Not found` | wrong path | It's `/freebusy`, lowercase, no trailing slash. |
| nothing at all / connection error | not deployed | `npx wrangler deployments list` |

To watch requests live while you test: `npx wrangler tail` in the `worker/`
directory, then hit the URL in another terminal.

## 4. Point the page at it

In `index.html`, one line:

```js
apiBase: "https://agp-cal.<your-subdomain>.workers.dev",
```

Commit, push. Settings -> Pages -> Deploy from branch `main` / root.
Serves at `https://cavatello.github.io/bookshawn/`.

If you later point a custom domain at it, update `ALLOWED_ORIGIN` in
`wrangler.toml` to match and redeploy the Worker, or the browser will block the
calendar request on CORS.

---

## Two things that break this silently

Both fail *open* — the page shows time as available that isn't. Check them before
you trust it.

**1. Events marked "Free" are invisible to free/busy.**

Google's busy calculation honours each event's Busy/Free setting. An event marked
Free returns nothing at all — the Worker can't see it, so the page offers the slot.

Open one of your red `BLOCK` events → the Busy/Free dropdown → confirm it says
**Busy**. Same for anything your EHR creates. This is the single most likely cause
of "it offered a time I was clearly booked."

**1b. All-day events are the special case of the above.**

Timed events in Google default to Busy. **All-day events default to Free.** So the
obvious way to block a vacation — create an all-day "Away" event spanning the week —
does nothing at all. The page will keep offering that entire week.

When you block a day or a stretch of days, either:
- create a *timed* event covering the hours (7am–9pm is plenty), or
- create the all-day event and change its Busy/Free dropdown to **Busy**.

Verify with the curl below before you leave. This is the one worth actually testing
rather than trusting.

**2. Sessions on a calendar you didn't list.**

Free/busy only looks at the calendars you name. Your sidebar shows *AGP Shawn
Walters*, *Birthdays*, *Tasks*, and *Holidays in United States*. If Ensora syncs
sessions onto its own calendar rather than your primary, the primary looks empty.

`CALENDAR_ID` takes a comma-separated list, and the Worker merges busy ranges
across all of them:

```toml
CALENDAR_ID = "shawn@agoodplacetherapy.com,abc123@group.calendar.google.com"
```

Get a secondary calendar's ID from its settings page ("Integrate calendar" →
Calendar ID). Don't add Birthdays or Holidays unless you actually want US holidays
blocking your bookings.

A calendar the Worker can't read is treated as a **hard error**, not an empty
result — you'll get a 502 and the page will show its "couldn't reach my calendar"
banner. That's deliberate: degrading to "nothing is busy" would mark your whole
week open.

**Verify both at once** — count what comes back for a week you know is busy:

```bash
curl -s "https://agp-cal.<sub>.workers.dev/freebusy?start=2026-08-03T00:00:00Z&end=2026-08-10T00:00:00Z" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['busy']),'busy ranges'); [print(' ',b['start'],'→',b['end']) for b in d['busy'][:10]]"
```

If that count is obviously lower than the number of blocks on your calendar for
that week, one of the two problems above is why.

---

## What you maintain, and what maintains itself

There are exactly two layers, and only one of them is your job.

| | Weekly template | Google Calendar |
|---|---|---|
| Lives in | `index.html` + `worker.js` | Google |
| Holds | 9 recurring time windows | every appointment and block |
| Changes when | your working pattern changes | constantly |
| Updated by | editing code | you, normally, in Calendar |
| Cadence | ~twice a year | re-read every 90 seconds |

**No appointment is ever stored in the code.** Nothing needs a daily refresh, and
no screenshot of your week needs re-sending. The page asks Google what's busy each
time it loads, subtracts that from your template, and offers what's left.

### Blocking time

Put it in Google Calendar. That's the entire procedure — there is no second place
to update, no deploy, no rebuild.

| You want to | Do this |
|---|---|
| Block a single hour | Create an event. Gone within 90 seconds. |
| Block an afternoon | Create an event covering it. |
| Take a vacation week | Timed event across the days — see the all-day warning above. |
| Free up time you'd blocked | Delete the event. It reappears. |
| Stop bookings entirely | Delete `apiBase`, or push a `BLOCK` across the horizon. |

### Changing the template

Only when the *pattern* changes — you drop Tuesday evenings, add Monday afternoons,
move the office hours. That's a code edit in two files (`AVAILABILITY` in both
`index.html` and `worker.js`), so it's the one thing worth sending my way.

Everything short of that — a client reschedules, you add a supervision block, you
take Friday off — is just Google Calendar, and the page follows on its own.

---

## Editing your hours

`AVAILABILITY` appears in **both** `index.html` and `worker.js`. Change both.

The duplication is deliberate: the browser copy draws the UI, the Worker copy is
the authority. Without the server-side check, someone could edit the page in
devtools and POST a 3am booking.

```js
{ day: 3, start: "07:00", end: "14:00" }   // day: 0=Sun … 6=Sat, practice-local
```

Currently loaded from your screenshots:

| | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| **Virtual** | 8–9a | 8–9a, 11a–1p | 3–6p | — | 8–9a |
| **In person** | — | 2–9p | 7a–2p | 7a–2p | 2–8p |

8 virtual hours/week, 27 in-person.

Other knobs in `CONFIG`:

| Key | Now | Does |
|---|---|---|
| `sessionMins` | 53 | session length |
| `bufferMins` | 7 | gap kept clear after each session |
| `slotEveryMins` | 60 | start times land on the hour |
| `minNoticeHrs` | 24 | nothing bookable sooner than this |
| `horizonDays` | 28 | how far out to offer |
| `refreshSecs` | 90 | re-poll while the page is open |

`sessionMins` also lives in `worker.js` as `SESSION_MINUTES`.

---

## Read this before you take real bookings

**The page is safe. The booking form is the part that needs a decision.**

Displaying availability moves no personal data — the Worker only handles
timestamps. But the moment someone types a name and email into a form headed
"book a therapy session," that submission is health information: it identifies a
person and reveals they're seeking treatment.

Right now the Worker writes that into your Google Calendar. Google Workspace is a
HIPAA-covered service **if you've signed the BAA** (Admin console → Account →
Legal & Compliance). Cloudflare, however, does not sign a BAA on free or Pro
plans, and the request passes through it.

Three ways to close that:

1. **Show availability here, book elsewhere.** Delete the form; link each slot to
   Google Calendar Appointment Schedules or your EHR's portal. The Worker keeps
   doing free/busy only, and no PHI ever touches Cloudflare. Least work, cleanest.
2. **Keep the form, name it honestly.** Treat it as a first-contact request, not
   scheduling — first name and email only, no clinical detail, no intake questions.
   The page already says this, and the Worker writes `HOLD —` events you confirm by
   hand. Lower risk, not zero.
3. **Move the Worker somewhere with a BAA.** Google Cloud Run signs one and is
   covered under the same Workspace BAA. `worker.js` is small; porting it is an
   afternoon.

I'd take (1) unless you specifically want booking to finish on your own site.

**Worth knowing before you build further:** Google Calendar Appointment Schedules
is included in your Workspace and already does 53-minute slots, buffers, booking
pages, confirmations, and reminders — under your existing BAA, with no code. If
what you want is *bookings*, use it and embed it. If what you want is *this page's
look and feel with your real availability on it*, that's what you now have. The
two combine well: this page as the front door, Appointment Schedules as the
checkout.

---

## Operational notes

- **Cache.** Free/busy is cached 60s at Cloudflare's edge. A booking made in Google
  can take up to a minute to disappear here. Lower `max-age` in `handleFreeBusy` if
  that bothers you; you'll still be far under quota.
- **Double-booking.** The Worker re-checks the live calendar immediately before
  writing, so two people clicking the same slot seconds apart can't both get it.
  The second sees "that time was just taken."
- **Timezones.** Slots are computed as real UTC instants from practice-local wall
  clock, so DST transitions are handled — a 2am spring-forward Sunday won't produce
  a phantom slot. Visitors see their own timezone with your Pacific time shown
  underneath. Verified against a New York viewer in the test suite.
- **Blocked time.** Your red `BLOCK` events are just busy ranges to free/busy, so
  they remove slots exactly like sessions do. Nothing to configure.
- **`noindex`** is set on the page. Remove the robots meta tag if you want it found
  in search.

## Tests

```bash
cd dev
node serve.js &                     # static + mock Google on :8099
node test-cal.js
```

`serve.js` serves the repo root from inside `dev/`, and `/blank/` returns the
page with `apiBase` emptied so the never-configured path can be tested without
calling the live Worker.

**`test-cal.js` — 90 assertions.** Slot maths against hand-calculated counts,
busy-block subtraction, the 24-hour notice floor, cross-timezone rendering,
fail-closed behaviour when the calendar is unreachable, the booking POST shape,
the confirmation panel, generated Google/Outlook/`.ics` links including a parsed
53-minute duration, and the arrival panel appearing for in-person but not virtual.
Also pins your AMFT number, supervisor and employer — those will fail when you get
licensed, which is deliberate.

**`test-devices.js` — 159 checks across 11 viewports.** iPhone SE through 1920px
wide, plus landscape and a 320px floor. Each runs the full booking flow and checks
for horizontal overflow, elements past the viewport edge, overlapping controls,
44px tap targets on touch, 16px inputs (Safari zooms the page below that), and
text under 11px.

---

## Refresh cadence, precisely

| When | What happens |
|---|---|
| Page load | Full fetch of the next 28 days |
| Every 90s while open | Re-fetch; slots appear/disappear without a reload |
| Edge cache | 60s at Cloudflare, so worst-case staleness is ~150s |
| At the moment of booking | Fresh re-check of that exact slot before writing |

That last row is the one that matters. Even if someone is looking at a 2-minute-old
page, the Worker re-queries Google immediately before creating the hold. Two people
clicking the same slot seconds apart cannot both get it — the second sees "that time
was just taken."

To make it snappier: lower `refreshSecs` in `index.html` and `max-age=60` in
`handleFreeBusy`. Google's quota is ~1M queries/day, so even a 10-second cache is
nowhere near it.

---

## Practice details

All of it lives in one place — `CONFIG.practice` in `index.html`. Change it there
and it updates the footer, the browser tab title, and the in-person location note
together.

```js
practice: {
  name:         "A Good Place Therapy",
  clinician:    "Shawn Walters, AMFT #138642",
  pronouns:     "He/Him",
  title:        "Registered Associate Marriage and Family Therapist — California",
  supervisor:   "Supervised by Christina Miller-Martinez, LMFT #105663",
  phone:        "971-514-2190",
  address:      "667 Lytton Ave, Suite 9, Palo Alto, CA 94301",
  addressShort: "667 Lytton Ave, Palo Alto"
}
```

`addressShort` shows next to the in-person toggle so someone knows where they'd be
going before they pick a time. `phone` is turned into a `tel:` link automatically,
so strip or reformat it however you like.

**When you get licensed**, this is the block to update — registration number
becomes a licence number, the supervisor line comes out, and `AMFT` becomes `LMFT`
in `clinician`. Eight assertions in `dev/test-cal.js` currently pin the associate
details; update those at the same time or they'll fail loudly, which is the point.

---

## Day-to-day: dev/watch.js

```bash
cd ~/bookshawn && node dev/watch.js
```

Watches the repo **and** `~/Downloads`. On any change it waits for you to stop
typing, then runs the suite, commits, pushes, redeploys the Worker if `worker/`
changed, and polls Pages until the new build is serving.

Two things it refuses to do:

- **Push when a test fails.** The suite knows the footer must disclose your
  supervisor and employer, that no slots appear without a live calendar, and that
  the weekly template stays unpublished. A bad push is public within a minute.
- **Push anything credential-shaped.** It scans staged additions for Google
  refresh tokens (`1//…`), client secrets (`GOCSPX-…`), access tokens (`ya29.…`),
  private keys, and AWS keys. A hit unstages everything and stops. Auto-push means
  a mistake is public in seconds and git history is hard to scrub.

It also picks up files dropped in `~/Downloads`, handling browser renaming
(`index_9.html`, `index (1).html`, a bare `wrangler`), taking the newest only when
it differs from what's in place. So: click download, and it's live in about a
minute.

| Flag | Effect |
|---|---|
| `--dry` | print what would happen, change nothing |
| `--no-test` | push without running the suite |
| `--no-deploy` | never touch Cloudflare |
| `--delay=N` | seconds of quiet before acting (default 3) |
| `--auto-install` | run an `install.sh` bundle dropped in Downloads |

### About the tests on your machine

The browser suites need Playwright, which isn't installed by default. When it's
missing the watcher says so and publishes anyway:

```
tests skipped — Playwright isn't installed on this machine
```

That's deliberate. Everything in a bundle was run through all 253 checks before
you got it, and Playwright plus Chromium is a ~300MB install to re-run tests that
already passed. The guard that must never be skipped — the credential scan — has
no dependencies and always runs.

To run the full suite locally as well:

```bash
npm install -g playwright && npx playwright install chromium
```

Then `node dev/test-cal.js` and `node dev/test-devices.js` work directly, and the
watcher will run them on every change.

### --auto-install

With this flag, downloading an `install.sh` I've given you is the whole workflow:
the watcher unpacks it, runs the tests, commits, pushes, redeploys the Worker if
`worker/` changed, and waits for Pages to serve it. You don't touch the terminal
after starting the watcher once.

Running a shell script straight out of Downloads is a genuine footgun, so it's
gated twice. The flag is off by default, and the file must contain the line
`# bookshawn-installer` near the top. Anything else named `install.sh` is skipped
with a note. Verified: an unmarked script that tries to touch a file is refused
without executing.

It commits on every save, so history is granular. Run with `--dry` while drafting
and push by hand if you'd rather batch.

---

## Verifying the booking write

`check-worker.js` only proves reading works. To prove the whole booking path,
including the invite email:

```bash
node dev/check-booking.js https://agp-cal.cavatello.workers.dev you@example.com
```

It books a real slot on your real calendar, then tries three things that must be
refused: a time outside your hours, a wrong duration, and a double-book of the
slot it just took. It prints the event link so you can delete it after.

---

## Where the session happens

Two settings in `worker/wrangler.toml` fill the event's Location field, which is
what the client sees in the invite Google emails them.

```toml
OFFICE_ADDRESS   = "667 Lytton Ave, Suite 9, Palo Alto, CA 94301"
VIRTUAL_LOCATION = "meet"
```

`OFFICE_ADDRESS` is used for in-person bookings. It's already public on your site,
so a plain var is fine.

`VIRTUAL_LOCATION` has three modes:

| Value | Behaviour |
|---|---|
| `"meet"` | Google mints a **fresh Meet link for every booking**. Recommended. |
| a URL | used as-is for every virtual session |
| empty | invite says "video link to follow"; you send one yourself |

### Switching from Meet to Zoom

**Don't put a Zoom link in `wrangler.toml`.** That file is committed to a public
repo, and a personal-meeting-room URL is enough for anyone to walk into a session.

Order matters here. Cloudflare's precedence when a var and a secret share a name
isn't something to rely on — `wrangler deploy` can overwrite a secret with a var
of the same name. So remove the var first, deploy, then set the secret:

```bash
cd ~/bookshawn/worker
```

Delete this line from `wrangler.toml`:

```toml
VIRTUAL_LOCATION = "meet"
```

Then:

```bash
npx wrangler deploy
```

```bash
npx wrangler secret put VIRTUAL_LOCATION
```

Paste your Zoom URL at the prompt. It lives only in Cloudflare, same as your
Google credentials, and never enters the repo.

To go back to Meet: `npx wrangler secret delete VIRTUAL_LOCATION`, restore the
var, redeploy.

Google Meet is still the better choice: the link is unique per booking, so there's
no standing URL to leak, and it's already covered by the Workspace BAA you have.
A static Zoom room is one forwarded invite away from being public.

After changing either value:

```bash
cd worker && npx wrangler deploy
```

The confirmation screen and the downloadable `.ics` both use whatever the Worker
resolved, so a Meet link created at booking time appears in all three places —
your calendar, their invite, and the page.

---

## Adding the session to the client's own calendar

The confirmation screen offers three routes, which between them cover every
common setup:

| Button | What it does |
|---|---|
| **Google Calendar** | opens a pre-filled event in Google Calendar on the web |
| **Outlook** | opens a pre-filled event in Outlook on the web |
| **Apple Calendar · .ics** | downloads a standard `.ics` file |

The `.ics` is the catch-all. On iPhone and iPad, opening it hands the event
straight to the Calendar app. On a Mac it opens Apple Calendar. On Windows it
opens desktop Outlook. Thunderbird, Fantastical and everything else read it too.

All three carry the same data: title, start and end, and whatever location the
Worker resolved — your office address, or the Meet/Zoom link created at booking.
The `.ics` is generated in the browser, so nothing extra is sent anywhere.

None of this is required, incidentally. Google already emails them a proper
invitation with Yes/No/Maybe buttons the moment the booking lands. These buttons
are for people who'd rather add it by hand, or who booked from a device that
isn't where their calendar lives.

---

## Directions for in-person bookings

The confirmation screen shows a **Getting here** panel — office address, Google
Maps and Apple Maps buttons, your arrival notes, and a tappable phone number.
It appears only for in-person bookings; virtual ones show a join link instead.

All of it lives in `CONFIG.practice` in `index.html`:

```js
photo:    "",                       // optional, see below
photoAlt: "The red brick building at 667 Lytton Ave",
arrival: [
  "The building is red brick. There's no parking on the premises.",
  "There's no parking on the premises. Street parking is on Byron St, near the Byron and Lytton corner.",
  ...
]
```

Each string becomes a bulleted line. Edit, reorder or add freely.

### Adding a photo

Take a picture of the frontage, save it as `office.jpg` in the repo root, and set:

```js
photo: "office.jpg",
```

A photo of the frontage beats a map tile — what someone needs standing on Lytton
is "red-shingled house, covered porch, 667 above it", not a pin. Keep it under
~300KB.

**Take your own photo.** A Google Street View screenshot is Google's imagery, not
yours, and republishing one on your site isn't covered by fair use or the Maps
terms. Thirty seconds with a phone from the pavement solves it and looks better.

### Why there's no embedded map

An embedded, interactive Google Map needs a Maps JavaScript API key, which means
a billing account and key restrictions to maintain. The keyless embed URL that
used to work now returns a 301 — I tested it. The Maps and Apple Maps buttons
open the native app on a phone and the web map on a desktop, which is what
people do with an address anyway.

---

## weekview — your two-week planner

<https://cavatello.github.io/bookshawn/weekview/>

Not linked from anywhere and marked `noindex`, but it is a public URL — treat it
as unlisted, not private. It shows only free time, never client names, so the
exposure is the same shape as the booking page.

Two Sunday-start weeks, filterable to virtual, in person, or both, with a
copy-paste block at the bottom:

```
Tue, Aug 4
  Virtual: 8:00 AM, 11:00 AM, 12:00 PM
  In person: 2:00 PM, 3:00 PM, 7:00 PM

Wed, Aug 5
  In person: 7:00 AM, 8:00 AM

All times Pacific. Sessions are 53 minutes.
```

With one type selected the headings would repeat on every line, so it collapses
to a flat list and names the type once at the end:

```
Tue, Aug 4 — 8:00 AM, 11:00 AM, 12:00 PM
Wed, Aug 5 — 3:00 PM, 4:00 PM, 5:00 PM

All virtual. All times Pacific. Sessions are 53 minutes.
```

**No 24-hour notice here.** The public page won't offer anything inside 24 hours;
this one shows everything still ahead of you, including later today, because
you're the one deciding what's realistic.

`AVAILABILITY` is duplicated here as well — a third copy alongside `index.html`
and `worker/worker.js`. Change your hours and all three need it.
