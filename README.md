# claude-vis

Watch your Claude Code agents come to life in the terminal. Every live session
and subagent gets a little animated sprite that thinks `.oO(?)`, reads `(o_o)[#]`,
types `(>_<)/[=]`, runs commands `(o_o)>_`, and goes `*poof*` when it finishes.

<img alt="claude-vis grid view: four animated agent cards — a main session delegating work plus researcher, test-writer, and reviewer subagents — each with its state, current activity, and running cost" src="assets/grid.svg" width="820">

## Install

```sh
brew install turleynerd/tap/claude-vis
```

Self-contained binary (macOS/Linux, arm64/x64) — no Node required. Running
from a source checkout with `node index.js` (Node ≥18) works too.

## Usage

```sh
claude-vis                       # watch everything active in the last 5 min
claude-vis --project rocket      # only sessions whose project path matches
claude-vis --window 15           # widen the activity window to 15 minutes
claude-vis --tree                # start in tree view
claude-vis --past                # start in the past-sessions view
claude-vis --sort cost           # order past sessions by cost instead of date
claude-vis --sort project        # group past sessions by project directory
claude-vis --theme cats          # sprite theme (see Themes below)
claude-vis --once                # print one frame and exit (no TUI)
claude-vis --install-hooks       # opt into exact liveness signals (see below)
claude-vis --uninstall-hooks     # remove them again
```

Keys: `v` toggles grid/tree, `p` toggles the past-sessions view, `t` opens
the sprite-theme picker (arrow keys to preview live, enter to keep, esc to
cancel), `s` cycles past ordering (date / cost / project), `q` quits. The
tree and past views scroll with `j`/`k`, the arrow keys, or the mouse wheel —
`ctrl-d`/`ctrl-u` and PgDn/PgUp jump half a page, `g`/`G` jump to top/bottom.

View, sort, and theme choices persist across launches (in
`~/.config/claude-vis/config.json`); command-line flags override them.

## Tree view

The tree nests each subagent under the session that spawned it, with one row
per agent: sprite, state, what it's doing right now, and a running cost — the
`Σ` on the session row spans the whole team.

<img alt="claude-vis tree view: a session row with Σ cost followed by indented researcher, test-writer, and reviewer rows, each with its own state and cost" src="assets/tree.svg" width="980">

The bottom of the screen also shows a live activity ticker of recent events
(tool calls, spawns, finishes) across all agents.

## Past sessions

Press `p` for your history: the most recent finished sessions (capped at 15)
in the same tree layout — when each ended, what it cost in dollars and
tokens, and its priciest subagents nested under it.

<img alt="claude-vis past view: greyed-out finished sessions, each showing when it ended, Σ cost and tokens, and its subagents with their own tallies" src="assets/past.svg" width="980">

Sorting by project (`s`, or `--sort project`) groups sessions by directory
and rolls the cost up into the group headers — a quick answer to "what has
each project cost me lately?":

<img alt="claude-vis past view grouped by project: rocket-shop and todo-app headers with per-project session counts and Σ cost, sessions listed under each" src="assets/past-project.svg" width="980">

Past tallies are scanned lazily — one transcript per tick — so a deep history
never stalls the animation.

## Costs

Every tally is computed from the `usage` blocks in the agent's transcript,
deduped by request ID, with cache reads/writes priced separately. Pre-existing
sessions are scanned in full at startup, so totals reflect the whole session,
not just what happened since launch.

Per-transcript token sums are cached in `~/.cache/claude-vis/` (validated by
file size + mtime), so relaunching doesn't rescan your whole history — a
transcript that grew resumes scanning where the last run stopped. Only token
counts are cached; costs are recomputed at load, so price updates apply
retroactively.

Per-model prices are fetched at launch from [LiteLLM](https://github.com/BerriAI/litellm)'s
community-maintained [model pricing sheet](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
(there is no official Anthropic pricing API — thanks to the LiteLLM folks for
keeping this data current), and existing tallies are repriced when the fetch
lands. If the fetch fails or a model isn't listed yet, a built-in per-family
table is used instead — the footer shows whether `live` or `static` prices
are in effect.

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

## Themes

Not a people person? `--theme <name>`, or press `t` for a picker that
previews each theme live on your running agents. A theme re-skins every
sprite — the animations, props, and *poof* stay the same:

| Theme    | Working   | Editing       | Happy     | Done      |
| -------- | --------- | ------------- | --------- | --------- |
| `people` | `(o_o)`   | `(>_<)/[=]`   | `(^o^)`   | `(x_x)`   |
| `bots`   | `[o_o]`   | `[>_<]/[=]`   | `[^o^]`   | `[=__]` (low battery) |
| `cats`   | `(=o.o=)` | `(=>.<=)/[=]` | `(=^o^=)` | `(=x.x=)` |
| `owls`   | `{o,o}`   | `{>,<}/[=]`   | `{^,^}`   | `{x,x}`   |
| `ghosts` | `(~o_o)~` | `(~>_<)~/[=]` | `(~^o^)~` | `(~x_x)~` |

## How it works

Claude Code writes session transcripts as JSONL to `~/.claude/projects/`
(subagents get their own files under `<session-id>/subagents/`). claude-vis
tails those files and animates each agent based on the latest event — no
config and no changes needed in the session being watched (hooks are an
optional accuracy upgrade, see below).

### Knowing when an agent is *really* gone

Claude only writes a transcript line when a block finishes, so a long `Bash`
call, a slow tool, or a big generation leaves the file silent for minutes —
silence alone can't tell "still working" from "quit". claude-vis resolves it
in two layers:

1. **Process probe.** Every ~5s it checks the process table for the session's
   claude process — by `--session-id`/`--resume` in argv, or a claude binary
   whose cwd is the project root. Two consecutive misses means the session
   closed (detected within ~10s). The check is tracked per *session*, so it
   covers subagents too: a subagent runs inside its parent's process, so it
   can't have died while that process is still listed.
2. **State-aware timers.** An agent caught mid-work (thinking, editing,
   running a tool, or waiting on its subagents) is never timed out on silence
   alone — only a confirmed process exit ends it. Only agents at a turn
   boundary fall back to timers: subagents despawn after 90s of quiet, main
   sessions after 10 minutes. A long backstop clears anything an abrupt exit
   left stranded mid-state.

This is why a subagent blocked on a slow `npm test` no longer *poofs* as
"finished" while it's actually still running.

### Exact signals via hooks (optional)

The above is all heuristics over transcripts and the process table — no setup
required. If you want ground truth instead of inference, run:

```sh
claude-vis --install-hooks
```

This registers small hooks in `~/.claude/settings.json` (`SessionStart`,
`SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`) that shell back into
`claude-vis --hook-emit <Event>` and append one compact line to
`~/.cache/claude-vis/hook-events.jsonl`. A running claude-vis tails that log
and, for any session it sees there, ends it the instant `SessionEnd` fires
instead of waiting out the silence timer — so a closed session poofs at once.
(There are deliberately no per-tool hooks: those would spawn a process on
every tool call, and an agent that's mid-tool already shows an active state
on its own.) Existing settings are preserved, a `.claude-vis.bak` backup is
written, and `--uninstall-hooks` removes only the entries claude-vis added and
deletes the event log. The hooks take effect for *new* Claude Code sessions;
sessions started without them keep using the probe-and-timer fallback.

Set `CLAUDE_VIS_PROJECTS_DIR` to watch a directory other than
`~/.claude/projects` (handy for demos and testing). The screenshots above are
real frames rendered against a synthetic fixture of placeholder projects —
regenerate them with `node scripts/readme-svgs.js`.
