# India Mutual Fund AI Assistant

An agentic chatbot for a mutual fund investing app. Users ask questions in plain English (or Hinglish);
a Gemini model decides which data tools to call, runs them through an **MCP server** backed by
official AMFI NAV data, and streams back an answer with charts.

- "What was the NAV of Parag Parikh Flexi Cap on 23 March 2020, and how much has it grown since?"
- "If I had started a ₹10,000 SIP in HDFC Mid Cap in Jan 2019 with a 10% yearly step-up, what would it be worth?"
- "Top 5 small cap funds by 3-year returns — and which had the smallest drawdown?"
- "Estimate what ₹5 lakh in a Nifty 50 index fund could become in 10 years."
- "How is my portfolio doing?" (signed-in users; built-in demo holdings — see "My portfolio" below)

Everything runs on **Node.js / TypeScript**, self-contained with its own MongoDB — no external app
database is needed. A website embeds it with one `<script>` tag: a Laravel app can use
[`laravel-embed/README.md`](laravel-embed/README.md); any other site (WordPress, Shopify, plain HTML)
pastes the same tag into its header or footer: see [`docs/embed-any-website.md`](docs/embed-any-website.md).

## Architecture

```
 Website (any site)                      agent-service  (Node.js, :3000)              mcp-server (Node.js, :3100)
┌───────────────────────┐   HTTPS/SSE   ┌──────────────────────────────┐  MCP over   ┌───────────────────────────┐
│ <script src=".../     │ ────────────▶ │ /embed.js   chat widget      │  HTTP       │ 14 tools: search, NAV     │
│   embed.js"           │   user JWT    │ /api/chat/stream (SSE)       │ ──────────▶ │ history, SIP/lumpsum,     │
│   data-token="…">     │   (Bearer)    │ Gemini agent loop            │             │ risk, rolling returns,    │
│                       │ ◀──────────── │  ├ Gemini Flash-Lite (+failover)            │ compare, rank, projection,│
│ Shadow-DOM widget,    │   streamed    │  ├ get_my_portfolio (demo)   │             │ portfolio valuation       │
│ charts, markdown      │   text+charts │  └ chats + usage ─┐          │             └────────────┬──────────────┘
└───────────────────────┘               └───────────────────┼──────────┘                          │ cached HTTP
                                                          MongoDB                     AMFI NAVAll.txt + mfapi.in
```

| Folder | What it is |
| --- | --- |
| [`mcp-server/`](mcp-server) | MCP server exposing Indian MF data and analytics (stdio or Streamable HTTP). Reusable from any MCP client. |
| [`agent-service/`](agent-service) | Express API, Gemini agent loop, MCP client, auth, rate limits, conversation store, serves `embed.js`. |
| [`widget/`](widget) | Chat UI (vanilla JS, Shadow DOM), bundled into `agent-service/public/embed.js`. |
| [`laravel-embed/`](laravel-embed) | The Blade snippet and 4-step guide for your Laravel app. |
| `api/index.js`, `vercel.json` | Vercel deployment (one function, MCP server in-process). Not used on a VPS. |
| [`docs/`](docs) | Step-by-step deployment guides: [Vercel](docs/deploy-vercel.md) and [VPS](docs/deploy-vps.md). |

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

1. The widget POSTs `{message, conversation_id?, context?}` with the user's JWT as a Bearer token.
2. The agent loads the conversation, builds the system prompt (today's date, compliance rules, user
   context such as the fund page being viewed) and sends the MCP tools to Gemini as function declarations.
3. Gemini calls tools, often several in parallel. The agent runs them, streams `tool_start`/`tool_end`
   progress and `chart` events, and feeds results back. This repeats for up to `AGENT_MAX_STEPS`; the final
   step is forced to answer.
