#!/usr/bin/env node
// claude-vis — watch your Claude Code agents come to life in the terminal.
//
// Tails the session transcripts Claude Code writes to ~/.claude/projects/
// and renders a little animated sprite for every live agent: the main
// session plus each subagent it spawns. No config needed in the session
// being watched.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile } = require('child_process');

const PROJECTS_DIR = process.env.CLAUDE_VIS_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');

// ---------- cli args ----------
const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(`claude-vis ${require('./package.json').version}`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`claude-vis — animated sprites for your running Claude Code agents

usage: claude-vis [options]

options:
  --project <name>   only show sessions whose project path contains <name>
  --window <mins>    treat sessions modified in the last N minutes as live (default 5)
  --tree             start in tree view (press t to toggle at runtime)
  --past             start in the past-sessions view
  --sort <key>       order past sessions by "date" (default), "cost", or
                     "project" (grouped by directory)
  --theme <name>     sprite theme: people, bots, cats, owls, ghosts
  --once             render a single frame to stdout and exit (no TUI)
  --install-hooks    register Claude Code hooks for exact liveness signals
                     (so a long Bash/tool call no longer looks like a death)
  --uninstall-hooks  remove those hooks again
  -v, --version      print version
  -h, --help         show this help

keys:
  v                  toggle sprite grid / relationship tree
  t                  pick a sprite theme (menu, arrow keys, live preview)
  p                  toggle the past-sessions view
  s                  cycle past-session order: date / cost / project
  j/k, arrows, wheel scroll the tree and past views
  ctrl-d/u, PgDn/Up  scroll half a page; g jumps to top, G to bottom
  q                  quit

state:
  view/sort/theme choices persist in ~/.config/claude-vis/config.json
  (flags override); token tallies are cached in ~/.cache/claude-vis/`);
  process.exit(0);
}
const FILTER = argVal('--project', null);
const ACTIVE_WINDOW_MS = parseFloat(argVal('--window', '5')) * 60_000;
const ONCE = args.includes('--once');

// ---------- persisted preferences ----------
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-vis');
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'claude-vis');
const PREFS_FILE = path.join(CONFIG_DIR, 'config.json');
const CACHE_FILE = path.join(CACHE_DIR, 'tallies.json');
const HOOK_EVENTS_FILE = process.env.CLAUDE_VIS_HOOK_EVENTS
  || path.join(CACHE_DIR, 'hook-events.jsonl');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ---------- hook bridge (opt-in ground truth) ----------
// `claude-vis --install-hooks` registers tiny hooks in the user's Claude Code
// settings that shell back into `claude-vis --hook-emit <Event>`. Each call
// appends one compact line to HOOK_EVENTS_FILE, which a running monitor tails
// for exact lifecycle/activity instead of inferring it from transcript
// silence (see readHookEvents/lifecycle). Without this, detection still works
// — it just falls back to the mtime + process-probe heuristics.
const HOOK_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
// SessionEnd is the signal that matters (exact, immediate close); the rest are
// cheap liveness heartbeats. We intentionally skip Pre/PostToolUse — they'd
// spawn a process on *every* tool call, and we no longer need them (an agent
// mid-tool already shows an active transcript state).
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop'];
let HOOK_EMIT_MODE = false;

function hookCommand(event) {
  // quote both paths so spaces in the install location survive the shell
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} --hook-emit ${event}`;
}
function isOurHookGroup(group) {
  return group && Array.isArray(group.hooks)
    && group.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes('--hook-emit'));
}
function configureHooks(remove) {
  let s = readJson(HOOK_SETTINGS_FILE);
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  s.hooks = (s.hooks && typeof s.hooks === 'object') ? s.hooks : {};
  // sweep every event already in settings (so stale claude-vis entries from an
  // older install — e.g. Pre/PostToolUse we no longer use — get cleaned up too)
  // plus the events we add on install
  const events = new Set([...Object.keys(s.hooks), ...HOOK_EVENTS]);
  const wanted = new Set(HOOK_EVENTS);
  for (const event of events) {
    const list = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    // strip prior claude-vis entries first so installs stay idempotent
    const kept = list.filter((g) => !isOurHookGroup(g));
    if (!remove && wanted.has(event)) kept.push({ matcher: '*', hooks: [{ type: 'command', command: hookCommand(event) }] });
    if (kept.length) s.hooks[event] = kept;
    else delete s.hooks[event];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  try {
    fs.mkdirSync(path.dirname(HOOK_SETTINGS_FILE), { recursive: true });
    if (fs.existsSync(HOOK_SETTINGS_FILE)) {
      fs.copyFileSync(HOOK_SETTINGS_FILE, `${HOOK_SETTINGS_FILE}.claude-vis.bak`); // one-step undo
    }
    fs.writeFileSync(HOOK_SETTINGS_FILE, JSON.stringify(s, null, 2) + '\n');
  } catch (e) {
    console.error(`claude-vis: could not update ${HOOK_SETTINGS_FILE}: ${e.message}`);
    process.exit(1);
  }
  let removedLog = false;
  if (remove) {
    try { fs.rmSync(HOOK_EVENTS_FILE, { force: true }); removedLog = true; } catch { /* nothing to clean */ }
  }
  console.log(remove
    ? `claude-vis: removed hooks from ${HOOK_SETTINGS_FILE}${removedLog ? `\nclaude-vis: deleted the event log ${HOOK_EVENTS_FILE}` : ''}`
    : `claude-vis: installed hooks into ${HOOK_SETTINGS_FILE} (backup at ${path.basename(HOOK_SETTINGS_FILE)}.claude-vis.bak)
