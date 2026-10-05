// The scroll of a name too long for its column, shared by the tree's selected
// agent name (draw.mjs) and the ticket view's selected title (ticket-draw.mjs).
export const MARQUEE = { holdStartMs: 3000, holdEndMs: 5000, msPerChar: 250 }

// How many characters a selected name of `length` scrolls left by, `elapsedMs`
// after its row was selected, in a column `width` wide: 0 while it fits.
// Otherwise it shows its start for 3 s, scrolls left at 4 characters a
// second until its end is in view, holds its end for 5 s, and snaps back to
// its start, over and over.
export function marqueeOffset(elapsedMs, length, width) {
  const max = length - width
  if (max <= 0) return 0
  const scrollMs = max * MARQUEE.msPerChar
  const t = Math.max(0, elapsedMs) % (MARQUEE.holdStartMs + scrollMs + MARQUEE.holdEndMs)
  return t < MARQUEE.holdStartMs ? 0 : Math.min(max, Math.floor((t - MARQUEE.holdStartMs) / MARQUEE.msPerChar))
}
