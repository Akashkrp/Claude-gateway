# ⚡ Claude Code Gateway

An OpenAI-compatible local HTTP gateway that routes requests through your **Claude Pro / Team subscription** via the Claude Code CLI (`claude -p`).

No Anthropic API credit balance or pay-per-token API key required!

---

## 🚀 Quick Start

1. Double-click **`start.bat`** (or run `node server.js` in terminal).
2. The console will display your Gateway URL and generated API Key:
   ```
   ========================================================================
   🚀 Claude Code Gateway is RUNNING
   ========================================================================
   📡 Local Endpoint : http://127.0.0.1:8000
   🔑 Your API Key   : cgw_sk_live_...
   👤 Claude Account : your-email@domain.com (TEAM/PRO)
   ⚡ Models         : claude-sonnet-4-6, claude-3-7-sonnet, claude-opus-5
   ========================================================================
   ```
3. Open **Ghostly (GST)**:
   - Go to **Settings** or **API Setup**.
   - Choose **Claude Pro (Subscription)**.
   - Paste your API key (`cgw_sk_live_...`).
   - Click **Test** — you are ready to go!

---

## ⚙️ Configuration (`config.json`)

`config.json` is created automatically on first run:

```json
{
  "port": 8000,
  "apiKey": "cgw_sk_live_...",
  "claudePath": "auto",
  "defaultModel": "claude-sonnet-4-6",
  "timeoutMs": 180000
}
```

- **`apiKey`**: Persistent API key required in the `Authorization: Bearer <key>` or `x-api-key` header.
- **`port`**: Port to listen on (default `8000`).
- **`claudePath`**: Set to `"auto"` to automatically find `claude.exe` in `~/.local/bin/` or `PATH`.

---

## 📡 API Endpoints

- **`GET /`**: Web UI status dashboard displaying gateway state, Claude login email, models, and API key with a copy button.
- **`GET /health`**: Health check returning uptime and Claude authentication status.
- **`GET /v1/models`**: List of available Claude models.
- **`POST /v1/chat/completions`**: OpenAI-compatible chat completion endpoint supporting:
  - Real-time Server-Sent Events (SSE) streaming (`stream: true`)
  - Non-streaming responses (`stream: false`)
  - Image / Screenshot vision analysis (PNG, JPEG, WEBP base64)
