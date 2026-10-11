// Pure helpers: no `$`, so tests call them directly.

export const SYSTEM = [
  "You suggest what the user of a coding agent will most likely type next.",
  'Reply with 2 or 3 lines, one suggestion per line, nothing else: no numbering, quotes or preamble.',
  "Each line is a short prompt in the user's own voice (under 12 words), concrete to this conversation.",
  'Prefer the obvious next step: approve or merge what was proposed, answer a question the agent asked, run or check something.',
].join(' ')

export function prompt(asked: string, answer: string): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

  return `The user asked:\n${clip(asked, 1500)}\n\nThe agent replied:\n${clip(answer, 4000)}\n\nThe user's likely next prompts:`
}

export function parse(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'`]|["'`]$/g, '').trim())
    .filter(l => l.length > 2 && l.length <= 120)
    .slice(0, 3)
}
