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
  | { kind: 'unreadable'; detail: string }          // .mcp.json exists but isn't valid JSON
  | { kind: 'found'; entry: Record<string, unknown> }

// The parser's error as "line L, column C: message", or the bare message when
// it gives no position. Handles both V8 forms ("at position N" and "(line L column C)").
function describeJsonError(text: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const lineCol = /\(line (\d+) column (\d+)\)/.exec(raw)
  const position = /at position (\d+)/.exec(raw)
  const message = raw
    .replace(/\s*\(line \d+ column \d+\)/, '')
    .replace(/\s*in JSON at position \d+/, '')
    .replace(/\s*at position \d+/, '')
    .trim()
  if (lineCol) return `line ${lineCol[1]}, column ${lineCol[2]}: ${message}`
  if (position) {
    const before = text.slice(0, Number(position[1]))
    const line = before.split('\n').length
    const column = before.length - before.lastIndexOf('\n')
    return `line ${line}, column ${column}: ${message}`
  }
  return message
}

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
  } catch (error) {
    return { kind: 'unreadable', detail: describeJsonError(text, error) }
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

// This plugin also ships the server in its own .mcp.json, so a session can
// re-dial it as a plugin server. Plugin servers' tools carry a plugin prefix.
const PLUGIN_NAME = 'unreal-mcp-status'

// Which copies of the server this session has tools from: the project's
// (.mcp.json) and/or the plugin's own.
type ToolSources = { project: boolean; plugin: boolean }

async function sessionToolSources($: EngineInterface, server: string): Promise<ToolSources> {
  try {
    const names = (await $.tool.list()).map(t => t.name)
    return {
      project: names.some(n => n.startsWith(`mcp__${server}__`)),
      plugin: names.some(n => n.startsWith(`mcp__plugin_${PLUGIN_NAME}_${server}__`)),
    }
  } catch {
    return { project: false, plugin: false }
  }
}

async function hasSessionTools($: EngineInterface, server: string): Promise<boolean> {
  const sources = await sessionToolSources($, server)
  return sources.project || sources.plugin
}

// The URL in this plugin's own .mcp.json.
const PLUGIN_SERVER_URL = 'http://127.0.0.1:8000/mcp'

function normaliseUrl(url: string): string {
  return url.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '')
}

// Claude Code drops a plugin server whose URL a project server already uses,
// so a project entry at the plugin's URL hides the plugin's copy, and the mod
// can't connect it.
function shadowsPluginServer(projectUrl: string): boolean {
  return projectUrl !== '' && normaliseUrl(projectUrl) === normaliseUrl(PLUGIN_SERVER_URL)
}

const SHADOW_DETAIL =
  `The project's .mcp.json lists unreal-mcp at the same URL as the ${PLUGIN_NAME} plugin's server, which is preventing ` +
  'reconnection from this session. To allow reconnection, remove unreal-mcp from .mcp.json and then start a new session.'

const TWICE_DETAIL =
  'This session is connected twice, meaning that every editor tool is listed twice. To prevent this, remove unreal-mcp ' +
  `from .mcp.json or else disable the ${PLUGIN_NAME} plugin.`

const GONE_DETAIL = 'The editor stopped answering. Restart editor to reconnect.'

// Ends a sentence taken from elsewhere with exactly one full stop.
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

const connectFailedToast = (reason: string) =>
  `Couldn't connect to the editor's MCP server: ${sentence(reason)} The mod retries every 30 seconds. Run /unreal-connect to retry now.`

const connectFailedReply = (reason: string) =>
  `Couldn't connect to the Unreal Editor MCP server: ${sentence(reason)} Check that the editor is running with its Model Context Protocol plugin enabled.`

// detail is "line L, column C: message" when the parser gave a position, else the bare message.
function invalidJsonToast(detail: string): string {
  const what = detail.startsWith('line ')
    ? `isn't valid JSON (${detail}).`
    : `isn't valid JSON: ${sentence(detail)}`
  return `The project's .mcp.json ${what} Fix the file. The status will refresh within 15 seconds.`
}

