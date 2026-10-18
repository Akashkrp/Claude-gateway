const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn, execSync } = require('child_process');

// --- Ingest Environment Credentials (for Cloud / Docker / Railway / Render) ---
if (process.env.CLAUDE_CREDENTIALS) {
  try {
    const homeDir = os.homedir();
    const claudeDir = path.join(homeDir, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    const credPath = path.join(claudeDir, '.credentials.json');
    let credContent = process.env.CLAUDE_CREDENTIALS.trim();
    if (!credContent.startsWith('{')) {
      try {
        const decoded = Buffer.from(credContent, 'base64').toString('utf8');
        if (decoded.startsWith('{')) credContent = decoded;
      } catch {}
    }
    fs.writeFileSync(credPath, credContent, 'utf-8');
    console.log('✅ [CLOUD INIT] Successfully injected Claude credentials into', credPath);
  } catch (err) {
    console.error('⚠️ [CLOUD INIT] Failed to write CLAUDE_CREDENTIALS:', err.message);
  }
}

const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- 1. Load or Initialize Configuration ---
function loadConfig() {
  let config = {
    port: 8000,
    apiKey: '',
    claudePath: 'auto',
    defaultModel: 'claude-sonnet-4-6',
    timeoutMs: 180000
  };

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config = { ...config, ...data };
    } catch (err) {
      console.warn('⚠️ Could not parse existing config.json, recreating with defaults.');
    }
  }

  // Override or set from environment variables if provided (Cloud deployments)
  if (process.env.API_KEY && process.env.API_KEY.trim()) {
    config.apiKey = process.env.API_KEY.trim();
  }

  // Generate a persistent API key if none exists
  if (!config.apiKey || config.apiKey.trim() === '') {
    const randomHex = crypto.randomBytes(16).toString('hex');
    config.apiKey = `cgw_sk_live_${randomHex}`;
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch {}
  }

  return config;
}

const config = loadConfig();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : config.port;
const HOST = process.env.HOST || '0.0.0.0';

// --- 2. Dynamic Network & Proxy Detection ---
const COLLEGE_PROXY_HOST = '172.31.100.25';
const COLLEGE_PROXY_PORT = 3128;
const COLLEGE_PROXY_URL = 'http://edcguest:edcguest@172.31.100.25:3128';

let cachedProxyState = {
  isCollegeProxyReachable: false,
  lastCheckTime: 0
};

function checkCollegeProxy(timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    s.setTimeout(timeoutMs);
    s.on('connect', () => {
      done = true;
      s.destroy();
      resolve(true);
    });
    s.on('timeout', () => {
      s.destroy();
      if (!done) { done = true; resolve(false); }
    });
    s.on('error', () => {
      s.destroy();
      if (!done) { done = true; resolve(false); }
    });
    try {
      s.connect(COLLEGE_PROXY_PORT, COLLEGE_PROXY_HOST);
    } catch {
      resolve(false);
    }
  });
}

async function getExecutionEnv() {
  const now = Date.now();
  // Cache proxy probe for 10 seconds to keep requests snappy
  if (now - cachedProxyState.lastCheckTime > 10000) {
    cachedProxyState.isCollegeProxyReachable = await checkCollegeProxy(700);
    cachedProxyState.lastCheckTime = now;
  }

  const env = { ...process.env };
  // Always prevent loopback/localhost traffic from being proxied
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = '127.0.0.1,localhost,::1';

  if (cachedProxyState.isCollegeProxyReachable) {
    env.HTTP_PROXY = COLLEGE_PROXY_URL;
    env.HTTPS_PROXY = COLLEGE_PROXY_URL;
    env.http_proxy = COLLEGE_PROXY_URL;
    env.https_proxy = COLLEGE_PROXY_URL;
    env.ALL_PROXY = COLLEGE_PROXY_URL;
    env.all_proxy = COLLEGE_PROXY_URL;
    return { env, proxyMode: 'College Proxy (172.31.100.25:3128)' };
  } else {
    // Mobile Internet / Home Wi-Fi / Direct
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.ALL_PROXY;
    delete env.all_proxy;
    return { env, proxyMode: 'Direct Internet (Mobile Hotspot / Home Wi-Fi)' };
  }
}

