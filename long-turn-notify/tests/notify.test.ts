import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const turn = (durationMs: number, extra: object = {}) =>
  ({ answer: '## All 42 tests pass\nDetails…', durationMs, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as const

function engine(on: On, surface: 'terminal' | 'desktop') {
  const ran: string[][] = []
  const toasts: string[] = []
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.cwd', () => ({ value: '/Users/me/other-app' }))
  on('session.surfaces', () => ({ value: [surface] }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { ran, toasts }
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
