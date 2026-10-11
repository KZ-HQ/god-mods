import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LIMIT_HIT, failedAgents, parseReset, resetFromWindows } from '../hooks/reset.ts'

const NOTICE = `<task-notification>
<status>failed</status>
<summary>Agent "Implement FEAT-42 scoped data-access helper" failed: Agent terminated early due to an API error: You've hit your session limit · resets 12am (UTC) (error type rate_limit, HTTP 429)</summary>
</task-notification>`

describe('reset helpers', () => {
  test('recognises the limit and the agents it stopped', async () => {
    expect(LIMIT_HIT.test(NOTICE)).toBe(true)
    expect(LIMIT_HIT.test('Agent "x" failed: tests did not pass')).toBe(false)
    expect(failedAgents(NOTICE)).toEqual(['Implement FEAT-42 scoped data-access helper'])
  })

  test('reads "resets 12am" as the coming midnight', async () => {
    const now = new Date(2026, 9, 7, 22, 15).getTime()
    expect(parseReset(NOTICE, now)).toBe(new Date(2026, 9, 8, 0, 0).getTime())
    expect(parseReset('resets 3:30pm', now)).toBe(new Date(2026, 9, 8, 15, 30).getTime())
    expect(parseReset('no time here', now)).toBeUndefined()
  })

  test('prefers the spent window reset time', async () => {
    const now = Date.parse('2026-10-07T12:00:00Z')
    expect(resetFromWindows([{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-07T13:00:00Z' }, { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-10T00:00:00Z' }], now))
      .toBe(Date.parse('2026-10-07T13:00:00Z'))
  })
})

function engine(on: On, fiveHour: number) {
  let spawned = false
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-08T00:00:00Z' }] } }))
  on('agent.spawn', () => {
    spawned = true

    return { model: 'claude-opus-5-5', agentId: 'a1' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({ result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Hold off' } } }))

  return () => spawned
}

const SPAWN = { tool_use_id: 't1', prompt: 'do it', description: 'KEI-154', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5' } as const

describe('agent.spawn', () => {
  test('starts agents freely while the window has room', async ($, on) => {
    const spawned = engine(on, 40)
    await $.agent.spawn(SPAWN as never)
    expect(spawned()).toBe(true)
  })

  test('holds an agent when the 5h window is nearly spent and the user says so', async ($, on) => {
    const spawned = engine(on, 91)
    const r = await $.agent.spawn(SPAWN as never)
    expect(spawned()).toBe(false)
    expect(r.deny).toMatch(/held off starting "KEI-154"/)
  })
})

describe('limit hit', () => {
  test('a task notification about the limit is recorded and shown by /limit', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: Date.parse('2026-10-07T13:00:00Z') })
    engine(on, 100)
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    await $.prompt.submit({ text: NOTICE, wait: false, origin: { kind: 'task-notification' } })
    const r = await $.command.run({ command: 'limit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(r.text).toMatch(/stopped Implement FEAT-42.*\/limit-guard:resume/)
  })
})

const GRACE = "[Usage limit reached; a short grace allowance remains, then this turn is cut off without warning. Judge what's left: ...]"

describe('grace warning', () => {
  test('the injected warning records the running agents, and /limit-guard:resume hands them to the model', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: Date.parse('2026-10-09T14:00:00Z') })
    engine(on, 100)
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('agent.list', () => ({
      value: [
        { id: 'a1', description: 'KEI-189 backup tooling', type: 'general-purpose', status: 'running' },
        { id: 'a2', description: 'KEI-185 done', type: 'general-purpose', status: 'completed' },
      ],
    }))
    let args = ''
    on('command.run', { command: 'limit-guard:resume' }, (_$, e) => {
      args = e.args

      return { text: '' }
    })

    // Nothing in the test kit stores the row; the hook has recorded the hit by then
    await $.session.append({ message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: GRACE }] } } as never).catch(() => undefined)
    const shown = await $.command.run({ command: 'limit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(shown.text).toMatch(/stopped KEI-189 backup tooling\. \/limit-guard:resume/)

    await $.command.run({ command: 'limit-guard:resume', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(args).toBe('background agents "KEI-189 backup tooling"')

    const after = await $.command.run({ command: 'limit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(after.text).toMatch(/No limit hit recorded/)
  })
})