// --- 3. Locate Claude Executable ---
function getClaudePath() {
  if (config.claudePath && config.claudePath !== 'auto' && fs.existsSync(config.claudePath)) {
    return config.claudePath;
  }

  // Check user home directory
  const home = os.homedir();
  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const localBin = path.join(home, '.local', 'bin', exeName);
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  // Check standard Linux/Unix global bin locations (Docker / Railway / Render)
  const globalBins = [
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/bin/claude'
  ];
  for (const bin of globalBins) {
    if (fs.existsSync(bin)) {
      return bin;
    }
  }

  // Try checking PATH
  try {
    const checkCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const stdout = execSync(checkCmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    const firstLine = stdout.split(/\r?\n/)[0]?.trim();
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch (e) {
    // ignore
  }

  return 'claude';
}

const claudeExe = getClaudePath();

// --- 4. Verify Claude Auth Status ---
let authInfo = { loggedIn: false, email: 'unknown', subscriptionType: 'unknown' };
try {
  const authOut = execSync(`"${claudeExe}" auth status`, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 6000 }).toString();
  authInfo = JSON.parse(authOut);
} catch (e) {
  console.warn('⚠️ Warning: Failed to query "claude auth status". Claude CLI might need login.');
}

// --- 5. Helpers for OpenAI <-> Claude translation ---
function extractKeyFromHeaders(headers) {
  const auth = headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return headers['x-api-key'] || '';
}

function parseOpenAIMessages(messages = []) {
  let systemPrompt = '';
  const history = [];
  let userText = '';
  const imageBlocks = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isLast = (i === messages.length - 1);

    if (m.role === 'system') {
      const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      systemPrompt += (systemPrompt ? '\n\n' : '') + contentStr;
      continue;
    }

    if (!isLast) {
      const txt = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(p => (typeof p === 'string' ? p : p.text || '')).join(' ')
          : '';
      const speaker = m.role === 'assistant' ? 'Assistant' : 'User';
      history.push(`[${speaker}]: ${txt}`);
    } else {
      // Last message (current user prompt)
      if (typeof m.content === 'string') {
        userText = m.content;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') {
            userText += (userText ? '\n' : '') + (part.text || '');
          } else if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url;
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              imageBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1],
                  data: match[2]
                }
              });
            }
          }
        }
      }
    }
  }

  let finalPrompt = '';
  if (history.length > 0) {
    finalPrompt += 'Previous conversation:\n' + history.join('\n\n') + '\n\n---\n\nCurrent request:\n';
  }
  finalPrompt += userText || 'Hello';

  const contentBlocks = [];
  for (const img of imageBlocks) {
    contentBlocks.push(img);
  }
  contentBlocks.push({ type: 'text', text: finalPrompt });

  return { systemPrompt, contentBlocks };
}

