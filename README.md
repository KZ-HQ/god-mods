# god-mods

Claude Code mods: hooks modules that change Claude's interface and behaviour, published as the `god-mods` plugin marketplace.

## Install

In Claude Code:

```
/plugin marketplace add KZ-HQ/god-mods
/plugin install danger-guard@god-mods
```

Install the mods you want one by one. Restart Claude Code (a full restart; `/reload-plugins` does not load new mod code) for them to take effect.

## Mods

| Mod | What it does |
| --- | --- |
| agent-fleet | Pane of running background agents: task, elapsed time, tokens, current tool, with a Stop button; `/fleet` |
| context-gauge | Band above the prompt: context fill, last turn's cost, session cost and rate limits; `/gauge` toggles it |
| danger-guard | Holds risky shell commands and writes to protected data, previews what they would change, and asks before they run |
| limit-guard | Asks before starting agents when the 5h/weekly usage window is nearly spent, records what a usage-limit cut-off stopped; `/limit-guard:resume` continues it |
| long-turn-notify | macOS notification when a long turn finishes or Claude needs your input, in terminal sessions |
| merge-gate | Holds `gh pr merge` until CI passes on the PR head; `/gate` runs the project's CI steps locally |
| mod-stats | `/mod-stats [days]`: what each mod did, cost and saved, and how often it faulted |
| mod-faults | Passive: records any god-mod hook that fails, times out or is refused, and toasts at a mod's third fault in a session; `/mod-faults`. It sees only mods beneath it: put `mod-faults@god-mods` first in `enabledPlugins` (that order is the chain order) |
| next-steps | Suggests 2–3 likely next prompts after each turn; press 1/2/3 to draft one; `/next off` |
| prompt-shaper | Expands your shorthand and attaches git state to each prompt; adds a project-toolchain note to the system prompt |
| search-router | Steers web search to Exa and scraping to Firecrawl, and fails over when either runs out of credits; `/search-router` |
| secret-scrubber | Masks API keys and tokens in tool output, and refuses to write them into source files |
| test-on-edit | When Claude's answer ends, runs the tests of the files it edited; failures go to Claude with your next prompt |
| topic-drift | Band that suggests a fresh session when a prompt drifts off the session's topic |
| worktree-janitor | Lists agent worktrees with their PR state and removes merged ones on your say-so; `/worktrees` |

## Plugin order

Installed mods nest in the order of `enabledPlugins` in `~/.claude/settings.json`, first outermost; a plugin can't choose its place. mod-faults only sees faults in mods beneath it, so keep it first:

```json
"enabledPlugins": {
  "mod-faults@god-mods": true,
  "agent-fleet@god-mods": true,
  ...
}
```

Plugins installed later are appended, so they land beneath it. Reinstalling mod-faults moves it to the end again; its start-up toast and `/mod-faults` name any mods it can't see.

## Metrics

Every mod appends local JSON lines to `~/.claude/mods/metrics.jsonl`; nothing leaves your machine. Rows (schema `v: 2`) carry `t`, `mod`, `event`, `ver`, `session` and `project`:

- `loaded`: once per session start, with the mod's version
- `turn`: once per turn, counting each hook's calls, e.g. `{"tool.call": 3, "command.run{goal}": 1}`
- anything else: an outcome the mod recorded, e.g. merge-gate's `verdict`

Rows hold counts, kinds and lengths only, never prompt, command or tool-input text. `/mod-stats` summarises them. mod-faults adds a `fault` row per failed hook, naming the mod and event; it no longer writes `~/.claude/logs/god-mods-faults.jsonl`, which can be deleted.

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
