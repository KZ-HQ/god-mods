import type { EngineInterface, Register } from 'claude-code'

import { SECRET_STORE, isExample, scrub } from './patterns.ts'

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

type Block = { type: string; text?: string; content?: unknown; [k: string]: unknown }

// A tool_result's content is a string or a list of blocks; only text is touched
function scrubContent(content: unknown, kinds: Set<string>): unknown {
  if (typeof content === 'string') {
    const s = scrub(content)
    s.kinds.forEach(k => kinds.add(k))

    return s.text
  }
  if (Array.isArray(content)) {
    return content.map((b: Block) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return b
      const s = scrub(b.text)
      s.kinds.forEach(k => kinds.add(k))

      return { ...b, text: s.text }
    })
  }

  return content
}

export const register: Register = on => {
  // Tool output, before the model reads it or the transcript stores it
  on('session.append', async ($, e, next) => {
    if (e.door !== 'tool-result') return next(e)
    const kinds = new Set<string>()
    const content = (e.message.content as unknown as Block[]).map(b =>
      b.type === 'tool_result' ? { ...b, content: scrubContent(b.content, kinds) } : b,
    )
    if (kinds.size === 0) return next(e)
    track($, 'secret-scrubber', 'masked', { kinds: [...kinds] })
    $.ui.toast(`secret-scrubber: masked ${[...kinds].join(', ')} in tool output`)

    return next({ ...e, message: { ...e.message, content: content as never } })
  })

  // A key written into source ends up in git; it belongs in an env file
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Write' && e.tool !== 'Edit') return next(e)
    const path = String(e.file_path)
    if (SECRET_STORE.test(path) || isExample(path)) return next(e)
    const text = e.tool === 'Write' ? String(e.content) : String(e.new_string)
    const { kinds } = scrub(text)
    const real = kinds.filter(k => k !== 'assigned')
    if (real.length === 0) return next(e)
    track($, 'secret-scrubber', 'blocked', { kinds: real, tool: e.tool })

    return {
      deny:
        `secret-scrubber: this ${e.tool} puts a ${real.join(', ')} key into ${path}. ` +
        'Read it from an environment variable (.env / .dev.vars, or the platform secret store) instead of writing the value into source.',
    }
  })
}
