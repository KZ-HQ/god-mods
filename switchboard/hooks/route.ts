// Pure helpers: no `$`, so tests call them directly.

export type Tier = 'haiku' | 'sonnet' | 'opus'

// Judgment-heavy work keeps the strongest model
const HEAVY = /\b(review|security|adversarial|audit|architect\w*|design|threat|vulnerab\w*|migration plan|root cause|debug\w*|investigat\w*)\b/i
// Look-up work: finding, listing, reading, summarising
const LIGHT = /\b(search|find|locate|list|grep|look ?up|explore|read[- ]only|summari[sz]e|inventory|which files|where is|count)\b/i
const BUILD = /\b(implement|fix|refactor|write|edit|add|update|change|convert|port|migrate|build|create|scope)\b/i
const LIGHT_TYPES = new Set(['Explore', 'claude-code-guide', 'repo-researcher', 'statusline-setup'])

export type Pick = { tier: Tier; why: string }

// Undefined: leave the model as asked (an explicit model, a fork, a type we don't know)
export function pick(input: { description: string; prompt: string; subagentType: string; model?: string }): Pick | undefined {
  if (input.model) return undefined
  if (input.subagentType === 'fork') return undefined
  const text = `${input.description}\n${input.prompt.slice(0, 2000)}`
  if (HEAVY.test(text)) return { tier: 'opus', why: 'review, security or design work' }
  if (LIGHT_TYPES.has(input.subagentType)) return { tier: 'haiku', why: `${input.subagentType} agent` }
  if (LIGHT.test(input.description) && !BUILD.test(input.description)) return { tier: 'haiku', why: 'look-up task' }
  if (BUILD.test(text)) return { tier: 'sonnet', why: 'implementation task' }

  return undefined
}

// List prices per million tokens (Claude API, 2026-10): input, cache read, cache write, output.
// Cache write is taken as 1.25x input; Haiku's cache read as a tenth of input.
const PRICE: Record<Tier, [number, number, number, number]> = {
  haiku: [0.1, 0.01, 0.125, 0.5],
  sonnet: [2, 0.2, 2.5, 10],
  opus: [4, 0.2, 5, 20],
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function cost(tier: Tier, u: Usage): number {
  const [i, r, w, o] = PRICE[tier]

  return (u.input_tokens * i + u.cache_read_input_tokens * r + u.cache_creation_input_tokens * w + u.output_tokens * o) / 1e6
}

export const tierOf = (model: string): Tier => (/haiku/i.test(model) ? 'haiku' : /sonnet/i.test(model) ? 'sonnet' : 'opus')
