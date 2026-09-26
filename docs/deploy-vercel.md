# Deploy on Vercel (step by step)

The same code runs on Vercel now and on a VPS later ([deploy-vps.md](deploy-vps.md)). The repo already
contains the Vercel setup:

| File | What it does on Vercel |
| --- | --- |
| `vercel.json` | Build command, Mumbai region (`bom1`), 120 s limit per reply, routes everything except `/embed.js` to the function |
| `api/index.js` | The single Vercel Function: chat API + MCP data server running **in-process** |
| `agent-service/public/embed.js` | The chat widget, served from Vercel's CDN |

What you'll end up with:

```
Laravel page ──HTTPS──▶ chat.yourdomain.com  (Vercel)
                          ├─ /embed.js  → CDN (static file)
                          └─ everything else → one Function: Gemini agent + MCP server (in-process)
                                                chat memory → Vercel Runtime Cache (or Redis)
```

**Time:** about 20 minutes. **Cost:** covered by your Pro plan for normal traffic. The function mostly
waits on Gemini, and waiting isn't billed as active CPU.

---

## 1. Put the code on GitHub

On your PC (PowerShell). `.env` files, `node_modules`, build output and `.vercel` are excluded by `.gitignore`.

```bash
cd "E:\projects\Agentic AI\Mutual-funds-chat"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_GITHUB_USER/mutual-funds-chat.git
git push -u origin main
```

Use a **private** repository.

## 2. Create the Vercel project

1. In the Vercel dashboard: **Add New → Project**, then import `mutual-funds-chat` from GitHub.
2. **Framework Preset:** leave it as detected (**Other**; `vercel.json` sets it).
3. **Root Directory:** leave it as `./` (the repo root, **not** `agent-service`).
4. **Build and Output Settings:** leave the defaults; `vercel.json` provides them.
5. Open **Environment Variables** on the same screen and add the values from step 3 **before**
   clicking **Deploy**.

## 3. Environment variables

Generate a secret for `WIDGET_TOKEN_SECRET` (on your PC):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use the same values for **Production, Preview and Development**. The repo's `.env.vercel` (created locally,
never committed) has them ready to import: **Settings → Environment Variables → Import .env**.

| Variable | Value |
| --- | --- |
| `GEMINI_API_KEY` | your Gemini key |
| `WIDGET_TOKEN_SECRET` | the generated secret. Laravel's `MF_CHAT_SECRET` must be identical |
| `ALLOWED_ORIGINS` | `https://your-laravel-site.com`. Exact, no trailing slash. Add `,https://www.your-laravel-site.com` if you use www |
| `APP_NAME` | your app's name, e.g. `MyFunds` |
| `ASSISTANT_NAME` | the assistant's name, e.g. `Fundy` |
| `PORTFOLIO_SOURCE` | `none` for now (see step 9) |
| `ENABLE_PLAYGROUND` | `true` while testing: a public test page at `/playground` (see "Using the playground"). Set `false` before launch |

Optional: `PLAYGROUND_PASSWORD` (12+ characters; puts a browser login on the playground), `ALLOW_ANONYMOUS=true` (let logged-out visitors chat), `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS`,
`LOG_LEVEL`. Redis variables are added by the Upstash integration (step 8); don't type them yourself.

**Don't set these on Vercel:**
- `NODE_ENV`: setting it to `production` makes npm skip the build tools and the build fails. The app
  detects production through Vercel's own `VERCEL_ENV`.
- `HOST`, `PORT`, `MF_MCP_URL`, `MCP_AUTH_TOKEN`, `MCP_SERVERS`, `TRUST_PROXY`: VPS-only, or handled
  automatically on Vercel.

> **Gemini tier:** for real users, enable billing on your Gemini API key. The paid tier has much higher
> rate limits, and Google's terms allow prompts sent on the free tier to be used to improve its products.

## 4. Deploy and check

Click **Deploy**. The build runs `npm ci` and `npm run build` and takes 1–2 minutes. Then open:

```
https://<your-project>.vercel.app/health
```

Expected: `{"status":"ok",…,"store":"vercel","mcp":[{"name":"india-mf","connected":true,"tools":14}]}`.
(`store` becomes `upstash` after step 8.)
If it shows `startup_failed`, open **Logs** in the project; it's almost always a missing environment variable.

## 5. Use your own domain (makes a later move to a VPS a DNS-only change)

1. Project → **Settings → Domains → Add**, enter `chat.yourdomain.com`.
2. Vercel shows a DNS record, usually a **CNAME** for `chat`. Add exactly that at your DNS provider.
3. Wait until Vercel shows the domain as valid. HTTPS is issued automatically.

Check `https://chat.yourdomain.com/health`.

## 6. Connect your Laravel app

Follow [`laravel-embed/README.md`](../laravel-embed/README.md) with these values in Laravel's `.env`:

```env
MF_CHAT_URL=https://chat.yourdomain.com
MF_CHAT_SECRET=<exactly the same as WIDGET_TOKEN_SECRET on Vercel>
```

Then run `php artisan config:clear` (or `config:cache` in production). Open your Laravel site while logged in;
the chat button appears in the bottom-right corner.

## 7. Protect the API with a rate limit

The app has its own per-user limits, but on Vercel each function instance counts separately, so add a
Firewall rule as well:

Project → **Firewall** → **Configure** → **New Rule** (names may differ slightly in the dashboard):

- **If:** Request Path **starts with** `/api/chat`
- **Then:** **Rate Limit**, for example **30 requests per 60 seconds per IP**, then deny (429).

