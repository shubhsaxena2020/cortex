# Higgsfield MCP Integration Setup

## What is Higgsfield?

Higgsfield is an AI image and video generation platform that exposes an MCP
(Model Context Protocol) server, so an MCP client like Claude Code can drive its
image/video models from a conversation. Per Higgsfield's site it offers a range
of image and video models (e.g. FLUX / Seedream / Nano Banana family for images,
and Sora / Veo / Kling / Soul / Seedance for video) — check
https://higgsfield.ai/mcp for the current, authoritative model list and limits.

> The specific model names, resolutions, and durations are Higgsfield's claims,
> not something verified here. This doc only verifies the MCP endpoint + transport.

## Configuration (verified)

The MCP server is configured in the project `.mcp.json`:

```json
{
  "mcpServers": {
    "higgsfield": {
      "type": "http",
      "url": "https://mcp.higgsfield.ai/mcp"
    }
  }
}
```

### Why this URL/transport (and not /sse)

Verified against the live service on 2026-06-05:

- `https://mcp.higgsfield.ai/sse` -> **404** (`{"message":"Route GET:/sse not found"}`).
  The `/sse` path does not exist; do not use it.
- `https://mcp.higgsfield.ai/mcp` -> **401 Unauthorized**, which is the real
  endpoint. It uses the **streamable HTTP** transport (`"type": "http"`) and is
  **OAuth-protected**:
  `WWW-Authenticate: Bearer resource_metadata="https://mcp.higgsfield.ai/.well-known/oauth-protected-resource", scope="openid email offline_access"`.
- OAuth discovery documents are live (RFC 9728 protected-resource metadata and
  RFC 8414 authorization-server metadata both return 200), so Claude Code can run
  the standard browser auth flow automatically.
- `https://higgsfield.ai/mcp` (HTTP 200) is the human docs page and references
  `https://mcp.higgsfield.ai/mcp` as the endpoint, confirming the corrected URL.

## How to Use

1. **Reload MCP config** — restart Claude Code (or re-open this project) so it
   reads `.mcp.json`. In the Claude Code CLI you can also run `claude mcp list`
   to confirm `higgsfield` is registered.
2. **Authenticate** — on first connect, the 401 triggers an OAuth flow; Claude
   Code opens a browser to sign in with your Higgsfield account and authorize the
   `openid email offline_access` scopes. The token is stored by the client.
3. **Generate** — once connected, the Higgsfield tools appear and you can ask,
   e.g. "generate a 4K product photo of a water bottle" or "make a short clip of X".
   Ask Claude which model fits a given task.

## Credits & Billing

Higgsfield uses a credit system tied to your Higgsfield account — generations
draw down those credits. There is no separate billing through the MCP client.
Confirm current pricing/credit costs on higgsfield.ai.

## When to Use (for these projects)

- Marketing / product imagery
- Short demo or social clips
- UGC-style ad creatives

Note: this `.mcp.json` lives in the Cortex repo and is committed, so anyone who
opens this project in an MCP-aware client will be prompted to connect/authorize
Higgsfield. That auth is per-user (OAuth), so no secrets are stored in the repo.

## Useful Links

- Platform: https://higgsfield.ai
- MCP page: https://higgsfield.ai/mcp
- Endpoint (OAuth-protected): https://mcp.higgsfield.ai/mcp

---

Set up and verified on: 2026-06-05
