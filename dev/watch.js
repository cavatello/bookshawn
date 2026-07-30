#!/usr/bin/env node
/**
 * watch.js — save a file, and it ships.
 *
 *   cd ~/bookshawn && node dev/watch.js
 *
 * Watches the project. On any change it waits for you to stop typing, then:
 *
 *   1. runs the test suite      (skip with --no-test)
 *   2. commits and pushes       (skip with --dry)
 *   3. redeploys the Worker     only if worker/ changed
 *   4. polls GitHub Pages until the new build is actually serving
 *
 * A failing test blocks the push. That is the point — the tests know things
 * like "the footer must disclose the supervisor" and "no slots without a live
 * calendar", and a broken push is public within a minute.
 *
 * Ctrl-C to stop.
 *
 * Flags:
 *   --dry        show what would happen, change nothing
 *   --no-test    push without running the suite (not advised)
 *   --no-deploy  never touch Cloudflare, even if worker/ changed
 *   --delay=N    seconds of quiet before acting (default 3)
 */

const { execSync, spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);
const DRY = has("--dry");
const NO_TEST = has("--no-test");
const NO_DEPLOY = has("--no-deploy");
const DELAY = (Number((ARGV.find((a) => a.startsWith("--delay=")) || "").split("=")[1]) || 3) * 1000;

const LIVE = "https://cavatello.github.io/bookshawn/";
const DOWNLOADS = process.env.DOWNLOADS || path.join(process.env.HOME || "", "Downloads");

// Files I hand over, and where each belongs. A new copy landing in Downloads
// is treated exactly like editing the file in place.
const FILE_MAP = {
  "index.html": ".", "SETUP.md": ".", "NEXT-STEPS.md": ".",
  "worker.js": "worker", "wrangler.toml": "worker",
  "serve.js": "dev", "test-cal.js": "dev", "watch.js": "dev",
  "check-google.js": "dev", "check-worker.js": "dev", "get-token.js": "dev",
};
const IGNORE = [/(^|\/)\.git(\/|$)/, /node_modules/, /\.wrangler/, /\.DS_Store$/,
                /\.bak$/, /(^|\/)install\.sh$/, /~$/, /\.swp$/];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const stamp = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const log = (m) => console.log(dim(stamp()) + "  " + m);

function run(cmd, cwd) {
  return execSync(cmd, { cwd: cwd || ROOT, encoding: "utf8", stdio: "pipe" });
}

/* ---------- guard rails ---------- */
if (!fs.existsSync(path.join(ROOT, ".git"))) {
  console.log(r("\n  Not a git repo: " + ROOT + "\n"));
  process.exit(1);
}
try { run("git rev-parse --abbrev-ref HEAD"); }
catch { console.log(r("\n  git isn't usable here.\n")); process.exit(1); }

const BRANCH = run("git rev-parse --abbrev-ref HEAD").trim();

console.log();
console.log(bold("  Watching " + ROOT));
console.log(dim("  branch " + BRANCH + "  ·  quiet period " + DELAY / 1000 + "s" +
  (DRY ? "  ·  DRY RUN" : "") + (NO_TEST ? "  ·  tests off" : "") +
  (NO_DEPLOY ? "  ·  deploy off" : "")));
console.log(dim("  Ctrl-C to stop.\n"));

/* ---------- the pipeline ---------- */
let timer = null;
let running = false;
let pending = new Set();

function ignored(rel) {
  return !rel || IGNORE.some((re) => re.test(rel));
}

function testsPass() {
  if (NO_TEST) return true;
  log("running tests…");

  // Always start a private server on its own port. Reusing whatever happens to
  // be on 8099 once let a stale server from another directory serve the tests —
  // they passed against code that was not the code being shipped.
  const PORT = 8100 + Math.floor(Math.random() * 800);
  const server = spawn("node", ["serve.js"], {
    cwd: path.join(ROOT, "dev"),
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });

  const started = Date.now();
  let up = false;
  while (Date.now() - started < 8000) {
    try {
      execSync(`curl -s -o /dev/null --max-time 1 http://localhost:${PORT}/`);
      up = true; break;
    } catch { execSync("sleep 0.3"); }
  }
  if (!up) { server.kill(); log(r("could not start the test server")); return false; }

  const res = spawnSync("node", ["test-cal.js"], {
    cwd: path.join(ROOT, "dev"), encoding: "utf8",
    env: { ...process.env, BASE: `http://localhost:${PORT}` },
  });
  server.kill();
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(/(\d+) passed, (\d+) failed/);

  if (res.status === 0 && m) { log(g("tests pass") + dim("  " + m[1] + " assertions")); return true; }

  log(r("TESTS FAILED — not pushing"));
  out.split("\n").filter((l) => /FAIL/.test(l)).forEach((l) => console.log("      " + r(l.trim())));
  if (!m) console.log(dim(out.split("\n").slice(-6).map((l) => "      " + l).join("\n")));
  return false;
}

