#!/usr/bin/env node
// Regenerate the README's terminal screenshots (assets/*.svg).
//
// Renders real `claude-vis --once` frames against a synthetic fixture of
// placeholder projects and sessions — nothing is read from the local
// ~/.claude/projects — then converts the ANSI output to SVG.
//
// usage: node scripts/readme-svgs.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets');

// ---------- fixture ----------
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vis-demo-'));
const now = Date.now();

// last transcript line -> sprite state
const FINAL = {
  delegate: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'dig into the docs' } }],
  edit: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/w/foo.test.ts' } }],
  run: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }],
  talk: [{ type: 'text', text: 'Looks good overall, two small nits in the diff.' }],
  think: null, // a user tool_result line -> THINK "reading results"
};

let reqCounter = 0;
function writeTranscript(file, { slug, agent, cwd, reqs, state, agoSec }) {
  const meta = { cwd };
  if (slug) meta.slug = slug;
  if (agent) meta.attributionAgent = agent;
  const lines = [];
  for (let i = 0; i < reqs; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      requestId: `req-${reqCounter++}`,
      ...meta,
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 2000, output_tokens: 900, cache_read_input_tokens: 150000, cache_creation_input_tokens: 9000 },
        content: [{ type: 'thinking' }],
      },
    }));
  }
  const content = FINAL[state];
  lines.push(content
    ? JSON.stringify({ type: 'assistant', ...meta, message: { model: 'claude-sonnet-4-6', content } })
    : JSON.stringify({ type: 'user', ...meta, message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const t = (now - agoSec * 1000) / 1000;
  fs.utimesSync(file, t, t);
}

function session({ project, id, slug, state, reqs, agoSec, subs = [] }) {
  const dirName = `-Users-demo-src-${project}`;
  const cwd = `/Users/demo/src/${project}`;
  writeTranscript(path.join(fixture, dirName, `${id}.jsonl`), { slug, cwd, reqs, state, agoSec });
  subs.forEach((s, i) => {
    writeTranscript(path.join(fixture, dirName, id, 'subagents', `agent-${id.slice(0, 4)}${i}.jsonl`),
      { agent: s.name, cwd, reqs: s.reqs, state: s.state, agoSec: s.agoSec ?? agoSec });
  });
}

// one live session with a little team, for the grid + tree shots
session({
  project: 'rocket-shop', id: '11111111-aaaa-4bbb-8ccc-000000000001',
  slug: 'brisk-juggling-comet', state: 'delegate', reqs: 38, agoSec: 14,
  subs: [
    { name: 'researcher', reqs: 9, state: 'think', agoSec: 2 },
    { name: 'test-writer', reqs: 5, state: 'edit', agoSec: 1 },
    { name: 'reviewer', reqs: 7, state: 'talk', agoSec: 5 },
  ],
});

// finished sessions, for the past-view shots
session({
  project: 'rocket-shop', id: '22222222-aaaa-4bbb-8ccc-000000000002',
  slug: 'snoozing-purple-walrus', state: 'talk', reqs: 88, agoSec: 12 * 60,
  subs: [
    { name: 'engineer', reqs: 27, state: 'talk' },
    { name: 'test-writer', reqs: 13, state: 'talk' },
  ],
});
session({
  project: 'todo-app', id: '33333333-aaaa-4bbb-8ccc-000000000003',
  slug: 'quiet-painting-meadow', state: 'talk', reqs: 57, agoSec: 3 * 3600,
  subs: [{ name: 'researcher', reqs: 18, state: 'talk' }],
});
session({
  project: 'rocket-shop', id: '44444444-aaaa-4bbb-8ccc-000000000004',
  slug: 'floating-mango-sunrise', state: 'talk', reqs: 49, agoSec: 26 * 3600,
  subs: [
    { name: 'engineer', reqs: 12, state: 'talk' },
    { name: 'doc-writer', reqs: 8, state: 'talk' },
  ],
});

// ---------- frame capture ----------
function frame(args, cols) {
  return execFileSync('node', [path.join(ROOT, 'index.js'), '--once', ...args], {
    // point config/cache at the throwaway fixture so the maintainer's local
    // prefs (theme, view, sort) can't leak into the screenshots — shots must
    // render the defaults (people theme, date sort) deterministically
    env: {
      ...process.env,
      CLAUDE_VIS_PROJECTS_DIR: fixture,
      XDG_CONFIG_HOME: path.join(fixture, '.config'),
      XDG_CACHE_HOME: path.join(fixture, '.cache'),
      COLUMNS: String(cols),
    },
    encoding: 'utf8',
  });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// drop the (empty in --once) activity section and the padding above the footer
function tidy(raw) {
  const lines = raw.replace(/\n+$/, '').split('\n');
  const footer = lines.pop();
  const act = lines.findIndex((l) => stripAnsi(l).includes('─── activity'));
  if (act >= 0) lines.length = act;
  while (lines.length && stripAnsi(lines[lines.length - 1]).trim() === '') lines.pop();
  return [...lines, '', footer];
}

// ---------- ansi -> svg ----------
const FG = '#c9d1d9';
const PALETTE = {
  30: '#484f58', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922',
  34: '#58a6ff', 35: '#bc8cff', 36: '#39c5cf', 37: '#b1bac4',
  90: '#6e7681', 91: '#ff7b72', 92: '#3fb950', 93: '#e3b341',
  94: '#58a6ff', 95: '#bc8cff', 96: '#56d4dd', 97: '#f0f6fc',
};

function lineRuns(line) {
  const runs = [];
  let fg = FG;
  let bold = false;
  let idx = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > idx) runs.push({ text: line.slice(idx, m.index), fg, bold });
    for (const c of (m[1] || '0').split(';')) {
      if (c === '' || c === '0') { fg = FG; bold = false; }
      else if (c === '1') bold = true;
      else if (PALETTE[c]) fg = PALETTE[c];
    }
    idx = re.lastIndex;
  }
  if (idx < line.length) runs.push({ text: line.slice(idx), fg, bold });
  return runs;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toSvg(lines) {
  const CW = 7.85;   // monospace char advance at 13px
  const LH = 19;
  const FS = 13;
  const PADX = 18;
  const PADY = 12;
  const CHROME = 30; // traffic-light bar
  const cols = Math.max(...lines.map((l) => stripAnsi(l).length));
  const w = Math.ceil(cols * CW + PADX * 2);
  const h = Math.ceil(lines.length * LH + PADY * 2 + CHROME);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace" font-size="${FS}">`,
    `<rect width="${w}" height="${h}" rx="8" fill="#0d1117"/>`,
    '<circle cx="20" cy="16" r="6" fill="#ff5f57"/>',
    '<circle cx="40" cy="16" r="6" fill="#febc2e"/>',
    '<circle cx="60" cy="16" r="6" fill="#28c840"/>',
  ];
  lines.forEach((line, i) => {
    const runs = lineRuns(line).filter((r) => r.text);
    if (!runs.length) return;
    const spans = runs.map((r) =>
      `<tspan fill="${r.fg}"${r.bold ? ' font-weight="bold"' : ''}>${esc(r.text)}</tspan>`).join('');
    out.push(`<text x="${PADX}" y="${CHROME + PADY + i * LH + FS}" xml:space="preserve">${spans}</text>`);
  });
  out.push('</svg>');
  return out.join('\n') + '\n';
}

// ---------- main ----------
// files must be >3s old for claude-vis to treat them as preexisting sessions
// (fresh files would render the spawn animation instead of their real state)
setTimeout(() => {
  fs.mkdirSync(OUT, { recursive: true });
  const shots = {
    'grid.svg': [[], 100], // 100 cols -> two cards per row
    'tree.svg': [['--tree'], 120],
    'past.svg': [['--past'], 120],
    'past-project.svg': [['--past', '--sort', 'project'], 120],
  };
  for (const [name, [args, cols]] of Object.entries(shots)) {
    fs.writeFileSync(path.join(OUT, name), toSvg(tidy(frame(args, cols))));
    console.log(`wrote assets/${name}`);
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}, 4000);
