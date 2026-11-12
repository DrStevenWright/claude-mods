import type { Register, EngineInterface, PluginOptions } from 'claude-code'

const FALLBACK_ENDPOINT = 'http://127.0.0.1:8000/mcp'
const POLL_MS = 15_000
// Once connected, only every second tick checks again (30 s).
const CONNECTED_EVERY_N_TICKS = 2

type Settings = { server: string; endpointOverride: string }

function readSettings(options: PluginOptions): Settings {
  const server = typeof options.server_name === 'string' && options.server_name.trim()
    ? options.server_name.trim()
    : 'unreal-mcp'
  const endpointOverride = typeof options.endpoint_url === 'string' ? options.endpoint_url.trim() : ''
  return { server, endpointOverride }
}

type ProjectEntry =
  | { kind: 'absent' }                              // no .mcp.json, or it doesn't list the server
  | { kind: 'unreadable' }                          // .mcp.json exists but isn't valid JSON
  | { kind: 'found'; entry: Record<string, unknown> }

// The server's entry in the project's .mcp.json. The mod stays silent when the
// project doesn't configure the server, and says so when the file is broken.
async function projectServerEntry($: EngineInterface, cwd: string, server: string): Promise<ProjectEntry> {
  let text: string
  try {
    text = await $.fs.read(`${cwd}/.mcp.json`)
  } catch {
    return { kind: 'absent' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unreadable' }
  }
  const entry = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.[server]
  return entry && typeof entry === 'object'
    ? { kind: 'found', entry: entry as Record<string, unknown> }
    : { kind: 'absent' }
}

const PROBE_TIMEOUT_MS = 3_000

type Probe = 'up' | 'down' | 'slow'

// Any HTTP answer means the editor's MCP plugin is listening; a rejected
// fetch (connection refused) means it is not. $.http.fetch has no timeout or
// abort signal, so the probe races it against a sleep: an editor that is busy
// (cooking, compiling shaders) or hung answers 'slow' instead of hanging the check.
async function probeEndpoint($: EngineInterface, url: string): Promise<Probe> {
  const request = $.http
    .fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
    .then((): Probe => 'up', (): Probe => 'down')
  const timeout = $.clock.sleep(PROBE_TIMEOUT_MS).then((): Probe => 'slow')
  return Promise.race([request, timeout])
}

async function hasSessionTools($: EngineInterface, server: string): Promise<boolean> {
  try {
    const prefix = `mcp__${server}__`
    return (await $.tool.list()).some(t => t.name.startsWith(prefix))
  } catch {
    return false
  }
}

// Per-session state, so sessions sharing this module don't hide each other's updates.
type SessionState = {
  last: string | undefined
  upAtStart: boolean | undefined   // endpoint state on the first check of this session
  connected: boolean
  tick: number
  inFlight: boolean
}

function show($: EngineInterface, state: SessionState, text: string | undefined): void {
  if (text !== state.last) {
    state.last = text
    $.ui.status(text)
  }
}

function describe(probe: Probe, tools: boolean, upAtStart: boolean | undefined): string {
  if (probe === 'slow') {
    return tools
      ? 'Unreal MCP ◐ connected · editor busy (no answer in 3 s)'
      : 'Unreal MCP ○ editor busy or hung (no answer in 3 s)'
  }
  const up = probe === 'up'
  if (up && tools) return 'Unreal MCP ● connected'
  if (up) {
    // The session's MCP client dials servers once at start; a server that wasn't
    // listening then stays failed until the session reconnects it.
    return upAtStart === false
      ? 'Unreal MCP ◐ editor started after this session · reconnect, fork or start a new session'
      : 'Unreal MCP ◐ editor up · this session not connected · reconnect, fork or start a new session'
  }
  if (tools) return 'Unreal MCP ○ editor not responding'
  return 'Unreal MCP ○ offline (editor not running)'
}

async function refresh($: EngineInterface, cwd: string, settings: Settings, state: SessionState): Promise<void> {
  const project = await projectServerEntry($, cwd, settings.server)
  if (project.kind === 'absent') {
    state.connected = false
    return show($, state, undefined)
  }
  if (project.kind === 'unreadable') {
    state.connected = false
    return show($, state, 'Unreal MCP ○ .mcp.json is not valid JSON')
  }

  const entry = project.entry
  const url = settings.endpointOverride
    || (typeof entry.url === 'string' && entry.url)
    || FALLBACK_ENDPOINT
  const [probe, tools] = await Promise.all([probeEndpoint($, url), hasSessionTools($, settings.server)])
  // A slow answer says the editor process exists, so it counts as up for the start check.
  if (state.upAtStart === undefined) state.upAtStart = probe !== 'down'
  state.connected = probe === 'up' && tools
  show($, state, describe(probe, tools, state.upAtStart))
}

// Skip a tick while the previous check is still pending, so a hung editor
// doesn't pile up requests that can't be cancelled.
async function guardedRefresh($: EngineInterface, cwd: string, settings: Settings, state: SessionState): Promise<void> {
  if (state.inFlight) return
  state.inFlight = true
  try {
    await refresh($, cwd, settings, state)
  } finally {
    state.inFlight = false
  }
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const state: SessionState = { last: undefined, upAtStart: undefined, connected: false, tick: 0, inFlight: false }
    void guardedRefresh($, e.cwd, settings, state)
    $.clock.every(POLL_MS, () => {
      state.tick++
      // Poll every 15 s until connected, then every 30 s.
      if (state.connected && state.tick % CONNECTED_EVERY_N_TICKS !== 0) return
      void guardedRefresh($, e.cwd, settings, state)
    })
    return result
  })
}
