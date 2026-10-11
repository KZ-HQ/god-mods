import { describe, expect, mock, test } from 'claude-code/testing'

import { describeTool, elapsed, tokens } from '../hooks/format.ts'

const PANE = {
  component: 'Pane',
  requestId: 'fleet',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

describe('format', () => {
  test('elapsed, tokens and tool lines', async () => {
    expect(elapsed(95_000)).toBe('1m 35s')
    expect(elapsed(3_725_000)).toBe('1h 02m')
    expect(tokens(398_094)).toBe('398k')
    expect(describeTool({ tool: 'Edit', file_path: '/a/b/scoped.mjs' })).toBe('Edit: scoped.mjs')
    expect(describeTool({ tool: 'Bash', command: 'node --test test/*.test.mjs' })).toBe('Bash: node --test test/*.test.mjs')
    expect(describeTool({ tool: 'mcp__a8b6-c79__get_issue' })).toBe('get_issue')
  })
})

describe('fleet', () => {
  test('tracks a spawned agent and draws it with a Stop button', async ($, on) => {
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a119' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.status', () => ({ value: undefined }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))

    await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'KEI-154 owner-api', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm run lint', agentId: 'a119' } as never)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-fleet', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /KEI-154 owner-api/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 tools/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Bash: npm run lint/ })).toBeDefined()
      expect(await ui.find({ key: 'stop-a119' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /opus-5-5/ })).toBeDefined()
      await ui.unmount()
    }

    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a119' })
    const ui = await $.ui.mount({ plugin: 'agent-fleet', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'stop-a119' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /finished/ })).toBeDefined()
  })

  test('shows the context of the latest request, not a running sum of re-read context', async ($, on) => {
    on('agent.spawn', () => ({ model: 'm', agentId: 'a7' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.status', () => ({ value: undefined }))
    const usage = (input: number, out: number) => ({ input_tokens: 1000, cache_read_input_tokens: input - 1000, cache_creation_input_tokens: 0, output_tokens: out, model: 'm' })
    let step = 0
    on('turn.step', async function* (_$, e) {
      step += 1

      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: usage(step === 1 ? 40_000 : 60_000, 2_000) }
    })
    await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'KEI-189', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as never)
    for (const index of [0, 1]) {
      const stream = $.turn.step({ turnId: 'x', index, model: 'm', messageCount: 3, agentId: 'a7' })
      for await (const _ of stream) void _
    }
    const ui = await $.ui.mount({ plugin: 'agent-fleet', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /ctx 60k · out 4k/ })).toBeDefined()
  })

  test('finds agents that were already running when it loaded', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    on('ui.status', () => ({ value: undefined }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('agent.list', () => ({ value: [{ id: 'old1', description: 'KEI-156 conditions', type: 'general-purpose', status: 'running' }] }))
    await $.session.start({ cwd: '/r' } as never)
    await clock.advance(5_000)
    const ui = await $.ui.mount({ plugin: 'agent-fleet', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /KEI-156 conditions/ })).toBeDefined()
  })

  test('a finished agent that is re-opened shows as running again', async ($, on) => {
    on('agent.spawn', () => ({ model: 'm', agentId: 'r1' }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.status', () => ({ value: undefined }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await $.agent.spawn({ tool_use_id: 't1', prompt: 'p', description: 'reopen me', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as never)
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer', agentId: 'r1' })
    let ui = await $.ui.mount({ plugin: 'agent-fleet', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'stop-r1' })).toBeUndefined()
    await ui.unmount()
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'r1' } as never)
    ui = await $.ui.mount({ plugin: 'agent-fleet', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'stop-r1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bash: ls/ })).toBeDefined()
  })
})
