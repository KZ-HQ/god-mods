import type { EngineInterface, On, Register } from 'claude-code'

const MAX_FILES = 12
const MAX_TODOS = 8
const TASK_CHARS = 200
const MAX_NOTE = 1500 // chars, roughly 400 tokens
const WATCH_TURNS = 5 // turns after a compaction in which re-reads of carried files are counted
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Todo = { content?: string; status?: string }

async function branchName($: EngineInterface): Promise<string> {
  try {
    const r = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 3000 })

    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// The note Claude sees after compaction; undefined when there is nothing worth carrying.
function buildNote(files: string[], task: string, todos: Todo[], branch: string): string | undefined {
  const open = todos.filter(t => t.status !== 'completed' && t.content).slice(0, MAX_TODOS)
  if (!files.length && !task && !open.length) return undefined
  const lines = ['Carried across compaction (working state just before it):']
  if (branch) lines.push(`Branch: ${branch}`)
  if (task) lines.push(`Last request: ${clip(task.replace(/\s+/g, ' ').trim(), TASK_CHARS)}`)
  if (open.length) lines.push('Open todos:', ...open.map(t => `- [${t.status === 'in_progress' ? '>' : ' '}] ${clip(t.content ?? '', 120)}`))
  if (files.length) lines.push(`Recent files (newest first): ${files.join(', ')}`)

  return clip(lines.join('\n'), MAX_NOTE)
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

let files: string[] = [] // most recent first
let task = ''
let todos: Todo[] = []
// After a compaction: carried files not yet re-read, and turns left to watch
let watch: { carried: number; pending: Set<string>; turns: number } | undefined

// Writes the outcome row for the watch window after a compaction, if one is open
function finishWatch($: EngineInterface): void {
  if (!watch) return
  track($, 'compact-carry', 'reread', { carried: watch.carried, reread: watch.carried - watch.pending.size, turns: WATCH_TURNS - watch.turns })
  watch = undefined
}

export const register: Register = on => {
  files = []
  task = ''
  todos = []
  watch = undefined

  // A new session (start, /clear, resume) starts with nothing carried
  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    files = []
    task = ''
    todos = []
    watch = undefined

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    count($, 'prompt.submit')
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') task = e.text

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    if (e.agentId !== undefined) return next(e)
    const input = e as unknown as { file_path?: string; notebook_path?: string; todos?: Todo[] }
    if (e.tool === 'TodoWrite' && Array.isArray(input.todos)) todos = input.todos
    const path = input.file_path ?? input.notebook_path
    if (FILE_TOOLS.has(e.tool) && typeof path === 'string') {
      files = [path, ...files.filter(f => f !== path)].slice(0, MAX_FILES)
      if (e.tool === 'Read' && watch) watch.pending.delete(path)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    if (watch && --watch.turns <= 0) finishWatch($)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    count($, 'session.compact')
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    const result = await next(e)
    if (result.skip !== undefined) return result
    finishWatch($)
    const note = buildNote(files, task, todos, await branchName($))
    if (!note) {
      track($, 'compact-carry', 'carry', { trigger: e.trigger, chars: 0 })

      return result
    }
    const open = todos.filter(t => t.status !== 'completed').length
    track($, 'compact-carry', 'carry', { trigger: e.trigger, chars: note.length, files: files.length, todos: open, task: task.length > 0 })
    watch = { carried: files.length, pending: new Set(files), turns: WATCH_TURNS }

    return { ...result, messages: [...result.messages, { role: 'user' as const, text: note, toolUses: [] }] }
  })
}
