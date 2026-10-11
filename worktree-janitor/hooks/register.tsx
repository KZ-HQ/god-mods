import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import type { Worktree } from '../types'
import { VERDICT_TEXT, agentIdOf, parseWorktrees, verdict } from './scan.ts'

const PANE = 'worktrees'
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const SCAN_EVERY_MS = 6 * 60 * 60 * 1000
const TOAST_EVERY_MS = 24 * 60 * 60 * 1000

const rows = atom({ plugin: 'worktree-janitor', key: 'rows' } as const, [])
const isBusy = atom({ plugin: 'worktree-janitor', key: 'isBusy' } as const, false)
const note = atom({ plugin: 'worktree-janitor', key: 'note' } as const, '')

async function git($: EngineInterface, args: string[], cwd?: string) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 15000 })

    return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() }
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) }
  }
}

// The desktop app's PATH has no Homebrew, so `gh` alone isn't found there: ask a login shell once
let ghPath: string | undefined

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

type Pr = { state?: string; url?: string; headRefOid?: string }

async function prOf($: EngineInterface, branch: string, root: string): Promise<Pr> {
  try {
    const r = await $.process.run(
      [await findGh($), 'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'state,number,headRefOid'],
      { cwd: root, timeoutMs: 20000 },
    )
    const [pr] = r.exitCode === 0 ? (JSON.parse(r.stdout) as { state: string; number: number; headRefOid: string }[]) : []

    return pr ? { state: pr.state, url: `#${pr.number}`, headRefOid: pr.headRefOid } : {}
  } catch {
    return {}
  }
}

async function scan($: EngineInterface): Promise<{ root: string; list: Worktree[] } | undefined> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return undefined
  const listed = await git($, ['worktree', 'list', '--porcelain'], top.out)
  if (!listed.ok) return undefined

  const [main, ...others] = parseWorktrees(listed.out)
  const root = main?.path ?? top.out
  const live = new Set((await $.agent.list().catch(() => [])).filter(a => LIVE.has(a.status)).map(a => a.id))

  const list = await Promise.all(
    others.filter(w => !w.isBare).map(async (w): Promise<Worktree> => {
      const status = await git($, ['status', '--porcelain'], w.path)
      const pr: Pr = w.branch ? await prOf($, w.branch, root) : {}
      // A squash merge with its branch deleted leaves every commit off the remotes; what the merged PR
      // already held is safe all the same
      const isInMergedPr =
        pr.state === 'MERGED' &&
        !!pr.headRefOid &&
        (pr.headRefOid === w.sha || (await git($, ['merge-base', '--is-ancestor', w.sha, pr.headRefOid], root)).ok)
      const ahead = isInMergedPr || !w.branch ? { ok: true, out: '0' } : await git($, ['rev-list', '--count', w.branch, '--not', '--remotes'], root)
      const id = agentIdOf(w.path)

      return {
        path: w.path,
        name: w.path.split('/').pop() ?? w.path,
        branch: w.branch ?? null,
        head: w.head,
        pr: pr.url ?? null,
        verdict: verdict({
          isRunning: id !== undefined && live.has(id),
          isDirty: !status.ok || status.out.length > 0,
          unpushed: Number(ahead.ok ? ahead.out : 0) || 0,
          prState: pr.state,
        }),
      }
    }),
  )

  return { root, list }
}

async function refresh($: EngineInterface) {
  await update($, isBusy, () => true)
  const found = await scan($)
  await update($, rows, () => found?.list ?? [])
  await update($, note, () => (found ? '' : 'Not in a git repository.'))
  await update($, isBusy, () => false)

  return found
}

