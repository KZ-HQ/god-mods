import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { SYSTEM, parse, prompt } from './suggest.ts'

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

// The smallest model: one short call per answered turn
const MODEL = 'claude-haiku-5-5'
const OFF_KEY = 'off'

const suggestions = atom({ plugin: 'next-steps', key: 'suggestions' } as const, [])

const isOff = async ($: EngineInterface) => (await $.store.get(OFF_KEY).catch(() => false)) === true

export const register: Register = on => {
  let lastAsked = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'next', description: 'Next-prompt suggestions after each turn: /next off | on' })

    return next(e)
  })

  on('command.run', { command: 'next' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') {
      await $.store.set(OFF_KEY, arg === 'off')
      if (arg === 'off') await update($, suggestions, () => [])
    }

    return { text: `next-steps is ${(await isOff($)) ? 'off' : 'on'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') lastAsked = e.text
    await update($, suggestions, () => [])

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
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