claude-vis: new Claude Code sessions will report live activity to ${HOOK_EVENTS_FILE}`);
}

if (args.includes('--install-hooks')) { configureHooks(false); process.exit(0); }
if (args.includes('--uninstall-hooks')) { configureHooks(true); process.exit(0); }
if (args[0] === '--hook-emit') {
  // invoked *by* a Claude Code hook; stdin carries the event's JSON payload
  HOOK_EMIT_MODE = true;
  const event = args[1] || 'unknown';
  let raw = '';
  const flush = () => {
    let j = {};
    try { j = JSON.parse(raw); } catch { /* tolerate empty / non-json stdin */ }
    const rec = { ts: Date.now(), event, sid: j.session_id || '', tool: j.tool_name || '', cwd: j.cwd || '' };
    try {
      fs.mkdirSync(path.dirname(HOOK_EVENTS_FILE), { recursive: true });
      // best-effort cap so an append-only log can't grow without bound
      try { if (fs.statSync(HOOK_EVENTS_FILE).size > (2 << 20)) fs.truncateSync(HOOK_EVENTS_FILE); } catch { /* no file yet */ }
      fs.appendFileSync(HOOK_EVENTS_FILE, JSON.stringify(rec) + '\n');
    } catch { /* never block the agent on telemetry */ }
    process.exit(0);
  };
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', flush);
  setTimeout(flush, 2000); // don't hang if stdin never closes
}

const prefs = readJson(PREFS_FILE) || {};

function savePrefs() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify({ theme, view: viewMode, sort: pastSort }, null, 2) + '\n');
  } catch { /* prefs are a nicety — keep running without them */ }
}

// explicit flags win, then saved prefs, then defaults
let viewMode = args.includes('--past') ? 'past'
  : args.includes('--tree') ? 'tree'
  : ['grid', 'tree', 'past'].includes(prefs.view) ? prefs.view : 'grid';
let liveView = viewMode === 'past' ? 'grid' : viewMode; // view to return to when leaving past
const sortArg = argVal('--sort', null);
let pastSort = ['date', 'cost', 'project'].includes(sortArg) ? sortArg
  : ['date', 'cost', 'project'].includes(prefs.sort) ? prefs.sort : 'date';
let scrollY = 0; // tree/past list scroll offset, clamped at render time

const TICK_MS = 120;          // render tick
const IDLE_AFTER_MS = 20_000; // no transcript lines for this long -> zzz
const SUB_DONE_AFTER_MS = 90_000;    // quiet subagent file -> done, despawn
const MAIN_GONE_AFTER_MS = 10 * 60_000; // quiet main session -> despawn
const DEATH_MS = 1300;        // length of the *poof* animation
const PAST_MAX = 15;          // most recent past sessions kept in the tree view
// states where transcript silence means "working" (a long tool call or
// generation), not "finished" — Claude writes a line only when a block
// completes, so an in-flight Bash leaves the file quiet. Agents in these
// states aren't timed out on silence alone; see lifecycle().
const ACTIVE_STATES = new Set(['thinking', 'editing', 'running', 'spawning']);
const ACTIVE_BACKSTOP_MS = 30 * 60_000; // hard cap: clear an active-state agent
                                        // left stranded by an abrupt end

// ---------- sprite animation frames: [thought-bubble line, body line] ----------
const ANIM = {
  spawn: [
    ['', '.'],
    ['', '*'],
    ['*  .  *', '(o_o)'],
    ['.  *  .', '\\(o_o)/'],
  ],
  thinking: [
    ['.', '(o_o)'],
    ['.o', '(o_o)'],
    ['.oO', '(o_O)'],
    ['.oO ( ? )', '(o_O)'],
    ['.oO ( ! )', '(O_O)'],
    ['', '(-_-)'],
  ],
  reading: [
    ['', '(o_o) [#]'],
    ['', '(o_-) [#]'],
    ['', '(-_o) [#]'],
    ['*flip*', '(o_o) [#]'],
  ],
  editing: [
    ['*tik*', '(>_<)/[=]'],
    ['', '(>_<)|[=]'],
    ['*tak*', '(>_<)\\[=]'],
    ['', '(>_<)|[=]'],
  ],
  running: [
    ['$ |', '(o_o)>_'],
    ['$ /', '(o_o)>_'],
    ['$ -', '(o_o)>_'],
    ['$ \\', '(o_o)>_'],
  ],
  spawning: [
    ['*', '(o_o)/'],
    ['+ *', '(o_o)/'],
    ['* + *', '\\(o_o)/'],
    ['+ * +', '(o_o)/'],
  ],
  talking: [
    ['" ... "', '(^o^)'],
    ['" o.. "', '(^o^)'],
    ['" oo. "', '(^_^)'],
    ['" ooo "', '(^o^)'],
  ],
  prompted: [
    ['!', '(O_O)'],
    ['! !', '(O_O)'],
  ],
  idle: [
    ['', '(-_-)'],
    ['z', '(-_-)'],
    ['zZ', '(-_-)'],
    ['zZz', '(-_-)'],
    ['zZz', '(-_-)'],
    ['', '(-_-)'],
  ],
  dying: [
    ['', '(x_x)'],
    ['', '(x_x)'],
    ['*poof*', '. : .'],
    ['', '.'],
    ['', ''],
  ],
};

// ---------- sprite themes ----------
// A theme re-skins the critter by swapping face tokens inside the base
// animation frames; props, thought bubbles, and the *poof* stay intact.
// All faces are plain ASCII so column alignment never drifts.
const THEMES = {
  people: null, // the base frames above
  bots: {
    '(o_o)': '[o_o]', '(o_O)': '[o_O]', '(O_O)': '[O_O]', '(-_-)': '[-_-]',
    '(>_<)': '[>_<]', '(^o^)': '[^o^]', '(^_^)': '[^_^]',
    // bots don't die, they run out of battery
    '(x_x)': '[=__]', '. : .': '[___]', '*poof*': '*low batt*',
  },
  cats: {
    '(o_o)': '(=o.o=)', '(o_O)': '(=o.O=)', '(O_O)': '(=O.O=)', '(-_-)': '(=-.-=)',
    '(>_<)': '(=>.<=)', '(^o^)': '(=^o^=)', '(^_^)': '(=^.^=)', '(x_x)': '(=x.x=)',
  },
  owls: {
    '(o_o)': '{o,o}', '(o_O)': '{o,O}', '(O_O)': '{O,O}', '(-_-)': '{-,-}',
    '(>_<)': '{>,<}', '(^o^)': '{^,^}', '(^_^)': '{^,^}', '(x_x)': '{x,x}',
  },
  ghosts: {
    '(o_o)': '(~o_o)~', '(o_O)': '(~o_O)~', '(O_O)': '(~O_O)~', '(-_-)': '(~-_-)~',
    '(>_<)': '(~>_<)~', '(^o^)': '(~^o^)~', '(^_^)': '(~^_^)~', '(x_x)': '(~x_x)~',
  },
};
const THEME_NAMES = Object.keys(THEMES);
const themeArg = argVal('--theme', null);
let theme = THEME_NAMES.includes(themeArg) ? themeArg
  : THEME_NAMES.includes(prefs.theme) ? prefs.theme : 'people';
let themeMenu = -1;      // selected row while the picker is open, -1 = closed
let themeBefore = null;  // theme to restore if the picker is cancelled

function themedFace(face) {
  return (THEMES[theme] && THEMES[theme][face]) || face;
}

function themedAnim(name) {
  const map = THEMES[name];
  if (!map) return ANIM;
  const sub = (s) => Object.entries(map).reduce((acc, [k, v]) => acc.split(k).join(v), s);
  const out = {};
  for (const [state, frames] of Object.entries(ANIM)) {
    out[state] = frames.map(([bubble, body]) => [sub(bubble), sub(body)]);
  }
  return out;
}
let anim = themedAnim(theme);

function setTheme(name) {
  theme = name;
  anim = themedAnim(name);
}

// state -> [label, ansi fg color]
const STYLE = {
  spawn: ['SPAWN', '97'],
  thinking: ['THINK', '95'],
  reading: ['READ', '96'],
  editing: ['EDIT', '93'],
  running: ['RUN', '92'],
  spawning: ['DELEGATE', '36'],
  talking: ['TALK', '94'],
  prompted: ['PROMPT', '91'],
  idle: ['IDLE', '90'],
  dying: ['DONE', '90'],
};

const CARD_W = 36; // total card width including borders

// ---------- transcript parsing ----------
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.file_path) return path.basename(String(input.file_path));
  if (input.path) return path.basename(String(input.path));
  if (input.description) return String(input.description);
  if (input.pattern) return String(input.pattern);
  if (input.command) return String(input.command);
  if (input.url) return String(input.url).replace(/^https?:\/\//, '');
  if (input.query) return String(input.query);
  if (input.subagent_type) return String(input.subagent_type);
  if (input.prompt) return String(input.prompt);
  return '';
}

function toolState(name) {
  const n = String(name).toLowerCase();
  if (/^(edit|write|multiedit|notebookedit)$/.test(n)) return 'editing';
  if (/^(bash|bashoutput|killshell)$/.test(n)) return 'running';
  if (/^(task|agent)$/.test(n)) return 'spawning';
  if (/^(read|grep|glob|ls|websearch|webfetch|toolsearch)$/.test(n)) return 'reading';
  return 'running';
}

function squish(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- token & cost tallies ----------
// Static fallback: $/MTok by model family (cache read = 0.1x input; cache
// write 1.25x for 5m TTL, 2x for 1h). Older/legacy models are approximated
// by family. Overridden by live per-model prices fetched at launch.
const PRICING = [
  [/fable/, 10, 50],
  [/opus/, 5, 25],
  [/sonnet/, 3, 15],
  [/haiku/, 1, 5],
];

// Live per-model rates ($/token) from LiteLLM's community pricing data —
// there is no official Anthropic pricing API.
const PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const livePrices = new Map();
let pricesSource = 'static';

function rateFor(model) {
  const r = livePrices.get(model)
    || livePrices.get(model.replace(/-\d{8}$/, '')); // dated id -> alias
  if (r) return r;
  const [, inP, outP] = PRICING.find(([re]) => re.test(model)) || [null, 5, 25];
  return {
    in: inP / 1e6,
    out: outP / 1e6,
    read: inP * 0.1 / 1e6,
    w5: inP * 1.25 / 1e6,
    w1: inP * 2 / 1e6,
  };
}

function priceBucket(model, b) {
  const p = rateFor(model);
  return b.i * p.in + b.o * p.out + b.r * p.read + b.w5 * p.w5 + b.w1 * p.w1;
}

function usageEntry(u, model) {
  const cc = u.cache_creation;
  return {
    m: model,
    i: u.input_tokens || 0,
    o: u.output_tokens || 0,
    r: u.cache_read_input_tokens || 0,
    w5: cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0),
    w1: cc ? (cc.ephemeral_1h_input_tokens || 0) : 0,
  };
}

// Tallies aggregate token sums per model (price-independent), so totals can
// be repriced exactly when live prices land and cached across runs.
function bucketFor(t, model) {
  let b = t.byModel.get(model);
  if (!b) t.byModel.set(model, b = { i: 0, o: 0, r: 0, w5: 0, w1: 0 });
  return b;
}

function addToBucket(t, e, sign) {
  const b = bucketFor(t, e.m);
  b.i += sign * e.i;
  b.o += sign * e.o;
  b.r += sign * e.r;
  b.w5 += sign * e.w5;
  b.w1 += sign * e.w1;
}

function retotal(t) {
  t.tok = 0;
  t.cost = 0;
  for (const [m, b] of t.byModel) {
    t.tok += b.i + b.o + b.r + b.w5 + b.w1;
    t.cost += priceBucket(m, b);
  }
}

function fetchJson(url, timeoutMs, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'claude-vis' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return fetchJson(res.headers.location, timeoutMs, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`http ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function loadLivePrices() {
  let data;
  try {
    data = await fetchJson(PRICES_URL, 10_000);
  } catch {
    return; // offline or fetch failed — the static table stays in effect
  }
  for (const [key, v] of Object.entries(data)) {
    if (!v || v.litellm_provider !== 'anthropic') continue;
    if (typeof v.input_cost_per_token !== 'number') continue;
    const id = key.replace(/^anthropic\//, '');
    if (!id.startsWith('claude')) continue;
    livePrices.set(id, {
      in: v.input_cost_per_token,
      out: v.output_cost_per_token || 0,
      read: v.cache_read_input_token_cost ?? v.input_cost_per_token * 0.1,
      w5: v.cache_creation_input_token_cost ?? v.input_cost_per_token * 1.25,
      w1: v.cache_creation_input_token_cost_above_1hr ?? v.input_cost_per_token * 2,
    });
  }
  if (livePrices.size === 0) return;
  pricesSource = 'live';
  // reprice everything tallied before the fetch finished
  for (const t of [...agents.values(), ...retainedUsage.values()]) retotal(t);
  for (const p of pastSessions.values()) {
    retotal(p);
    for (const s of p.subs.values()) retotal(s);
  }
}

// Transcripts repeat the same usage on every line of a streamed message, so
// tallies are keyed by requestId — later lines overwrite, never double-count.
function addUsage(agent, obj) {
  if (agent.skipUsage) return; // priming replay: tally already counted
  const u = obj.message && obj.message.usage;
  const key = obj.requestId || (obj.message && obj.message.id);
  if (!u || !key) return;
  const entry = usageEntry(u, obj.message.model || '');
  const prev = agent.usageByReq.get(key);
  if (prev) addToBucket(agent, prev, -1);
  agent.usageByReq.set(key, entry);
  addToBucket(agent, entry, 1);
  retotal(agent);
  // the dedupe map can shed old entries freely — totals live in byModel
  if (agent.usageByReq.size > 4000) {
    let drop = 1000;
    for (const k of agent.usageByReq.keys()) {
      agent.usageByReq.delete(k);
      if (--drop === 0) break;
    }
  }
}

// ---------- tally cache ----------
// Full-transcript scans are expensive on big histories, so per-file token
// sums persist across runs (keyed by path, validated by size+mtime). Only
// token counts are cached — costs are recomputed at load, so price updates
// apply retroactively. A file that grew resumes scanning at the old size;
// the final request's entry is kept so a message still streaming across the
// boundary doesn't double-count.
const tallyCache = new Map(); // transcript path -> cached tally
let cacheDirty = false;
{
  const data = readJson(CACHE_FILE);
  if (data && data.v === 1 && data.files) {
    for (const [f, c] of Object.entries(data.files)) tallyCache.set(f, c);
  }
}

function lastReqEntry(map) {
  let last = null;
  for (const kv of map) last = kv;
  return last;
}

function storeCache(file, size, mtimeMs, t) {
  tallyCache.set(file, {
    size,
    mtimeMs,
    byModel: Object.fromEntries(t.byModel),
    last: t.usageByReq ? lastReqEntry(t.usageByReq) : null,
    name: t.name || '',
    project: t.project || '',
    cwd: t.cwd || '',
  });
  cacheDirty = true;
}

function applyCached(t, c) {
  for (const [m, b] of Object.entries(c.byModel || {})) {
    const dst = bucketFor(t, m);
    dst.i += b.i;
    dst.o += b.o;
    dst.r += b.r;
    dst.w5 += b.w5;
    dst.w1 += b.w1;
  }
  if (c.last && t.usageByReq) t.usageByReq.set(c.last[0], c.last[1]);
  if (c.name) t.name = c.name;
  if (c.cwd) {
    t.cwd = c.cwd;
    if (!t.project) t.project = path.basename(c.cwd);
  }
  if (c.project && !t.project) t.project = c.project;
  retotal(t);
}

// tally a transcript into target, through the cache when possible
function tallyFile(target, file, st) {
  const c = tallyCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) {
    applyCached(target, c);
    return;
  }
  if (c && c.size > 0 && c.size < st.size) {
    applyCached(target, c); // resume where the last run stopped
    scanUsageInto(target, file, st.size, c.size);
  } else {
    scanUsageInto(target, file, st.size, 0);
  }
  storeCache(file, st.size, st.mtimeMs, target);
}

function saveCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    let entries = [...tallyCache.entries()];
    if (entries.length > 4000) { // keep the most recently active transcripts
      entries.sort((x, y) => y[1].mtimeMs - x[1].mtimeMs);
      entries.length = 4000;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ v: 1, files: Object.fromEntries(entries) }));
  } catch { /* the cache is best-effort */ }
}

// refresh cache entries for agents that are still being tailed
function cacheLiveAgents() {
  for (const a of agents.values()) {
    const consumed = a.offset - Buffer.byteLength(a.buf, 'utf8');
    if (consumed > 0) storeCache(a.file, consumed, a.mtimeMs, a);
  }
}

function fmtTok(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'm';
}
function fmtCost(c) {
  return c >= 100 ? '$' + Math.round(c) : c >= 10 ? '$' + c.toFixed(1) : '$' + c.toFixed(2);
}

// ---------- event ticker ----------
const ticker = [];
function logEvent(agent, state, detail) {
  ticker.push({ t: Date.now(), agent, state, detail: detail || '' });
  if (ticker.length > 200) ticker.splice(0, 100);
}

function setState(agent, state, detail) {
  if (agent.state !== state || agent.detail !== detail) {
    agent.state = state;
    agent.detail = detail || '';
    agent.stateSince = Date.now();
    if (!agent.priming && state !== 'idle') logEvent(agent, state, detail);
  }
}

function applyLine(agent, obj) {
  if (!obj || typeof obj !== 'object') return;
  // metadata that names the sprite
  if (agent.kind === 'main' && obj.slug) agent.name = obj.slug;
  if (obj.attributionAgent) agent.name = obj.attributionAgent;
  if (obj.cwd) {
    agent.cwd = obj.cwd;
    if (!agent.project) agent.project = path.basename(obj.cwd);
  }
  addUsage(agent, obj);
  // legacy inline sidechains live in the main file; modern subagents have
  // their own files, so skip sidechain lines when tailing a main session
  if (agent.kind === 'main' && obj.isSidechain) return;

  if (obj.type === 'assistant') {
    const blocks = (obj.message && obj.message.content) || [];
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking') setState(agent, 'thinking', '');
      else if (b.type === 'text') setState(agent, 'talking', squish(b.text || '', 60));
      else if (b.type === 'tool_use') {
        const st = toolState(b.name);
        setState(agent, st, squish(`${b.name} ${toolDetail(b.input)}`, 60));
        if (st === 'editing' && b.id) agent.editToolIds.add(b.id);
      }
    }
  } else if (obj.type === 'user') {
    const c = obj.message && obj.message.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
      // an edit's result lands while the agent is usually already writing the
      // next change — hold EDIT instead of flashing back to THINK
      let editDone = false;
      for (const b of c) {
        if (b && b.type === 'tool_result' && agent.editToolIds.delete(b.tool_use_id)) editDone = true;
      }
      if (!(editDone && agent.state === 'editing')) setState(agent, 'thinking', 'reading results');
    } else if (typeof c === 'string' || Array.isArray(c)) {
      setState(agent, 'prompted', 'new instructions');
    }
  }
}

