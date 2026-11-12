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
  | { kind: 'absent' }                              // no .mcp.json, or it lists no Unreal server
  | { kind: 'unreadable'; detail: string }          // .mcp.json exists but isn't valid JSON
  // entry: the server under its configured name, if listed. aliases: other names
  // in .mcp.json at the plugin server's URL (a renamed or duplicated entry).
  | { kind: 'found'; entry: Record<string, unknown> | undefined; aliases: string[] }

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
  const servers = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {}
  const raw = servers[server]
  const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const aliases = Object.entries(servers)
    .filter(([name, value]) => name !== server && value && typeof value === 'object'
      && typeof (value as { url?: unknown }).url === 'string'
      && normaliseUrl((value as { url: string }).url) === normaliseUrl(PLUGIN_SERVER_URL))
    .map(([name]) => name)
  return entry || aliases.length > 0 ? { kind: 'found', entry, aliases } : { kind: 'absent' }
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

// The .mcp.json servers the user has turned off (merged settings), which
// Claude Code doesn't load, so they neither hide the plugin's server nor
// connect alongside it.
async function disabledProjectServers($: EngineInterface): Promise<Set<string>> {
  try {
    const value = await $.settings.read({ key: 'disabledMcpjsonServers' })
    return new Set(Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [])
  } catch {
    return new Set()
  }
}

// A server name as it appears in tool names: characters other than letters,
// digits, '_' and '-' become '_'.
function toolSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

// projectNames: the configured name plus any other .mcp.json names at the
// plugin server's URL, so a renamed entry still counts as the project's copy.
async function sessionToolSources($: EngineInterface, server: string, projectNames: string[] = [server]): Promise<ToolSources> {
  try {
    const names = (await $.tool.list()).map(t => t.name)
    const projectPrefixes = projectNames.map(n => `mcp__${toolSegment(n)}__`)
    return {
      project: names.some(n => projectPrefixes.some(p => n.startsWith(p))),
      plugin: names.some(n => n.startsWith(`mcp__plugin_${PLUGIN_NAME}_${toolSegment(server)}__`)),
    }
  } catch {
    return { project: false, plugin: false }
  }
}

// The URL in this plugin's own .mcp.json.
const PLUGIN_SERVER_URL = 'http://127.0.0.1:8000/mcp'

function normaliseUrl(url: string): string {
  return url.trim().toLowerCase().replace('://localhost', '://127.0.0.1').replace(/\/+$/, '')
}

// Toasts are kept short: the cause and the fix.
const shadowToast = (name: string) =>
  `.mcp.json lists ${name}, which blocks reconnection. Remove it and start a new session.`

const twiceToast = (names: string[]) =>
  `connected twice, so every tool is listed twice. Remove ${names.join(' and ')} from .mcp.json or disable this plugin.`

// A session reconnects by itself when an editor it was connected to comes back.
const GONE_TOAST = 'the editor stopped answering. Restart it to reconnect.'

// A session dials its MCP servers once, at start. A plugin server that failed
// then stays failed: $.mcp.connect returns the startup failure without
// re-dialling (tested). The desktop app's Reconnect button does re-dial it, and
// the server is listed there as "Unreal MCP".
const RECONNECT_TOAST = 'the editor is up. To connect, press Reconnect on Unreal MCP under Connectors.'

// detail is "line L, column C: message" when the parser gave a position, else
// the bare message; the toast keeps only the position.
function invalidJsonToast(detail: string): string {
  const position = /^line \d+, column \d+/.exec(detail)
  return position
    ? `.mcp.json isn't valid JSON (${position[0]}). Fix the file.`
    : ".mcp.json isn't valid JSON. Fix the file."
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
  shadowed: boolean                // the project's entry hides the plugin's server
  projectNames: string[]           // .mcp.json names of the project's copies of the server
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

function show($: EngineInterface, state: SessionState, text: string | undefined): void {
  if (text !== state.last) {
    state.last = text
    $.ui.status(text)
  }
}

function describe(probe: Probe, tools: boolean, upAtStart: boolean | undefined, shadowed: boolean, twice: boolean): string {
  if (twice) return 'Unreal MCP ⚠ connected twice ⓘ'
  if (probe === 'slow') {
    return tools
      ? 'Unreal MCP ◐ connected · editor busy'
      : 'Unreal MCP ○ editor busy'
  }
  const up = probe === 'up'
  if (up && tools) return 'Unreal MCP ● connected'
  if (up) {
    // Shadowed by a project entry or just not connected yet: either way the
    // toast says what to do. upAtStart is kept in case "started after the
    // session" needs telling apart again.
    void upAtStart
    void shadowed
    return 'Unreal MCP ◐ editor up · not connected ⓘ'
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

  // Entries the user turned off with disabledMcpjsonServers aren't loaded, so they don't count.
  const disabled = await disabledProjectServers($)
  const listed = project.kind === 'found' ? project.entry : undefined
  const entry = listed && !disabled.has(settings.server) ? listed : undefined
  const projectUrl = listed && typeof listed.url === 'string' ? listed.url : ''
  const url = settings.endpointOverride || projectUrl || FALLBACK_ENDPOINT
  // Project copies of the server: its configured name (if listed and enabled)
  // and any other enabled name at the plugin server's URL.
  const aliases = project.kind === 'found' ? project.aliases.filter(n => !disabled.has(n)) : []
  state.projectNames = [...(entry ? [settings.server] : []), ...aliases]
  const [probe, sources] = await Promise.all([
    probeEndpoint($, url),
    sessionToolSources($, settings.server, state.projectNames),
  ])
  const tools = sources.project || sources.plugin
  const twice = sources.project && sources.plugin
  // Claude Code drops a plugin server when the project lists one of the same
  // name (checked with `claude mcp list`), so a project entry under the plugin
  // server's name hides it. A renamed entry doesn't hide it; both connect, and
  // that shows as connected twice.
  state.shadowed = entry !== undefined
  // A slow answer says the editor process exists, so it counts as up for the start check.
  if (state.upAtStart === undefined) state.upAtStart = probe !== 'down'

  toastOnEntry($, state, 'twice', twice, twiceToast(state.projectNames))
  toastOnEntry($, state, 'shadowed', probe === 'up' && !tools && state.shadowed, shadowToast(settings.server))
  // Editor not responding: toast only when it follows a working connection.
  const gone = probe === 'down' && tools && (state.connected || state.toasted.has('gone'))
  toastOnEntry($, state, 'gone', gone, GONE_TOAST)

  // Editor up but this session has no tools: only the Reconnect button can re-dial.
  toastOnEntry($, state, 'reconnect', probe === 'up' && !tools && !state.shadowed, RECONNECT_TOAST)

  state.connected = probe === 'up' && tools
  show($, state, describe(probe, tools, state.upAtStart, state.shadowed, twice))
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
    const state: SessionState = {
      last: undefined, upAtStart: undefined, connected: false, tick: 0, inFlight: false,
      shadowed: false, projectNames: [], toasted: new Set<string>(),
    }
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
