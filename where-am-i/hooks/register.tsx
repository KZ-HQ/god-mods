import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Parked } from '../types'

// One JSON line per mod event in ~/.claude/mods/metrics.jsonl; /mod-stats reads it.
// Local only. Fire-and-forget: a failed write never blocks the hook that tracked it,
// but the first failure per load is surfaced as a toast instead of vanishing.
const APPEND = 'mkdir -p "$HOME/.claude/mods" && printf "%s\\n" "$1" >> "$HOME/.claude/mods/metrics.jsonl"'
let trackFailed = false

function track($: EngineInterface, mod: string, event: string, data: Record<string, unknown> = {}): void {
  void (async () => {
    const t = new Date(await $.clock.now()).toISOString()
    const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? ''
    const line = JSON.stringify({ t, mod, event, project, ...data })
    const { exitCode, stderr } = await $.process.run(['/bin/sh', '-c', APPEND, 'mod-metrics', line], { timeoutMs: 3000 })
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
  })().catch((err: unknown) => {
    if (trackFailed) return
    trackFailed = true
    $.ui.toast(`${mod}: metrics write failed (${err instanceof Error ? err.message : String(err)})`)
  })
}

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
    if ((e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !e.text.trim().startsWith('/')) {
      if (!(await read($, goal))) await update($, goal, () => firstLine(e.text))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) await update($, now, () => doing(e as unknown as Record<string, unknown>))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await update($, now, () => '')

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
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
