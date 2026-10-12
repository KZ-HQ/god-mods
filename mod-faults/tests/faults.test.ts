import { expect, test } from 'claude-code/testing'

const SECRET = 'sk-do-not-log'
const boom = {
  name: 'danger-guard',
  register(on: any) {
    on('tool.call', async () => { throw new Error(`boom ${SECRET}`) })
  },
}

// Stubs the marketplace manifest (null: unreadable) and captures metrics rows and toasts
function engine(on: any, names: string[] | null) {
  const files: Record<string, string> = {
    '/home/t/.claude/plugins/known_marketplaces.json': JSON.stringify({ 'god-mods': { installLocation: '/m' } }),
    '/m/.claude-plugin/marketplace.json': JSON.stringify({ plugins: (names ?? []).map(name => ({ name })) }),
  }
  const rows: any[] = []
  const toasts: string[] = []
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', ($: any, e: any) => {
    if (!names) throw new Error('ENOENT')
    return { value: files[e.path] ?? '{}' }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/w' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/w/app' }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text ?? String(e))
    return { value: undefined }
  })
  on('process.run', ($: any, e: any) => {
    const line = e.argv[4]
    if (line) rows.push(JSON.parse(line))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))

  return { rows, toasts, faults: () => rows.filter(r => r.event === 'fault') }
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const start = ($: any) => $.session.start({ cwd: '/w', surface: null, isInteractive: false })

test('reads the mod list from marketplace.json', { plugins: [{
  name: 'new-mod',
  register(on: any) { on('tool.call', async () => { throw new Error('boom') }) },
}] }, async ($: any, on: any) => {
  engine(on, ['new-mod', 'mod-faults'])
  await start($)
  await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  const out = await $.command.run({ command: 'mod-faults', args: '' })
  expect(out.text).toContain('new-mod: 1')
  expect(out.text).toContain('Mod list (1): /m/.claude-plugin/marketplace.json')
})

test('passes calls through and records a fault row in metrics, without the reason text', { plugins: [boom] }, async ($: any, on: any) => {
  const m = engine(on, ['danger-guard'])
  await start($)
  const r = await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  expect(r.deny).toBeUndefined()
  await settle()
  expect(m.faults()).toHaveLength(1)
  const row = m.faults()[0]
  expect(row).toMatchObject({ v: 2, mod: 'mod-faults', event: 'fault', plugin: 'danger-guard', hookEvent: 'tool.call' })
  expect(typeof row.reasonKind).toBe('string')
  expect(JSON.stringify(row)).not.toContain(SECRET)
  expect(m.rows.some(r => r.event === 'loaded')).toBe(true)
  const out = await $.command.run({ command: 'mod-faults', args: '' })
  expect(out.text).toContain('danger-guard: 1')
  expect(out.text).toContain('metrics.jsonl')
})

test('toasts once, at the third fault from one mod', { plugins: [boom] }, async ($: any, on: any) => {
  const m = engine(on, ['danger-guard'])
  await start($)
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  expect(m.toasts.filter(t => t.includes('danger-guard'))).toHaveLength(0)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  const alerts = m.toasts.filter(t => t.includes('danger-guard'))
  expect(alerts).toHaveLength(1)
  expect(alerts[0]).toContain('3 times')
})

test('without a readable manifest, a plugin not installed from god-mods is not counted', { plugins: [boom] }, async ($: any, on: any) => {
  const m = engine(on, null)
  await start($)
  await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  await settle()
  expect(m.faults()).toHaveLength(0)
  const out = await $.command.run({ command: 'mod-faults', args: '' })
  expect(out.text).not.toContain('danger-guard: 1')
  expect(out.text).toContain('Mod list (0): unavailable')
})

// An inline plugin sits beneath mod-faults; one that hooks session.start is seen there
const beneath = (name: string) => ({ name, register(on: any) { on('session.start', async ($: any, e: any, next: any) => next(e)) } })

test('names the god-mods it cannot see, once, with the fix', { plugins: [beneath('seen-mod')] }, async ($: any, on: any) => {
  const m = engine(on, ['seen-mod', 'above-mod', 'also-above'])
  await start($)
  await settle()
  const rows = m.rows.filter(r => r.event === 'blind')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ mods: ['above-mod', 'also-above'], of: 3 })
  expect(m.toasts.filter(t => /can't see faults in 2 of 3/.test(t))).toHaveLength(1)
  const out = (await $.command.run({ command: 'mod-faults', args: '' })).text
  expect(out).toContain('Not visible (above this mod, or not enabled): above-mod, also-above')
  expect(out).toContain('top of enabledPlugins')
})

test('says nothing about blind spots when it sees every god-mod', { plugins: [beneath('seen-mod')] }, async ($: any, on: any) => {
  const m = engine(on, ['seen-mod'])
  await start($)
  await settle()
  expect(m.rows.filter(r => r.event === 'blind')).toHaveLength(0)
  expect(m.toasts.filter(t => /can't see/.test(t))).toHaveLength(0)
  expect((await $.command.run({ command: 'mod-faults', args: '' })).text).not.toContain('Not visible')
})
