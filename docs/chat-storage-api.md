# Chat storage & credits API (Laravel)

This is the contract the Laravel server must fulfil so the chatbot can **store/retrieve chats**
and **meter usage per user**. You build these endpoints; the widget and `agent-service` call them.

There are two surfaces, with two different callers and two different ways of trusting the user — keep
them separate:

| Surface | Caller | Auth | Trusts `userId` from |
| --- | --- | --- | --- |
| **Storage** (chat history) | the browser widget, directly | your normal Laravel session/cookie | the logged-in session (the path `userId` is only cross-checked) |
| **Credits & usage** | `agent-service`, server→server | a shared service secret | the `uid` inside the signed token (never the browser) |

The one rule that ties them together: **the `uid` in the signed token equals the `userId` the widget
uses for storage**, so history and billing are about the same person.

---

## 1. The signed token (already in use)

The widget already proves who is logged in with an HMAC token your Blade snippet mints
(see [`laravel-embed/README.md`](../laravel-embed/README.md)). Nothing new to build here — it is
described so the credit endpoints below can reuse the same `uid`.

```
token = base64url( JSON {uid, name?, risk?, exp} ) + "." + hex( HMAC-SHA256(payloadPart, WIDGET_TOKEN_SECRET) )
```

- `uid` — string, 1–64 chars. This is the id everything keys on.
- `exp` — Unix seconds; the agent rejects an expired token.
- Signed with `WIDGET_TOKEN_SECRET`, shared between Laravel and `agent-service`.

---

## 2. Storage API — chat history

Called by the browser widget. Authenticated by your **Laravel session** (the user is already logged in
on the host page). `userId` is sent in the path on every call as required; your server must confirm it
matches the session user and return `403` if not. Scope every query by `user_id` so one user can never
read another's thread.

Base URL = your Laravel app, e.g. `https://app.yourdomain.com`.

### 2.1 Data model

**`conversations`**

| column | type | notes |
| --- | --- | --- |
| `id` | varchar(64) | the `conversation_id`; matches `^[A-Za-z0-9_-]{8,64}$` (minted by `agent-service`, returned in its `done` event) |
| `user_id` | varchar(64) | owner |
| `title` | varchar(200) null | derive from the first user message; for a history list |
| `created_at` / `updated_at` | datetime | |
| | | **UNIQUE (`user_id`, `id`)**; index on `user_id` |

**`messages`**

| column | type | notes |
| --- | --- | --- |
| `id` | bigint / uuid | primary key |
| `conversation_id` | varchar(64) | FK → `conversations.id` |
| `user_id` | varchar(64) | denormalised, so ownership is checkable on write |
| `role` | enum(`user`, `assistant`) | |
| `text` | longtext | the bubble text (markdown) |
| `charts` | json null | array of chart objects — **opaque**; store and return verbatim |
| `at` | datetime | message time (ISO 8601 from the client) |
| `client_id` | varchar(64) null | optional; for idempotent retries |
| | | index (`conversation_id`, `at`) |

You do **not** need to store the model's internal history — `agent-service` keeps that live context
itself. This API holds only the display transcript.

### 2.2 Save messages

Called after each reply. The widget sends the user message and the assistant reply together.

```
POST {base}/api/chat/{userId}/conversations/{conversationId}/messages
Content-Type: application/json

{
  "messages": [
    { "role": "user",      "text": "How did my SIP do?",      "at": "2026-10-20T09:00:01Z" },
    { "role": "assistant", "text": "Your SIP is up 12%…",
      "charts": [ { "kind": "line", "title": "SIP growth", "series": [ … ] } ],
      "at": "2026-10-20T09:00:04Z",
      "client_id": "a1b2c3"  }
  ]
}
```

- Upsert the `conversations` row if it does not exist; set `title` from the first user message and bump
  `updated_at`.
