# SellerSprite MCP Chat

LAN-friendly chat MVP for SellerSprite official MCP tools.

## Run

```powershell
$env:PORT="3001"
$env:DEEPSEEK_API_KEY="your DeepSeek key"
$env:SELLERSPRITE_SECRET_KEY="your SellerSprite secret"
npm start
```

Open:

```text
http://localhost:3001
```

The server binds to `0.0.0.0` and prints LAN URLs on startup.

## Features

- DeepSeek `deepseek-v4-flash` tool routing
- SellerSprite official MCP bridge
- Session list and per-session chat context
- Delete session
- SSE message updates
- Image upload/paste support
- Markdown rendering

Secrets are read only from environment variables.