// ---------- agent registry ----------
const agents = new Map(); // file path -> agent
let bornCounter = 0;
const startTime = Date.now();

function hashPhase(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 7;
}

function projectFromDirName(dirName) {
  const parts = dirName.split('-').filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

// files whose sprite already poofed — their mtime sits inside the activity
// window for a while, so scan() would resurrect them every ~2s otherwise.
// Maps file -> mtime at death; only a write after that revives the agent.
const deadFiles = new Map();

function ensureAgent(meta) {
  let a = agents.get(meta.file);
  if (a) return a;
  const st = safeStat(meta.file);
  if (!st) return null;
  const deadAt = deadFiles.get(meta.file);
  if (deadAt != null) {
    if (st.mtimeMs <= deadAt) return null; // still dead, stay poofed
    deadFiles.delete(meta.file); // file grew — session came back for real
  }
  retainedUsage.delete(meta.file); // a live agent re-counts its own file
  const preexisting = st.birthtimeMs < startTime - 3000;
  a = {
    file: meta.file,
    kind: meta.kind,
    sessionId: meta.sessionId,
    name: meta.kind === 'main'
      ? 'session'
      : path.basename(meta.file, '.jsonl').replace(/^agent-(.{4}).*/, 'agent-$1'),
    project: '',
    cwd: '',
    projectDir: projectFromDirName(meta.projectDir),
    offset: 0,
    buf: '',
    state: 'idle',
    detail: '',
    stateSince: st.mtimeMs,
    lastEventAt: st.mtimeMs,
    mtimeMs: st.mtimeMs,
    born: Date.now(),
    bornOrder: bornCounter++,
    preexisting,
    dyingAt: 0,
    phase: hashPhase(meta.file),
    editToolIds: new Set(),
    usageByReq: new Map(),
    byModel: new Map(),
    tok: 0,
    cost: 0,
  };
  if (preexisting) {
    a.priming = true;
    primeFromTail(a, st);
    a.priming = false;
  } else {
    logEvent(a, 'spawn', 'came to life');
  }
  agents.set(meta.file, a);
  return a;
}

// Scan a transcript from `start` for token tallies (only parsing lines that
// carry usage). `target` needs {usageByReq, byModel, tok, cost}; metadata
// fields are captured when present.
function scanUsageInto(target, file, size, start = 0) {
  const CHUNK = 1 << 22; // 4MB
  let pos = start;
  let rem = '';
  while (pos < size) {
    const want = Math.min(CHUNK, size - pos);
    const chunk = readChunk(file, pos, want);
    if (chunk == null) break;
    pos += want;
    const lines = (rem + chunk).split('\n');
    rem = lines.pop();
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      try {
        const obj = JSON.parse(line);
        addUsage(target, obj);
        if (target.kind === 'main' && obj.slug) target.name = obj.slug;
        if (obj.attributionAgent) target.name = obj.attributionAgent;
        if (obj.cwd) {
          target.cwd = obj.cwd;
          if (!target.project) target.project = path.basename(obj.cwd);
        }
      } catch { /* partial or non-json line */ }
    }
  }
}

// Usage retained from subagents that are no longer on screen — finished
// before launch, or despawned after their *poof* — so session totals stay
// complete. file -> {sessionId, usageByReq, tok, cost}
const retainedUsage = new Map();

function retainAgentUsage(a) {
  retainedUsage.set(a.file, {
    sessionId: a.sessionId,
    byModel: a.byModel,
    tok: a.tok,
    cost: a.cost,
  });
}

function sessionTotals(sessionId) {
  let tok = 0;
  let cost = 0;
  for (const a of agents.values()) {
    if (a.sessionId === sessionId) { tok += a.tok; cost += a.cost; }
  }
  for (const e of retainedUsage.values()) {
    if (e.sessionId === sessionId) { tok += e.tok; cost += e.cost; }
  }
  return { tok, cost };
}

// For files that existed before we started: skip history for animation, but
// tally the whole file (via the cache) and read a tail chunk to recover the
// agent's name and current state.
function primeFromTail(agent, st) {
  const size = st.size;
  agent.offset = size;
  tallyFile(agent, agent.file, st);
  const TAIL = 32 * 1024;
  const start = Math.max(0, size - TAIL);
  const chunk = readChunk(agent.file, start, size - start);
  if (!chunk) return;
  const lines = chunk.split('\n').filter((l) => l.trim());
  // first line of the tail may be partial; drop it unless we read from 0
  if (start > 0) lines.shift();
  // replay the tail in order so derived state (current activity, in-flight
  // edit ids) matches what live tailing would have produced; usage is
  // skipped — everything up to `size` is already in the tally
  agent.skipUsage = true;
  for (const line of lines) {
    try {
      applyLine(agent, JSON.parse(line));
    } catch { /* partial or non-json line */ }
  }
  agent.skipUsage = false;
  agent.stateSince = agent.mtimeMs;
}

function safeStat(f) {
  try { return fs.statSync(f); } catch { return null; }
}