4. Text streams to the browser as it's generated. The turn is saved to MongoDB (chats and token usage,
   keyed by user id); recent turns keep full tool detail, older turns keep only the final answers, so
   token cost stays flat in long chats.

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
| `WIDGET_TOKEN_SECRET` | — | Secret that verifies the website's JWT (HS256), ≥ 32 chars. User id is the `sub` claim. |
| `MONGODB_URI` / `MONGODB_DB` | — / `mfchat` | Where chats and usage are stored. Required in production; empty = in-memory (dev/tests only). |
| `USAGE_LIMIT_TOKENS` / `USAGE_WINDOW_HOURS` | `0` / `24` | Per-user token budget per window. `0` records usage without ever blocking. |
| `SERVICE_API_KEY` | — | Enables the [server-to-server API](docs/server-to-server-api.md) (`/internal/…`, header `X-Api-Key`), ≥ 16 chars. |
| `ALLOWED_ORIGINS` | — | Your site's origin(s), comma-separated. |
| `ALLOW_ANONYMOUS` | `false` | Let logged-out visitors chat. |
| `PORTFOLIO_SOURCE` | `none` | `none` (off) or `demo` (built-in sample holdings). No external database. |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_PER_IP_PER_MINUTE` | `20` / `60` | Per user and per IP. |
| `AGENT_MAX_STEPS`, `TOOL_TIMEOUT_MS`, `HISTORY_MAX_TURNS` | `8`, `45000`, `12` | Agent limits. |
| `APP_NAME`, `ASSISTANT_NAME` | `MF Invest`, `Fundy` | Used in the system prompt. |
| `ENABLE_PLAYGROUND` / `PLAYGROUND_PASSWORD` | — | Test page at `/playground`; the optional password adds a browser login. Turn it off before launch. |

More MCP servers can be added in `agent-service/mcp.config.json`: their tools are merged automatically.

## "My portfolio" questions

Set `PORTFOLIO_SOURCE=demo` to give every signed-in user a built-in sample portfolio, so you can try
"How is my portfolio doing?" without any external data. `none` turns the feature off.

This service holds no live holdings of its own — it does not connect to any external application
database. To feed real holdings, implement a `PortfolioProvider` in
`agent-service/src/portfolio/providers.ts` (`getHoldings(userId)` returning `scheme_code`, `units` and
optional `invested_amount` / `transactions`) that reads from your own source, and wire it into
`createPortfolioProvider`. Holdings are keyed by the verified user id; guests never get portfolio access.

## Security model

- **Identity:** the website signs a standard JWT (HS256) with `{sub, name?, risk?, exp}`. The Node
  service verifies it with the shared secret — algorithm pinned to HS256 (no `alg: none` / confusion),
  timing-safe compare, expiry checked. Chats and usage are stored in MongoDB keyed by the verified user
  id, so users can't read each other's chats, and the model never chooses whose portfolio to load.
- **Server-to-server:** the `/internal` read API is gated by a separate shared `SERVICE_API_KEY`
  (`X-Api-Key`) and is never exposed to the browser.
- **Browser access:** only the origins in `ALLOWED_ORIGINS` (CORS), JSON bodies capped at 32 KB,
  per-user and per-IP rate limits, and client disconnects cancel the Gemini and tool calls.
- **Widget:** markdown is sanitised with DOMPurify, and the UI is isolated in a Shadow DOM.
- **MCP server:** bearer token (`MCP_AUTH_TOKEN`) plus DNS-rebinding protection. Keep port 3100 private.
- **Prompt:** tool output is treated as data; the model is told it's not a SEBI-registered adviser,
  must not give buy/sell calls, and must add a market-risk disclaimer to return figures and projections.

## Deployment

The same code deploys to Vercel or to a VPS; the host decides how it runs, and no code changes are needed to switch.

| | Vercel ([guide](docs/deploy-vercel.md)) | VPS: DigitalOcean, Lightsail, Hetzner… ([guide](docs/deploy-vps.md)) |
| --- | --- | --- |
| Entry point | `api/index.js` → one Function | `npm start` / PM2 → two processes |
| MCP data server | in-process | separate process over HTTP (`mcp.config.json`) |
| Chats & usage | MongoDB via `MONGODB_URI` (e.g. Atlas) | MongoDB via `MONGODB_URI` (Atlas or self-hosted) |
| `embed.js` | Vercel CDN | served by Express |
| Config | Vercel environment variables | `agent-service/.env`, `mcp-server/.env` |

Serve it from your own domain (`chat.yourdomain.com`) from day one; moving hosts is then only a DNS change,
and Laravel keeps the same `MF_CHAT_URL`.

**Docker:** `docker compose up --build` runs the MCP server, agent and MongoDB (see `docker-compose.yml`).

## Development

```bash
npm test            # 22 MCP tests (analytics maths + HTTP transport) + 31 agent tests (fake Gemini, real MCP, HTTP/SSE, JWT auth, store, usage, S2S API)
npm run smoke       # calls all 14 MCP tools against live AMFI data
npm run typecheck
```

The agent tests use a scripted fake Gemini, so they run without an API key while still exercising
the real MCP server, live data, the SSE endpoint and token auth.

## Disclaimer

The assistant gives educational information from public NAV data. It is not investment advice.
Mutual fund investments are subject to market risks; past performance does not guarantee future results.
