// Pure helpers: no `$`, so tests call them directly.
import type { Agent } from '../types'

// <money: generated from shared/money.ts by shared/sync.sh>
// US dollars: three decimals under $1, where cents hide the cost of a cheap call; two from $1
function usd(n: number): string {
  return `$${Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)}`
}
// </money>

export function parse(stdout: string): Agent[] {
  const out: Agent[] = []
  for (const line of stdout.split('\n')) {
    try {
      const a = JSON.parse(line)
      if (typeof a?.usd === 'number' && typeof a.tier === 'string') out.push(a)
    } catch {}
  }

  return out
}

export type Group = { name: string; agents: number; usd: number; share: number }

export function groups(agents: Agent[], key: 'tier' | 'type'): Group[] {
  const total = agents.reduce((s, a) => s + a.usd, 0)
  const by = new Map<string, Group>()
  for (const a of agents) {
    const g = by.get(a[key]) ?? { name: a[key], agents: 0, usd: 0, share: 0 }
    g.agents += 1
    g.usd += a.usd
    by.set(a[key], g)
  }

  return [...by.values()].map(g => ({ ...g, share: total ? Math.round((g.usd * 100) / total) : 0 })).sort((a, b) => b.usd - a.usd)
}

export const costliest = (agents: Agent[], n: number) => [...agents].sort((a, b) => b.usd - a.usd).slice(0, n)

export function summary(agents: Agent[], days: number, project: string): string {
  const scope = `last ${days} day${days === 1 ? '' : 's'}${project ? ` in ${project}` : ''}`
  if (!agents.length) return `No subagents ran in the ${scope}.`
  const total = agents.reduce((s, a) => s + a.usd, 0)
  const row = (g: Group) => `  ${g.name.padEnd(18)} ${String(g.agents).padStart(4)} agents  ${usd(g.usd).padStart(8)}  ${String(g.share).padStart(3)}%`

  return [
    `${agents.length} agents, ${scope}: ${usd(total)}`,
    '',
    'By model',
    ...groups(agents, 'tier').map(row),
    '',
    'By agent type',
    ...groups(agents, 'type').map(row),
    '',
    'Costliest',
    ...costliest(agents, 5).map(a => `  ${usd(a.usd).padStart(7)}  ${a.tier.padEnd(6)} ${a.type.padEnd(16)} ${(a.tokens / 1e6).toFixed(1).padStart(5)}M  ${a.project}: ${a.desc}`),
    '',
    '$ are list-price estimates.',
  ].join('\n')
}
