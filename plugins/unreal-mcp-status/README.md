# unreal-mcp-status

A Claude Code status line that shows whether the Unreal Editor's MCP server is reachable and connected to the current session:

| Status line | Meaning |
| --- | --- |
| `Unreal MCP ● connected` | The editor answers and this session has the server's tools. |
| `Unreal MCP ◐ editor up · not connected ⓘ` | The editor answers, but this session has no connection, usually because the editor started after the session. Press **Reconnect** on **Unreal MCP** under Connectors. |
| `Unreal MCP ◐ editor up · not connected ⓘ` (project entry) | Not connected, and the project's `.mcp.json` lists `unreal-mcp` at the plugin's URL, which hides the plugin's server so the mod can't connect it. Remove the project entry, then start a new session. |
| `Unreal MCP ⚠ connected twice ⓘ` | The session has tools from both the project's and the plugin's server, so every tool is listed twice. Remove the project entry or disable this plugin. |
| `Unreal MCP ◐ connected · editor busy` | The session is connected, but the editor didn't answer within 3 seconds, usually because it is cooking, compiling shaders or blocked on a dialog. |
| `Unreal MCP ○ editor busy` | The same, in a session that isn't connected. |
| `Unreal MCP ○ editor not responding ⓘ` | The session was connected, but nothing answers at the endpoint any more, usually because the editor closed or crashed. Restart it to reconnect. |
| `Unreal MCP ○ offline` | Nothing answers at the endpoint, and the session isn't connected. |
| `Unreal MCP ○ invalid .mcp.json ⓘ` | The project's `.mcp.json` exists but can't be parsed. The toast gives the line and column. |

`ⓘ` means a toast explains the state, once each time the state is entered.

It checks every 15 seconds, and every 30 seconds once connected. The status updates on its own after a reconnect. It stays silent in any project whose `.mcp.json` does not configure the server, so it is safe to install at user scope.

**Reconnecting:** Claude Code connects to MCP servers once, when the session starts. Where Reconnect is available for the server (`/mcp` in the terminal CLI), use it. In the desktop app a project `.mcp.json` server may not be listed with a Reconnect button; forking or starting a new session connects it.

**The plugin's own server:** the plugin also ships the Unreal server in its own `.mcp.json` (`http://127.0.0.1:8000/mcp`). As a plugin server it can be reconnected in a running session: the desktop app lists it as **Unreal MCP** under Connectors, with a **Reconnect** button. A session that started before the editor needs that button (a mod can't re-dial a server that failed at startup: `$.mcp.connect` returns the old failure). A session that loses the editor reconnects by itself when the editor comes back. Its tools are named `mcp__plugin_unreal-mcp-status_unreal-mcp__*`. In a folder with a `.uproject` the status shows even when the project's `.mcp.json` has no `unreal-mcp` entry. Remove `unreal-mcp` from the project's `.mcp.json`: while the project lists a server of the same name, Claude Code uses it and drops the plugin's copy (`claude mcp list` shows only the project entry), so there is no plugin server to reconnect. Renaming the entry doesn't help: both servers then connect, and every editor tool is listed twice. The mod spots a renamed entry by its URL and reports it as connected twice.

## Install

```
/plugin install unreal-mcp-status --marketplace DrStevenWright/claude-mods
```

To turn it on for one Unreal project only, choose the **project** scope: that adds it to the project's `.claude/settings.json`, which you can commit.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `server_name` | `unreal-mcp` | The server's key in the project's `.mcp.json`. |
| `endpoint_url` | empty | Overrides the URL to probe. Empty uses the `url` from `.mcp.json`, falling back to `http://127.0.0.1:8000/mcp`. |
