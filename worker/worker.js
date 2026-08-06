/**
 * agp-cal — Google Calendar bridge for cavatello.github.io/therapist-tools/cal/
 *
 * Deploy to Cloudflare Workers (free tier is far more than enough).
 * The Google credential lives here as a secret and never reaches the browser.
 *
 * GET  /freebusy?start=<ISO>&end=<ISO>
 *      -> { timeZone, busy:[{start,end}], generatedAt }
 *      Returns ONLY time ranges. No event titles, no attendees, no CPT codes.
 *
 * POST /book  { start, end, mode, name, email, notes, viewerTz }
 *      -> { ok:true, htmlLink }
 *      Re-validates the slot against the calendar before writing, so two people
 *      clicking the same time three seconds apart cannot both get it.
 *
 * Secrets (wrangler secret put NAME):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 * Vars (wrangler.toml):
 *   CALENDAR_ID   e.g. "shawn@agoodplacetherapy.com"
 *   ALLOWED_ORIGIN e.g. "https://cavatello.github.io"
 *   PRACTICE_TZ   e.g. "America/Los_Angeles"
 */

const SESSION_MINUTES = 53;

/* ---------- server-side copy of the weekly template ----------
   Duplicated deliberately. The browser copy drives the UI; this one is the
   authority. A hand-crafted POST cannot book 3am by editing the page. */
/* The weekly template. This is the fallback shipped with the code — the live
   one lives in KV so it can be edited from /admin/ without a deploy. If KV is
   unset, unreachable, or holds anything malformed, we fall back to this. Never
   fail open: a broken template must never mean "everything is available". */
const DEFAULT_AVAILABILITY = {
  virtual: [
    { day: 1, start: "08:00", end: "09:00" },
    { day: 2, start: "08:00", end: "09:00" },
    { day: 2, start: "11:00", end: "13:00" },
    { day: 3, start: "15:00", end: "18:00" },
    { day: 5, start: "08:00", end: "09:00" },
  ],
  inperson: [
    { day: 2, start: "14:00", end: "21:00" },
    { day: 3, start: "07:00", end: "14:00" },
    { day: 4, start: "07:00", end: "14:00" },
    { day: 5, start: "14:00", end: "20:00" },
  ],
};

const AVAIL_KEY = "availability";

/* ---- template storage ---------------------------------------------------- */

// Every window must be a real day, a real HH:MM pair, and start before end.
// Anything else and we reject the whole payload rather than half-applying it.
function validateAvailability(v) {
  if (!v || typeof v !== "object") return "not an object";
  for (const mode of ["virtual", "inperson"]) {
    if (!Array.isArray(v[mode])) return `${mode} must be a list`;
    if (v[mode].length > 40) return `${mode} has too many windows`;
    for (const w of v[mode]) {
      if (!w || typeof w !== "object") return `${mode}: bad window`;
      if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6)
        return `${mode}: day must be 0-6`;
      for (const k of ["start", "end"]) {
        if (typeof w[k] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w[k]))
          return `${mode}: ${k} must be HH:MM`;
      }
      const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      if (mins(w.end) <= mins(w.start)) return `${mode}: end must be after start`;
    }
  }
  return null;
}

async function loadAvailability(env) {
  if (!env.SETTINGS) return DEFAULT_AVAILABILITY;      // KV not bound yet
  try {
    const raw = await env.SETTINGS.get(AVAIL_KEY);
    if (!raw) return DEFAULT_AVAILABILITY;
    const parsed = JSON.parse(raw);
    if (validateAvailability(parsed)) return DEFAULT_AVAILABILITY;
    return { virtual: parsed.virtual, inperson: parsed.inperson };
  } catch {
    return DEFAULT_AVAILABILITY;                        // KV down, keep serving
  }
}