function readChunk(file, pos, len) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// ---------- discovery ----------
function matchesFilter(dirName) {
  if (!FILTER) return true;
  return dirName.toLowerCase().includes(FILTER.replace(/\//g, '-').toLowerCase());
}

function scan() {
  const now = Date.now();
  // dead entries older than the window can't be rediscovered anyway
  for (const [f, t] of deadFiles) {
    if (now - t > ACTIVE_WINDOW_MS) deadFiles.delete(f);
  }
  let projDirs;
  try { projDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
  for (const pd of projDirs) {
    if (!pd.isDirectory() || !matchesFilter(pd.name)) continue;
    const projPath = path.join(PROJECTS_DIR, pd.name);
    let entries;
    try { entries = fs.readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(projPath, e.name);
      const st = safeStat(file);
      if (!st || now - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
      const sessionId = e.name.slice(0, -6);
      ensureAgent({ file, kind: 'main', sessionId, projectDir: pd.name });
      // subagents of an active session
      const subDir = path.join(projPath, sessionId, 'subagents');
      let subs;
      try { subs = fs.readdirSync(subDir); } catch { continue; }
      for (const s of subs) {
        if (!s.endsWith('.jsonl')) continue;
        const sf = path.join(subDir, s);
        const sst = safeStat(sf);
        if (!sst) continue;
        // a subagent that's already gone quiet is finished — don't resurrect
        // it, but tally its usage (however old) so session totals stay complete
        if (!agents.has(sf) && now - sst.mtimeMs > SUB_DONE_AFTER_MS) {
          if (!retainedUsage.has(sf)) {
            const t = { usageByReq: new Map(), byModel: new Map(), tok: 0, cost: 0 };
            tallyFile(t, sf, sst);
            retainedUsage.set(sf, { sessionId, byModel: t.byModel, tok: t.tok, cost: t.cost });
          }
          continue;
        }
        ensureAgent({ file: sf, kind: 'sub', sessionId, projectDir: pd.name });
      }
    }
  }
}

// ---------- past sessions ----------
// Finished sessions shown (greyed out) under the live tree when toggled on.
// Discovery is cheap (readdir + stat); usage tallies are scanned one file per
// tick off a queue so a deep history never freezes the render loop.
const pastSessions = new Map(); // main session file -> entry
const pastScanQueue = [];

function pastTarget(file, kind, name) {
  return {
    file, kind, name,
    project: '', cwd: '', mtimeMs: 0,
    usageByReq: new Map(), byModel: new Map(),
    tok: 0, cost: 0, scanned: false,
  };
}

function scanPastSessions() {
  const now = Date.now();
  let projDirs;
  try { projDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
  const found = [];
  for (const pd of projDirs) {
    if (!pd.isDirectory() || !matchesFilter(pd.name)) continue;
    const projPath = path.join(PROJECTS_DIR, pd.name);
    let entries;
    try { entries = fs.readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(projPath, e.name);
      if (agents.has(file)) continue; // live right now
      const st = safeStat(file);
      if (!st) continue;
      // recent and never poofed -> scan() is about to pick it up as live
      if (now - st.mtimeMs <= ACTIVE_WINDOW_MS && !deadFiles.has(file)) continue;
      found.push({ file, projectDir: pd.name, sessionId: e.name.slice(0, -6), mtimeMs: st.mtimeMs });
    }
  }
  found.sort((x, y) => y.mtimeMs - x.mtimeMs);
  if (found.length > PAST_MAX) found.length = PAST_MAX;
  const keep = new Set();
  for (const f of found) {
    keep.add(f.file);
    let p = pastSessions.get(f.file);
    if (!p) {
      p = pastTarget(f.file, 'main', f.sessionId.slice(0, 8)); // until the slug is scanned
      p.sessionId = f.sessionId;
      p.projectDir = f.projectDir;
      p.subs = new Map(); // sub file -> target
      pastSessions.set(f.file, p);
      pastScanQueue.push(p);
    }
    p.mtimeMs = f.mtimeMs;
    const subDir = path.join(PROJECTS_DIR, f.projectDir, f.sessionId, 'subagents');
    let subs;
    try { subs = fs.readdirSync(subDir); } catch { continue; }
    for (const s of subs) {
      if (!s.endsWith('.jsonl')) continue;
      const sf = path.join(subDir, s);
      if (p.subs.has(sf)) continue;
      const sst = safeStat(sf);
      if (!sst) continue;
      const t = pastTarget(sf, 'sub', s.slice(0, -6).replace(/^agent-(.{4}).*/, 'agent-$1'));
      t.mtimeMs = sst.mtimeMs;
      t.parentFile = f.file;
      p.subs.set(sf, t);
      pastScanQueue.push(t);
    }
  }
  for (const k of pastSessions.keys()) {
    if (!keep.has(k)) pastSessions.delete(k);
  }
}

// tally one queued transcript per call so the render loop stays smooth
// (cache hits are nearly free, so a cached history fills in immediately)
function processPastScans() {
  while (pastScanQueue.length) {
    const t = pastScanQueue.shift();
    if (!pastSessions.has(t.kind === 'sub' ? t.parentFile : t.file)) continue; // pruned
    const st = safeStat(t.file);
    if (!st) { t.scanned = true; continue; }
    const cached = tallyCache.get(t.file);
    const hit = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs;
    tallyFile(t, t.file, st);
    t.scanned = true;
    if (!hit) return; // an actual disk scan happened — yield until next tick
  }
}

function pastSessionTotals(p) {
  let tok = p.tok;
  let cost = p.cost;
  for (const s of p.subs.values()) { tok += s.tok; cost += s.cost; }
  return { tok, cost };
}

function sortedPastSessions() {
  return [...pastSessions.values()].sort((x, y) =>
    pastSort === 'cost'
      ? pastSessionTotals(y).cost - pastSessionTotals(x).cost
      : y.mtimeMs - x.mtimeMs
  );
}

// ---------- ingest ----------
function ingest(agent) {
  const st = safeStat(agent.file);
  if (!st) return;
  agent.mtimeMs = st.mtimeMs;
  if (st.size < agent.offset) { agent.offset = 0; agent.buf = ''; } // truncated
  if (st.size === agent.offset) return;
  const len = Math.min(st.size - agent.offset, 1 << 20); // cap 1MB per tick
  const chunk = readChunk(agent.file, agent.offset, len);
  if (chunk == null) return;
  agent.offset += Buffer.byteLength(chunk, 'utf8');
  agent.buf += chunk;
  const lines = agent.buf.split('\n');
  agent.buf = lines.pop(); // keep trailing partial line
  let sawEvent = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      applyLine(agent, JSON.parse(line));
      sawEvent = true;
    } catch { /* skip malformed line */ }
  }
  if (sawEvent) agent.lastEventAt = Date.now();
}

// ---------- session liveness (process probe) ----------
// Closing Claude Code doesn't remove its transcript — it just stops growing —
// so quiet-time alone can't tell "user stepped away" from "user quit". The
// session's process can, though: it runs a claude binary, often advertises
// its id in argv (--session-id / --resume), and keeps its cwd at the project
// root. A main session missing from two consecutive probes is closed.
const PROBE_TICKS = 42; // ~5s at TICK_MS
const liveProbe = { at: 0, ids: new Set(), cwds: new Set() };
const sessionProbe = new Map(); // sessionId -> { misses, probeSeen }
let probing = false;

function execOut(cmd, cmdArgs) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { maxBuffer: 8 << 20 }, (err, out) => {
      resolve(err && !out ? null : String(out));
    });
  });
}

async function probeProcesses() {
  if (probing || (process.platform !== 'darwin' && process.platform !== 'linux')) return;
  probing = true;
  try {
    const out = await execOut('ps', ['-axo', 'pid=,args=']);
    if (out == null) return;
    const ids = new Set();
    const pids = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)(.*)$/);
      if (!m) continue;
      const [, pid, bin, rest] = m;
      // claude *binaries* only — args mentioning claude (hooks etc.) don't count
      if (!/claude/i.test(bin) || /claude-vis/.test(bin)) continue;
      // helpers that exist without a user session
      if (/--bg-(?:spare|pty-host)\b/.test(rest) || /^\s*daemon\s/.test(rest)) continue;
      const sid = rest.match(/--(?:session-id|resume)[= ]+([0-9a-f][0-9a-f-]{35})/);
      if (sid) ids.add(sid[1]);
      pids.push(pid);
    }
    const cwds = new Set();
    if (pids.length) {
      if (process.platform === 'linux') {
        for (const pid of pids) {
          try { cwds.add(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch { /* pid gone */ }
        }
      } else {
        const lout = await execOut('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']);
        if (lout == null) return; // can't trust an empty cwd set — skip this probe
        for (const line of lout.split('\n')) {
          if (line[0] === 'n') cwds.add(line.slice(1));
        }
      }
    }
    liveProbe.ids = ids;
    liveProbe.cwds = cwds;
    liveProbe.at = Date.now();
  } finally {
    probing = false;
  }
}

// ---------- hook events (opt-in ground truth) ----------
// When `claude-vis --install-hooks` is active, Claude Code appends lifecycle
// events to HOOK_EVENTS_FILE. We tail it and track, per session, whether it
// has ended — SessionEnd is authoritative, so a hook-driven session poofs the
// instant it closes instead of waiting out the silence timers. We deliberately
// don't try to infer "a tool is running" from Pre/PostToolUse: that signal is
// per-session (it can't say *which* agent), and a rejected or failed tool
// fires PreToolUse with no PostToolUse, so a naive in-flight counter leaks and
// pins finished agents alive. An agent that's genuinely mid-tool already shows
// an active transcript state (RUN/THINK/EDIT), which lifecycle() honors on its
// own — so SessionEnd is the only hook signal we actually need.
const HOOK_FRESH_MS = 15 * 60_000;  // ignore a stale log left by an old run
const HOOK_END_GRACE_MS = 1500;     // let SessionEnd settle before the *poof*
const hookSessions = new Map(); // sid -> { lastAt, ended, endedAt }
let hookOffset = 0;

