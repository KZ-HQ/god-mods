import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import { overlap, words } from './words.ts'

// Below this share of known words, from the third prompt on, the prompt counts as a new topic
const DRIFT_BELOW = 0.15
const MIN_WORDS = 4
const FROM_PROMPT = 3

const drift = atom({ plugin: 'topic-drift', key: 'drift' } as const, null)

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
  logLoaded(on)
  logTurns(on)

  // Rebuilt from scratch on a reload: a reload costs one prompt's worth of history
  let vocab = new Set<string>()
  let prompts = 0

  on('prompt.submit', async ($, e, next) => {
    count($, 'prompt.submit')
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if (e.text.trim().startsWith('/')) return next(e)
    const mine = words(e.text)
    prompts += 1
    const share = overlap(mine, vocab)
    const isDrift = prompts >= FROM_PROMPT && mine.size >= MIN_WORDS && share < DRIFT_BELOW
    if (isDrift) track($, 'topic-drift', 'shown', { overlap: share })
    await update($, drift, () => (isDrift ? { overlap: share, prompt: e.text } : null))
    for (const w of mine) vocab.add(w)

    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear starts a new topic by definition
  on('session.end', async ($, e, next) => {
    count($, 'session.end')
    vocab = new Set()
    prompts = 0
    await update($, drift, () => null)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    count($, 'ui.render')
    const d = await read($, drift)
    if (d === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} width={Math.max(20, e.props.bodyColumns)}>
          <Text color="yellow" wrap="truncate-end">
            New topic? This prompt shares {Math.round(d.overlap * 100)}% of its words with the session. A fresh session keeps context small.
          </Text>
          <Button
            key="copy"
            label="Copy prompt"
            onPress={async press => {
              track($, 'topic-drift', 'copied', {})
              await $.ui.copy({ text: d.prompt, surface: press.surface })
              $.ui.toast('topic-drift: prompt copied; start a new session and paste it')
            }}
          />
          <Button key="dismiss" label="Dismiss" role="dismiss" onPress={() => {
              track($, 'topic-drift', 'dismissed', {})

              return update($, drift, () => null)
            }} />
        </Box>
        {below}
      </Box>
    )
  })
}