// Constant-time compare so a wrong token can't be narrowed down by timing.
function tokenOk(env, request) {
  const expected = String(env.ADMIN_TOKEN || "");
  if (!expected) return false;                          // no token set = locked
  const got = String(request.headers.get("x-admin-token") || "");
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleGetAvailability(env) {
  return { availability: await loadAvailability(env), source: env.SETTINGS ? "kv" : "default" };
}

async function handlePutAvailability(request, env) {
  if (!tokenOk(env, request)) throw fail("Not authorised", 401);
  if (!env.SETTINGS) throw fail("No KV namespace bound — see SETUP.md", 500);

  const body = await request.json();
  const v = body && body.availability;
  const problem = validateAvailability(v);
  if (problem) throw fail(`Rejected: ${problem}`, 400);

  const clean = { virtual: v.virtual, inperson: v.inperson };
  await env.SETTINGS.put(AVAIL_KEY, JSON.stringify(clean));
  return { ok: true, availability: clean, savedAt: new Date().toISOString() };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/freebusy" && request.method === "GET")
        return json(await handleFreeBusy(url, env, ctx), 200, cors);

      if (url.pathname === "/book" && request.method === "POST")
        return json(await handleBook(await request.json(), env), 200, cors);

      if (url.pathname === "/availability" && request.method === "GET")
        return json(await handleGetAvailability(env), 200, cors);

      if (url.pathname === "/availability" && request.method === "PUT")
        return json(await handlePutAvailability(request, env), 200, cors);

      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: err.message || "Server error" }, err.status || 500, cors);
    }
  },
};

// ALLOWED_ORIGIN may be a comma-separated list, so the live site, a future
// custom domain, and localhost for testing can coexist. The response echoes
// back only the caller's origin when it matches — never the whole list, and
// never a blanket "*" unless explicitly configured that way.
function corsHeaders(env, request) {
  const allowed = String(env.ALLOWED_ORIGIN || "*")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = request && request.headers.get("origin");

  let value = allowed[0];
  if (allowed.includes("*")) value = "*";
  else if (origin && allowed.includes(origin)) value = origin;

  return {
    "access-control-allow-origin": value,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,accept",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}
function fail(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/* ---------------- Google auth ---------------- */
let tokenCache = { value: null, expires: 0 };

async function accessToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expires - 60_000) return tokenCache.value;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    // Google sends error_description "Unauthorized" with error "invalid_client",
    // which alone reads like a Cloudflare problem. Surface both.
    const code = j.error || "unknown";
    const desc = j.error_description ? " — " + j.error_description : "";
    throw fail("Google auth failed: " + code + desc, 502);
  }

  tokenCache = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

/* ---------------- free/busy ---------------- */
async function fetchBusy(startISO, endISO, env) {
  const token = await accessToken(env);

  // CALENDAR_ID may be a comma-separated list. Sessions synced from an EHR
  // often land on a secondary calendar; if it isn't listed here, its events
  // are invisible to free/busy and the page will happily offer booked time.
  const ids = String(env.CALENDAR_ID).split(",").map((s) => s.trim()).filter(Boolean);

  const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: startISO,
      timeMax: endISO,
      timeZone: env.PRACTICE_TZ || "America/Los_Angeles",
      items: ids.map((id) => ({ id })),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw fail("Calendar read failed: " + (j.error?.message || r.status), 502);

  // A calendar we can't read must be a hard error, never a silent empty.
  // Degrading to "no busy time" would show every slot as open.
  const merged = [];
  for (const id of ids) {
    const cal = j.calendars?.[id];
    if (!cal || cal.errors?.length)
      throw fail(`Cannot read calendar ${id}: ${cal?.errors?.[0]?.reason || "not returned"}`, 502);
    for (const b of cal.busy || []) merged.push(b);
  }

  // Overlapping ranges across calendars are fine for the page's purposes,
  // but merging keeps the payload small and the client loop cheap.
  merged.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const out = [];
  for (const b of merged) {
    const last = out[out.length - 1];
    if (last && Date.parse(b.start) <= Date.parse(last.end)) {
      if (Date.parse(b.end) > Date.parse(last.end)) last.end = b.end;
    } else {
      out.push({ start: b.start, end: b.end });
    }
  }
  return out;
}

async function handleFreeBusy(url, env, ctx) {
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) throw fail("start and end are required", 400);
  if (!Date.parse(start) || !Date.parse(end)) throw fail("start and end must be ISO timestamps", 400);

  // 60s edge cache keeps us far under Google's quota even under load.
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cache = caches.default;
  // The template is merged in after the cache lookup, not stored in it — a
  // 60s-stale busy list is fine, a 60s-stale template means an edit appears
  // not to have taken.
  const hit = await cache.match(cacheKey);
  if (hit) return { ...(await hit.json()), availability: await loadAvailability(env) };

  const busy = await fetchBusy(start, end, env);
  const payload = {
    timeZone: env.PRACTICE_TZ || "America/Los_Angeles",
    busy: busy.map((b) => ({ start: b.start, end: b.end })),
    generatedAt: new Date().toISOString(),
  };

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
      })
    )
  );
  return { ...payload, availability: await loadAvailability(env) };
}

