import { test, expect } from 'claude-code/testing'

const boom = {
  name: 'danger-guard',
  register(on: any) {
    on('tool.call', async () => { throw new Error('boom') })
  },
}

test('reads the mod list from marketplace.json', { plugins: [{
  name: 'new-mod',
  register(on: any) { on('tool.call', async () => { throw new Error('boom') }) },
}] }, async ($: any, on: any) => {
  const files: Record<string, string> = {
    '/home/t/.claude/plugins/known_marketplaces.json': JSON.stringify({ 'god-mods': { installLocation: '/m' } }),
    '/m/.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'new-mod' }, { name: 'mod-faults' }] }),
  }
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', ($: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/w' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  const out = await $.command.run({ command: 'mod-faults', args: '' })
  expect(out.text).toContain('new-mod: 1')
  expect(out.text).toContain('/m/.claude-plugin/marketplace.json')
})

function stubMarketplace(on: any, names: string[] | null) {
  const files: Record<string, string> = {
    '/home/t/.claude/plugins/known_marketplaces.json': JSON.stringify({ 'god-mods': { installLocation: '/m' } }),
    '/m/.claude-plugin/marketplace.json': JSON.stringify({ plugins: (names ?? []).map(name => ({ name })) }),
  }
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', ($: any, e: any) => {
    if (!names) throw new Error('ENOENT')
    return { value: files[e.path] ?? '' }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/w' }))
  on('tool.call', () => ({ result: 'ok' }))
}

test('passes calls through and counts a failing god-mod', { plugins: [boom] }, async ($: any, on: any) => {
  stubMarketplace(on, ['danger-guard'])
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  const r = await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  expect(r.deny).toBeUndefined()
  const out = await $.command.run({ command: 'mod-faults', args: '' })
  expect(out.text).toContain('danger-guard: 1')
})

test('without a readable manifest, a plugin not installed from god-mods is not counted', { plugins: [boom] }, async ($: any, on: any) => {
  stubMarketplace(on, null)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
  const out = await $.command.run({ command: 'mod-faults', args: '' })
  expect(out.text).not.toContain('danger-guard: 1')
  expect(out.text).toContain('Mod list (0): unavailable')
})
