import { describe, expect, mock, test } from 'claude-code/testing'

import { cost, pick } from '../hooks/route.ts'

const base = { prompt: '', subagentType: 'general-purpose' }

describe('pick', () => {
  test('routes by task', async () => {
    expect(pick({ ...base, description: 'Adversarial review of scoped.mjs' })?.tier).toBe('opus')
    expect(pick({ ...base, description: 'Find where reminders are sent' })?.tier).toBe('haiku')
    expect(pick({ ...base, description: 'Implement KEI-154 core module scoping' })?.tier).toBe('sonnet')
    expect(pick({ ...base, subagentType: 'Explore', description: 'Map the auth flow' })?.tier).toBe('haiku')
    expect(pick({ ...base, description: 'Implement it', model: 'opus' })).toBeUndefined()
    expect(pick({ ...base, description: 'Hello' })).toBeUndefined()
  })

  test('prices tokens', async () => {
    expect(cost('opus', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(4)
  })
})

const SPAWN = (description: string) =>
  ({ tool_use_id: 't', prompt: 'p', description, subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5' }) as never

describe('modes', () => {
  test('routes by default; observe records without changing the model', async ($, on) => {
    mock.store(on)
    on('ui.toast', () => ({ value: undefined }))
    let model: string | undefined = 'unset'
    on('agent.spawn', (_$, e) => {
      model = e.model

      return { model: e.model ?? 'opus', agentId: 'a1' }
    })
    await $.agent.spawn(SPAWN('Find where reminders are sent'))
    expect(model).toBe('haiku')

    const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
    await $.command.run({ command: 'route', args: 'observe', ...RUN })
    await $.agent.spawn(SPAWN('Find where reminders are sent'))
    expect(model).toBeUndefined()
    await $.command.run({ command: 'route', args: 'on', ...RUN })

    const shown = await $.command.run({ command: 'route', args: '', ...RUN })
    expect(shown.text).toMatch(/→ Find where reminders are sent: asked opus, pick haiku/)
  })

  test('records each finished agent with its cost and saving', async ($, on) => {
    mock.store(on)
    on('ui.toast', () => ({ value: undefined }))
    on('session.cwd', () => ({ value: '/x/my-app' }))
    on('clock.now', () => ({ value: 0 }))
    const lines: string[] = []
    on('process.run', (_$, e) => {
      lines.push(e.argv[4] ?? '')

      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('agent.spawn', () => ({ model: 'opus', agentId: 'a1' }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await $.agent.spawn(SPAWN('Find where reminders are sent'))
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 }
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a1', usage } as never)
    const agentRow = () => lines.map(l => JSON.parse(l) as { event: string }).find(r => r.event === 'agent')
    for (let i = 0; i < 50 && !agentRow(); i++) await $.agent.spawn(SPAWN('noop'))
    const row = agentRow()
    expect(row).toMatchObject({ v: 2, mod: 'switchboard', event: 'agent', project: 'my-app', asked: 'opus', used: 'haiku', applied: true })
    expect(row.savedUsd).toBe(4.875)
  })
})

