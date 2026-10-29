import type { EngineInterface, On, Register } from 'claude-code'

import { deletedTests, caseCount, isTestPath, newDisablers } from './fake-green.ts'
import { candidates, parents, runner, summary } from './find.ts'

const TIMEOUT_MS = 60_000

// Test files running now: an edit while its test still runs adds nothing
const running = new Set<string>()
let isOn = true
// Files edited this turn, and failures waiting for the next prompt
const edited = new Set<string>()
let pending: string | undefined
// Fake-green flags (tests removed from a file), also waiting for the next prompt
const flags: string[] = []

async function project($: EngineInterface, root: string, rel: string) {
  let modRoot: string | undefined
  for (const dir of parents(rel)) {
    if (await $.fs.exists(`${root}/${dir}/.claude-plugin/plugin.json`).catch(() => false)) {
      modRoot = dir
      break
    }
  }
  if (modRoot === undefined && (await $.fs.read(`${root}/${rel}`).catch(() => '')).includes(`'claude-code/testing'`)) modRoot = parents(rel)[0] ?? ''
  const hasUvLock = await $.fs.exists(`${root}/uv.lock`).catch(() => false)
  let deps: string[] = []
  try {
    const pkg = JSON.parse(await $.fs.read(`${root}/package.json`)) as { dependencies?: object; devDependencies?: object }
    deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
  } catch {
    // No package.json
  }

  return { hasUvLock, deps, modRoot }
}

type Result = { test: string; ok: boolean; note: string }

async function findTest($: EngineInterface, path: string, root: string): Promise<string | undefined> {
  for (const c of candidates(path, root)) if (await $.fs.exists(c).catch(() => false)) return c

  return undefined
}

async function runTest($: EngineInterface, test: string, root: string): Promise<Result | undefined> {
  if (running.has(test)) return undefined
  running.add(test)
  const rel = test.startsWith(`${root}/`) ? test.slice(root.length + 1) : test
  const command = runner(rel, await project($, root, rel))
  const started = await $.clock.now()
  try {
    const r = await $.process.run(['/bin/zsh', '-lc', command], { cwd: root, timeoutMs: TIMEOUT_MS })
    const secs = Math.round(((await $.clock.now()) - started) / 1000)

    return r.exitCode === 0
      ? { test: rel, ok: true, note: `${rel} passes (${secs}s)` }
      : { test: rel, ok: false, note: `${rel} FAILS (exit ${r.exitCode}, \`${command}\`):\n${summary(`${r.stdout}\n${r.stderr}`)}` }
  } catch (err) {
    return { test: rel, ok: false, note: `${rel} could not run within ${TIMEOUT_MS / 1000}s (${err instanceof Error ? err.message : String(err)})` }
  } finally {
    running.delete(test)
  }
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

// <git: generated from shared/git.ts by shared/sync.sh>
// The git top level of cwd (the session's folder when omitted); undefined outside a repository or when git fails
async function repoRoot($: EngineInterface, cwd?: string): Promise<string | undefined> {
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { ...(cwd ? { cwd } : {}), timeoutMs: 5000 }).catch(() => undefined)

  return r && r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
}
// </git>

const WHY = 'Fix the code under test instead, or ask the user to approve this (they can also run /test-on-edit off).'