/* ---------------- booking ---------------- */
function tzOffsetMs(instant, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  f.formatToParts(instant).forEach((x) => (p[x.type] = x.value));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - instant.getTime();
}
function wallToEpoch(y, m, d, hh, mm, tz) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const ts = naive - tzOffsetMs(new Date(naive), tz);
  return naive - tzOffsetMs(new Date(ts), tz);
}
function tzParts(instant, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = {};
  f.formatToParts(instant).forEach((x) => (p[x.type] = x.value));
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, m: +p.month, d: +p.day, dow: dow[p.weekday] };
}

function windowsFor(mode, AVAILABILITY) {
  // "anyvirtual" = video in any hour Shawn is working, which is the union of
  // both templates. Sent only by /virtual/. Without this the Worker would reject
  // in-person hours submitted as video, and the page would look fine right up
  // until someone pressed submit.
  if (mode === "anyvirtual") return AVAILABILITY.virtual.concat(AVAILABILITY.inperson);
  return AVAILABILITY[mode] || [];
}

function insideTemplate(startMs, endMs, mode, tz, AVAILABILITY) {
  const p = tzParts(new Date(startMs), tz);
  return windowsFor(mode, AVAILABILITY).some((w) => {
    if (w.day !== p.dow) return false;
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    return (
      startMs >= wallToEpoch(p.y, p.m, p.d, sh, sm, tz) &&
      endMs <= wallToEpoch(p.y, p.m, p.d, eh, em, tz)
    );
  });
}

// Where the session happens, as it should read in the calendar event and in the
// invite the client receives.
//   OFFICE_ADDRESS    plain var; already public on your site
//   VIRTUAL_LOCATION  "meet" to have Google mint a fresh Meet link per booking,
//                     or a Zoom URL. Set a Zoom URL as a SECRET, not a var —
//                     wrangler.toml is committed to a public repo.
function locationFor(mode, env) {
  // anyvirtual is a video session, so it gets the join link, not the address.
  if (mode === "inperson") return String(env.OFFICE_ADDRESS || "").trim();
  const v = String(env.VIRTUAL_LOCATION || "").trim();
  if (!v || v.toLowerCase() === "meet") return "";   // Meet link is attached separately
  return v;
}