function readHookEvents() {
  const st = safeStat(HOOK_EVENTS_FILE);
  if (!st) return;
  if (st.size < hookOffset) hookOffset = 0; // log truncated/rotated under us
  if (st.size > hookOffset) {
    const chunk = readChunk(HOOK_EVENTS_FILE, hookOffset, st.size - hookOffset);
    hookOffset = st.size;
    const now = Date.now();
    for (const line of (chunk || '').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e.sid || now - (e.ts || 0) > HOOK_FRESH_MS) continue; // skip old runs
      let h = hookSessions.get(e.sid);
      if (!h) { h = { lastAt: 0, ended: false, endedAt: 0 }; hookSessions.set(e.sid, h); }
      h.lastAt = Math.max(h.lastAt, e.ts || now);
      // any event other than SessionEnd means the session is alive again
      if (e.event === 'SessionEnd') { h.ended = true; h.endedAt = e.ts || now; }
      else h.ended = false;
    }
  }
  // forget sessions that ended (or fell silent) long ago
  const cutoff = Date.now() - HOOK_FRESH_MS;
  for (const [sid, h] of hookSessions) {
    if ((h.ended && h.endedAt < cutoff) || h.lastAt < cutoff) hookSessions.delete(sid);
  }
}

// ---------- lifecycle ----------
function lifecycle() {
  const now = Date.now();
  const liveSubSessions = new Set();
  for (const a of agents.values()) {
    if (a.kind === 'sub' && !a.dyingAt) liveSubSessions.add(a.sessionId);
  }
  // Process probe → sessions whose claude process has vanished. Misses are
  // tracked per *session* (not per agent): a session's subagents run inside
  // the same process and share its id and cwd, so this protects them too —
  // a subagent can't have died while the process running it is still listed.
  // The probe must postdate the session (its cwd may not be parsed at birth).
  const closedSessions = new Set();
  const seenSessions = new Set();
  for (const a of agents.values()) {
    if (seenSessions.has(a.sessionId)) continue;
    seenSessions.add(a.sessionId);
    let cwd = '';
    let born = Infinity;
    for (const b of agents.values()) {
      if (b.sessionId !== a.sessionId) continue;
      if (!cwd && b.cwd) cwd = b.cwd;
      if (b.born < born) born = b.born;
    }
    let p = sessionProbe.get(a.sessionId);
    if (!p) { p = { misses: 0, probeSeen: 0 }; sessionProbe.set(a.sessionId, p); }
    if (cwd && liveProbe.at > Math.max(born, p.probeSeen)) {
      p.probeSeen = liveProbe.at;
      const alive = liveProbe.ids.has(a.sessionId) || liveProbe.cwds.has(cwd);
      p.misses = alive ? 0 : p.misses + 1;
    }
    if (p.misses >= 2) closedSessions.add(a.sessionId);
  }
  for (const sid of sessionProbe.keys()) {
    if (!seenSessions.has(sid)) sessionProbe.delete(sid);
  }
  for (const [file, a] of agents) {
    const quiet = now - Math.max(a.mtimeMs, a.lastEventAt);
    const gone = !safeStat(file);
    // "closed" — the session is really gone, not just quiet. SessionEnd (when
    // hooks are installed) is exact and immediate; the process probe is the
    // fallback and also catches a hard kill that never fired SessionEnd.
    const hk = hookSessions.get(a.sessionId);
    const endedByHook = hk && hk.ended && now - hk.endedAt > HOOK_END_GRACE_MS;
    const closed = endedByHook || closedSessions.has(a.sessionId);
    // an agent mid-tool or mid-generation shows an active transcript state and
    // writes nothing until the block completes — don't time it out on silence;
    // lean on `closed`, with a long backstop for anything an abrupt exit left
    // stranded in an active state.
    const active = ACTIVE_STATES.has(a.state);
    const doneAfter = a.kind === 'sub' ? SUB_DONE_AFTER_MS : MAIN_GONE_AFTER_MS;
    const quietDone = active ? quiet > ACTIVE_BACKSTOP_MS : quiet > doneAfter;
    if ((gone || closed || quietDone) && !a.dyingAt) {
      a.dyingAt = now;
      logEvent(a, 'dying', closed && !gone ? 'session closed — *poof*' : 'finished — *poof*');
    }
    if (a.dyingAt && now - a.dyingAt > DEATH_MS) {
      if (a.kind === 'sub') retainAgentUsage(a);
      const consumed = a.offset - Buffer.byteLength(a.buf, 'utf8');
      if (consumed > 0) storeCache(file, consumed, a.mtimeMs, a);
      const st = safeStat(file);
      if (st) deadFiles.set(file, st.mtimeMs);
      agents.delete(file);
      continue;
    }
    if (!a.dyingAt && quiet > IDLE_AFTER_MS) {
      // a quiet main session whose subagents are still working isn't asleep —
      // it's waiting on its team
      if (a.kind === 'main' && liveSubSessions.has(a.sessionId)) {
        if (a.state !== 'spawning') setState(a, 'spawning', 'waiting on agents');
      } else if (a.state === 'talking') {
        // only the turn-boundary state falls asleep: a quiet file in an
        // active state (thinking, running, editing…) usually means a long
        // generation or slow tool call — lines are written only when blocks
        // complete, so silence there doesn't mean idle
        setState(a, 'idle', '');
      }
    }
  }
}

// ---------- rendering ----------
let tick = 0;
const ESC = '\x1b';
const color = (code, s) => `${ESC}[${code}m${s}${ESC}[0m`;