// A deny reason when the call deletes or disables tests; flags (to the next prompt) when it only drops cases
async function fakeGreen($: EngineInterface, e: { tool: string; [k: string]: unknown }): Promise<string | undefined> {
  if (e.tool === 'Bash') {
    const gone = deletedTests(String(e.command ?? ''))
    if (gone.length === 0) return undefined
    track($, 'test-on-edit', 'fake-green', { action: 'blocked', kind: 'delete', files: gone.length, tool: 'Bash' })

    return `test-on-edit: refusing to delete test file${gone.length > 1 ? 's' : ''} ${gone.join(', ')}. ${WHY}`
  }
  if (e.tool !== 'Edit' && e.tool !== 'Write') return undefined
  const path = String(e.file_path)
  if (!isTestPath(path)) return undefined
  const before = e.tool === 'Edit' ? String(e.old_string ?? '') : await $.fs.read(path).catch(() => '')
  const after = e.tool === 'Edit' ? String(e.new_string ?? '') : String(e.content ?? '')
  const kinds = newDisablers(before, after)
  if (kinds.length > 0) {
    track($, 'test-on-edit', 'fake-green', { action: 'blocked', kind: kinds, tool: e.tool })

    return `test-on-edit: refusing to disable tests in ${path} (${kinds.join(', ')}). ${WHY}`
  }
  const removed = caseCount(before) - caseCount(after)
  if (removed > 0) {
    track($, 'test-on-edit', 'fake-green', { action: 'flagged', kind: 'removed', cases: removed, tool: e.tool })
    flags.push(`test-on-edit: ${path} lost ${removed} test case${removed > 1 ? 's' : ''} in an edit last turn. If they were not obsolete, restore them and fix the code instead.`)
  }

  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'test-on-edit', description: 'Run the edited file\'s tests after each edit: /test-on-edit off | on' })

    return next(e)
  })

  on('command.run', { command: 'test-on-edit' }, async ($, e) => {
    count($, 'command.run{test-on-edit}')
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') isOn = arg === 'on'

    return { text: `${isOn ? 'on' : 'off for this session'}.` }
  })

  // Before a test is deleted or disabled: refuse. Otherwise only note which files changed
  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    if (isOn) {
      const reason = await fakeGreen($, e)
      if (reason) return { deny: reason }
    }
    const ran = await next(e)
    if (isOn && (e.tool === 'Edit' || e.tool === 'Write') && ran.deny === undefined && !ran.isError) edited.add(String(e.file_path))

    return ran
  })

  // When Claude's answer ends: run each edited file's tests once, off the turn's path
  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId !== undefined || edited.size === 0 || !isOn) return done
    const paths = [...edited]
    edited.clear()
    void (async () => {
      const cwd = await $.session.cwd()
      const root = (await repoRoot($, cwd)) ?? cwd
      const tests = new Set<string>()
      for (const p of paths) {
        const t = await findTest($, p, root)
        if (t) tests.add(t)
      }
      if (tests.size === 0) return
      $.ui.status(`test-on-edit: running ${tests.size} test file${tests.size > 1 ? 's' : ''}…`)
      const results = (await Promise.all([...tests].map(t => runTest($, t, root)))).filter((r): r is Result => !!r)
      const failed = results.filter(r => !r.ok)
      track($, 'test-on-edit', 'run', { files: results.length, failed: failed.length })
      if (failed.length === 0) {
        pending = undefined
        $.ui.status(undefined)
        $.ui.toast(`test-on-edit: ${results.length} test file${results.length > 1 ? 's' : ''} pass`)

        return
      }
      pending = `test-on-edit ran the tests for files edited last turn, and some fail:\n\n${failed.map(r => r.note).join('\n\n')}`
      $.ui.status(`test-on-edit: ${failed.length} failing (${failed.map(r => r.test.split('/').pop()).join(', ')}); Claude sees it with your next prompt`)
      $.ui.toast(`test-on-edit: ${failed.map(r => r.test).join(', ')} failing`)
    })().catch(() => $.ui.status(undefined))

    return done
  })

  // Hand failures to Claude with the next prompt, once
  on('prompt.submit', async ($, e, next) => {
    count($, 'prompt.submit')
    if ((!pending && flags.length === 0) || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return next(e)
    const note = [pending, ...flags].filter(Boolean).join('\n\n')
    pending = undefined
    flags.length = 0
    $.ui.status(undefined)
    track($, 'test-on-edit', 'delivered', { chars: note.length })

    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))
}
