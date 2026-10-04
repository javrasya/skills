// What a harness's own events say about a person being waited on, as the
// crew daemon keeps it for a session (`session.waiting`): a worker that waits
// is blocked on a human, and a session not yet prompted is not ready.
//
// Each reader takes one event and answers { waiting: <what for> } when the
// harness starts waiting on the person, { waiting: null } once it is past it,
// and null for an event that says neither. `keep: true` sets it only when
// nothing is waited on yet, so a vaguer event after a precise one, Claude's
// permission notification after its permission request, keeps the precise one.

const line = (s) =>
  String(s ?? '')
    .split('\n')[0]
    .trim()

// Claude's hooks (crew passes them to a worker's session with --settings):
// a permission dialog, its question tool, and an MCP server asking for input
// wait on the person; the next tool, prompt, turn end or answer is past it.
// Claude has no event for a dialog closing, so whatever comes next clears it.
export function claudeWaiting(p) {
  switch (p?.hook_event_name) {
    case 'PermissionRequest': {
      const what = line(p.tool_input?.command ?? p.tool_input?.file_path ?? p.tool_input?.url)
      return { waiting: `Claude asks permission to use ${p.tool_name}${what ? `: ${what}` : ''}` }
    }
    case 'Elicitation':
      return { waiting: `${p.mcp_server_name ?? 'an MCP server'} asks: ${line(p.message)}` }
    case 'Notification':
      return ['permission_prompt', 'elicitation_dialog'].includes(p.notification_type) ? { waiting: line(p.message), keep: true } : null
    case 'PreToolUse':
      return p.tool_name === 'AskUserQuestion' ? { waiting: `Claude asks you: ${line(p.tool_input?.questions?.[0]?.question)}` } : { waiting: null }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
    case 'ElicitationResult':
    case 'UserPromptSubmit':
    case 'Stop':
      return { waiting: null }
    default:
      return null
  }
}

// The hook events claudeWaiting reads, which crew's --settings hooks name.
export const CLAUDE_HOOK_EVENTS = Object.freeze(['PermissionRequest', 'Elicitation', 'Notification', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult', 'UserPromptSubmit', 'Stop'])

// pi's extension events (crew loads its extension into a worker's session
// with -e): every dialog an extension opens, pi-mcp-adapter's MCP approval
// among them, starts and ends one, before the first prompt and after.
export function piWaiting(e) {
  if (e?.type === 'ui_prompt_start') return { waiting: e.title ? `pi asks: ${line(e.title)}` : `pi shows a ${e.kind ?? 'dialog'} dialog` }
  if (e?.type === 'ui_prompt_end') return { waiting: null }
  return null
}
