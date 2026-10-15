import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import type { Spend } from '../types'
import { costliest, groups, parse, summary } from './spend.ts'
import type { Group } from './spend.ts'

const PANE = 'agent-spend'
const spend = atom({ plugin: 'agent-spend', key: 'spend' } as const, null)

// <metrics: generated from shared/metrics.ts by shared/sync.sh>
// Shared mod metrics (schema v2). Source of truth: ~/.claude/mods/shared/metrics.ts.
// shared/sync.sh inlines it between the metrics markers in each mod's register.tsx (the engine only lets $
// into functions declared in the same file). Edit here, run sync.sh, never edit an inlined copy.
//
// Rows appended to ~/.claude/mods/metrics.jsonl, all with { v: 2, t, mod, event, ver, session, project }:
//   loaded   once per load (logLoaded, or count() in the mod's session.start hook), at session.start: proves which version of the mod is running
//   turn     once per turn with activity (logTurns, or count() in the mod's turn.complete hook): { hooks: { <event>: calls } }
//   <other>  outcome rows from track(), e.g. merge-gate 'verdict'
// Privacy: never put prompt, command, tool-input or matched-secret text in a row; lengths, kinds and counts only.

const APPEND = 'mkdir -p "$HOME/.claude/mods" && printf "%s\\n" "$1" >> "$HOME/.claude/mods/metrics.jsonl"'


const ctx = { ver: '', session: '', project: '' }
const stats = new Map<string, number>()
let writeFailed = false

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

function write($: EngineInterface, mod: string, event: string, data: Record<string, unknown>): void {
  void (async () => {
    const t = new Date(await $.clock.now()).toISOString()
    if (!ctx.project) ctx.project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? ''
    const line = JSON.stringify({ v: 2, t, mod, event, ver: ctx.ver, session: ctx.session, project: ctx.project, ...data })
    const { exitCode, stderr } = await $.process.run(['/bin/sh', '-c', APPEND, 'mod-metrics', line], { timeoutMs: 3000 })
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
  })().catch((err: unknown) => {
    if (writeFailed) return
    writeFailed = true
    $.ui.toast(`${mod}: metrics write failed (${message(err)})`)
  })
}

// An outcome row: something the mod decided or did. Fire-and-forget.
function track($: EngineInterface, mod: string, event: string, data: Record<string, unknown> = {}): void {
  write($, mod, event, data)
}

async function loaded($: EngineInterface): Promise<void> {
  const mod = $.plugin.name
  ctx.session = await $.session.id().catch(() => '')
  ctx.project = ''
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    ctx.ver = manifest.version ?? ''
  } catch {
    ctx.ver = '?'
  }
  write($, mod, 'loaded', {})
}

function flush($: EngineInterface): void {
  const mod = $.plugin.name
  if (!stats.size) return
  const hooks = Object.fromEntries(stats)
  stats.clear()
  write($, mod, 'turn', { hooks })
}

// The engine allows one hook per event per plugin, and counts them by spelling. A mod that hooks
// session.start or turn.complete itself calls count() in that hook, which writes the row; otherwise
// it calls the matching helper once in register.
function logLoaded(on: On): void {
  on('session.start', async ($, e, next) => {
    await loaded($)

    return next(e)
  })
}

function logTurns(on: On): void {
  on('turn.complete', async ($, e, next) => {
    flush($)

    return next(e)
  })
}

// First statement of every hook: counts the call into this turn's row. The engine only accepts
// function literals as hooks, so calls are counted from inside rather than by wrapping.
// In a session.start hook it also writes the loaded row; in a turn.complete hook it writes the turn row.
function count($: EngineInterface, event: string): void {
  stats.set(event, (stats.get(event) ?? 0) + 1)
  if (event === 'session.start') void loaded($)
  if (event === 'turn.complete') flush($)
}
// </metrics>

// <money: generated from shared/money.ts by shared/sync.sh>
// US dollars: three decimals under $1, where cents hide the cost of a cheap call; two from $1
function usd(n: number): string {
  return `$${Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)}`
}
// </money>

// The folder a session or worktree belongs to: a worktree under <repo>/.claude/worktrees counts as the repo
const projectOf = (cwd: string) => cwd.split('/.claude/worktrees/')[0].split('/').filter(Boolean).pop() ?? ''

async function scan($: EngineInterface, days: number, project: string): Promise<Spend> {
  const r = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/scan.py`, String(days)], { timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `scan exited ${r.exitCode}`)
  const agents = parse(r.stdout).filter(a => !project || a.project === project)
  track($, 'agent-spend', 'scanned', { days, agents: agents.length, here: !!project })

  return { agents, days, project }
}

export const register: Register = on => {
  logTurns(on)

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'spend', description: 'Subagent spend by model and agent type: /spend [days] [here]' })

    return next(e)
  })

  on('command.run', { command: 'spend' }, async ($, e) => {
    count($, 'command.run{spend}')
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const days = Math.max(1, Number(args.find(a => /^\d+$/.test(a)) ?? 7))
    const project = args.includes('here') ? projectOf(await $.session.cwd()) : ''
    try {
      const s = await scan($, days, project)
      await update($, spend, () => s)
      void $.ui.open({ id: PANE, title: 'Agent spend' }).catch(() => undefined)

      return { text: summary(s.agents, s.days, s.project) }
    } catch (err) {
      return { text: `agent-spend: could not read subagent transcripts (${err instanceof Error ? err.message : String(err)}).` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    count($, 'ui.render')
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, spend)
    if (!s) return <Text dimColor>Run /spend [days] [here] to scan subagent spend.</Text>
    if (!s.agents.length) return <Text dimColor>{summary(s.agents, s.days, s.project)}</Text>
    const total = s.agents.reduce((n, a) => n + a.usd, 0)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 14)
    const row = (g: Group, key: string) => (
      <Text key={key}>
        {g.name.padEnd(16)} {String(g.agents).padStart(4)} {usd(g.usd).padStart(8)} <Text dimColor>{String(g.share).padStart(3)}%</Text>
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text bold>
          {usd(total)} · {s.agents.length} agents · last {s.days}d{s.project ? ` · ${s.project}` : ''}
        </Text>
        <Text dimColor>By model</Text>
        {groups(s.agents, 'tier').map(g => row(g, `m-${g.name}`))}
        <Text dimColor>By agent type</Text>
        {groups(s.agents, 'type').map(g => row(g, `t-${g.name}`))}
        <Text dimColor>Costliest</Text>
        {costliest(s.agents, room).map((a, i) => (
          <Text key={`c-${i}`} wrap="truncate">
            {usd(a.usd).padStart(7)} {a.tier.padEnd(6)} {a.type} <Text dimColor>{a.desc}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