// Auto-push means a leaked credential is public in seconds, and git history is
// very hard to scrub. Refuse to publish anything credential-shaped.
const SECRET_PATTERNS = [
  [/1\/\/[0-9A-Za-z_-]{20,}/, "Google refresh token"],
  [/GOCSPX-[0-9A-Za-z_-]{10,}/, "Google client secret"],
  [/ya29\.[0-9A-Za-z._-]{20,}/, "Google access token"],
  [/BEGIN [A-Z ]*PRIVATE KEY/, "private key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
];

function credentialScan() {
  let diff = "";
  try { diff = run("git diff --cached -U0"); } catch { return true; }
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const hits = [];
  for (const line of added) {
    for (const [re, what] of SECRET_PATTERNS) {
      if (re.test(line)) hits.push([what, line.trim().slice(0, 90)]);
    }
  }
  if (!hits.length) return true;
  console.log();
  log(r("BLOCKED — something credential-shaped is staged"));
  hits.slice(0, 5).forEach(([what, line]) => console.log("      " + r(what) + dim("  " + line)));
  console.log(dim("      Nothing was pushed. Remove it, then: git reset"));
  console.log(dim("      Secrets belong in: cd worker && npx wrangler secret put NAME"));
  console.log();
  try { run("git reset"); } catch {}
  return false;
}

function ship(changed) {
  running = true;
  const files = [...changed];
  const workerTouched = files.some((f) => f.startsWith("worker/"));

  console.log();
  log(bold(files.length + " file(s) changed") + dim("  " + files.slice(0, 4).join(", ") +
    (files.length > 4 ? ` +${files.length - 4}` : "")));

  try {
    let status = run("git status --porcelain").trim();
    if (!status) { log(dim("nothing for git to commit")); running = false; return; }

    if (!testsPass()) { running = false; return; }

    if (workerTouched && !NO_DEPLOY) {
      if (DRY) log(y("[dry] would run: wrangler deploy"));
      else {
        log("worker changed — deploying…");
        try { run("npx wrangler deploy", path.join(ROOT, "worker")); log(g("worker deployed")); }
        catch (e) {
          log(r("wrangler deploy failed — pushing the page anyway"));
          console.log(dim("      " + String(e.stdout || e.message).trim().split("\n").slice(-3).join("\n      ")));
        }
      }
    }

    const msg = "Update " + files.slice(0, 3).join(", ") + (files.length > 3 ? ` +${files.length - 3}` : "");
    if (DRY) { log(y('[dry] would commit + push: "' + msg + '"')); running = false; return; }

    run("git add -A");
    if (!credentialScan()) { running = false; return; }
    run(`git commit -m ${JSON.stringify(msg)}`);
    const sha = run("git rev-parse --short HEAD").trim();
    try {
      run("git push");
    } catch (e) {
      log(y("committed " + sha + " locally, but push failed"));
      console.log(dim("      " + String(e.stderr || e.stdout || e.message).trim().split("\n")[0]));
      console.log(dim("      fix the remote, then: git push"));
      return;
    }
    log(g("pushed ") + dim(sha + "  " + msg));
    pollPages();
  } catch (e) {
    log(r("failed: " + String(e.stdout || e.stderr || e.message).trim().split("\n")[0]));
  } finally {
    running = false;
  }
}

function pollPages() {
  log(dim("waiting for GitHub Pages…"));
  let n = 0;
  const tick = setInterval(() => {
    n++;
    let code = "000";
    try {
      code = execSync(`curl -s -o /dev/null -w "%{http_code}" -H "Cache-Control: no-cache" ${LIVE}`,
        { encoding: "utf8" }).trim();
    } catch {}
    if (code === "200") {
      clearInterval(tick);
      log(g("live") + dim("  " + LIVE));
      console.log();
    } else if (n >= 12) {
      clearInterval(tick);
      log(y("Pages still building after 4 min — check the Actions tab"));
      console.log();
    }
  }, 20000);
}

/* ---------- pull new downloads into place ---------- */
function pullDownloads() {
  if (!fs.existsSync(DOWNLOADS)) return [];
  const moved = [];
  for (const [name, dest] of Object.entries(FILE_MAP)) {
    const stem = name.replace(/\.[^.]+$/, "");
    const ext = name.split(".").pop();
    // newest of "name", "name-2.ext", "name (1).ext", "name_6.ext", or bare stem
    let best = null, bestT = 0;
    for (const f of fs.readdirSync(DOWNLOADS)) {
      const ok = (f === name) || (f === stem) ||
                 (f.startsWith(stem) && f.endsWith("." + ext));
      if (!ok) continue;
      const full = path.join(DOWNLOADS, f);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = full; }
    }
    if (!best) continue;

    const target = path.join(ROOT, dest, name);
    let same = false;
    try { same = fs.readFileSync(best).equals(fs.readFileSync(target)); } catch {}
    if (same) continue;
    // only take it if the download is actually newer than what we have
    let tgtT = 0; try { tgtT = fs.statSync(target).mtimeMs; } catch {}
    if (bestT <= tgtT) continue;

    if (DRY) { log(y("[dry] would pull " + path.basename(best) + " -> " + dest + "/" + name)); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(best, target);
    fs.utimesSync(target, new Date(), new Date());
    log(g("pulled ") + dim(path.basename(best) + "  ->  " + dest + "/" + name));
    moved.push(dest === "." ? name : dest + "/" + name);
  }
  return moved;
}

/* ---------- watcher ---------- */
function schedule(rel) {
  if (running) return;
  pending.add(rel);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const batch = pending; pending = new Set();
    ship(batch);
  }, DELAY);
}

fs.watch(ROOT, { recursive: true }, (evt, filename) => {
  if (!filename) return;
  const rel = filename.split(path.sep).join("/");
  if (ignored(rel)) return;
  schedule(rel);
});

if (fs.existsSync(DOWNLOADS)) {
  console.log(dim("  also watching " + DOWNLOADS + " for new versions of project files\n"));
  fs.watch(DOWNLOADS, () => {
    if (running) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const moved = pullDownloads();
      if (!moved.length) return;
      const batch = new Set(moved); pending = new Set();
      ship(batch);
    }, DELAY);
  });
  // catch anything already sitting there
  const initial = pullDownloads();
  if (initial.length) schedule(initial[0]);
}

process.on("SIGINT", () => { console.log(dim("\n  stopped\n")); process.exit(0); });
