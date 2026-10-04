// crew's MCP server, passed to a worker's Claude session only (`claude
// --mcp-config`, crew-host crewMcpConfig), never installed: Claude starts it
// over stdio and it gives the session crew's tools (crew-tools.mjs), as crew's
// pi extension gives pi's. JSON-RPC by hand, one message a line, as MCP's
// stdio transport has it: initialize, tools/list and tools/call, nothing more.
// It lists the tools of the session's agent, as the daemon holds its
// dispatch (CREW_SESSION, under CREW_HOME), so a session of no agent, or one
// outside crew, lists none. A call is one daemon op; whatever fails it, a
// refusal or a daemon gone, comes back as error content, so Claude goes on.
// stdout is the protocol's alone: anything else goes to stderr.
import { createInterface } from 'node:readline'
import { agentOf, crewTools } from './crew-tools.mjs'

const env = process.env
const LATEST = '2025-06-18'

// Asked again until an agent is found: a session of none may be one whose
// dispatch is not made yet.
let tools = null
const toolsOf = async () => {
  if (tools) return tools
  const agent = await agentOf(env)
  return agent ? (tools = crewTools(agent, env)) : []
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/** @type {Record<string, (params: any) => any>} */
const methods = {
  // The version Claude asks for: crew uses nothing a version changes.
  initialize: ({ protocolVersion } = {}) => ({ protocolVersion: protocolVersion ?? LATEST, capabilities: { tools: {} }, serverInfo: { name: 'crew', version: '1' } }),
  ping: () => ({}),
  'tools/list': async () => ({ tools: (await toolsOf()).map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })) }),
  'tools/call': async ({ name, arguments: args = {} } = {}) => {
    const t = (await toolsOf()).find((t) => t.name === name)
    if (!t) return text(`crew has no tool ${name} for this session.`, true)
    try {
      return text(await t.call(args))
    } catch (e) {
      return text(e?.message ?? String(e), true)
    }
  },
}

const reply = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return reply({ id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const { id, method, params } = message ?? {}
  // A notification (initialized, cancelled) asks for no answer.
  if (id === undefined || id === null) return
  const handle = Object.hasOwn(methods, method) ? methods[method] : null
  if (!handle) return reply({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  try {
    reply({ id, result: await handle(params) })
  } catch (e) {
    process.stderr.write(`crew mcp: ${method}: ${e?.message ?? e}\n`)
    reply({ id, error: { code: -32603, message: e?.message ?? String(e) } })
  }
})
