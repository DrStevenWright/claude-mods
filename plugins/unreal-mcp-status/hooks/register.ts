import type { Register, EngineInterface, PluginOptions } from 'claude-code'

const FALLBACK_ENDPOINT = 'http://127.0.0.1:8000/mcp'
const POLL_MS = 15_000

type Settings = { server: string; endpointOverride: string }

function readSettings(options: PluginOptions): Settings {
  const server = typeof options.server_name === 'string' && options.server_name.trim()
    ? options.server_name.trim()
    : 'unreal-mcp'
  const endpointOverride = typeof options.endpoint_url === 'string' ? options.endpoint_url.trim() : ''
  return { server, endpointOverride }
}

// The server's entry in the project's .mcp.json, or undefined when the
// project does not configure it (the mod then stays silent).
async function projectServerEntry($: EngineInterface, cwd: string, server: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(`${cwd}/.mcp.json`))
    const servers = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers
    const entry = servers?.[server]
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// Any HTTP answer means the editor's MCP plugin is listening; a rejected
// fetch (connection refused) means it is not.
async function isEndpointUp($: EngineInterface, url: string): Promise<boolean> {
  try {
    await $.http.fetch(url, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' } })
    return true
  } catch {
    return false
  }
}

async function hasSessionTools($: EngineInterface, server: string): Promise<boolean> {
  try {
    const prefix = `mcp__${server}__`
    return (await $.tool.list()).some(t => t.name.startsWith(prefix))
  } catch {
    return false
  }
}

let last: string | undefined

function show($: EngineInterface, text: string | undefined): void {
  if (text !== last) {
    last = text
    $.ui.status(text)
  }
}

async function refresh($: EngineInterface, cwd: string, settings: Settings): Promise<void> {
  const entry = await projectServerEntry($, cwd, settings.server)
  if (!entry) return show($, undefined)

  const url = settings.endpointOverride
    || (typeof entry.url === 'string' && entry.url)
    || FALLBACK_ENDPOINT
  const [up, tools] = await Promise.all([isEndpointUp($, url), hasSessionTools($, settings.server)])
  show($,
    up && tools ? 'Unreal MCP ● connected'
    : up ? 'Unreal MCP ◐ editor up, session not connected (Reconnect in /mcp)'
    : tools ? 'Unreal MCP ○ editor not responding'
    : 'Unreal MCP ○ offline (editor not running)')
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    last = undefined
    void refresh($, e.cwd, settings)
    $.clock.every(POLL_MS, () => { void refresh($, e.cwd, settings) })
    return result
  })
}
