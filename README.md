# India Mutual Fund AI Assistant

An agentic chatbot for a mutual fund investing app. Users ask questions in plain English (or Hinglish);
a Gemini model decides which data tools to call, runs them through an **MCP server** backed by
official AMFI NAV data, and streams back an answer with charts.

- "What was the NAV of Parag Parikh Flexi Cap on 23 March 2020, and how much has it grown since?"
- "If I had started a ₹10,000 SIP in HDFC Mid Cap in Jan 2019 with a 10% yearly step-up, what would it be worth?"
- "Top 5 small cap funds by 3-year returns — and which had the smallest drawdown?"
- "Estimate what ₹5 lakh in a Nifty 50 index fund could become in 10 years."
- "How is my portfolio doing?" (signed-in users; reads holdings from your database)

Everything runs on **Node.js / TypeScript**. Your Laravel app only adds a `<script>` tag:
see [`laravel-embed/README.md`](laravel-embed/README.md).

## Architecture

```
 Laravel page (any site)                 agent-service  (Node.js, :3000)              mcp-server (Node.js, :3100)
┌───────────────────────┐   HTTPS/SSE   ┌──────────────────────────────┐  MCP over   ┌───────────────────────────┐
│ <script src=".../     │ ────────────▶ │ /embed.js   chat widget      │  HTTP       │ 14 tools: search, NAV     │
│   embed.js"           │   signed user │ /api/chat/stream (SSE)       │ ──────────▶ │ history, SIP/lumpsum,     │
│   data-token="…">     │   token       │ Gemini agent loop            │             │ risk, rolling returns,    │
│                       │ ◀──────────── │  ├ Gemini Flash-Lite (+failover)            │ compare, rank, projection,│
│ Shadow-DOM widget,    │   streamed    │  ├ conversation memory       │             │ portfolio valuation       │
│ charts, markdown      │   text+charts │  └ get_my_portfolio ─┐       │             └────────────┬──────────────┘
└───────────────────────┘               └──────────────────────┼───────┘                          │
                                                               │ read-only SQL                    │ cached HTTP
                                                        your MySQL DB                 AMFI NAVAll.txt + mfapi.in
```

| Folder | What it is |
| --- | --- |
| [`mcp-server/`](mcp-server) | MCP server exposing Indian MF data and analytics (stdio or Streamable HTTP). Reusable from any MCP client. |
| [`agent-service/`](agent-service) | Express API, Gemini agent loop, MCP client, auth, rate limits, conversation store, serves `embed.js`. |
| [`widget/`](widget) | Chat UI (vanilla JS, Shadow DOM), bundled into `agent-service/public/embed.js`. |
| [`laravel-embed/`](laravel-embed) | The Blade snippet and 4-step guide for your Laravel app. |

**Why Node.js:** it's the language you know best, and the official SDKs used here are
first-class in TypeScript: `@google/genai` for Gemini and `@modelcontextprotocol/sdk` for MCP.
SSE streaming, the MCP server and the widget share one language and one `npm` workspace.

## Quick start

Requirements: Node.js 20.12+ (tested on 24) and a Gemini API key from https://aistudio.google.com/apikey.

```bash
npm install
cp mcp-server/.env.example mcp-server/.env          # already created for you with generated secrets
cp agent-service/.env.example agent-service/.env    # "
# put your key in agent-service/.env:  GEMINI_API_KEY=...
npm run build
npm run dev          # mcp-server :3100, agent-service :3000, widget rebuild on change
```

Open **http://127.0.0.1:3000/playground** and ask a question. The playground loads the same
`embed.js` your site will. `PORTFOLIO_SOURCE=demo` gives every signed-in user a sample
portfolio to try "How is my portfolio doing?".

Then add it to Laravel: [`laravel-embed/README.md`](laravel-embed/README.md).

## MCP tools

