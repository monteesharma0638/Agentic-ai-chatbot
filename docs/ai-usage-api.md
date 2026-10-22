# AI usage-limit API (Laravel)

Two Laravel endpoints the chat server needs so it can **check** a user's remaining AI quota and
**update** their token usage after each answer. This is **server-to-server**: the chat server (the
Node/Next.js backend on Vercel, `agent-service`) calls Laravel directly — never the browser.

Keep it simple: one small table (or a couple of columns on the user), one controller with two methods.

## How the user is identified

1. Laravel signs a **JWT** (HS256, shared secret) and hands it to the page.
2. The embed script receives that token (e.g. `data-token="…"`) and sends it to the chat server.
3. The chat server **decodes the JWT with the same secret** → gets the user id, with no DB lookup.
4. Using that id, the chat server calls the two APIs below to gate and record usage.

**JWT payload** (what Laravel should put in it):

```json
{ "sub": "12345", "name": "Asha", "plan": "pro", "iat": 1760000000, "exp": 1760043200 }
```

- `sub` — the user id. This is the `{userId}` used in the API paths below. (Required.)
- `name`, `plan` — optional, for greeting / messaging.
- `exp` — Unix seconds; the chat server refuses an expired token.
- The **quota limit is not in the JWT** (usage changes as they chat); it comes from the API.

> Signed with the same `WIDGET_TOKEN_SECRET` the chat server already holds, so no new key exchange is
> needed for decoding. The two APIs below use a **separate** service key (next section).

## Authenticating the API calls

Because these are server-to-server, protect both routes with one **shared service key** sent as a
header. Reject anything without it. This is all the auth the APIs need.

```
X-Api-Key: <SERVICE_API_KEY shared between Laravel and the chat server>
```

(The browser never sees this key and never calls these routes.)

---

## 1. Check usage — before answering

The chat server calls this to decide whether to answer. If the quota is spent it stops and tells the
user to come back after `reset_at`.

| | |
| --- | --- |
| **Method & path** | `GET {base}/api/ai/usage/{userId}` |
| **Takes** | path `userId` (the JWT `sub`); header `X-Api-Key`. No body. |
| **Sends back** | the usage object (below), as JSON |

## 2. Update usage — after answering

The chat server calls this once per answered message, with the tokens the model used. Laravel adds
them to the user's running total and returns the new figures.

| | |
| --- | --- |
| **Method & path** | `POST {base}/api/ai/usage/{userId}` |
| **Takes** | path `userId`; header `X-Api-Key`; JSON body (below) |
| **Sends back** | the same usage object, with the updated total, as JSON |

**Request body:**

```json
{
  "tokens": { "prompt": 1800, "output": 220, "thinking": 90, "total": 2110 },
  "model": "gemini-3.5-flash-lite",
  "conversation_id": "ab12cd34",
  "at": "2026-10-21T09:00:04Z"
}
```

- `tokens.total` is the number to add to the user's used quota; the breakdown is for your records.
- `model`, `conversation_id`, `at` are optional — store them if you want per-model / per-chat reporting.

---

## The usage object (response of both endpoints)

Both endpoints return the **same** shape, so the chat server has one thing to read:

```json
{
  "user_id": "12345",
  "unit": "tokens",
  "used": 18450,
  "limit": 50000,
  "remaining": 31550,
  "blocked": false,
  "reset_at": "2026-10-22T00:00:00Z"
}
```

- `remaining` = `limit - used` (never below 0). `blocked` = `true` when `remaining <= 0`.
- `reset_at` — when the quota refills (ISO 8601 UTC). Laravel owns the window (e.g. daily); the chat
  server just reads this value to tell the user when to return.
- When `blocked` is `true`, the chat server does **not** call the model — it shows a message like
  *"You've used your AI quota for now. Please come back after \<reset_at\>."*

## URLs at a glance

| Purpose | Method | Path |
| --- | --- | --- |
| Check remaining quota (gate the answer) | `GET` | `{base}/api/ai/usage/{userId}` |
| Record tokens used (after answering) | `POST` | `{base}/api/ai/usage/{userId}` |

`{base}` = your Laravel app, e.g. `https://app.yourdomain.com`.

## Errors

Blocking is a normal `200` with `blocked: true` — not an error. Use error codes only for real failures:

| Status | When |
| --- | --- |
| `401` | missing/wrong `X-Api-Key` |
| `404` | unknown `userId` (optional — you may instead create the row on first use) |
| `422` | malformed body (e.g. `tokens.total` missing) |

## Storing it (minimal)

Enough to back the two endpoints — a daily counter per user:

| column | type | notes |
| --- | --- | --- |
| `user_id` | varchar/bigint | |
| `used` | bigint | tokens used in the current window |
| `limit` | bigint | the user's quota (from their plan) |
| `window_start` | datetime | when the current window began; reset `used` to 0 and move this forward once `now >= window_start + window` |

`remaining`, `blocked` and `reset_at` are computed from these at request time.

## Build checklist

- [ ] JWT minting already produces `sub` = user id, signed with `WIDGET_TOKEN_SECRET`.
- [ ] `SERVICE_API_KEY` set on both Laravel and the chat server.
- [ ] `GET /api/ai/usage/{userId}` and `POST /api/ai/usage/{userId}`, both behind the `X-Api-Key` check.
- [ ] A usage counter per user with a reset window; decide the per-plan `limit` and window length.
