# god-mods

Claude Code mods: hooks modules that change Claude's interface and behaviour, published as the `god-mods` plugin marketplace.

## Install

In Claude Code:

```
/plugin marketplace add KZ-HQ/god-mods
/plugin install context-gauge@god-mods
```

Install the mods you want one by one. Restart Claude Code (a full restart; `/reload-plugins` does not load new mod code) for them to take effect.

## Mods

| Mod | What it does |
| --- | --- |
| compact-carry | After a compaction, appends a short note (under ~400 tokens): the branch, the last request (first 200 chars), open todos and up to 12 files recently read or edited. Records the note's size and how many carried files Claude re-read in the 5 turns after, so `/mod-stats` shows whether it helps |
| context-gauge | Band above the prompt: context fill, last turn's cost, session cost plus this session's subagent cost (`+ agents $…`, a list-price estimate from subagent transcripts), and rate limits. In the last 10 minutes of the 1h prompt cache it counts down, and once lapsed it shows what the next message pays to re-write it; `/gauge` toggles it. Tallies tool-result size per file (~chars/4); the band names the biggest, a one-time toast fires when one file passes 30k tokens or 20% of context, and `/hogs` lists the top 10 |
| long-turn-notify | macOS notification when a long turn finishes, a turn dies on an API error, or Claude needs your input, in terminal sessions; records failed tool calls and API errors (kinds only) |
| merge-gate | Holds `gh pr merge` until CI passes on the PR head; `/gate` runs the project's CI steps locally |
| mod-stats | `/mod-stats [days] [here]`: what each mod did, cost and saved; labels each active, stale or dormant (loaded but never used: a removal candidate); hook time per mod; tokens mods added to context. Also watches the other mods' hooks and records any that fail, time out or are refused, toasting at a mod's third fault in a session. At session start it toasts any mod newly dormant for a week (secret-scrubber exempt) or with a hook call over 2s. It sees only mods beneath it: put `mod-stats@god-mods` first in `enabledPlugins` |
| next-steps | Suggests 2–3 likely next prompts after each turn; press 1/2/3 to draft one; `/next off` |
| prompt-shaper | Attaches git state to a prompt when it changed; adds a project-toolchain note to the system prompt. Records each time Claude runs `git status` itself, so `/mod-stats` shows whether the note saves those checks |
| secret-scrubber | Masks API keys and tokens in tool output, and refuses to write them into source files |
| test-on-edit | When Claude's answer ends, runs the tests of the files it edited; failures go to Claude with your next prompt; refuses deleting or disabling tests (skip, xfail, only), flags dropped cases |

## Plugin order

Installed mods nest in the order of `enabledPlugins` in `~/.claude/settings.json`, first outermost; a plugin can't choose its place. mod-stats only sees faults and hook time in mods beneath it, so keep it first:

```json
"enabledPlugins": {
  "mod-stats@god-mods": true,
  "context-gauge@god-mods": true,
  ...
}
```

Plugins installed later are appended, so they land beneath it. Reinstalling mod-stats moves it to the end again; its start-up toast and `/mod-stats` name any mods it can't see.

## Metrics

Every mod appends local JSON lines to `~/.claude/mods/metrics.jsonl`; nothing leaves your machine. Rows (schema `v: 2`) carry `t`, `mod`, `event`, `ver`, `session` and `project`:

- `loaded`: once per session start, with the mod's version
- `turn`: once per turn, counting each hook's calls, e.g. `{"tool.call": 3, "command.run{goal}": 1}`
- anything else: an outcome the mod recorded, e.g. merge-gate's `verdict`

Rows hold counts, kinds and lengths only, never prompt, command or tool-input text. `/mod-stats` summarises them. mod-stats adds a `fault` row per failed hook, naming the mod and event, and a `latency` row per turn with each mod's own hook time (rows from before 0.6.0 carry `mod: "mod-faults"`).

## Development

Each mod is a folder with `.claude-plugin/plugin.json` and `hooks/register.tsx`, plus tests in `tests/`.

The metrics code lives once in `shared/metrics.ts` and is inlined into every `register.tsx` between `// <metrics>` markers, because the engine only lets `$` into functions declared in the same file. Edit the shared file, then:

```bash
shared/sync.sh          # inline into every mod
shared/sync.sh --check  # fail if any copy is stale
```

Check a mod before committing:

```bash
claude plugin validate <mod>
claude plugin test <mod>
```

Bump the mod's version in its `plugin.json` and in `.claude-plugin/marketplace.json` together.
