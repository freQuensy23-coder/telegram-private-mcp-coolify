# telegram-private-mcp-coolify

Remote HTTPS MCP wrapper for `@kfastov/tgcli`.

Production endpoint:

```text
https://api.fstr.cc/telegram-private-mcp/mcp
```

The public `/mcp` endpoint is protected by:

```http
Authorization: Bearer <MCP_BEARER_TOKEN>
```

Telegram data is not baked into the image. The container expects a persistent
store mounted at `/data` with:

- `/data/config.json`
- `/data/session.json`
- `/data/messages.db` after sync starts

## Client Setup

Codex:

```bash
export TELEGRAM_PRIVATE_MCP_TOKEN="..."
codex mcp add telegram-private --url https://api.fstr.cc/telegram-private-mcp/mcp --bearer-token-env-var TELEGRAM_PRIVATE_MCP_TOKEN
```

Claude Code:

```bash
claude mcp add --transport http telegram-private https://api.fstr.cc/telegram-private-mcp/mcp \
  --header "Authorization: Bearer ..."
```
