import type { EngineInterface, On, Register } from 'claude-code'

import { MCP_MERGE, judge, mergeFromMcp, parseMerge, stepsFromMakefile, stepsFromPackage, stepsFromWorkflow } from './steps.ts'
import type { Check, Merge, Step } from './steps.ts'
import { buildNote, isPrCreate, isTestCommand, lineDelta, prUrl, withNote } from './note.ts'

const NOTE_OFF_KEY = 'prNoteOff'
const work = { tests: { runs: 0, pass: 0, fail: 0 }, added: 0, removed: 0 }
const STEP_TIMEOUT_MS = 10 * 60 * 1000
const FAIL_TAIL_LINES = 25
const MERGE = 'Merge anyway'
const HOLD = "Don't merge"

const join = (root: string, rel: string) => (rel === '.' || rel === '' ? root : rel.startsWith('/') ? rel : `${root}/${rel.replace(/^\.\//, '')}`)

// Where the steps come from, first match wins: .claude/gate.json, CI workflows, Makefile, package.json.
async function findSteps($: EngineInterface, root: string): Promise<{ source: string; steps: Step[] }> {
  const read = (p: string) => $.fs.read(`${root}/${p}`).catch(() => undefined)

  const custom = await read('.claude/gate.json')
  if (custom) {
    const parsed = JSON.parse(custom) as { steps?: Step[] }

    return { source: '.claude/gate.json', steps: (parsed.steps ?? []).map(s => ({ ...s, cwd: s.cwd ?? '.' })) }
  }

  const flows = (await $.fs.list(`${root}/.github/workflows`).catch(() => [])).filter(f => /\.ya?ml$/.test(f.name)).map(f => f.name).sort()
  const fromFlows: Step[] = []
  for (const f of flows) fromFlows.push(...stepsFromWorkflow((await read(`.github/workflows/${f}`)) ?? ''))
  if (fromFlows.length) return { source: `.github/workflows (${flows.join(', ')})`, steps: fromFlows }

  const make = await read('Makefile')
  if (make && stepsFromMakefile(make).length) return { source: 'Makefile', steps: stepsFromMakefile(make) }

  const pkg = await read('package.json')
  if (pkg) return { source: 'package.json', steps: stepsFromPackage(JSON.parse(pkg) as { scripts?: Record<string, string> }, '.') }

  return { source: 'nothing found', steps: [] }
}

const tail = (text: string) => text.trimEnd().split('\n').slice(-FAIL_TAIL_LINES).join('\n')