async function handleBook(body, env) {
  const { start, end, mode, name, email, notes, viewerTz, kind } = body || {};
  const tz = env.PRACTICE_TZ || "America/Los_Angeles";

  if (!start || !end || !mode) throw fail("Missing start, end or mode", 400);
  // The live template, not the constant — otherwise an edit made in /admin/
  // would show on the page but be rejected here.
  const AVAILABILITY = await loadAvailability(env);
  if (!windowsFor(mode, AVAILABILITY).length) throw fail("Unknown session type", 400);
  if (!name || !String(name).trim()) throw fail("Name is required", 400);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail("A valid email is required", 400);

  const s = Date.parse(start), e = Date.parse(end);
  if (!s || !e) throw fail("Invalid times", 400);
  if (Math.round((e - s) / 60000) !== SESSION_MINUTES)
    throw fail(`Sessions are ${SESSION_MINUTES} minutes`, 400);
  // Must match minNoticeHrs in index.html. The server keeps its own copy so a
  // hand-crafted POST can't book five minutes from now.
  const noticeHrs = Number(env.MIN_NOTICE_HOURS ?? 24);
  if (s < Date.now() + noticeHrs * 3600 * 1000) {
    throw fail(
      noticeHrs >= 24
        ? "Please pick a time at least 24 hours out"
        : `Please pick a time at least ${noticeHrs} hours out`,
      400);
  }
  if (!insideTemplate(s, e, mode, tz, AVAILABILITY))
    throw fail("That time is outside my available hours", 409);

  // Re-check against the live calendar immediately before writing.
  const busy = await fetchBusy(new Date(s).toISOString(), new Date(e).toISOString(), env);
  if (busy.some((b) => s < Date.parse(b.end) && e > Date.parse(b.start)))
    throw fail("That time was just taken — please pick another", 409);

  const token = await accessToken(env);
  const clean = (v, n) => String(v || "").replace(/[\r\n]+/g, " ").slice(0, n);

  const event = {
    summary: `HOLD — ${kind === "reschedule" ? "RESCHEDULE" : "New"} · ` +
             `${mode === "inperson" ? "In person" : "Virtual"} · ${clean(name, 60)}`,
    description:
      `Requested via the website booking page.\n` +
      `Name: ${clean(name, 80)}\n` +
      `Email: ${clean(email, 120)}\n` +
      `Their timezone: ${clean(viewerTz || "unknown", 60)}\n` +
      `Kind: ${kind === "reschedule" ? "Rescheduling an existing session" : "New session"}\n` +
      (mode !== "inperson" && locationFor(mode, env)
        ? `\nJoin: ${locationFor(mode, env)}\n` : "") +
      (notes ? `\nNotes: ${clean(notes, 800)}\n` : "") +   // kept: older pages may still send it
      `\nUnconfirmed until you reply.`,
    start: { dateTime: new Date(s).toISOString(), timeZone: tz },
    end: { dateTime: new Date(e).toISOString(), timeZone: tz },
    // Colour 5 = banana, so website holds are visually distinct from real sessions.
    colorId: "5",
    location: locationFor(mode, env),
    transparency: "opaque",
    reminders: { useDefault: true },
  };

  // Without an attendee Google emails nobody, and the page would be claiming a
  // confirmation that never went out. SEND_INVITES="false" turns this off, and
  // the page then says only that a hold was placed.
  const invite = String(env.SEND_INVITES ?? "true") !== "false";
  if (invite) event.attendees = [{ email: String(email).trim(), responseStatus: "needsAction" }];

  // Ask Google for a per-event Meet link. Unique each time, so there is no
  // standing URL that could leak.
  const wantMeet = mode !== "inperson" &&
    String(env.VIRTUAL_LOCATION || "").trim().toLowerCase() === "meet";
  if (wantMeet) {
    event.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events` +
    `?sendUpdates=${invite ? "all" : "none"}` +
    (wantMeet ? "&conferenceDataVersion=1" : ""),
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(event),
    }
  );
  const j = await r.json();
  if (!r.ok) throw fail("Could not write the hold: " + (j.error?.message || r.status), 502);

  // Hand the resolved location back so the page can show it on the confirmation
  // and put it in the .ics the visitor downloads.
  const meetLink = j.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  return {
    ok: true, htmlLink: j.htmlLink, id: j.id, invited: invite,
    location: meetLink || j.location || "",
  };
}