function trunc(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}
function padEnd(s, n) { return trunc(s, n).padEnd(n); }
function padCenter(s, n) {
  s = trunc(s, n);
  const left = Math.floor((n - s.length) / 2);
  return ' '.repeat(left) + s + ' '.repeat(n - s.length - left);
}
function mmss(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
function agoStr(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function whenStr(t) {
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
}

function currentFrame(a, now) {
  let key = a.state;
  let frames;
  let idx;
  if (a.dyingAt) {
    key = 'dying';
    frames = anim.dying;
    idx = Math.min(frames.length - 1, Math.floor((now - a.dyingAt) / 260));
  } else if (!a.preexisting && now - a.born < 1200) {
    key = 'spawn';
    frames = anim.spawn;
    idx = Math.min(frames.length - 1, Math.floor((now - a.born) / 300));
  } else {
    frames = anim[key] || anim.thinking;
    idx = Math.floor((tick + a.phase) / 3) % frames.length;
  }
  return { key, frame: frames[idx] };
}

function card(a, now) {
  const inner = CARD_W - 2;
  const { key, frame } = currentFrame(a, now);
  const [label, fg] = STYLE[key] || STYLE.thinking;
  const icon = a.kind === 'main' ? '@' : '>';
  const name = trunc(`${icon} ${a.name}`, inner - 6);
  const top = `┌─ ${name} ${'─'.repeat(Math.max(0, inner - name.length - 4))}─┐`;
  const elapsed = mmss(now - a.stateSince);
  const detail = padEnd(a.dyingAt ? '*poof*' : a.detail, inner - 17);
  const stats = a.tok ? `${fmtCost(a.cost)}·${fmtTok(a.tok)}` : '';
  const proj = trunc(a.project || a.projectDir, inner - stats.length - 8);
  const bot = stats
    ? `└ ${stats} ${'─'.repeat(Math.max(0, inner - stats.length - proj.length - 5))} ${proj} ─┘`
    : `└${'─'.repeat(Math.max(0, inner - proj.length - 3))} ${proj} ─┘`;
  const b = (s) => color(fg, s);
  return [
    b(top),
    b('│') + color('97', padCenter(frame[0], inner)) + b('│'),
    b('│') + color(`1;${fg}`, padCenter(frame[1], inner)) + b('│'),
    b('│') + ` ${color(`1;${fg}`, padEnd(label, 9))}${color('37', detail)} ${color('90', elapsed)} ` + b('│'),
    b(bot),
  ];
}

// ---------- tree view ----------
function treeRow(a, prefix, now, cols, totals) {
  const { key, frame } = currentFrame(a, now);
  const [label, fg] = STYLE[key] || STYLE.thinking;
  const isMain = a.kind === 'main';
  const name = padEnd(a.name, isMain ? 25 : 27 - prefix.length);
  const sprite = padEnd(`${frame[1]}${frame[0] ? '  ' + frame[0] : ''}`, 18);
  const elapsed = mmss(now - a.stateSince);
  const detail = padEnd(a.dyingAt ? '*poof*' : a.detail, Math.max(10, cols - 94));
  const stats = (totals
    ? `Σ ${fmtCost(totals.cost)} ${fmtTok(totals.tok)}`
    : `${fmtCost(a.cost)} ${fmtTok(a.tok)}`).padStart(13);
  const proj = trunc(a.project || a.projectDir, 14);
  return ' ' + color('90', prefix) +
    color(isMain ? '1;97' : '37', name) + ' ' +
    color(`1;${fg}`, sprite) + ' ' +
    color(`1;${fg}`, padEnd(label, 9)) + ' ' +
    color('37', detail) + ' ' +
    color('33', stats) + ' ' +
    color('90', `${elapsed}  ${proj}`);
}

function pastRow(t, prefix, now, cols, totals) {
  const isMain = t.kind === 'main';
  const name = padEnd(t.name, isMain ? 25 : 27 - prefix.length);
  const sprite = padEnd(themedFace('(x_x)'), 18);
  const detail = padEnd(
    !t.scanned ? 'tallying…' : isMain ? `ended ${agoStr(now - t.mtimeMs)}` : '',
    Math.max(10, cols - 94));
  const stats = (totals
    ? `Σ ${fmtCost(totals.cost)} ${fmtTok(totals.tok)}`
    : `${fmtCost(t.cost)} ${fmtTok(t.tok)}`).padStart(13);
  const proj = trunc(t.project || (t.projectDir ? projectFromDirName(t.projectDir) : ''), 14);
  return ' ' + color('90', prefix) +
    color(isMain ? '37' : '90', name) + ' ' +
    color('90', sprite) + ' ' +
    color('90', padEnd('ENDED', 9)) + ' ' +
    color('90', detail) + ' ' +
    color('33', stats) + ' ' +
    color('90', `${padEnd(whenStr(t.mtimeMs), 6)} ${proj}`);
}

// slice a full list of content lines to the visible window at scrollY, with
// "more above/below" markers in the edge rows
function windowLines(all, maxLines) {
  scrollY = Math.max(0, Math.min(scrollY, all.length - maxLines));
  if (all.length <= maxLines) return all;
  const view = all.slice(scrollY, scrollY + maxLines);
  if (scrollY > 0) view[0] = color('90', `   ↑ ${scrollY} more…`);
  const below = all.length - scrollY - maxLines;
  if (below > 0) view[view.length - 1] = color('90', `   ↓ ${below} more…`);
  return view;
}

function buildTreeLines(now, cols, maxLines) {
  // group agents by session: main first, then its subagents
  const groups = new Map();
  for (const a of sortedAgents()) {
    let g = groups.get(a.sessionId);
    if (!g) groups.set(a.sessionId, (g = { main: null, subs: [] }));
    if (a.kind === 'main' && !g.main) g.main = a;
    else g.subs.push(a);
  }
  const out = [];
  for (const [sessionId, g] of groups) {
    if (g.main) out.push(treeRow(g.main, '@ ', now, cols, sessionTotals(sessionId)));
    else out.push(color('90', ` @ session ${sessionId.slice(0, 8)} (gone)`));
    g.subs.forEach((s, i) => {
      out.push(treeRow(s, i === g.subs.length - 1 ? '└─ ' : '├─ ', now, cols));
    });
    out.push('');
  }
  if (out[out.length - 1] === '') out.pop();
  return windowLines(out, maxLines);
}

function buildPastLines(now, cols, maxLines) {
  const out = [];
  const pushSession = (p) => {
    out.push(pastRow(p, '@ ', now, cols, pastSessionTotals(p)));
    // big agent teams would crowd out other sessions — show the priciest few
    const subs = [...p.subs.values()].sort((x, y) => y.cost - x.cost);
    const hidden = Math.max(0, subs.length - 6);
    subs.length -= hidden;
    subs.forEach((s, i) => {
      out.push(pastRow(s, i === subs.length - 1 && !hidden ? '└─ ' : '├─ ', now, cols));
    });
    if (hidden) out.push(color('90', ` └─ +${hidden} more subagents (in Σ above)`));
    out.push('');
  };
  if (pastSort === 'project') {
    // group by project directory, most recently active project first
    const groups = new Map(); // projectDir -> sessions, newest first
    for (const p of [...pastSessions.values()].sort((x, y) => y.mtimeMs - x.mtimeMs)) {
      let g = groups.get(p.projectDir);
      if (!g) groups.set(p.projectDir, (g = []));
      g.push(p);
    }
    for (const [dir, sessions] of groups) {
      const totals = sessions.map(pastSessionTotals);
      const cost = totals.reduce((s, t) => s + t.cost, 0);
      const tok = totals.reduce((s, t) => s + t.tok, 0);
      const name = sessions.find((p) => p.project)?.project || projectFromDirName(dir);
      const head = ` ─── ${name} · ${sessions.length} session${sessions.length === 1 ? '' : 's'} · Σ ${fmtCost(cost)} ${fmtTok(tok)} `;
      out.push(color('90', head + '─'.repeat(Math.max(0, cols - head.length - 1))));
      for (const p of sessions) pushSession(p);
    }
  } else {
    for (const p of sortedPastSessions()) pushSession(p);
  }
  if (out[out.length - 1] === '') out.pop();
  return windowLines(out, maxLines);
}

function sortedAgents() {
  return [...agents.values()].sort((x, y) =>
    x.sessionId === y.sessionId
      ? (x.kind === y.kind ? x.bornOrder - y.bornOrder : x.kind === 'main' ? -1 : 1)
      : x.sessionId < y.sessionId ? -1 : 1
  );
}

function buildScreen() {
  const cols = process.stdout.columns || parseInt(process.env.COLUMNS, 10) || 100;
  const rows = process.stdout.rows || parseInt(process.env.LINES, 10) || 30;
  const now = Date.now();
  const list = sortedAgents();
  const sessions = new Set(list.map((a) => a.sessionId)).size;

  // reserve space for the activity ticker on tall enough terminals; the past
  // view has no live activity to show, so it gets the whole screen
  const tickerH = viewMode !== 'past' && rows >= 18 ? Math.min(6, 1 + Math.floor((rows - 12) / 2)) : 0;

  const lines = [];
  const title = color('1;96', ' *  claude-vis');
  const mode = color('36', `[${viewMode}]`);
  let stats;
  if (viewMode === 'past') {
    let totTok = 0;
    let totCost = 0;
    for (const p of pastSessions.values()) {
      const t = pastSessionTotals(p);
      totTok += t.tok;
      totCost += t.cost;
    }
    const n = pastSessions.size;
    stats = color('90', `${n} past session${n === 1 ? '' : 's'} · by ${pastSort} · ${fmtCost(totCost)} · ${fmtTok(totTok)} tok · ${new Date().toLocaleTimeString()}`);
  } else {
    const liveSessionIds = new Set(list.map((a) => a.sessionId));
    let totTok = list.reduce((s, a) => s + a.tok, 0);
    let totCost = list.reduce((s, a) => s + a.cost, 0);
    for (const e of retainedUsage.values()) {
      if (liveSessionIds.has(e.sessionId)) { totTok += e.tok; totCost += e.cost; }
    }
    stats = color('90', `${sessions} session${sessions === 1 ? '' : 's'} · ${list.length} agent${list.length === 1 ? '' : 's'} · ${fmtCost(totCost)} · ${fmtTok(totTok)} tok · ${new Date().toLocaleTimeString()}`);
  }
  lines.push(`${title} ${mode}  ${stats}`);
  lines.push('');

  if (viewMode === 'past') {
    if (pastSessions.size === 0) {
      lines.push(color('90', '   no past sessions found yet…'));
      lines.push(color('90', '   (scanning ~/.claude/projects for finished transcripts)'));
    } else {
      lines.push(...buildPastLines(now, cols, Math.max(1, rows - 4)));
    }
  } else if (list.length === 0) {
    lines.push(color('90', '   waiting for Claude to wake up…'));
    lines.push(color('90', `   (watching ~/.claude/projects for sessions active in the last ${Math.round(ACTIVE_WINDOW_MS / 60000)}m)`));
  } else if (viewMode === 'tree') {
    lines.push(...buildTreeLines(now, cols, Math.max(1, rows - 4 - tickerH)));
  } else {
    const perRow = Math.max(1, Math.floor((cols + 1) / (CARD_W + 1)));
    const maxRows = Math.max(1, Math.floor((rows - 4 - tickerH) / 6));
    const visible = list.slice(0, perRow * maxRows);
    for (let i = 0; i < visible.length; i += perRow) {
      const rowCards = visible.slice(i, i + perRow).map((a) => card(a, now));
      for (let l = 0; l < 5; l++) lines.push(rowCards.map((c) => c[l]).join(' '));
      lines.push('');
    }
    if (visible.length < list.length) lines.push(color('90', `   +${list.length - visible.length} more…`));
  }

  if (tickerH > 0) {
    while (lines.length < rows - 1 - tickerH) lines.push('');
    lines.length = rows - 1 - tickerH;
    lines.push(color('90', ` ─── activity ${'─'.repeat(Math.max(0, cols - 15))}`));
    const recent = ticker.slice(-(tickerH - 1));
    for (const e of recent) {
      const [label, fg] = STYLE[e.state] || STYLE.running;
      const time = new Date(e.t).toLocaleTimeString();
      lines.push(
        ` ${color('90', padEnd(time, 11))} ${color('1;37', padEnd(e.agent.name, 15))} ` +
        `${color(fg, padEnd(label, 9))} ${color('37', padEnd(e.detail, Math.max(10, cols - 56)))} ` +
        color('90', trunc(e.agent.project || e.agent.projectDir, 14))
      );
    }
  }
  while (lines.length < rows - 1) lines.push('');
  lines.length = rows - 1;
  lines.push(color('90', viewMode === 'past'
    ? ` q quit · p back to live · s sort (${pastSort}) · t theme · j/k scroll · ${pricesSource} prices`
    : ` q quit · v grid/tree · p past · t theme · j/k scroll · ${pricesSource} prices · *poof* = done`));
  overlayThemeMenu(lines, cols);
  return lines;
}

// theme picker: a small modal box drawn over the screen; moving the cursor
// previews the theme live on the sprites behind it
function overlayThemeMenu(lines, cols) {
  if (themeMenu < 0) return;
  const face = (name, f) => (THEMES[name] && THEMES[name][f]) || f;
  const body = THEME_NAMES.map((name, i) => ({
    sel: i === themeMenu,
    txt: `${i === themeMenu ? ' > ' : '   '}${padEnd(name, 8)} ` +
      `${padEnd(face(name, '(o_o)'), 9)}${padEnd(face(name, '(>_<)') + '/[=]', 13)}` +
      `${padEnd(face(name, '(^o^)'), 9)}${face(name, '(x_x)')}`,
  }));
  const hint = '   ↑↓ choose · enter keep · esc cancel';
  const inner = Math.max(hint.length, ...body.map((r) => r.txt.length)) + 2;
  const rows = [
    color('90', `┌─ sprite theme ${'─'.repeat(Math.max(0, inner - 16))}┐`),
    ...body.map((r) =>
      color('90', '│') + color(r.sel ? '1;96' : '37', padEnd(r.txt, inner)) + color('90', '│')),
    color('90', '│' + ' '.repeat(inner) + '│'),
    color('90', '│') + color('90', padEnd(hint, inner)) + color('90', '│'),
    color('90', `└${'─'.repeat(inner)}┘`),
  ];
  const left = ' '.repeat(Math.max(1, Math.floor((cols - inner - 2) / 2)));
  const start = Math.min(2, Math.max(0, lines.length - rows.length));
  rows.forEach((r, i) => { lines[start + i] = left + r; });
}

function draw() {
  const lines = buildScreen();
  process.stdout.write(`${ESC}[H` + lines.map((l) => l + `${ESC}[K`).join('\n') + `${ESC}[J`);
}

// ---------- main ----------
function handleKey(k) {
  if (themeMenu >= 0) { // picker is open and owns the keyboard
    const n = THEME_NAMES.length;
    if (k === 'j' || k === `${ESC}[B`) themeMenu = (themeMenu + 1) % n;
    else if (k === 'k' || k === `${ESC}[A`) themeMenu = (themeMenu + n - 1) % n;
    else if (k === '\r' || k === '\n' || k === ' ') { themeMenu = -1; savePrefs(); } // keep preview
    else if (k === ESC || k === 't' || k === 'q') { setTheme(themeBefore); themeMenu = -1; }
    else if (k === '\x03') cleanup();
    else return;
    if (themeMenu >= 0) setTheme(THEME_NAMES[themeMenu]); // live preview
    draw();
    return;
  }
  if (k === 'q' || k === '\x03') cleanup();
  if (k === 'v') {
    viewMode = liveView = viewMode === 'grid' ? 'tree' : 'grid';
    scrollY = 0;
    savePrefs();
    draw();
  }
  if (k === 't') {
    themeBefore = theme;
    themeMenu = THEME_NAMES.indexOf(theme);
    draw();
  }
  if (k === 'p') {
    if (viewMode === 'past') {
      viewMode = liveView;
    } else {
      liveView = viewMode;
      viewMode = 'past';
      scanPastSessions();
    }
    scrollY = 0;
    savePrefs();
    draw();
  }
  if (k === 's') {
    pastSort = pastSort === 'date' ? 'cost' : pastSort === 'cost' ? 'project' : 'date';
    scrollY = 0;
    savePrefs();
    draw();
  }
  // scrolling: vim keys, arrows, page keys, mouse wheel (SGR buttons 64/65)
  const half = Math.max(1, Math.floor((process.stdout.rows || 30) / 2));
  let delta = 0;
  if (k === 'j' || k === `${ESC}[B`) delta = 1;
  if (k === 'k' || k === `${ESC}[A`) delta = -1;
  if (k === '\x04' || k === `${ESC}[6~`) delta = half;  // ctrl-d / PgDn
  if (k === '\x15' || k === `${ESC}[5~`) delta = -half; // ctrl-u / PgUp
  if (k === 'g') { scrollY = 0; draw(); }
  if (k === 'G') { scrollY = Number.MAX_SAFE_INTEGER; draw(); } // clamped at render
  const wheel = k.match(/^\x1b\[<(6[45]);/);
  if (wheel) delta = wheel[1] === '64' ? -3 : 3;
  if (delta) { scrollY = Math.max(0, scrollY + delta); draw(); }
}

function cleanup() {
  cacheLiveAgents();
  saveCache();
  if (!ONCE) process.stdout.write(`${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
  process.exit(0);
}

function main() {
  scan();
  for (const a of agents.values()) ingest(a);
  readHookEvents();

  if (ONCE) {
    if (viewMode === 'past') {
      scanPastSessions();
      while (pastScanQueue.length) processPastScans();
    }
    lifecycle();
    console.log(buildScreen().join('\n'));
    cacheLiveAgents();
    saveCache();
    return;
  }

  loadLivePrices(); // async — repricing kicks in when (and if) the fetch lands
  probeProcesses(); // async — liveness verdicts apply as probes land
  if (viewMode === 'past') scanPastSessions();

  // alt screen, hidden cursor, mouse button reporting (SGR) for wheel scroll
  process.stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[?1000h${ESC}[?1006h`);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      // batched input (key repeat, wheel bursts) lands in one chunk — split
      // it into mouse reports, CSI sequences, and single keys
      const keys = d.toString().match(/\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) || [];
      for (const k of keys) handleKey(k);
    });
  }

  setInterval(() => {
    tick++;
    if (tick % 17 === 1) scan();                       // discover new agents ~2s
    if (tick % PROBE_TICKS === 2) probeProcesses();    // session liveness ~5s
    if (tick % 4 === 3) readHookEvents();              // tail hook events ~0.5s
    if (viewMode === 'past' && tick % 17 === 9) scanPastSessions(); // refresh past list ~2s
    if (viewMode === 'past') processPastScans();       // tally one transcript per tick
    if (tick % 250 === 7) { cacheLiveAgents(); saveCache(); } // persist tallies ~30s
    if (tick % 2 === 0) for (const a of agents.values()) ingest(a); // tail ~4/s
    lifecycle();
    draw();
  }, TICK_MS);
}

if (!HOOK_EMIT_MODE) main(); // --hook-emit stays in its stdin handler and exits
