import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { groups, parse, summary } from '../hooks/spend.ts'

const A = (o: object) => JSON.stringify({ type: 'general-purpose', tier: 'sonnet', usd: 1, tokens: 1_000_000, project: 'app', desc: 'Fix it', ...o })
const SCAN = [
  A({ tier: 'opus', usd: 6, desc: 'Implement KEI-175' }),
  A({ usd: 3 }),
  A({ type: 'Explore', tier: 'haiku', usd: 0.5, project: 'other' }),
  '{torn',
].join('\n')
const PANE = { component: 'Pane', requestId: 'agent-spend', props: { title: 'Agent spend', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

// The scanner answers SCAN; the metrics block's /bin/sh appends succeed
function engine(on: On, scan: { exitCode: number; stdout: string; stderr: string } = { exitCode: 0, stdout: SCAN, stderr: '' }) {
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])

    return { value: e.argv[0] === 'python3' ? scan : { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('session.cwd', () => ({ value: '/Users/k/Coding/app/.claude/worktrees/feat-1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

  return runs
}

describe('spend helpers', () => {
  test('groups by model and by agent type, costliest first, with shares', () => {
    const agents = parse(SCAN)
    expect(agents).toHaveLength(3)
    expect(groups(agents, 'tier').map(g => [g.name, g.agents, g.share])).toEqual([['opus', 1, 63], ['sonnet', 1, 32], ['haiku', 1, 5]])
    expect(groups(agents, 'type').map(g => g.name)).toEqual(['general-purpose', 'Explore'])
  })

  test('summary names the total, the groups and the costliest agents', () => {
    const out = summary(parse(SCAN), 7, '')
    expect(out).toMatch(/^3 agents, last 7 days: \$9\.50/)
    expect(out).toMatch(/opus\s+1 agents\s+\$6\.00\s+63%/)
    expect(out).toMatch(/\$6\.00\s+opus\s+general-purpose\s+1\.0M\s+app: Implement KEI-175/)
    expect(summary([], 1, 'app')).toBe('No subagents ran in the last 1 day in app.')
  })
})

describe('/spend', () => {
  test('scans the given window, reports and fills the pane', async ($, on) => {
    const runs = engine(on)
    const r = await $.command.run({ command: 'spend', args: '30' })
    expect(r.text).toMatch(/^3 agents, last 30 days: \$9\.50/)
    expect(runs.find(a => a[0] === 'python3')?.slice(-1)).toEqual(['30'])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-spend', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /\$9\.50 · 3 agents · last 30d/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Implement KEI-175/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('here keeps the agents of this project, counting a worktree as its repo', async ($, on) => {
    engine(on)
    const r = await $.command.run({ command: 'spend', args: 'here' })
    expect(r.text).toMatch(/^2 agents, last 7 days in app: \$9\.00/)
  })

  test('a failed scan says so instead of reporting nothing', async ($, on) => {
    engine(on, { exitCode: 1, stdout: '', stderr: 'Traceback\nPermissionError: denied' })
    expect((await $.command.run({ command: 'spend', args: '' })).text).toBe('agent-spend: could not read subagent transcripts (PermissionError: denied).')
  })

  test('the pane asks for a scan before the first /spend', async $ => {
    const ui = await $.ui.mount({ plugin: 'agent-spend', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /Run \/spend/ })).toBeDefined()
  })
})
