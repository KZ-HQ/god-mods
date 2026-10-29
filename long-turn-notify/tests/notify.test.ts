import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const turn = (durationMs: number, extra: object = {}) =>
  ({ answer: '## All 42 tests pass\nDetails…', durationMs, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as const

function engine(on: On, surface: 'terminal' | 'desktop') {
  const ran: string[][] = []
  const rows: string[] = []
  const toasts: string[] = []
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.cwd', () => ({ value: '/Users/me/other-app' }))
  on('session.surfaces', () => ({ value: [surface] }))
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_$, e) => {
    if (e.argv[3] === 'mod-metrics') rows.push(String(e.argv[4]))
    if (e.argv[3] === 'mod-metrics') return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { ran, toasts, rows }
}

describe('long-turn-notify', () => {
  test('a long terminal turn sends a macOS notification with the answer', async ($, on) => {
    const { ran, toasts } = engine(on, 'terminal')
    await $.turn.complete(turn(95_000))
    expect(ran).toHaveLength(1)
    expect(ran[0]![0]).toBe('osascript')
    expect(ran[0]).toContain('All 42 tests pass')
    expect(ran[0]).toContain('Claude · other-app')
    expect(toasts[0]).toMatch(/1m 35s/)
  })

  test('short turns, subagent turns and desktop sessions send nothing to the OS', async ($, on) => {
    const { ran } = engine(on, 'desktop')
    await $.turn.complete(turn(10_000))
    await $.turn.complete(turn(95_000, { agentId: 'a1' }))
    await $.turn.complete(turn(95_000))
    expect(ran).toHaveLength(0)
  })

  test('a permission prompt in a terminal session sends a macOS notification', async ($, on) => {
    const { ran } = engine(on, 'terminal')
    on('classic.Notification', () => ({}))
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', title: 'Permission needed', notification_type: 'permission_prompt' })
    expect(ran).toHaveLength(1)
    expect(ran[0]).toContain('Claude needs your permission to use Bash')
    expect(ran[0]).toContain('Permission needed')
  })

  test('the desktop app gets no duplicate', async ($, on) => {
    const { ran } = engine(on, 'desktop')
    on('classic.Notification', () => ({}))
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
    expect(ran).toHaveLength(0)
  })
})

describe('failures', () => {
  test('an API error notifies with the kind only, once, and records a row', async ($, on) => {
    const { ran, toasts, rows } = engine(on, 'terminal')
    on('classic.StopFailure', () => ({}))
    await $.classic.StopFailure({ error: 'rate_limit', error_details: 'secret sk-123' } as never)
    await $.turn.complete(turn(2_000, { reason: 'error' }))
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(ran).toHaveLength(1)
    expect(ran[0]).toContain('Failed: rate limit')
    expect(toasts).toEqual(['Failed: rate limit'])
    const row = rows.find(r => r.includes('api_error'))!
    expect(JSON.parse(row).kind).toBe('rate_limit')
    expect(row).not.toContain('sk-123')
  })

  test('an error turn without StopFailure does not suppress the next turn\'s notification', async ($, on) => {
    const { ran } = engine(on, 'terminal')
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('classic.StopFailure', () => ({}))
    await $.turn.complete(turn(30_000, { reason: 'error' }))
    await $.turn.start({ turnId: 't2' } as never)
    await $.classic.StopFailure({ error: 'overloaded' } as never)
    expect(ran).toHaveLength(2)
    expect(ran[1]).toContain('Failed: API overloaded')
  })

  test('a short error turn completing before StopFailure still notifies', async ($, on) => {
    const { ran } = engine(on, 'terminal')
    on('classic.StopFailure', () => ({}))
    await $.turn.complete(turn(2_000, { reason: 'error' }))
    await $.classic.StopFailure({ error: 'rate_limit' } as never)
    expect(ran).toHaveLength(1)
    expect(ran[0]).toContain('Failed: rate limit')
  })

  test('a subagent turn.start does not clear the flag', async ($, on) => {
    const { ran } = engine(on, 'terminal')
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('classic.StopFailure', () => ({}))
    await $.classic.StopFailure({ error: 'rate_limit' } as never)
    await $.turn.start({ turnId: 'sub', agentId: 'a1', text: '' } as never)
    await $.turn.complete(turn(30_000, { reason: 'error' }))
    expect(ran).toHaveLength(1)
  })

  test('a failed tool call records name and duration, not input or error text', async ($, on) => {
    const { rows } = engine(on, 'terminal')
    on('classic.PostToolUseFailure', () => ({}))
    await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'echo sk-123' }, error: 'boom sk-123', is_interrupt: false, duration_ms: 40 } as never)
    for (let i = 0; i < 50; i++) await Promise.resolve()
    const row = rows.find(r => r.includes('tool_failure'))!
    expect(JSON.parse(row)).toMatchObject({ tool: 'Bash', interrupted: false, ms: 40 })
    expect(row).not.toContain('sk-123')
  })
})

describe('metrics', () => {
  test('a failing metrics write toasts once, however many rows fail', async ($, on) => {
    const toasts: string[] = []
    on('clock.now', () => ({ value: 0 }))
    on('session.id', () => ({ value: 's1' }))
    on('session.cwd', () => ({ value: '/r' }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'disk full', isStdoutTruncated: false, isStderrTruncated: false } }))
    for (let i = 0; i < 3; i++) await $.session.start({ cwd: '/r' } as never)
    for (let i = 0; i < 50; i++) await Promise.resolve()
    const failures = toasts.filter(t => /metrics write failed/.test(t))
    expect(failures).toEqual(['long-turn-notify: metrics write failed (disk full)'])
  })
})
