import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { agentIdOf, parseWorktrees, verdict } from '../hooks/scan.ts'

const PORCELAIN = `worktree /r
HEAD db03db4aaaaaaa
branch refs/heads/main

worktree /r/.claude/worktrees/agent-a119abc207ca9908a
HEAD f5253b1bbbbbbb
branch refs/heads/user/feat-42-scoped

worktree /r/tmp
HEAD 0000000ccccccc
detached
`

describe('scan', () => {
  test('parses worktrees and agent ids', async () => {
    const list = parseWorktrees(PORCELAIN)
    expect(list.map(w => w.branch)).toEqual(['main', 'user/feat-42-scoped', undefined])
    expect(list[1]!.head).toBe('f5253b1')
    expect(agentIdOf(list[1]!.path)).toBe('a119abc207ca9908a')
    expect(agentIdOf('/r/tmp')).toBeUndefined()
  })

  test('only a clean, finished worktree with a merged PR and nothing unpushed is removable', async () => {
    const base = { isRunning: false, isDirty: false, unpushed: 0, prState: 'MERGED' }
    expect(verdict(base)).toBe('merged')
    expect(verdict({ ...base, isRunning: true })).toBe('running')
    expect(verdict({ ...base, isDirty: true })).toBe('dirty')
    expect(verdict({ ...base, unpushed: 2 })).toBe('unpushed')
    expect(verdict({ ...base, prState: 'OPEN' })).toBe('open')
    expect(verdict({ ...base, prState: undefined })).toBe('no-pr')
  })
})


// A worktree whose PR was squash-merged and whose remote branch is gone: none of its commits are on a remote
function repo(on: On, prHead: string, ran: string[] = []) {
  const SHA = 'f5253b1aaaabbbbccccddddeeeeffff000011112'
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_$, e) => {
    const a = e.argv.join(' ')
    ran.push(a)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a.startsWith('/bin/zsh')) return out('/opt/homebrew/bin/gh\n')
    if (a === 'git rev-parse --show-toplevel') return out('/r\n')
    if (a === 'git worktree list --porcelain') return out(`worktree /r\nHEAD 0000000\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/agent-a119abc207ca9908a\nHEAD ${SHA}\nbranch refs/heads/feat-42\n`)
    if (a === 'git status --porcelain') return out('')
    if (a.includes('pr list')) return out(JSON.stringify([{ state: 'MERGED', number: 32, headRefOid: prHead }]))
    if (a.startsWith('git merge-base --is-ancestor')) return out('', 1)
    if (a.startsWith('git rev-list --count')) return out('3\n')
    if (a.startsWith('git branch --list')) return out('feat-42\n')

    return out('')
  })

  return SHA
}

const RUN = { command: 'worktrees', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

describe('squash merges', () => {
  test('a worktree whose head is the merged PR head is removable even with no remote branch', async ($, on) => {
    const sha = repo(on, 'f5253b1aaaabbbbccccddddeeeeffff000011112')
    expect(sha.length).toBe(40)
    const r = await $.command.run(RUN)
    expect(r.text).toMatch(/agent-a119abc207ca9908a.*#32.*PR merged, safe to remove/)
  })

  test('a worktree with commits beyond the merged PR is kept', async ($, on) => {
    repo(on, '9999999999999999999999999999999999999999')
    const r = await $.command.run(RUN)
    expect(r.text).toMatch(/commits not on the remote/)
  })
})

describe('/worktrees clean', () => {
  test('removes the merged worktree and its branch, then prunes', async ($, on) => {
    const ran: string[] = []
    repo(on, 'f5253b1aaaabbbbccccddddeeeeffff000011112', ran)
    const r = await $.command.run({ ...RUN, args: 'clean' })
    expect(r.text).toMatch(/Worktree cleanup:\n✔ agent-a119abc207ca9908a \(branches: feat-42\)/)
    expect(ran).toContain('git worktree remove /r/.claude/worktrees/agent-a119abc207ca9908a')
    expect(ran).toContain('git branch -D feat-42')
    expect(ran).toContain('git worktree prune')
  })
})

describe('pane', () => {
  test('lists each scanned worktree with its branch and verdict', async ($, on) => {
    repo(on, 'f5253b1aaaabbbbccccddddeeeeffff000011112')
    await $.command.run(RUN)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'worktree-janitor', surface, component: 'Pane', requestId: 'worktrees', props: { title: 'Worktrees', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
      expect(await ui.find({ type: 'Text', text: /agent-a119abc207ca9908a/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /feat-42/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
