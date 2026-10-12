// Money formatting, so a cost reads the same in every mod. Source of truth: ~/.claude/mods/shared/money.ts.
// shared/sync.sh inlines it between the money markers in each mod file that uses it. Edit here, run sync.sh, never edit an inlined copy.

// US dollars: three decimals under $1, where cents hide the cost of a cheap call; two from $1
function usd(n: number): string {
  return `$${Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)}`
}
