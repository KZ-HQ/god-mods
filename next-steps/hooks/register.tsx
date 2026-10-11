import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import { SYSTEM, parse, prompt } from './suggest.ts'

// The smallest model: one short call per answered turn
const MODEL = 'claude-haiku-5-5'
const OFF_KEY = 'off'

const suggestions = atom({ plugin: 'next-steps', key: 'suggestions' } as const, [])

const isOff = async ($: EngineInterface) => (await $.store.get(OFF_KEY).catch(() => false)) === true

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
  let lastAsked = ''

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'next', description: 'Next-prompt suggestions after each turn: /next off | on' })

    return next(e)
  })

  on('command.run', { command: 'next' }, async ($, e) => {
    count($, 'command.run{next}')
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') {
      await $.store.set(OFF_KEY, arg === 'off')
      if (arg === 'off') await update($, suggestions, () => [])
    }

    return { text: `next-steps is ${(await isOff($)) ? 'off' : 'on'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    count($, 'prompt.submit')
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') lastAsked = e.text
    await update($, suggestions, () => [])

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !e.answer.trim() || (await isOff($))) return done

    // Off the turn's path: the suggestions arrive a moment after the answer
    void (async () => {
      const r = await $.model.complete({ model: MODEL, system: SYSTEM, prompt: prompt(lastAsked, e.answer), maxTokens: 120, timeoutMs: 15_000 })
      const u = r.usage
      track($, 'next-steps', 'shown', { ok: r.isAnswered, usd: u ? (u.input_tokens * 0.1 + u.output_tokens * 0.5) / 1e6 : 0, tokens: u ? u.input_tokens + u.output_tokens : 0 })
      if (r.isAnswered) await update($, suggestions, () => parse(r.text))
    })().catch(() => undefined)

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    count($, 'ui.render')
    const list = await read($, suggestions)
    if (list.length === 0 || e.props.hasSurvey || e.props.isWorking) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const below = await next(e)

    const width = Math.max(20, e.props.bodyColumns)

    // One row per suggestion so long ones wrap instead of being cut off
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} width={width}>
          <Text dimColor>Next (press a number, 0 hides):</Text>
          <Button key="hide" hotkey="0" plain label="✕" role="dismiss" onPress={() => update($, suggestions, () => [])} />
        </Box>
        {list.map((s, i) => (
          <Box key={`row${i + 1}`} flexDirection="row" gap={1} width={width}>
            <Button
              key={`s${i + 1}`}
              hotkey={String(i + 1)}
              label={String(i + 1)}
              onPress={async () => {
                track($, 'next-steps', 'clicked', { n: i + 1 })
                await $.prompt.fill({ text: s, mode: 'replace' })
                await update($, suggestions, () => [])
              }}
            />
            <Text wrap="wrap">{s}</Text>
          </Box>
        ))}
        {below}
      </Box>
    )
  })
}