// An Unreal project folder: the plugin's own server is used there even when
// the project's .mcp.json doesn't list one.
async function isUnrealProject($: EngineInterface, cwd: string): Promise<boolean> {
  try {
    return (await $.fs.list(cwd)).some(f => f.name.toLowerCase().endsWith('.uproject'))
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
  lastConnectAt: number            // clock time of the last automatic connect attempt
  connectError: string | undefined // why the last connect attempt failed, if it did
  shadowed: boolean                // the project's entry hides the plugin's server
  toasted: Set<string>             // states whose toast has shown since the state was entered
}

// Shows a state's detail as a toast once each time the state is entered:
// `active` false clears it, so the toast shows again if the state returns.
function toastOnEntry($: EngineInterface, state: SessionState, key: string, active: boolean, text: string): void {
  if (!active) {
    state.toasted.delete(key)
    return
  }
  if (state.toasted.has(key)) return
  state.toasted.add(key)
  $.ui.toast(`Unreal MCP: ${text}`, { timeoutMs: 12_000 })
}

// The server's key in this plugin's own .mcp.json, which $.mcp.connect takes.
const PLUGIN_SERVER_KEY = 'unreal-mcp'
const AUTO_CONNECT_EVERY_MS = 30_000

// Connects the plugin's own Unreal server. Returns undefined on success, or
// the refusal as one short sentence.
async function connectServer($: EngineInterface, state: SessionState): Promise<string | undefined> {
  try {
    const result = await $.mcp.connect(PLUGIN_SERVER_KEY)
    state.connectError = result.isConnected ? undefined : result.message
  } catch (error) {
    state.connectError = error instanceof Error ? error.message : String(error)
  }
  return state.connectError
}

function show($: EngineInterface, state: SessionState, text: string | undefined): void {
  if (text !== state.last) {
    state.last = text
    $.ui.status(text)
  }
}

function describe(probe: Probe, tools: boolean, upAtStart: boolean | undefined, connectError: string | undefined,
  shadowed: boolean, twice: boolean): string {
  if (twice) return 'Unreal MCP ⚠ connected twice ⓘ'
  if (probe === 'slow') {
    return tools
      ? 'Unreal MCP ◐ connected · editor busy'
      : 'Unreal MCP ○ editor busy'
  }
  const up = probe === 'up'
  if (up && tools) return 'Unreal MCP ● connected'
  if (up) {
    // The session's MCP client dials servers once at start; a server that wasn't
    // listening then stays failed until it is connected again. The mod tries that
    // itself (see refresh); this is what shows while it hasn't worked.
    if (shadowed) return 'Unreal MCP ◐ editor up · not connected ⓘ'
    if (connectError) return 'Unreal MCP ◐ editor up · connect failed ⓘ'
    return upAtStart === false
      ? 'Unreal MCP ◐ editor up · not connected'
      : 'Unreal MCP ◐ editor up · not connected'
  }
  if (tools) return 'Unreal MCP ○ editor not responding ⓘ'
  return 'Unreal MCP ○ offline'
}

async function refresh($: EngineInterface, cwd: string, settings: Settings, state: SessionState): Promise<void> {
  const project = await projectServerEntry($, cwd, settings.server)
  toastOnEntry($, state, 'invalid', project.kind === 'unreadable',
    project.kind === 'unreadable' ? invalidJsonToast(project.detail) : '')
  if (project.kind === 'unreadable') {
    state.connected = false
    return show($, state, 'Unreal MCP ○ invalid .mcp.json ⓘ')
  }
  // Stay silent outside Unreal projects: no project entry and no .uproject.
  if (project.kind === 'absent' && !(await isUnrealProject($, cwd))) {
    state.connected = false
    return show($, state, undefined)
  }

  const projectUrl = project.kind === 'found' && typeof project.entry.url === 'string' ? project.entry.url : ''
  const url = settings.endpointOverride || projectUrl || FALLBACK_ENDPOINT
  const [probe, sources] = await Promise.all([probeEndpoint($, url), sessionToolSources($, settings.server)])
  let tools = sources.project || sources.plugin
  const twice = sources.project && sources.plugin
  state.shadowed = shadowsPluginServer(projectUrl)
  // A slow answer says the editor process exists, so it counts as up for the start check.
  if (state.upAtStart === undefined) state.upAtStart = probe !== 'down'

  toastOnEntry($, state, 'twice', twice, TWICE_DETAIL)
  toastOnEntry($, state, 'shadowed', probe === 'up' && !tools && state.shadowed, SHADOW_DETAIL)
  // Editor not responding: toast only when it follows a working connection.
  const gone = probe === 'down' && tools && (state.connected || state.toasted.has('gone'))
  toastOnEntry($, state, 'gone', gone, GONE_DETAIL)

  // Editor up but no tools: connect the plugin's own server, at most every 30 s.
  // Not while the project entry hides it: there is nothing to connect.
  if (probe === 'up' && !tools && !state.shadowed) {
    const now = await $.clock.now()
    if (now - state.lastConnectAt >= AUTO_CONNECT_EVERY_MS) {
      state.lastConnectAt = now
      if (!(await connectServer($, state))) tools = await hasSessionTools($, settings.server)
    }
  }
  if (tools) state.connectError = undefined
  const failed = probe === 'up' && !tools && !state.shadowed && state.connectError !== undefined
  toastOnEntry($, state, 'connect', failed, connectFailedToast(state.connectError ?? ''))

  state.connected = probe === 'up' && tools
  show($, state, describe(probe, tools, state.upAtStart, state.connectError, state.shadowed, twice))
}

// The latest session's state and cwd, for /unreal-connect (registered once per module).
let active: { state: SessionState; cwd: string } | undefined

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
    const state: SessionState = {
      last: undefined, upAtStart: undefined, connected: false, tick: 0, inFlight: false,
      lastConnectAt: Number.NEGATIVE_INFINITY, connectError: undefined,
      shadowed: false, toasted: new Set<string>(),
    }
    active = { state, cwd: e.cwd }
    await $.command.register({
      name: 'unreal-connect',
      description: 'Connect this session to the Unreal Editor MCP server',
    })
    void guardedRefresh($, e.cwd, settings, state)
    $.clock.every(POLL_MS, () => {
      state.tick++
      // Poll every 15 s until connected, then every 30 s.
      if (state.connected && state.tick % CONNECTED_EVERY_N_TICKS !== 0) return
      void guardedRefresh($, e.cwd, settings, state)
    })
    return result
  })

  on('command.run', { command: 'unreal-connect' }, async $ => {
    if (!active) return { text: 'Unreal MCP status has not started in this session yet.' }
    const { state, cwd } = active
    const sources = await sessionToolSources($, settings.server)
    if (sources.project && sources.plugin) return { text: TWICE_DETAIL }
    if (sources.project || sources.plugin) {
      void guardedRefresh($, cwd, settings, state)
      return { text: 'Already connected to the Unreal Editor MCP server.' }
    }
    if (state.shadowed) return { text: `Not connected. ${SHADOW_DETAIL}` }
    const error = await connectServer($, state)
    state.lastConnectAt = await $.clock.now()
    void guardedRefresh($, cwd, settings, state)
    return {
      text: error
        ? connectFailedReply(error)
        : 'Connected to the Unreal Editor MCP server.',
    }
  })
}
