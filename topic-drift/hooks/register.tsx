import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { overlap, words } from './words.ts'

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

// Below this share of known words, from the third prompt on, the prompt counts as a new topic
const DRIFT_BELOW = 0.15
const MIN_WORDS = 4
const FROM_PROMPT = 3

const drift = atom({ plugin: 'topic-drift', key: 'drift' } as const, null)

export const register: Register = on => {
  // Rebuilt from scratch on a reload: a reload costs one prompt's worth of history
  let vocab = new Set<string>()
  let prompts = 0

  on('prompt.submit', async ($, e, next) => {
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
    vocab = new Set()
    prompts = 0
    await update($, drift, () => null)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
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