Leave **Deployment Protection** at the default (**Standard Protection**), which locks preview URLs behind your
Vercel login. Production must stay public, because your Laravel visitors' browsers call it.

## 8. Chat memory that's never evicted: Redis (recommended)

Without Redis, conversations are kept in **Vercel Runtime Cache**: shared by all instances, 24-hour expiry,
nothing to set up, but it can drop old entries when full. Redis keeps every chat for its full 24 hours.

1. Project → **Storage** → **Create Database** (or **Browse Marketplace**) → choose **Upstash** → **Redis**.
2. **Region:** pick **Mumbai (ap-south-1)** if offered, to sit next to the function (`bom1`). The free plan is
   plenty to start with.
3. **Connect** it to this project with **all environments** ticked (Production, Preview, Development).
   Upstash adds its variables automatically, for example `KV_REST_API_URL` / `KV_REST_API_TOKEN` or
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, sometimes also `KV_URL` / `REDIS_URL`. The app detects
   any of them, so you don't need to rename or copy anything.
4. **Redeploy** (Deployments → ⋯ → Redeploy); new variables only apply to new deployments.
5. Check `https://chat.yourdomain.com/health`: it should now say `"store":"upstash"` (or `"redis"`).

Production and Preview then share this Redis database. Chats never mix between them because every entry is
keyed by user and conversation id. If you'd rather keep them apart, create a second database and connect it
to Preview only.

## 9. "My portfolio" answers: best left for the VPS

Vercel functions don't have a fixed IP address, so your Laravel MySQL database would have to accept
connections from the whole internet (with TLS, a strong password and a read-only user), or you'd need Vercel's
paid **Static IPs** feature so the database can allow only those addresses.

- **For now:** keep `PORTFOLIO_SOURCE=none`, or use `demo` to show sample holdings.
- **On a VPS later:** it has a fixed IP, so follow step 11 of [deploy-vps.md](deploy-vps.md).

If you still want it on Vercel, set the `PORTFOLIO_*` variables exactly as described in
[deploy-vps.md, step 11](deploy-vps.md#11-optional-how-is-my-portfolio-doing-from-your-laravel-database), and add
`?ssl={"rejectUnauthorized":true}` to `PORTFOLIO_DB_URL`.

## Using the playground

With `ENABLE_PLAYGROUND=true`, open:

```
https://chat.yourdomain.com/playground
```

You can chat there without Laravel. It works on preview URLs too; Vercel asks for your Vercel login there first.

- Add `?settings=1` to the address to show the settings panel (user id, name, fund-page context, guest mode).
- To switch the playground off, set `ENABLE_PLAYGROUND=false` and redeploy.
- **It's public:** anyone who finds the URL can chat (using your Gemini quota) and create test logins for any
  user id. That's fine while only a few testers know the URL. Before launch, set `ENABLE_PLAYGROUND=false`,
  or add `PLAYGROUND_PASSWORD` to put a login in front of it. The logs warn about this on every start.
- It won't start together with `PORTFOLIO_SOURCE=mysql` unless `PLAYGROUND_PASSWORD` is set; otherwise
  anyone could view any user's real holdings.

## Updating

Push to `main` and Vercel builds and deploys it automatically. If something breaks, use
**Deployments → ⋯ → Instant Rollback** on the last good deployment.

Local development is unchanged: `npm run dev` and `http://127.0.0.1:3000/playground`.

## Logs

Project → **Logs** shows every request with its log lines (JSON). Useful filters: level `error`, or search
for `chat failed`, `Model failed` or `tool call`.

## Moving to a VPS later

Follow [deploy-vps.md](deploy-vps.md). No code changes are needed; the same repo runs as a normal server
there. The switch itself:

1. Set up the VPS completely (steps 1–13 there), copying your Vercel environment variables into
   `agent-service/.env`.
2. Change the `chat` DNS record from Vercel's CNAME to an **A record** pointing at the VPS.
3. After it's live, remove `chat.yourdomain.com` from the Vercel project.

Laravel keeps using `https://chat.yourdomain.com` and needs no changes.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Build fails at `tsc` or `esbuild: not found` | `NODE_ENV=production` is set in Vercel; remove it. |
| `/health` shows `startup_failed` | A required variable is missing. See **Logs** for the exact message. |
| `startup_failed` right after enabling the playground | `PLAYGROUND_PASSWORD` is shorter than 12 characters, or the playground is on without a password while `PORTFOLIO_SOURCE=mysql`. |
| `/health` still shows `"store":"vercel"` after adding Upstash | Redeploy; variables only reach new deployments. Check that Upstash is connected to that environment. |
| Widget shows "Your session has expired" | Laravel `MF_CHAT_SECRET` ≠ Vercel `WIDGET_TOKEN_SECRET`. Fix, redeploy, `php artisan config:clear`. |
| Browser console: `403` / `origin_not_allowed` | `ALLOWED_ORIGINS` doesn't exactly match the Laravel site address (https, www, no trailing slash). Redeploy after changing it. |
| Widget can't load, or requests fail on a preview URL | Preview URLs are login-protected; use the production domain from Laravel. |
| First answer after a quiet period is slower | A new function instance is downloading the AMFI fund list (a second or two); later answers are fast. |
| "Something went wrong while generating a reply" | Logs → search `chat failed`. Usually the Gemini key, quota (429) or all models overloaded (503). |

Changing an environment variable only takes effect after a redeploy (**Deployments → ⋯ → Redeploy**).
