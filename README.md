# claude-vis

Watch your Claude Code agents come to life in the terminal. Every live session
and subagent gets a little animated sprite that thinks `.oO(?)`, reads `(o_o)[#]`,
types `(>_<)/[=]`, runs commands `(o_o)>_`, and goes `*poof*` when it finishes.

```
┌─ @ calm-waddling-harbor ─────────┐ ┌─ > test-writer ──────────────────┐
│             .oO ( ? )            │ │               $ /                │
│              (o_O)               │ │             (o_o)>_              │
│ THINK   reading results    00:05 │ │ RUN     Bash npm test      00:02 │
└───────────────────── claude-vis ─┘ └───────────────────── claude-vis ─┘
```

## Install

```sh
brew install turleynerd/tap/claude-vis
```

Self-contained binary (macOS/Linux, arm64/x64) — no Node required. Running
from a source checkout with `node index.js` (Node ≥18) works too.

## How it works

Claude Code writes session transcripts as JSONL to `~/.claude/projects/`
(subagents get their own files under `<session-id>/subagents/`). claude-vis
tails those files and animates each agent based on the latest event — no
hooks, no config, and no changes needed in the session being watched.

## Usage

```sh
claude-vis                       # watch everything active in the last 5 min
claude-vis --project claude-vis  # only sessions whose project path matches
claude-vis --window 15           # widen the activity window to 15 minutes
claude-vis --tree                # start in tree view
claude-vis --past                # start in the past-sessions view
claude-vis --sort cost           # order past sessions by cost instead of date
claude-vis --sort project        # group past sessions by project directory
claude-vis --once                # print one frame and exit (no TUI)
```

Keys: `t` toggles between the sprite grid and a relationship tree that nests
each subagent under the session that spawned it; `p` switches to the
past-sessions view (and back); `s` cycles past ordering through date, cost,
and project (grouped by directory, with per-project session counts and cost
totals in the group headers); `q` quits. The tree and past views scroll with `j`/`k`, the arrow keys, or the
mouse wheel (`ctrl-d`/`ctrl-u` and PgDn/PgUp jump half a page, `g`/`G` jump to
top/bottom).

```
 @ happy-demo-session    \(o_o)/ *   DELEGATE  Task dig into the docs  00:14
 ├─ researcher           (o_O) .oO   THINK     reading results         00:02
 ├─ test-writer          (>_<)/[=]   EDIT      Edit foo.test.ts        00:01
 └─ reviewer             (^o^)       TALK      Looks good overall, tw… 00:05
```

The past view replaces the live grid/tree and activity ticker with the most
recent finished sessions (capped at 15), each with its end time, total cost,
and its priciest subagents nested under it:

```
 @ mutable-beaming-flame  (x_x)      ENDED     ended 2h ago   Σ $136 201.2m
 ├─ engineer              (x_x)      ENDED                      $3.08 6.43m
 └─ +12 more subagents (in Σ above)
```

Past tallies are scanned lazily — one transcript per tick — so a deep history
never stalls the animation.

The bottom of the screen shows a live activity ticker of recent events
(tool calls, spawns, finishes) across all agents.

Each agent also shows a running token/cost tally (`$3.31·609.5k`) computed
from the `usage` blocks in its transcript, deduped by request ID, with cache
reads/writes priced separately. Pre-existing sessions are scanned in full at
startup, so tallies reflect the whole session, not just what happened since
launch.

Per-model prices are fetched at launch from LiteLLM's community pricing data
(there is no official Anthropic pricing API) and existing tallies are repriced
when the fetch lands. If the fetch fails or a model isn't listed yet, a
built-in per-family table is used instead — the footer shows whether `live`
or `static` prices are in effect.

Set `CLAUDE_VIS_PROJECTS_DIR` to watch a directory other than
`~/.claude/projects` (handy for demos and testing).

## States

| Sprite        | State    | Trigger                                      |
| ------------- | -------- | -------------------------------------------- |
| `.oO(?) (o_O)`| THINK    | thinking block, or processing a tool result   |
| `(o_o) [#]`   | READ     | Read / Grep / Glob / WebFetch / WebSearch     |
| `(>_<)/[=]`   | EDIT     | Edit / Write / NotebookEdit                   |
| `(o_o)>_`     | RUN      | Bash and other tools                          |
| `\(o_o)/ *`   | DELEGATE | Task / Agent (spawning a subagent)            |
| `(^o^) "..."` | TALK     | streaming a text response                     |
| `(-_-) zZz`   | IDLE     | no transcript activity for 20s                |
| `(x_x)`       | DONE     | agent finished — sprite poofs away            |

A session *poofs* as soon as its Claude process disappears from the process
table (closing Claude is detected within ~10s, via `--session-id`/`--resume`
in argv or a claude binary whose cwd is the project root). Sessions whose
process can't be identified fall back to timers: subagents despawn after 90s
of silence, main sessions after 10 minutes.