// --- 5. HTTP Request Handler ---
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, *');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ── Health Endpoint ────────────────────────────────────────────────────────
  if (pathname === '/health' || pathname === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'Claude Code Gateway',
      version: '1.0.0',
      claudePath: claudeExe,
      auth: {
        loggedIn: authInfo.loggedIn,
        email: authInfo.email,
        subscriptionType: authInfo.subscriptionType
      },
      uptime: process.uptime()
    }));
    return;
  }

  // ── Models Endpoint ────────────────────────────────────────────────────────
  if (pathname === '/v1/models' && req.method === 'GET') {
    const models = [
      { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic', permission: [] },
      { id: 'claude-3-7-sonnet', object: 'model', owned_by: 'anthropic', permission: [] },
      { id: 'claude-opus-5', object: 'model', owned_by: 'anthropic', permission: [] },
      { id: 'claude-haiku-4-5', object: 'model', owned_by: 'anthropic', permission: [] }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models }));
    return;
  }

  // ── Health Endpoint ────────────────────────────────────────────────────────
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // ── Web UI Dashboard ───────────────────────────────────────────────────────
  if (pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Claude Code Gateway</title>
  <style>
    :root {
      --bg: #09090b;
      --card: #18181b;
      --border: #27272a;
      --accent: #f97316;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --code-bg: #121215;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      padding: 40px 20px;
    }
    .container {
      max-width: 680px;
      width: 100%;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .logo {
      font-size: 32px;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .badge-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: rgba(34, 197, 94, 0.12);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #4ade80;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      margin-left: auto;
    }
    .dot {
      width: 8px;
      height: 8px;
      background: #22c55e;
      border-radius: 50%;
      box-shadow: 0 0 8px #22c55e;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 18px;
    }
    .label {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .value-box {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      word-break: break-all;
    }
    .copy-btn {
      background: rgba(249, 115, 22, 0.15);
      border: 1px solid rgba(249, 115, 22, 0.4);
      color: #fb923c;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: all 0.2s;
      white-space: nowrap;
      margin-left: 12px;
    }
    .copy-btn:hover {
      background: rgba(249, 115, 22, 0.3);
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 12px;
    }
    .info-item {
      background: var(--code-bg);
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .info-title {
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .info-val {
      font-size: 14px;
      font-weight: 600;
      color: #e4e4e7;
    }
    ol {
      margin-left: 20px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }
    ol li { margin-bottom: 8px; }
    strong { color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">⚡</div>
      <div>
        <h1>Claude Code Gateway</h1>
        <p style="color: var(--muted); font-size: 13px;">OpenAI-Compatible Local Endpoint for Claude Pro / Team</p>
      </div>
      <div class="badge-status">
        <span class="dot"></span> ACTIVE
      </div>
    </div>

    <div class="card">
      <div class="label">Your Gateway API Key</div>
      <div class="value-box">
        <span id="apiKey">${config.apiKey}</span>
        <button class="copy-btn" onclick="navigator.clipboard.writeText('${config.apiKey}'); this.innerText='COPIED!'; setTimeout(() => this.innerText='COPY KEY', 2000);">COPY KEY</button>
      </div>
      <div class="info-grid">
        <div class="info-item">
          <div class="info-title">Connected Claude Account</div>
          <div class="info-val">${authInfo.email || 'None'}</div>
        </div>
        <div class="info-item">
          <div class="info-title">Subscription Type</div>
          <div class="info-val" style="color: #fb923c; text-transform: uppercase;">${authInfo.subscriptionType || 'Free'}</div>
        </div>
        <div class="info-item">
          <div class="info-title">Base URL</div>
          <div class="info-val">http://127.0.0.1:${PORT}/v1</div>
        </div>
        <div class="info-item">
          <div class="info-title">Claude CLI</div>
          <div class="info-val" style="font-size: 11px; word-break: break-all;">${path.basename(claudeExe)}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="label">How to use in GST (Ghostly)</div>
      <ol>
        <li>Open <strong>Ghostly</strong> and go to <strong>API Setup</strong> or <strong>Settings</strong>.</li>
        <li>Select provider: <strong>Claude Pro (Subscription)</strong>.</li>
        <li>Paste the API key above into the key field.</li>
        <li>Click <strong>Test</strong> to verify the connection. That's it! All questions & screenshots now stream through your Claude Pro subscription with zero extra token costs!</li>
      </ol>
    </div>
  </div>
</body>
</html>`;
    res.end(html);
    return;
  }

  // ── Chat Completions Endpoint ──────────────────────────────────────────────
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    console.log(`\n[${new Date().toLocaleTimeString()}] 📨 Incoming request: POST /v1/chat/completions`);
    // 1. Auth check
    const clientKey = extractKeyFromHeaders(req.headers);
    if (config.apiKey && clientKey !== config.apiKey) {
      console.warn(`❌ [AUTH ERROR] Client provided key: "${clientKey || '(none)'}", expected: "${config.apiKey}"`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Incorrect or missing API key. Get your key from http://127.0.0.1:' + PORT + ' or config.json.',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      }));
      return;
    }

    // 2. Read body
    let rawBody = '';
    req.on('data', chunk => {
      rawBody += chunk;
      if (rawBody.length > 50 * 1024 * 1024) { // 50MB max limit
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Payload too large' } }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch (err) {
        console.warn(`❌ [BODY ERROR] Invalid JSON body:`, err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
        return;
      }

      const stream = Boolean(body.stream);
      const model = body.model || config.defaultModel;
      const { systemPrompt, contentBlocks } = parseOpenAIMessages(body.messages);
      const { env: childEnv, proxyMode } = await getExecutionEnv();
      console.log(`⚡ [CLAUDE PRO] Model: ${model} | Stream: ${stream} | Messages: ${body.messages?.length || 1}`);
      console.log(`🌐 [NETWORK] ${proxyMode}`);
      console.log(`🚀 Spawning Claude CLI process...`);

      // Build CLI arguments
      const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--tools', '',
        '--no-session-persistence',
        '--include-partial-messages'
      ];

      if (model && model !== 'default') {
        args.push('--model', model);
      }
      if (systemPrompt && systemPrompt.trim()) {
        args.push('--system-prompt', systemPrompt.trim());
      }

      const userPayload = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: contentBlocks
        }
      }) + '\n';

      const completionId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
      const created = Math.floor(Date.now() / 1000);

      // Setup response headers
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
      }

      let child;
      let isDone = false;
      let accumulatedText = '';
      let buffer = '';

      try {
        // Dedicated isolated cwd (the gateway's own dir) with dynamic environment
        child = spawn(claudeExe, args, {
          cwd: __dirname,
          env: childEnv,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (spawnErr) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Failed to spawn claude CLI: ${spawnErr.message}` } }));
        }
        return;
      }

      const sendChunk = (deltaText) => {
        if (!stream) return;
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: created,
          model: model,
          choices: [
            {
              index: 0,
              delta: { content: deltaText },
              finish_reason: null
            }
          ]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      const finishStream = () => {
        if (isDone) return;
        isDone = true;

        if (stream) {
          const finalChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }
            ]
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: completionId,
            object: 'chat.completion',
            created: created,
            model: model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: accumulatedText
                },
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          }));
        }
      };

      // Watchdog timeout: Kill child if it takes more than 75 seconds without finishing
      const watchdog = setTimeout(() => {
        if (!isDone) {
          console.error('⏰ [TIMEOUT] Claude CLI process exceeded 75 seconds.');
          if (!accumulatedText) {
            sendChunk('\n\n⚠️ Request timed out. Claude CLI took too long to respond. Please check internet connection.');
          }
          try { child.kill(); } catch (e) {}
          finishStream();
        }
      }, 75000);

      // Handle stream stdout
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const ev = JSON.parse(trimmed);

            // Log network retries if Anthropic API encounters errors
            if (ev.type === 'system' && ev.subtype === 'api_retry') {
              console.warn(`⚠️ [CLAUDE RETRY] Connection retry ${ev.attempt}/${ev.max_retries} (${ev.error || 'network issue'})...`);
            }

            // 1. Stream events (token deltas)
            if (ev.type === 'stream_event') {
              if (ev.event?.type === 'content_block_delta' && ev.event?.delta?.type === 'text_delta') {
                const text = ev.event.delta.text;
                accumulatedText += text;
                sendChunk(text);
              }
            } else if (ev.type === 'assistant') {
              // Assistant turn snapshot
              if (ev.message?.content) {
                for (const part of ev.message.content) {
                  if (part.type === 'text' && !accumulatedText) {
                    accumulatedText = part.text;
                    sendChunk(part.text);
                  }
                }
              }
            } else if (ev.type === 'result') {
              if (ev.result && !accumulatedText) {
                accumulatedText = ev.result;
                sendChunk(ev.result);
              }
            }
          } catch (e) {
            // non-json line (e.g. CLI warning), ignore
          }
        }
      });

      child.stderr.on('data', errChunk => {
        const text = errChunk.toString();
        // Log stderr if not benign
        if (!text.includes('Warning: no stdin data')) {
          console.warn(`[claude stderr] ${text.trim()}`);
        }
      });

      child.on('close', code => {
        clearTimeout(watchdog);
        console.log(`✅ [CLAUDE PRO] Finished. Exit code: ${code} | Response chars: ${accumulatedText.length}`);
        if (!accumulatedText && code !== 0) {
          sendChunk(`\n\n⚠️ Claude CLI closed with error (exit code ${code}). Check internet connectivity or subscription status.`);
        }
        finishStream();
      });

      child.on('error', err => {
        clearTimeout(watchdog);
        console.error('Subprocess error:', err);
        if (!isDone) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message } }));
          } else {
            res.end();
          }
          isDone = true;
        }
      });

      // Write payload to stdin and close
      child.stdin.write(userPayload);
      child.stdin.end();

      // Handle client disconnect (only if response wasn't finished)
      res.on('close', () => {
        clearTimeout(watchdog);
        if (!isDone && !res.writableEnded && child && !child.killed) {
          try { child.kill(); } catch (e) {}
        }
      });
    });
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

// --- 6. Start the Gateway Server ---
server.listen(PORT, HOST, () => {
  const line = '='.repeat(72);
  console.log(`\n${line}`);
  console.log(`🚀 Claude Code Gateway is RUNNING`);
  console.log(`${line}`);
  console.log(`📡 Endpoint       : http://${HOST}:${PORT}`);
  console.log(`🔑 Your API Key   : ${config.apiKey}`);
  console.log(`👤 Claude Account : ${authInfo.email} (${authInfo.subscriptionType?.toUpperCase()})`);
  console.log(`⚡ Models         : claude-sonnet-4-6, claude-3-7-sonnet, claude-opus-5`);
  console.log(`🌐 Auto-Proxy     : Dynamic (College Proxy <-> Direct Mobile Hotspot)`);
  console.log(`${line}`);
  console.log(`👉 In Ghostly (GST), choose: "Claude Pro (Subscription)"`);
  console.log(`   and paste this API key: ${config.apiKey}`);
  console.log(`${line}\n`);
});
