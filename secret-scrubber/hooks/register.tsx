import type { EngineInterface, On, Register } from 'claude-code'

import { SECRET_STORE, isExample, scrub } from './patterns.ts'

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

  // Tool output, before the model reads it or the transcript stores it
  on('session.append', async ($, e, next) => {
    count($, 'session.append')
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
    count($, 'tool.call')
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
