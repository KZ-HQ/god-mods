import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Worktree } from '../types'
import { VERDICT_TEXT, agentIdOf, parseWorktrees, verdict } from './scan.ts'

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
    if (e.args.trim() === 'clean') {
      const lines = await clean($)

      return { text: `Worktree cleanup:\n${lines.join('\n')}` }
    }
    void $.ui.open({ id: PANE, title: 'Worktrees' })
    const found = await refresh($)

    return { text: found ? summary(found.list) : 'Not in a git repository.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
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
