// What a harness's screen says before its first prompt: ready for it, asking
// the person something (a dialog only they should answer: trusting a folder,
// approving a repo's MCP servers), or nothing crew recognises. The crew host
// types a prompt only into a ready screen, never into a dialog: one it
// recognises becomes `needs you` on the agent's row, and the agent carries
// on once the person has answered it in the session and the screen is ready.
//
// Each harness has its own reader, since each CLI draws its own screens, and
// each is a table to add to as a CLI's screens change or a new one is met:
//   ready(lines)   whether the screen is the harness's input prompt, or null
//                  for a harness whose ready screen crew cannot tell
//   tells          true for a harness that tells crew itself when it takes a
//                  prompt (hooks/, the daemon's session.ready), whose screen
//                  then says nothing about it. With neither ready nor tells,
//                  the harness is taken as ready once its terminal has gone
//                  quiet
//   dialogs        what the harness asks the person, checked before ready:
//                  { name, match(text, lines), ask }, `ask` saying what the
//                  person must do, shown as the agent's reason
// A screen neither ready nor a dialog is unrecognised: loading, most often,
// and, once the host has waited long enough for it, `needs you` too.

// A screen's rows as one text, its runs of spaces closed up, so a match does
// not depend on how a TUI positions its words.
const textOf = (lines) => lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
const any = (...patterns) => (text) => patterns.some((p) => p.test(text))

// A horizontal rule as Claude draws its input box's edges.
const RULE = /^[─━]{20,}$/
// Claude's input box: a `❯` row with a rule right above it, and another below
// it or below the lines the input has grown to.
function claudeInputBox(lines) {
  const rows = lines.map((l) => l.trim())
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i].startsWith('❯') || !RULE.test(rows[i - 1])) continue
    if (rows.slice(i + 1, i + 12).some((r) => RULE.test(r))) return true
  }
  return false
}

// Claude's dialogs all end in this line: whatever one it is, it is not ready.
const CLAUDE_CONFIRM = /Enter to confirm|Esc to (cancel|exit)/

export const SCREENS = Object.freeze({
  claude: Object.freeze({
    ready: claudeInputBox,
    dialogs: Object.freeze([
      { name: 'workspace trust', match: any(/Yes, I trust this folder/, /Do you trust the files in this folder/, /Quick safety check: Is this a project you created or one you trust/), ask: 'Claude asks whether to trust this folder: enter the session and answer it' },
      { name: 'MCP servers', match: any(/New MCP servers? found/, /Use this and all future MCP servers in this project/), ask: "Claude asks whether to use the repo's MCP servers (.mcp.json): enter the session and answer it" },
      { name: 'external imports', match: any(/Allow external CLAUDE\.md file imports/), ask: 'Claude asks whether to allow CLAUDE.md imports from outside the repo: enter the session and answer it' },
      { name: 'bypass permissions', match: any(/Bypass Permissions mode/i), ask: 'Claude asks you to accept bypass-permissions mode: enter the session and answer it' },
      { name: 'settings error', match: any(/Settings Error/i, /Invalid Settings/i), ask: 'Claude reports a settings file it cannot read: enter the session and deal with it' },
      { name: 'login', match: any(/Select login method/i, /Please run \/login/, /Invalid API key/i, /OAuth token has expired/i), ask: 'Claude is not logged in: enter the session and log in' },
      { name: 'onboarding', match: any(/Choose the text style/i, /Let's get started/i), ask: "Claude's first-run setup is showing: enter the session and finish it" },
      // Any other dialog Claude draws: named by its first line.
      { name: 'a dialog', match: (text, lines) => CLAUDE_CONFIRM.test(text) && !claudeInputBox(lines), ask: 'Claude shows a dialog: enter the session and answer it' },
    ]),
  }),
  // pi is launched with --approve, so its trust prompt never shows, and its
  // extensions' dialogs are told by pi's own events (waiting.mjs), not read
  // off its screen. Nor is its readiness: pi says so itself (hooks/crew-pi.mjs
  // on session_start). Its terminal cannot be waited on to go quiet, as an
  // extension's status line may redraw it every second for good.
  pi: Object.freeze({ ready: null, tells: true, dialogs: Object.freeze([]) }),
})

// What `lines`, a screen of `harness`, shows: { state: 'ready' }, { state:
// 'dialog', dialog, ask, detail } where `detail` is the screen's first line
// of text, or null for a screen not recognised. A harness with no reader has
// no dialogs and no ready screen crew can tell.
export function readScreen(harness, lines, screens = SCREENS) {
  const reader = screens[harness]
  if (!reader) return null
  const text = textOf(lines)
  for (const d of reader.dialogs) {
    if (d.match(text, lines)) return { state: 'dialog', dialog: d.name, ask: d.ask, detail: text.split('\n').find((l) => l && !RULE.test(l)) ?? null }
  }
  return reader.ready?.(lines) ? { state: 'ready' } : null
}

// Whether crew can tell `harness`'s ready screen, rather than wait for quiet.
export const readsReady = (harness, screens = SCREENS) => typeof screens[harness]?.ready === 'function'
export const tellsReady = (harness, screens = SCREENS) => screens[harness]?.tells === true
