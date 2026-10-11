// Pure helpers: no `$`, so tests call them directly.

const STOP = new Set(
  'this that with from have what when where which there their they them then than these those will would could should about into also just like make made does done been being were your yours ours mine some more most very much many each other only over such here please thanks thank want need good well okay sure still again lets check look give take tell show using used use can the and for are but not you all any how why who our its was has had get got let new now one two way'.split(' '),
)

// Content words: lowercase, 4+ letters, stop words out, simple plurals folded
export function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []) {
    if (STOP.has(raw)) continue
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw)
  }

  return out
}

// The share of a prompt's words the session has already used
export function overlap(prompt: Set<string>, session: Set<string>): number {
  if (prompt.size === 0) return 1
  let shared = 0
  for (const w of prompt) if (session.has(w)) shared++

  return shared / prompt.size
}