async function runGate($: EngineInterface): Promise<string> {
  const root = await repoRoot($)
  if (!root) return 'gate: not in a git repository.'
  const { source, steps } = await findSteps($, root)
  if (steps.length === 0) return 'gate: no checks found. Add .claude/gate.json: { "steps": [{ "name": "test", "run": "npm test", "cwd": "." }] }'

  const lines: string[] = [`gate: ${steps.length} steps from ${source}`]
  for (const [i, step] of steps.entries()) {
    $.ui.status(`gate: ${i + 1}/${steps.length} ${step.name}…`)
    const started = await $.clock.now()
    try {
      const r = await $.process.run(['/bin/zsh', '-lc', step.run], { cwd: join(root, step.cwd), timeoutMs: STEP_TIMEOUT_MS })
      const secs = Math.round(((await $.clock.now()) - started) / 1000)
      if (r.exitCode === 0) {
        lines.push(`✔ ${step.name} (${secs}s)`)
        continue
      }
      lines.push(`✘ ${step.name} (exit ${r.exitCode}, ${secs}s)`, tail(`${r.stdout}\n${r.stderr}`))
    } catch (err) {
      lines.push(`✘ ${step.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const skipped = steps.slice(i + 1).map(s => s.name)
    if (skipped.length) lines.push(`skipped: ${skipped.join(', ')}`)
    break
  }
  $.ui.status(undefined)

  return lines.join('\n')
}

async function ask($: EngineInterface, question: string): Promise<boolean> {
  try {
    const merged = (await $.ui.ask(question, { header: 'Merge gate', options: [MERGE, HOLD] })) === MERGE
    track($, 'merge-gate', 'asked', { answer: merged ? 'merge' : 'hold' })

    return merged
  } catch {
    return false
  }
}

// The desktop app's PATH has no Homebrew, so `gh` alone isn't found there: ask a login shell once
async function gh($: EngineInterface, args: string[], cwd: string | undefined) {
  const r = await $.process.run([await findGh($), ...args], { cwd, timeoutMs: 30000 })

  return { code: r.exitCode, out: r.stdout.trim(), err: r.stderr.trim() }
}

const heldOnError = (error: unknown) => ({
  deny: `merge-gate could not check this merge (${message(error)}), so it was held.`,
})

// The folder the merge command runs in: its leading `cd`, with ~ and $HOME expanded, against the session's folder.
// A missing folder makes spawning gh fail as ENOENT naming gh itself, so callers check it exists.
async function mergeCwd($: EngineInterface, dir: string | undefined): Promise<string> {
  const sessionCwd = await $.session.cwd()
  if (!dir) return sessionCwd
  const home = (await $.env.get('HOME')) ?? ''
  const expanded = home ? dir.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home) : dir

  return join(sessionCwd, expanded)
}

// Undefined lets the merge go ahead; a string is why it is held.
async function gate($: EngineInterface, merge: Merge): Promise<string | undefined> {
  const cwd = await mergeCwd($, merge.cwd)
  if (!(await $.fs.exists(cwd))) return `merge-gate: the merge runs in ${cwd}, which does not exist, so CI could not be checked.`
  const target = [...(merge.selector ? [merge.selector] : []), ...(merge.repo ? ['--repo', merge.repo] : [])]
  const label = merge.selector ? `PR ${merge.selector}` : 'the PR for this branch'

  let checks: Check[]
  let draft = false
  try {
    const view = await gh($, ['pr', 'view', ...target, '--json', 'number,isDraft,state'], cwd)
    if (view.code !== 0) throw new Error(view.err.split('\n')[0] || `gh exited ${view.code}`)
    draft = (JSON.parse(view.out) as { isDraft: boolean }).isDraft
    // Exits non-zero while checks fail or run, and still prints them
    const r = await gh($, ['pr', 'checks', ...target, '--json', 'name,bucket,state'], cwd)
    checks = r.out.startsWith('[') ? (JSON.parse(r.out) as Check[]) : []
    if (!r.out.startsWith('[') && !/no checks reported/i.test(r.err)) throw new Error(r.err.split('\n')[0] || `gh exited ${r.code}`)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)

    return (await ask($, `merge-gate couldn't read CI for ${label} (${why}). Merge anyway?`))
      ? undefined
      : `merge-gate: couldn't verify CI for ${label} (${why}), and the user didn't approve merging blind.`
  }

  if (draft) return `merge-gate: ${label} is a draft. Mark it ready for review first.`

  const verdict = judge(checks)
  track($, 'merge-gate', 'verdict', { kind: verdict.kind })
  switch (verdict.kind) {
    case 'pass':
      $.ui.toast(`merge-gate: ${verdict.count} checks passed on ${label}`)

      return undefined
    case 'fail':
      return `merge-gate: CI failed on ${label}: ${verdict.names.join(', ')}. Fix and push, then merge once checks pass.`
    case 'pending':
      return `merge-gate: CI is still running on ${label} (${verdict.names.join(', ')}). Wait with \`gh pr checks ${merge.selector ?? ''} --watch\`, or queue it with \`gh pr merge --auto\`.`
    case 'none':
      return (await ask($, `${label} has no CI checks. Merge anyway?`))
        ? undefined
        : `merge-gate: ${label} has no CI checks and the user didn't approve merging without them.`
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

// <money: generated from shared/money.ts by shared/sync.sh>
// US dollars: three decimals under $1, where cents hide the cost of a cheap call; two from $1
function usd(n: number): string {
  return `$${Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)}`
}
// </money>

// <gh: generated from shared/gh.ts by shared/sync.sh>
let ghPath: string | undefined

// gh's absolute path, found through a login shell: the desktop app's PATH lacks Homebrew. Falls back to plain gh.
async function findGh($: EngineInterface): Promise<string> {
  if (ghPath) return ghPath
  try {
    const r = await $.process.run(['/bin/zsh', '-lc', 'command -v gh'], { timeoutMs: 5000 })
    const found = r.stdout.trim().split('\n').pop()
    if (r.exitCode === 0 && found?.startsWith('/')) return (ghPath = found)
  } catch {
    // No zsh: fall back to PATH
  }

  return 'gh'
}
// </gh>

// <git: generated from shared/git.ts by shared/sync.sh>
// The git top level of cwd (the session's folder when omitted); undefined outside a repository or when git fails
async function repoRoot($: EngineInterface, cwd?: string): Promise<string | undefined> {
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { ...(cwd ? { cwd } : {}), timeoutMs: 5000 }).catch(() => undefined)

  return r && r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
}
// </git>

// After `gh pr create` succeeded: append the provenance note to the new PR's body. Runs gh without a shell, so
// no body form (--body, -b, --body-file, -F, heredoc, none) can break; any failure only toasts.
async function addNote($: EngineInterface, output: string): Promise<void> {
  const url = prUrl(output)
  if (!url || (await $.store.get(NOTE_OFF_KEY).catch(() => false)) === true) return
  try {
    const cost = (await $.session.usage()).cost?.usd
    const bin = await findGh($)
    const view = await $.process.run([bin, 'pr', 'view', url, '--json', 'body', '-q', '.body'], { timeoutMs: 30000 })
    if (view.exitCode !== 0) throw new Error(view.stderr.trim().split('\n')[0] || `gh exited ${view.exitCode}`)
    const note = buildNote({ usd: typeof cost === 'number' ? usd(cost) : undefined, ...work })
    const current = view.stdout.replace(/\n$/, '')
    const body = withNote(current, note)
    if (body === current) return
    const edit = await $.process.run([bin, 'pr', 'edit', url, '--body', body], { timeoutMs: 30000 })
    if (edit.exitCode !== 0) throw new Error(edit.stderr.trim().split('\n')[0] || `gh exited ${edit.exitCode}`)
    track($, 'merge-gate', 'pr-note', { ok: true, tests: work.tests.runs, edits: work.added + work.removed > 0 })
  } catch (err) {
    track($, 'merge-gate', 'pr-note', { ok: false })
    $.ui.toast(`merge-gate: PR note not added (${message(err)})`)
  }
}

export const register: Register = on => {
  logTurns(on)

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    work.tests = { runs: 0, pass: 0, fail: 0 }
    work.added = 0
    work.removed = 0
    await $.command.register({ name: 'gate', description: "Run the project's CI steps locally (no Claude turn); /gate list shows them" })
    await $.command.register({ name: 'prnote', description: 'Provenance note on PRs Claude creates: /prnote off | on' })

    return next(e)
  })

  // /clear ends the session without a new session.start: the note counts start over
  on('session.end', async ($, e, next) => {
    count($, 'session.end')
    work.tests = { runs: 0, pass: 0, fail: 0 }
    work.added = 0
    work.removed = 0

    return next(e)
  })

  on('command.run', { command: 'prnote' }, async ($, e) => {
    count($, 'command.run{prnote}')
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') await $.store.set(NOTE_OFF_KEY, arg === 'off')

    return { text: `PR provenance note is ${(await $.store.get(NOTE_OFF_KEY).catch(() => false)) === true ? 'off' : 'on'}.` }
  })

  on('command.run', { command: 'gate' }, async ($, e) => {
    count($, 'command.run{gate}')
    if (e.args.trim() === 'list') {
      const root = await repoRoot($)
      if (!root) return { text: 'gate: not in a git repository.' }
      const { source, steps } = await findSteps($, root)

      return { text: [`From ${source}:`, ...steps.map(s => `  [${s.cwd}] ${s.run.replace(/\n/g, ' && ')}`)].join('\n') }
    }

    return { text: await runGate($) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    count($, 'tool.call{Bash}')
    const merge = parseMerge(e.command)
    if (!merge) {
      const testRun = isTestCommand(e.command)
      const create = isPrCreate(e.command)
      const r = await next(e)
      if (r.deny !== undefined) return r
      if (testRun) {
        work.tests.runs++
        work.tests[r.isError ? 'fail' : 'pass']++
      }
      if (create && !r.isError) void addNote($, r.text ?? '')

      return r
    }
    const deny = await gate($, merge)

    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : heldOnError(next.error)))

  // The same gate for a merge through an MCP server's tool
  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    if (e.tool === 'Edit' || e.tool === 'Write') {
      const d = lineDelta(e.tool, e as unknown as Record<string, unknown>)
      const r = await next(e)
      if (d && r.deny === undefined && !r.isError) {
        work.added += d.added
        work.removed += d.removed
      }

      return r
    }
    if (!MCP_MERGE.test(String(e.tool)) || !String(e.tool).startsWith('mcp__')) return next(e)
    const merge = mergeFromMcp(e as unknown as Record<string, unknown>)
    if (!merge) return next(e)
    const deny = await gate($, merge)

    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : heldOnError(next.error)))
}
