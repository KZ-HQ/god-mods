// Text formatting. Source of truth: ~/.claude/mods/shared/text.ts.
// shared/sync.sh inlines it between the text markers in each mod file that uses it. Edit here, run sync.sh, never edit an inlined copy.

// The first non-blank line, trimmed, cut to max characters with an ellipsis
function firstLine(text: string, max = 90): string {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
