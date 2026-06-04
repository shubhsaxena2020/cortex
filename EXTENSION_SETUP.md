# Cortex Browser Extension — Setup

The extension auto-captures conversations from claude.ai, chatgpt.com, and gemini.google.com into your local Cortex vault. It talks to the desktop app over `127.0.0.1`; nothing leaves your machine.

## Prerequisites

- Cortex desktop app installed and running (`Cortex Setup 0.1.0.exe`).
- A vault folder configured (Settings → Vault Folder on first launch).
- Chrome, Edge, Brave, or any Chromium-based browser with MV3 support.

## Install (unpacked, until Web Store listing lands in v0.2)

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select the `extension/` folder from your Cortex install — by default:
   `C:\Users\shubh\cortex\extension\` (or wherever you cloned the repo).
5. The Cortex icon appears in the extensions toolbar. Pin it for easy access.

## Pair the extension with the desktop app

The desktop app's HTTP server requires a one-time handshake. The pairing window is only open for 60 seconds at a time — a security feature, not a bug.

1. In Cortex desktop → **Settings** → scroll to **Browser Extension**.
2. Click **Pair Extension**. The button changes to "Waiting for extension… (60s)".
3. Within 60 seconds: click the Cortex extension icon in your browser → **Authorize**.
4. The desktop button flips to **Extension paired ✓**. You're done.

### Manual pairing (advanced fallback)

If the auto-pair flow fails:

1. In desktop Settings → expand **Manual pairing (advanced)**.
2. Copy the **Port** (e.g. `48729`) and **Token**.
3. In the extension popup, expand **Advanced** and paste both. Save.

## Verify it works

1. Open <https://claude.ai/> (or chatgpt.com, gemini.google.com) and send any message.
2. After the assistant responds, wait ~2 seconds — the extension picks up the conversation.
3. In Cortex desktop → **Notes** view → you'll see the new conversation at the top.
4. Open the file in **Graph** view — a new node appears connected by source colour.
5. The conversation is also saved as Markdown in
   `<vault>/AI Conversations/<Claude|ChatGPT|Gemini>/<date>-<slug>.md`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Extension popup says "Not connected" | Desktop app not running, or pairing expired. Click **Pair Extension** in Settings again. |
| Pair button does nothing | Check the bottom status bar — port should show e.g. `port 48729`. If blank, restart the desktop app. |
| `/health` returns 401 | Token mismatch — re-run pairing to rotate. |
| Conversations not appearing | Open browser DevTools on claude.ai → Console — extension logs prefixed `[Cortex]`. Most common: content script not loaded; reload the tab. |
| Wrong vault folder | Settings → Vault Folder → **Change folder**. New conversations go to the new vault; existing files stay where they are. |
| Conversation captured twice | Known v0.1 limitation. Deduplication ships in v0.2 (see [ROADMAP.md](./ROADMAP.md)). |

## What the extension actually sends

For every captured conversation, the extension POSTs to `http://127.0.0.1:<port>/api/capture` with:
- `title` — the conversation's title (auto-derived from first message)
- `content` — full conversation text, Markdown-formatted
- `source` — `claude` / `chatgpt` / `gemini`
- `tags` — empty in v0.1; auto-tagged in v0.2
- `url` — the chat URL so you can jump back

No identifiers, no analytics, no third-party endpoints. Source for the extension is in `extension/` — audit it yourself.
