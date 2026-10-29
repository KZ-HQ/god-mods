import { describe, expect, mock, test } from 'claude-code/testing'

import { TRIM } from '../hooks/register.tsx'
import { alerts, parse, report } from '../hooks/stats.ts'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const L = (o: object) => JSON.stringify({ t: '2026-10-10T10:00:00Z', project: 'my-app', ...o })

describe('stats', () => {
  test('summarizes cost and answers per mod', async () => {
    const text = [
      L({ mod: 'next-steps', event: 'shown', ok: true, usd: 0.0001 }),
      L({ mod: 'next-steps', event: 'shown', ok: true, usd: 0.0001 }),
      L({ mod: 'next-steps', event: 'clicked', n: 1 }),
      L({ mod: 'secret-scrubber', event: 'masked' }),
      L({ mod: 'context-gauge', event: 'compact', outcome: 'done', before: 500_000, after: 40_000 }),
      '{torn',
      JSON.stringify({ t: '2026-09-01T00:00:00Z', mod: 'secret-scrubber', event: 'masked' }),
    ].join('\n')
    const out = report(parse(text), NOW - 7 * 86_400_000, 7, undefined, ['merge-gate', 'some-mod'])
    expect(out).toMatch(/next-steps(?: \([^)]*\))?: 2 suggestion sets, 1 clicked \(50%\)/)
    expect(out).toMatch(/secret-scrubber(?: \([^)]*\))?: 1 outputs masked/)
    expect(out).toMatch(/compact: 1 done \(460k tokens freed\)/)
    expect(out).toMatch(/No events: .*merge-gate/)
    expect(out).toMatch(/\(5 events\)/)
  })

  test('filters to one project', async () => {
    const text = [L({ mod: 'secret-scrubber', event: 'masked' }), L({ mod: 'secret-scrubber', event: 'masked', project: 'other' })].join('\n')
    expect(report(parse(text), 0, 7, 'other')).toMatch(/secret-scrubber(?: \([^)]*\))?: 1 outputs masked/)
  })

  test('v2 rows: loads and hook calls show beside outcomes, and a loaded mod with no outcomes is not quiet', async () => {
    const text = [
      L({ v: 2, mod: 'some-mod', event: 'loaded', ver: '0.3.0' }),
      L({ v: 2, mod: 'some-mod', event: 'turn', hooks: { 'tool.call': 3, 'turn.complete': 1 } }),
      L({ v: 2, mod: 'merge-gate', event: 'loaded', ver: '0.2.0' }),
      L({ v: 2, mod: 'merge-gate', event: 'verdict', kind: 'pass' }),
    ].join('\n')
    const out = report(parse(text), 0, 7)
    expect(out).toMatch(/some-mod(?: \([^)]*\))?: no outcomes · loaded 1× \(v0\.3\.0\), 4 hook calls/)
    expect(out).toMatch(/merge-gate(?: \([^)]*\))?: 1 merges checked: 1 pass.* · loaded 1× \(v0\.2\.0\), 0 hook calls/)
    expect(out).toMatch(/\(1 events\)/)
    expect(out).not.toMatch(/No events: .*some-mod/)
  })

  test('/mod-stats lists every mod in marketplace.json, including ones with no rows', async ($: any, on: any) => {
    const files: Record<string, string> = {
      '/home/t/.claude/plugins/known_marketplaces.json': JSON.stringify({ 'god-mods': { installLocation: '/m' } }),
      '/m/.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'brand-new-mod' }, { name: 'some-mod' }] }),
    }
    on('env.get', () => ({ value: '/home/t' }))
    on('fs.read', ($: any, e: any) => ({ value: files[e.path] ?? '' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: L({ v: 2, mod: 'some-mod', event: 'loaded', ver: '1.0.0' }), stderr: '' } }))
    on('clock.now', () => ({ value: NOW }))
    const out = await $.command.run({ command: 'mod-stats', args: '' })
    expect(out.text).toMatch(/No events: brand-new-mod/)
    expect(out.text).toMatch(/some-mod(?: \([^)]*\))?: no outcomes/)
  })

  test('/mod-stats still reports when the marketplace manifest is unreadable', async ($: any, on: any) => {
    on('env.get', () => ({ value: '/home/t' }))
    on('fs.read', () => { throw new Error('ENOENT') })
    on('process.run', () => ({ value: { exitCode: 0, stdout: L({ v: 2, mod: 'some-mod', event: 'loaded', ver: '1.0.0' }), stderr: '' } }))
    on('clock.now', () => ({ value: NOW }))
    const out = await $.command.run({ command: 'mod-stats', args: '' })
    expect(out.text).toMatch(/some-mod(?: \([^)]*\))?: no outcomes/)
    expect(out.text).not.toMatch(/No events/)
  })

  test('shows mod-faults fault rows against the mod that faulted', async () => {
    const text = [
      L({ v: 2, mod: 'danger-guard', event: 'loaded', ver: '0.4.2' }),
      L({ v: 2, mod: 'mod-faults', event: 'fault', plugin: 'danger-guard', hookEvent: 'tool.call', outcome: 'skipped', reasonKind: 'none' }),
      L({ v: 2, mod: 'mod-faults', event: 'fault', plugin: 'danger-guard@god-mods', hookEvent: 'tool.call', outcome: 'caught', reasonKind: 'none' }),
      L({ v: 2, mod: 'mod-faults', event: 'fault', plugin: 'some-mod', hookEvent: 'agent.spawn', outcome: 'expired', reasonKind: 'timeout' }),
    ].join('\n')
    const out = report(parse(text), 0, 7, undefined, ['danger-guard', 'some-mod', 'test-on-edit'])
    expect(out).toMatch(/danger-guard(?: \([^)]*\))?: no outcomes · loaded 1× \(v0\.4\.2\), 0 hook calls · 2 faults/)
    expect(out).toMatch(/some-mod(?: \([^)]*\))?: no outcomes · 1 fault$/m)
    expect(out).toMatch(/mod-faults(?: \([^)]*\))?: 3 hook faults recorded across mods/)
    expect(out).toMatch(/No events: test-on-edit$/m)
  })

  test('v1 rows (no v, no project) still count, and rows missing fields are skipped', async () => {
    const text = [
      JSON.stringify({ t: '2026-10-10T10:00:00Z', mod: 'secret-scrubber', event: 'masked' }),
      JSON.stringify({ t: '2026-10-10T10:00:00Z', mod: 'secret-scrubber' }),
      JSON.stringify({ mod: 'secret-scrubber', event: 'masked' }),
      '',
      '   ',
    ].join('\n')
    const rows = parse(text)
    expect(rows).toHaveLength(1)
    expect(report(rows, 0, 7)).toMatch(/secret-scrubber(?: \([^)]*\))?: 1 outputs masked/)
  })

  test('/mod-stats with an empty log says nothing is recorded yet', async ($: any, on: any) => {
    on('env.get', () => ({ value: '/home/t' }))
    on('fs.read', () => { throw new Error('ENOENT') })
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
    on('clock.now', () => ({ value: NOW }))
    const out = await $.command.run({ command: 'mod-stats', args: '' })
    expect(out.text).toMatch(/^No mod events recorded yet/)
  })

  test("mod-faults' blind spot shows only when its latest session reported one", async () => {
    const at = (t: string, o: object) => JSON.stringify({ t, project: 'my-app', v: 2, ...o })
    const blind = [
      at('2026-10-10T09:00:00Z', { mod: 'mod-faults', event: 'loaded', session: 's1', ver: '0.5.0' }),
      at('2026-10-10T09:00:01Z', { mod: 'mod-faults', event: 'blind', session: 's1', mods: ['context-gauge', 'danger-guard'], of: 16 }),
    ]
    expect(report(parse(blind.join('\n')), 0, 7)).toMatch(/mod-faults(?: \([^)]*\))?: no outcomes · .* · can't see 2: context-gauge, danger-guard/)
    const fixed = [...blind, at('2026-10-10T10:00:00Z', { mod: 'mod-faults', event: 'loaded', session: 's2', ver: '0.5.0' })]
    expect(report(parse(fixed.join('\n')), 0, 7)).not.toMatch(/can't see/)
  })
})

