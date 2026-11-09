# unreal-mcp-status

A Claude Code status line that shows whether the Unreal Editor's MCP server is reachable and connected to the current session:

| Status line | Meaning |
| --- | --- |
| `Unreal MCP ● connected` | The editor answers and this session has the server's tools. |
| `Unreal MCP ◐ editor up, session not connected` | The editor answers, but the session dropped the connection: press Reconnect in `/mcp`. |
| `Unreal MCP ○ editor not responding` | The session has the tools, but the editor stopped answering. |
| `Unreal MCP ○ offline (editor not running)` | Nothing answers at the endpoint. |

It checks every 15 seconds. It stays silent in any project whose `.mcp.json` does not configure the server, so it is safe to install at user scope.

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
