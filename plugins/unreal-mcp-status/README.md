# unreal-mcp-status

A Claude Code status line that shows whether the Unreal Editor's MCP server is reachable and connected to the current session:

| Status line | Meaning |
| --- | --- |
| `Unreal MCP ● connected` | The editor answers and this session has the server's tools. |
| `Unreal MCP ◐ editor started after this session · …` | The editor wasn't running when the session started, so the session's one connection attempt failed. Reconnect the server, fork the session or start a new one. |
| `Unreal MCP ◐ editor up · this session not connected · …` | The editor answers, but the session has no connection (it dropped, or failed for another reason). Same fixes. |
| `Unreal MCP ○ editor not responding` | The session has the tools, but the editor stopped answering. |
| `Unreal MCP ○ offline (editor not running)` | Nothing answers at the endpoint. |
| `Unreal MCP ○ .mcp.json is not valid JSON` | The project's `.mcp.json` exists but can't be parsed. |

It checks every 15 seconds, and every 30 seconds once connected. The status updates on its own after a reconnect. It stays silent in any project whose `.mcp.json` does not configure the server, so it is safe to install at user scope.

**Reconnecting:** Claude Code connects to MCP servers once, when the session starts. Where Reconnect is available for the server (`/mcp` in the terminal CLI), use it. In the desktop app a project `.mcp.json` server may not be listed with a Reconnect button; forking or starting a new session connects it.

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
