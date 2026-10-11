import { describe, expect, test } from 'claude-code/testing'

import { parse, report } from '../hooks/stats.ts'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const L = (o: object) => JSON.stringify({ t: '2026-10-10T10:00:00Z', project: 'my-app', ...o })

describe('stats', () => {
  test('summarizes cost, savings and answers per mod', async () => {
    const text = [
      L({ mod: 'switchboard', event: 'agent', applied: true, usd: 1, savedUsd: 1 }),
      L({ mod: 'switchboard', event: 'agent', applied: false, usd: 2, savedUsd: 0 }),
      L({ mod: 'next-steps', event: 'shown', ok: true, usd: 0.0001 }),
      L({ mod: 'next-steps', event: 'shown', ok: true, usd: 0.0001 }),
      L({ mod: 'next-steps', event: 'clicked', n: 1 }),
      L({ mod: 'danger-guard', event: 'asked', answer: 'cancel' }),
      L({ mod: 'context-gauge', event: 'compact', outcome: 'done', before: 500_000, after: 40_000 }),
      '{torn',
      JSON.stringify({ t: '2026-09-01T00:00:00Z', mod: 'danger-guard', event: 'asked', answer: 'run' }),
    ].join('\n')
    const out = report(parse(text), NOW - 7 * 86_400_000, 7)
    expect(out).toMatch(/switchboard: 2 agents, 1 rerouted · spent \$3\.00 · saved \$1\.00/)
    expect(out).toMatch(/next-steps: 2 suggestion sets, 1 clicked \(50%\)/)
    expect(out).toMatch(/danger-guard: 1 risky commands asked about, you cancelled 1/)
    expect(out).toMatch(/compact: 1 done \(460k tokens freed\)/)
    expect(out).toMatch(/No events: .*merge-gate/)
    expect(out).toMatch(/\(7 events\)/)
  })

  test('filters to one project', async () => {
    const text = [L({ mod: 'secret-scrubber', event: 'masked' }), L({ mod: 'secret-scrubber', event: 'masked', project: 'other' })].join('\n')
    expect(report(parse(text), 0, 7, 'other')).toMatch(/secret-scrubber: 1 outputs masked/)
  })
})
