# unreal-mcp-status

A Claude Code status line that shows whether the Unreal Editor's MCP server is reachable and connected to the current session:

| Status line | Meaning |
| --- | --- |
| `Unreal MCP ● connected` | The editor answers and this session has the server's tools. |
| `Unreal MCP ◐ editor up · not connected` | The editor answers, but this session has no connection: usually the editor started after the session, whose one connection attempt failed. Reconnect the server, fork the session or start a new one. |
| `Unreal MCP ◐ editor up · not connected ⓘ` | Not connected, and the project's `.mcp.json` lists `unreal-mcp` at the plugin's URL, which hides the plugin's server so the mod can't connect it. A toast explains once per session; `/unreal-connect` shows the same. Remove the project entry. |
| `Unreal MCP ⚠ connected twice ⓘ` | The session has tools from both the project's and the plugin's server, so every tool is listed twice. Remove the project entry. |
| `Unreal MCP ◐ editor up · connect failed (/unreal-connect)` | The mod tried to connect the plugin's server and was refused. Run `/unreal-connect` to retry and see the reason. |
| `Unreal MCP ◐ connected · editor busy` | The session is connected, but the editor didn't answer within 3 seconds, usually because it is cooking, compiling shaders or blocked on a dialog. |
| `Unreal MCP ○ editor busy` | The same, in a session that isn't connected. |
| `Unreal MCP ○ editor not responding` | The session has the tools, but nothing answers at the endpoint any more. |
| `Unreal MCP ○ offline` | Nothing answers at the endpoint, and the session isn't connected. |
| `Unreal MCP ○ invalid .mcp.json` | The project's `.mcp.json` exists but can't be parsed. |

It checks every 15 seconds, and every 30 seconds once connected. The status updates on its own after a reconnect. It stays silent in any project whose `.mcp.json` does not configure the server, so it is safe to install at user scope.

**Reconnecting:** Claude Code connects to MCP servers once, when the session starts. Where Reconnect is available for the server (`/mcp` in the terminal CLI), use it. In the desktop app a project `.mcp.json` server may not be listed with a Reconnect button; forking or starting a new session connects it.

**The plugin's own server:** the plugin also ships the Unreal server in its own `.mcp.json` (`http://127.0.0.1:8000/mcp`). As a plugin server it can be connected in a running session. When the editor is up but the session has no Unreal tools, the mod connects it automatically (at most every 30 seconds), and `/unreal-connect` does the same on demand and says why if it fails. Its tools are named `mcp__plugin_unreal-mcp-status_unreal-mcp__*`. In a folder with a `.uproject` the status shows even when the project's `.mcp.json` has no `unreal-mcp` entry. Remove `unreal-mcp` from the project's `.mcp.json`: while a project server with the same URL exists, Claude Code uses it and drops the plugin's copy (`claude mcp list` shows only the project entry), so the automatic connect has nothing to connect.

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