| Tool | Answers |
| --- | --- |
| `search_funds` | Fuzzy fund search ("ppfas flexicap", "hdfc midcap direct") → scheme codes. Prefers Direct-Growth. Optional: every single-fund tool also accepts a `fund` name directly. |
| `list_categories`, `list_fund_houses` | SEBI categories and AMCs with scheme counts. |
| `get_fund_overview` | Latest NAV, day change, 52-week range, trailing returns (1W–10Y, SI), calendar-year returns, 3Y risk. |
| `get_nav_history` | NAV series between dates, auto-sampled; rendered as a chart in the widget. |
| `get_nav_on_date` | Historical NAV on specific dates (holiday-aware) and growth since then. |
| `calculate_lumpsum_returns` | Back-test a one-time investment: value, gain, CAGR. |
| `calculate_sip_returns` | Back-test a monthly SIP (with optional step-up): invested, value, XIRR, yearly snapshots + chart. |
| `estimate_future_value` | Conservative/base/optimistic projections from the fund's own rolling-return distribution, inflation-adjusted. |
| `get_rolling_returns` | Rolling-return distribution: median, range, percentiles, % negative periods. |
| `get_risk_metrics` | Volatility, Sharpe, Sortino, max drawdown (with recovery), beta/alpha vs Nifty 50. |
| `compare_funds` | 2–6 funds side by side, incl. growth of ₹10,000 over a common period. |
| `rank_funds_in_category` | Top funds in a category by return, Sharpe, volatility or drawdown. |
| `analyze_portfolio` | Values holdings at the latest NAV: gains, weights, XIRR, allocation by asset class/category/AMC. |