- If a `client_id` already exists for the conversation, skip that message (so a retry can't duplicate).

**Response `200`**

```json
{ "ok": true, "conversation_id": "ab12cd34", "saved": 2, "updated_at": "2026-10-20T09:00:04Z" }
```

### 2.3 Get a conversation

Called on page load to re-render the chat. This shape matches the widget's existing `historyUrl`
contract, so rendering works unchanged.

```
GET {base}/api/chat/{userId}/conversations/{conversationId}
```

**Response `200`**

```json
{
  "conversation_id": "ab12cd34",
  "messages": [
    { "role": "user",      "text": "How did my SIP do?", "charts": null, "at": "2026-10-20T09:00:01Z" },
    { "role": "assistant", "text": "Your SIP is up 12%…", "charts": [ … ], "at": "2026-10-20T09:00:04Z" }
  ],
  "updated_at": "2026-10-20T09:00:04Z"
}
```

Return `404` if the conversation does not exist **or** is not owned by `userId` (don't reveal which).

### 2.4 List a user's conversations (optional)

Only needed if you want a history panel. Cursor-paginated.

```
GET {base}/api/chat/{userId}/conversations?limit=20&cursor=<opaque>
```

**Response `200`**

```json
{
  "conversations": [
    { "conversation_id": "ab12cd34", "title": "SIP returns", "preview": "Your SIP is up 12%…", "updated_at": "2026-10-20T09:00:04Z" }
  ],
  "next_cursor": null
}
```

### 2.5 Delete / reset a conversation

The widget's "New chat".

```
DELETE {base}/api/chat/{userId}/conversations/{conversationId}
→ 204  (no body)
```

---

## 3. Credits & usage API

> **Superseded by [`ai-usage-api.md`](ai-usage-api.md)** — the simpler token-quota version we settled
> on (JWT via the embed, `X-Api-Key`, `GET`/`POST /api/ai/usage/{userId}`). The balance-style sketch
> below is kept only as an alternative.

Called by `agent-service` **server-to-server** (not the browser), so the user id here is the verified
`uid` from the signed token. Protect these routes with a **shared service secret**, sent as a header —
they must not be reachable from a browser.

```
X-Service-Token: <SERVICE_SECRET shared with agent-service>
```

This section assumes credits live in Laravel (recommended, since Laravel already owns the user). If you
would rather have `agent-service` enforce a simple per-user daily cap on its own, you can skip this
section — tell us and we'll do it in the agent instead.

### 3.1 Check balance (before answering)

```
GET {base}/api/internal/users/{uid}/credits
X-Service-Token: …
```

**Response `200`**

```json
{ "balance": 420, "plan": "pro", "reset_at": "2026-11-01T00:00:00Z" }
```

If `balance <= 0`, the agent returns a friendly "out of credits" message and skips the LLM call.
`plan` and `reset_at` are optional (used for messaging only).

### 3.2 Report usage (after answering)

Sent once per answered message, with the token counts from the agent's `done` event.

```
POST {base}/api/internal/users/{uid}/usage
X-Service-Token: …
Content-Type: application/json

{
  "conversation_id": "ab12cd34",
  "model": "gemini-3.5-flash-lite",
  "messages": 1,
  "tokens": { "prompt": 1800, "output": 220, "thinking": 90, "total": 2110 },
  "at": "2026-10-20T09:00:04Z"
}
```

Decrement the balance (your own credits-per-token or per-message formula) and record the row for
monitoring.

**Response `200`**

```json
{ "ok": true, "balance": 418 }
```

> **Monitoring at scale:** the `usage` rows are your per-user cost view — group by `uid`, `model` and
> day. `agent-service` also logs the same counts, so the two can be reconciled.

---

## 4. Conventions

**Error envelope** — every error is:

```json
{ "error": "out_of_credits", "message": "You've used up your chat credits for now." }
```

| Status | When |
| --- | --- |
| `401` | missing/invalid session (storage) or bad service token (credits) |
| `403` | path `userId` ≠ the authenticated user |
| `404` | conversation not found / not owned |
| `402` | out of credits (or return `200` with `balance: 0` from §3.1 — pick one) |
| `422` | malformed body |
| `429` | rate-limited |

**CORS (storage only)** — the widget calls from the browser, so allow your site's origin(s) and the
`Authorization`/`Content-Type` headers, methods `GET, POST, DELETE, OPTIONS`.

**Timestamps** — ISO 8601 UTC everywhere.

---

## 5. Build checklist

- [ ] `conversations` + `messages` tables (§2.1), scoped and indexed by `user_id`.
- [ ] Storage routes (§2.2–2.5), session-authed, path `userId` cross-checked against the session.
- [ ] `credits` + `usage` routes (§3), behind the service secret, keyed on token `uid`.
- [ ] `SERVICE_SECRET` set on both Laravel and `agent-service`; `WIDGET_TOKEN_SECRET` already shared.
- [ ] Decide the credit formula (per message, or per 1K tokens) in §3.2.
