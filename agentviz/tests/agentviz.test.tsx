import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Ev = { type: string; run?: string; id?: string; from?: string; to?: string; kind?: string; summary?: string; status?: string; label?: string; costUsd?: number; tokens?: number }

const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// Stands for the engine and for the relay: records what the mod POSTs
function engine(on: On, relay: { status?: number; down?: boolean } = {}) {
  const posts: { url: string; auth?: string; events: Ev[] }[] = []
  const toasts: string[] = []
  const rows: string[] = []
  let usd = 0.1
  const state = { ...relay }
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('http.fetch', (_$, e) => {
    if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:8787')
    posts.push({ url: e.url, auth: e.init?.headers?.authorization, events: JSON.parse(e.init?.body ?? '[]') as Ev[] })
    const status = state.status ?? 202

    return { value: { status, ok: status < 300, headers: {}, text: '' } }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/Users/me/threeMono' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { cost: { usd } } }) as never)
  on('session.start', () => ({ cwd: '/Users/me/threeMono' }))
  on('command.register', () => ({ value: { command: 'agentviz' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (e.argv[3] === 'mod-metrics') rows.push(String(e.argv[4]))

    return { value: OK }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer, usage: { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'sub1' }))
  on('tool.call', (_$, e) => (e.tool === 'Bash' && String((e as { command?: string }).command).startsWith('false') ? { result: {}, isError: true, text: 'exit 1: boom' } : { result: {}, text: 'x'.repeat(400) }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))

  const events = () => posts.flatMap(p => p.events)
  const spend = (v: number) => (usd = v)

  return { posts, toasts, rows, clock, events, state, spend }
}

const SESSION = { cwd: '/Users/me/threeMono', surface: 'terminal', isInteractive: true } as const
const turn = (text: string, turnId = 't1') => ({ text, turnId })
const done = (answer: string, extra: object = {}) => ({ answer, durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as const
const end = { reason: 'prompt_input_exit', sessionId: 'sess-1', resume: {} } as never
const PANE = { plugin: 'agentviz', component: 'Pane', requestId: 'agentviz', props: { title: 'AgentViz', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

describe('agentviz', () => {
  test('a session becomes one run: you, Claude, a prompt task, tool calls and the answer', async ($, on) => {
    const { events, posts, clock, toasts } = engine(on)
    await $.session.start(SESSION)
    await $.turn.start(turn('Fix the failing login test\nmore detail'))
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })
    await $.tool.call({ tool: 'Edit', file_path: '/Users/me/threeMono/src/login.ts', old_string: 'a', new_string: 'b', replace_all: false })
    await $.turn.complete(done('## Fixed the login test\nIt was a typo.'))
    await clock.advance(300)

    const evs = events()
    expect(posts[0]!.url).toBe('http://localhost:8787/events')
    expect(new Set(evs.map(e => e.run))).toEqual(new Set(['cc-sess-1']))
    expect(evs[0]).toMatchObject({ type: 'run.meta', label: 'threeMono · Claude Code' })
    expect(evs.filter(e => e.type === 'node.add').map(e => e.id)).toEqual(['you', 'claude', 'task.turn-1', 'tool.Bash', 'tool.Edit'])
    const msgs = evs.filter(e => e.type === 'message').map(e => `${e.from}>${e.to}:${e.kind}:${e.summary ?? ''}`)
    expect(msgs).toEqual([
      'you>claude:prompt:Fix the failing login test',
      'claude>tool.Bash:tool_call:Run the tests',
      'tool.Bash>claude:tool_result:ok: Run the tests',
      'claude>tool.Edit:tool_call:login.ts',
      'tool.Edit>claude:tool_result:ok: login.ts',
      'claude>you:response:Fixed the login test',
    ])
    expect(evs.find(e => e.type === 'usage')).toMatchObject({ id: 'claude', tokens: 1200 })
    expect(evs.filter(e => e.id === 'task.turn-1').pop()).toMatchObject({ status: 'done' })
    expect(toasts.some(t => /streaming this session/.test(t))).toBe(true)
  })

  test('subagents are agents Claude delegates to; their tool calls come from them', async ($, on) => {
    const { events, clock } = engine(on)
    await $.session.start(SESSION)
    await $.turn.start(turn('Explore the repo'))
    await $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Find the router', description: 'Find the router', subagentType: 'Explore', provider: { kind: 'builtin' } } as never)
    await $.turn.start({ text: 'Find the router', turnId: 's1', agentId: 'sub1' })
    await $.tool.call({ tool: 'Grep', pattern: 'createRouter', path: '/repo/src', agentId: 'sub1' } as never)
    await $.turn.complete(done('found it', { agentId: 'sub1', turnId: 's1' }))
    await clock.advance(300)
    // the subagent's own turn ending marks it done and counts its tokens, before Claude hears back
    expect(events().filter(e => e.id === 'agent.sub1' && e.status).pop()).toMatchObject({ status: 'done' })
    expect(events().find(e => e.type === 'usage' && e.id === 'agent.sub1')).toMatchObject({ tokens: 1200 })
    await $.tool.call({ tool: 'Agent', description: 'Find the router', prompt: 'Find the router', subagent_type: 'Explore', tool_use_id: 'tu-1' } as never)
    await clock.advance(300)

    const evs = events()
    expect(evs.find(e => e.type === 'node.add' && e.id === 'agent.sub1')).toMatchObject({ kind: 'agent', label: 'Explore: Find the router' })
    expect(evs.find(e => e.type === 'edge.add' && e.to === 'agent.sub1')).toMatchObject({ from: 'claude', kind: 'delegates' })
    expect(evs.some(e => e.type === 'message' && e.from === 'agent.sub1' && e.to === 'tool.Grep')).toBe(true)
    expect(evs.some(e => e.type === 'message' && e.from === 'agent.sub1' && e.to === 'claude' && e.kind === 'response')).toBe(true)
    // the Agent tool itself is not drawn as a tool
    expect(evs.some(e => e.id === 'tool.Agent')).toBe(false)
    expect(evs.filter(e => e.id === 'agent.sub1' && e.status).pop()).toMatchObject({ status: 'done' })
  })

  test('a failing tool call flows back as an error', async ($, on) => {
    const { events, clock } = engine(on)
    await $.session.start(SESSION)
    await $.turn.start(turn('run it'))
    await $.tool.call({ tool: 'Bash', command: 'false && echo hi' })
    await clock.advance(300)
    const err = events().find(e => e.type === 'message' && e.kind === 'error')
    expect(err).toMatchObject({ from: 'tool.Bash', to: 'claude', summary: 'exit 1: boom' })
    expect(events().filter(e => e.id === 'tool.Bash' && e.status).pop()).toMatchObject({ status: 'error' })
  })

  test('names mode sends no prompt, answer or tool-input text', { options: { detail: 'names' } }, async ($, on) => {
    const { events, clock } = engine(on)
    await $.session.start(SESSION)
    await $.turn.start(turn('My secret plan'))
    await $.tool.call({ tool: 'Bash', command: 'cat ~/.ssh/id_rsa' })
    await $.turn.complete(done('Here is the plan'))
    await clock.advance(300)
    const text = JSON.stringify(events())
    expect(text).not.toMatch(/secret|ssh|plan/i)
    expect(events().find(e => e.id === 'task.turn-1')).toMatchObject({ label: 'Prompt 1' })
  })

  test('the token goes in the Authorization header, and cost per turn is sent', { options: { token: 's3cret' } }, async ($, on) => {
    const { posts, events, clock, spend } = engine(on)
    await $.session.start(SESSION)
    await $.turn.start(turn('hi'))
    spend(0.35)
    await $.turn.complete(done('hello'))
    await clock.advance(300)
    expect(posts[0]!.auth).toBe('Bearer s3cret')
    expect(Math.abs(events().find(e => e.type === 'usage')!.costUsd! - 0.25)).toBeLessThan(1e-9)
  })

  test('while the relay is down events queue, then arrive in order once it is back', async ($, on) => {
    const { events, clock, state, toasts, posts } = engine(on, { down: true })
    await $.session.start(SESSION)
    await $.turn.start(turn('first'))
    await clock.advance(300)
    expect(posts).toHaveLength(0)
    expect(toasts.some(t => /can't reach http:\/\/localhost:8787/.test(t))).toBe(true)
    await $.tool.call({ tool: 'Read', file_path: '/a/b.ts' })
    state.down = false
    await clock.advance(1000) // still inside the retry wait: nothing sent
    expect(posts).toHaveLength(0)
    await clock.advance(5000)
    const ids = events().filter(e => e.type === 'node.add').map(e => e.id)
    expect(ids).toEqual(['you', 'claude', 'task.turn-1', 'tool.Read'])
    expect(toasts.some(t => /reachable again/.test(t))).toBe(true)
  })

  test('only the last few prompts stay on screen as tasks', async ($, on) => {
    const { events, clock } = engine(on)
    await $.session.start(SESSION)
    for (let i = 1; i <= 8; i++) {
      await $.turn.start(turn(`prompt ${i}`, `t${i}`))
      await $.turn.complete(done('ok', { turnId: `t${i}` }))
    }
    await clock.advance(300)
    expect(events().filter(e => e.type === 'node.remove').map(e => e.id)).toEqual(['task.turn-1', 'task.turn-2'])
  })

  test('/agentviz opens the pane with the live-view link; off pauses, on resumes', async ($, on) => {
    const { events, clock } = engine(on)
    await $.session.start(SESSION)
    await clock.advance(300)
    const shown = await $.command.run({ command: 'agentviz', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
    expect((shown as { text: string }).text).toContain('http://localhost:8787/?run=cc-sess-1')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /Streaming/ }))?.text).toBe('● Streaming')
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      await ui.unmount()
    }

    const off = await $.command.run({ command: 'agentviz', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
    expect((off as { text: string }).text).toMatch(/paused/)
    const before = events().length
    await $.tool.call({ tool: 'Read', file_path: '/a/b.ts' })
    await clock.advance(300)
    expect(events().length).toBe(before)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'pause' })
    await ui.unmount()
    await $.tool.call({ tool: 'Read', file_path: '/a/c.ts' })
    await clock.advance(300)
    expect(events().some(e => e.type === 'message' && e.to === 'tool.Read')).toBe(true)
  })

  test('the session end is sent at once and leaves a metrics row with counts only', async ($, on) => {
    const { events, rows, clock, toasts } = engine(on)
    await $.session.start(SESSION)
    await $.turn.start(turn('hello'))
    await $.tool.call({ tool: 'Read', file_path: '/a/b.ts' })
    await $.session.end(end)
    await clock.settle() // the metrics row is written in the background
    expect(events().filter(e => e.id === 'claude' && e.status).pop()).toMatchObject({ status: 'done' })
    const row = rows.map(r => JSON.parse(r) as Record<string, unknown>).find(r => r.event === 'stream')
    expect(row).toMatchObject({ mod: 'agentviz', toolCalls: 1, unsent: 0 })
    expect(JSON.stringify(row)).not.toMatch(/b\.ts|hello/)
    expect(toasts.some(t => /metrics write failed/.test(t))).toBe(false)
  })

  test('a relay URL that is not http(s) streams nothing and says why', { options: { relayUrl: 'localhost:8787' } }, async ($, on) => {
    const { posts, clock } = engine(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Read', file_path: '/a/b.ts' })
    await clock.advance(300)
    expect(posts).toHaveLength(0)
    const r = await $.command.run({ command: 'agentviz', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
    expect((r as { text: string }).text).toMatch(/not an http\(s\) URL/)
  })
})
