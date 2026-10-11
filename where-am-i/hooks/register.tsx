import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import type { Parked } from '../types'

const goal = atom({ plugin: 'where-am-i', key: 'goal' } as const, '')
const now = atom({ plugin: 'where-am-i', key: 'now' } as const, '')
const parked = atom({ plugin: 'where-am-i', key: 'parked' } as const, null)
const isHidden = atom({ plugin: 'where-am-i', key: 'isHidden' } as const, false)

const firstLine = (text: string, max = 90) => {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const doing = (e: Record<string, unknown>) => {
  const tool = String(e.tool).replace(/^mcp__.+?__/, '')
  const arg = [e.description, e.command, e.file_path, e.pattern, e.query].find((v): v is string => typeof v === 'string' && v.length > 0)
  const shown = arg === e.file_path && arg ? arg.split('/').pop() : arg

  return shown ? `${tool}: ${firstLine(shown, 50)}` : tool
}

// Parked notes are per working directory
const parkKey = async ($: EngineInterface) => `park:${await $.session.cwd()}`

async function branch($: EngineInterface): Promise<string> {
  const r = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 3000 }).catch(() => undefined)

  return r?.exitCode === 0 ? r.stdout.trim() : ''
}

const ago = (ms: number) => {
  const h = Math.round(ms / 3_600_000)

  return h < 1 ? 'just now' : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'goal', description: "Set this session's goal shown above the prompt; /goal clear, /goal hide" })
    await $.command.register({ name: 'park', description: 'Save where you left off in this folder: /park [note]; shown when you come back. /park clear' })
    const saved = (await $.store.get(await parkKey($)).catch(() => undefined)) as Parked | undefined
    if (saved?.note || saved?.goal) {
      await update($, parked, () => saved)
      if (!(await read($, goal))) await update($, goal, () => saved.goal)
      track($, 'where-am-i', 'parked-shown', {})
    }

    return next(e)
  })

  on('command.run', { command: 'goal' }, async ($, e) => {
    count($, 'command.run')
    const arg = e.args.trim()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')

      return { text: `where-am-i band ${arg === 'hide' ? 'hidden' : 'shown'}.` }
    }
    if (arg === 'clear') {
      await update($, goal, () => '')

      return { text: 'Goal cleared; your next prompt sets it.' }
    }
    if (arg) await update($, goal, () => firstLine(arg))

    return { text: `Goal: ${(await read($, goal)) || 'not set'}` }
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    count($, 'command.run')
    const key = await parkKey($)
    if (e.args.trim() === 'clear') {
      await $.store.delete(key)
      await update($, parked, () => null)

      return { text: 'Parked note cleared.' }
    }
    const note: Parked = { note: e.args.trim(), goal: await read($, goal), branch: await branch($), at: await $.clock.now() }
    await $.store.set(key, note)
    track($, 'where-am-i', 'park', {})

    return { text: `Parked${note.branch ? ` on ${note.branch}` : ''}: ${note.note || note.goal || '(no note)'}. It shows here next time you open this folder.` }
  })

  on('prompt.submit', async ($, e, next) => {
    count($, 'prompt.submit')
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !e.text.trim().startsWith('/')) {
      if (!(await read($, goal))) await update($, goal, () => firstLine(e.text))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    if (e.agentId === undefined) await update($, now, () => doing(e as unknown as Record<string, unknown>))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId === undefined) await update($, now, () => '')

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    count($, 'ui.render')
    const g = await read($, goal)
    const p = await read($, parked)
    if (e.props.hasSurvey || (await read($, isHidden)) || (!g && !p)) return next(e)
    const doingNow = await read($, now)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const at = p ? await $.clock.now() : 0
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {p && (
          <Box flexDirection="row" gap={1} width={width}>
            <Text color="cyan" wrap="truncate-end">
              Parked {ago(at - p.at)}
              {p.branch ? ` on ${p.branch}` : ''}: {p.note || p.goal}
            </Text>
            <Button key="unpark" label="Done" role="dismiss" onPress={() => update($, parked, () => null)} />
          </Box>
        )}
        {g && (
          <Box flexDirection="row" width={width}>
            <Text wrap="truncate-end">
              <Text bold>Goal</Text> {g} <Text dimColor>· {e.props.isWorking ? `now ${doingNow || 'thinking'}` : 'your turn'}</Text>
            </Text>
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