describe('health', () => {
  const at = (t: string, o: object) => JSON.stringify({ t, project: 'my-app', v: 2, ...o })

  test('labels mods active, stale or dormant, and names the dormant ones', async () => {
    const text = [
      at('2026-10-10T10:00:00Z', { mod: 'next-steps', event: 'shown', ok: true }),
      at('2026-10-05T10:00:00Z', { mod: 'merge-gate', event: 'verdict', kind: 'pass' }),
      at('2026-10-10T10:00:00Z', { mod: 'agent-spend', event: 'loaded', ver: '0.1.0' }),
      at('2026-10-10T10:00:00Z', { mod: 'agent-spend', event: 'turn', hooks: { 'session.start': 1 } }),
      at('2026-10-10T10:00:00Z', { mod: 'context-gauge', event: 'turn', hooks: { 'ui.render': 4 } }),
    ].join('\n')
    const out = report(parse(text), NOW - 7 * 86_400_000, 7)
    expect(out).toMatch(/next-steps \(active\):/)
    expect(out).toMatch(/context-gauge \(active\):/)
    expect(out).toMatch(/merge-gate \(stale, last used 2026-10-05\):/)
    expect(out).toMatch(/agent-spend \(dormant\):/)
    expect(out).toMatch(/Dormant \(loaded, never used in 7 days\): agent-spend: candidates to remove/)
  })

  test('sums hook time per mod and flags a slow hook', async () => {
    const text = [
      L({ v: 2, mod: 'mod-stats', event: 'latency', mods: { 'next-steps': { calls: 4, ms: 40, max: 20, maxEvent: 'turn.complete' } } }),
      L({ v: 2, mod: 'mod-stats', event: 'latency', mods: { 'next-steps': { calls: 6, ms: 2560, max: 2500, maxEvent: 'prompt.submit' } } }),
      L({ v: 2, mod: 'next-steps', event: 'shown', ok: true }),
    ].join('\n')
    expect(report(parse(text), 0, 7)).toMatch(/next-steps .*· hooks avg 260ms, max 2500ms \(prompt\.submit\) SLOW/)
  })

  test("totals what mods added to Claude's context", async () => {
    const text = [
      L({ mod: 'prompt-shaper', event: 'inject', chars: 4000 }),
      L({ mod: 'prompt-shaper', event: 'toolchain', chars: 400 }),
      L({ mod: 'test-on-edit', event: 'delivered', chars: 800 }),
    ].join('\n')
    expect(report(parse(text), 0, 7)).toMatch(/Tokens added to Claude's context: prompt-shaper ~1k, test-on-edit ~200/)
  })
})

describe('alerts', () => {
  const at = (t: string, o: object) => JSON.stringify({ t, project: 'my-app', v: 2, ...o })
  const LOG = [
    at('2026-09-20T10:00:00Z', { mod: 'old-mod', event: 'loaded' }),
    at('2026-10-09T10:00:00Z', { mod: 'old-mod', event: 'loaded' }),
    at('2026-09-20T10:00:00Z', { mod: 'secret-scrubber', event: 'loaded' }),
    at('2026-10-09T10:00:00Z', { mod: 'secret-scrubber', event: 'loaded' }),
    at('2026-10-09T10:00:00Z', { mod: 'new-mod', event: 'loaded' }),
    at('2026-10-09T10:00:00Z', { mod: 'mod-stats', event: 'latency', mods: { 'next-steps': { calls: 1, ms: 3100, max: 3100, maxEvent: 'turn.complete' } } }),
  ].join('\n')

  test('skips mods no longer in the marketplace', async () => {
    expect(alerts(parse(LOG), NOW, ['next-steps']).map(a => a.key)).toEqual(['slow:next-steps'])
  })

  test('names mods dormant a full week and slow hooks, sparing new installs and guards', async () => {
    expect(alerts(parse(LOG), NOW)).toEqual([
      { key: 'dormant:old-mod', text: 'old-mod is dormant: loaded but not used in 7 days' },
      { key: 'slow:next-steps', text: 'next-steps is slow: a turn.complete hook took 3.1s' },
    ])
  })

  test('session start toasts new alerts once, not again next session', async ($: any, on: any) => {
    mock.store(on)
    const toasts: string[] = []
    on('ui.toast', (_$: any, e: any) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
    on('clock.now', () => ({ value: NOW }))
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', (_$: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv[2]?.startsWith('tail') ? LOG : '', stderr: '' } }))
    const settle = async () => {
      for (let i = 0; i < 500; i++) await Promise.resolve()
    }
    await $.session.start({ cwd: '/r' })
    await settle()
    expect(toasts.filter(t => t.startsWith('mod-stats: old-mod is dormant'))).toHaveLength(1)
    expect(toasts.some(t => t.includes('next-steps is slow'))).toBe(true)
    await $.session.start({ cwd: '/r' })
    await settle()
    expect(toasts.filter(t => t.includes('dormant'))).toHaveLength(1)
  })
})

describe('log size', () => {
  test('each session start trims metrics.jsonl past 10 MB to the lines /mod-stats reads', async ($: any, on: any) => {
    const ran: string[] = []
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
    on('process.run', (_$: any, e: any) => {
      ran.push(e.argv.join(' '))

      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    })
    await $.session.start({ cwd: '/r' })
    await Promise.resolve()
    expect(ran).toContain(`/bin/sh -c ${TRIM}`)
    expect(TRIM).toMatch(/-gt 10000000 \] && tail -n 50000/)
  })
})