**Data sources:** [AMFI NAVAll.txt](https://www.amfiindia.com/spages/NAVAll.txt) for the scheme
master list and latest NAVs (refreshed every 3h), and [mfapi.in](https://www.mfapi.in) for
full daily NAV history (cached 1h per scheme). No API keys needed. Expense ratio, AUM,
holdings and fund managers aren't in these sources, and the assistant is told to say so
rather than guess.

### Use the MCP server from other clients

```jsonc
// Claude Desktop / Cursor / any MCP client (stdio)
{ "mcpServers": { "india-mf": { "command": "node", "args": ["<path>/mcp-server/dist/index.js", "--stdio"] } } }
```

Or over HTTP at `http://host:3100/mcp` with `Authorization: Bearer $MCP_AUTH_TOKEN`.
`npm run inspect -w mcp-server` opens the MCP Inspector.

## How the agent works

1. The widget POSTs `{message, conversation_id?, context?}` with the signed user token.
2. The agent loads the conversation, builds the system prompt (today's date, compliance rules, user
   context such as the fund page being viewed) and sends the MCP tools to Gemini as function declarations.
3. Gemini calls tools, often several in parallel. The agent runs them, streams `tool_start`/`tool_end`
   progress and `chart` events, and feeds results back. This repeats for up to `AGENT_MAX_STEPS`; the final
   step is forced to answer.
4. Text streams to the browser as it's generated. The turn is saved: recent turns keep full tool detail,
   older turns keep only the final answers, so token cost stays flat in long chats.

**Speed and reliability:**
- `gemini-3.5-flash-lite` is the default model: about 1 s per model step, and most questions finish in 4–6 s.
- Tools accept fund names (`fund: "hdfc mid cap"`), so a typical question needs only 2 model calls:
  tool, then answer. This also stretches free-tier per-minute quotas.
- If a model returns 503 "high demand", 429, 5xx, or goes silent for `MODEL_STALL_TIMEOUT_MS` (even
  mid-answer), the widget discards the partial text and the next model in `GEMINI_FALLBACK_MODELS`
  answers. The failed model is tried last for `MODEL_COOLDOWN_SECONDS`.
- Tool outputs are compact JSON with pre-computed figures, so the model doesn't do arithmetic. Upstream
  data is cached, and the widget bundle is 89 KB gzipped.

## Configuration (agent-service/.env)

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Required. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Main model. Any Gemini model id. |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.6-flash,gemini-3.8-flash` | Tried in order on overload, quota, errors or stalls. |
| `GEMINI_THINKING_LEVEL` | `low` | `minimal`/`low`/`medium`/`high`/empty. Dropped per model if that model rejects it. |
| `MODEL_STALL_TIMEOUT_MS` / `MODEL_COOLDOWN_SECONDS` | `20000` / `60` | Failover on a silent stream; how long a failed model is tried last. |
| `WIDGET_TOKEN_SECRET` | — | Shared with Laravel (`MF_CHAT_SECRET`), ≥ 32 chars. |
| `ALLOWED_ORIGINS` | — | Your site's origin(s), comma-separated. |
| `ALLOW_ANONYMOUS` | `false` | Let logged-out visitors chat. |
| `PORTFOLIO_SOURCE` | `none` | `none`, `demo` or `mysql` (see below). |
| `REDIS_URL` | — | Conversation store for multiple instances / restarts (in-memory otherwise). |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_PER_IP_PER_MINUTE` | `20` / `60` | Per user and per IP. |
| `AGENT_MAX_STEPS`, `TOOL_TIMEOUT_MS`, `HISTORY_MAX_TURNS` | `8`, `45000`, `12` | Agent limits. |
| `APP_NAME`, `ASSISTANT_NAME` | `MF Invest`, `Fundy` | Used in the system prompt. |
| `ENABLE_PLAYGROUND` | — | Dev only; refused when `NODE_ENV=production`. |

More MCP servers can be added in `agent-service/mcp.config.json`: their tools are merged automatically.

## "My portfolio" from your Laravel database

The Node service reads holdings directly and read-only; Laravel needs no changes. Create a MySQL user
with `SELECT` only, then set:

```env
PORTFOLIO_SOURCE=mysql
PORTFOLIO_DB_URL=mysql://mfchat_readonly:secret@127.0.0.1:3306/your_laravel_db
PORTFOLIO_HOLDINGS_SQL="SELECT scheme_code, units, invested_amount FROM holdings WHERE user_id = :user_id AND units > 0"
# optional, enables XIRR:
PORTFOLIO_TRANSACTIONS_SQL="SELECT scheme_code, DATE(created_at) AS date, IF(type = 'redeem', -amount, amount) AS amount FROM transactions WHERE user_id = :user_id"
```

Adjust the table and column names to your schema; the queries just need to return those column
aliases. `:user_id` is the id from the signed token (`auth()->id()`). Guests never get portfolio
access, and only single `SELECT` statements are accepted.

## Security model

- **Identity:** Laravel signs `{uid, name, exp}` with HMAC-SHA256 (12-hour expiry). The Node service
  verifies it with a timing-safe compare. Conversations are keyed by the verified user id, so users
  can't read each other's chats, and the model never chooses whose portfolio to load.
- **Browser access:** only the origins in `ALLOWED_ORIGINS` (CORS), JSON bodies capped at 32 KB,
  per-user and per-IP rate limits, and client disconnects cancel the Gemini and tool calls.
- **Widget:** markdown is sanitised with DOMPurify, and the UI is isolated in a Shadow DOM.
- **MCP server:** bearer token (`MCP_AUTH_TOKEN`) plus DNS-rebinding protection. Keep port 3100 private.
- **Prompt:** tool output is treated as data; the model is told it's not a SEBI-registered adviser,
  must not give buy/sell calls, and must add a market-risk disclaimer to return figures and projections.

## Deployment

**DigitalOcean, step by step:** [`docs/deploy-digitalocean.md`](docs/deploy-digitalocean.md). It covers the
Droplet, Node, PM2, nginx, free SSL, Redis, the MySQL portfolio and updates.

**PM2 + nginx** (simplest for a Node developer):

```bash
npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save
```

In `agent-service/.env`: `NODE_ENV=production`, `ENABLE_PLAYGROUND=false`, `TRUST_PROXY=1`,
`ALLOWED_ORIGINS=https://app.yourdomain.com`, and ideally `REDIS_URL`. Put nginx in front of port 3000
with streaming enabled:

```nginx
server {
  server_name chat.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # required for streaming replies
    proxy_read_timeout 180s;
  }
}
```

**Docker:** `docker compose up --build` runs the MCP server, agent and Redis (see `docker-compose.yml`).

## Development

```bash
npm test            # 22 MCP tests (analytics maths + HTTP transport) + 14 agent tests (fake Gemini, real MCP, HTTP/SSE, auth)
npm run smoke       # calls all 14 MCP tools against live AMFI data
npm run typecheck
```

The agent tests use a scripted fake Gemini, so they run without an API key while still exercising
the real MCP server, live data, the SSE endpoint and token auth.

## Disclaimer

The assistant gives educational information from public NAV data. It is not investment advice.
Mutual fund investments are subject to market risks; past performance does not guarantee future results.