// Removes merged, clean worktrees and their branches; anything else is left alone.
async function clean($: EngineInterface): Promise<string[]> {
  const found = await refresh($)
  if (!found) return ['Not in a git repository.']
  await update($, isBusy, () => true)
  const done: string[] = []

  for (const w of found.list.filter(r => r.verdict === 'merged')) {
    const removed = await git($, ['worktree', 'remove', w.path], found.root)
    if (!removed.ok) {
      done.push(`✘ ${w.name}: ${removed.err.split('\n')[0]}`)
      continue
    }
    const branches = [w.branch, `worktree-${w.name}`].filter((b): b is string => !!b)
    const existing = (await git($, ['branch', '--list', ...branches, '--format=%(refname:short)'], found.root)).out.split('\n').filter(Boolean)
    if (existing.length) await git($, ['branch', '-D', ...existing], found.root)
    done.push(`✔ ${w.name}${existing.length ? ` (branches: ${existing.join(', ')})` : ''}`)
  }
  await git($, ['worktree', 'prune'], found.root)
  await update($, isBusy, () => false)
  await refresh($)

  track($, 'worktree-janitor', 'cleaned', { removed: done.filter(l => l.startsWith('✔')).length, failed: done.filter(l => l.startsWith('✘')).length })

  return done.length ? done : ['Nothing merged to remove.']
}

const summary = (list: readonly Worktree[]) =>
  list.length === 0
    ? 'No extra worktrees.'
    : list.map(w => `${w.verdict === 'merged' ? '●' : '○'} ${w.name}  ${w.branch ?? '(detached)'}  ${w.pr ?? ''}  ${VERDICT_TEXT[w.verdict]}`).join('\n')

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
  logTurns(on)

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'worktrees', description: 'Agent worktrees and their PR state; /worktrees clean removes the merged ones' })
    // Off the start path, and at most every few hours per repo: each scan asks GitHub about every worktree
    void (async () => {
      const top = await git($, ['rev-parse', '--show-toplevel'])
      if (!top.ok) return
      const key = `seen:${top.out}`
      const now = await $.clock.now()
      const seen = ((await $.store.get(key)) ?? {}) as { scannedAt?: number; toastedAt?: number }
      if (now - (seen.scannedAt ?? 0) < SCAN_EVERY_MS) return
      const found = await refresh($)
      const merged = found?.list.filter(w => w.verdict === 'merged').length ?? 0
      const shouldToast = merged > 0 && now - (seen.toastedAt ?? 0) >= TOAST_EVERY_MS
      if (merged > 0) track($, 'worktree-janitor', 'found', { merged })
      if (shouldToast) $.ui.toast(`worktree-janitor: ${merged} merged worktree${merged > 1 ? 's' : ''} can be removed (/worktrees)`)
      await $.store.set(key, { scannedAt: now, toastedAt: shouldToast ? now : seen.toastedAt })
    })().catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async ($, e) => {
    count($, 'command.run')
    if (e.args.trim() === 'clean') {
      const lines = await clean($)

      return { text: `Worktree cleanup:\n${lines.join('\n')}` }
    }
    void $.ui.open({ id: PANE, title: 'Worktrees' })
    const found = await refresh($)

    return { text: found ? summary(found.list) : 'Not in a git repository.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    count($, 'ui.render')
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, rows)
    const busy = await read($, isBusy)
    const message = await read($, note)
    const merged = list.filter(w => w.verdict === 'merged').length
    const width = Math.max(20, e.props.bodyColumns)

    return (
      <Box flexDirection="column" width={width}>
        {message !== '' && <Text dimColor>{message}</Text>}
        {list.length === 0 && message === '' && <Text dimColor>{busy ? 'Scanning…' : 'No extra worktrees.'}</Text>}
        {list.map(w => (
          <Box flexDirection="column" key={w.path}>
            <Text bold={w.verdict === 'merged'} wrap="truncate-end">
              {w.verdict === 'merged' ? '● ' : '○ '}
              {w.name}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {w.branch ?? '(detached)'} {w.pr ?? ''} · {VERDICT_TEXT[w.verdict]}
            </Text>
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Button
            key="clean"
            hotkey="c"
            variant="primary"
            label={busy ? 'Working…' : `Clean merged (${merged})`}
            onPress={async () => {
              if (busy || merged === 0) return
              const lines = await clean($)
              $.ui.toast(lines.join('\n'))
            }}
          />
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
