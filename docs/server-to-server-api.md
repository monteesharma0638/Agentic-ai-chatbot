# Server-to-server API (read chats & usage)

`agent-service` stores every chat and each user's token usage in **its own MongoDB**, keyed by the user
id from the JWT. These endpoints let **another backend** (never the browser) read that data.

`{base}` = the agent service, e.g. `https://chat.yourdomain.com`.

## Auth

All routes are under `/internal` and require a single shared key in a header. There is no CORS and the
browser must never be given this key.

```
X-Api-Key: <SERVICE_API_KEY>
```

Set `SERVICE_API_KEY` (min 16 chars) in the agent service's environment. Without it, every `/internal`
route returns `503`. A missing or wrong key returns `401` (compared in constant time).

The `{userId}` in each path is the same id the JWT carries in its `sub` claim.

---

## 1. List a user's conversations

| | |
| --- | --- |
| **Method & path** | `GET {base}/internal/users/{userId}/conversations?limit=20&cursor=<updated_at>` |
| **Query** | `limit` (1–50, default 20); `cursor` — pass back the previous page's `next_cursor` |
| **Sends back** | newest-first page (below) |

```json
{
  "conversations": [
    { "conversation_id": "ab12cd34", "title": "How did my SIP do?", "preview": "Your SIP is up 12%…", "updated_at": "2026-10-20T09:00:04Z" }
  ],
  "next_cursor": null
}
```

`next_cursor` is the `updated_at` to send as `cursor` for the next page, or `null` when there are no more.

## 2. Get one conversation

| | |
| --- | --- |
| **Method & path** | `GET {base}/internal/users/{userId}/conversations/{conversationId}` |
| **Sends back** | the conversation (below) |

```json
{
  "conversation_id": "ab12cd34",
  "messages": [
    { "role": "user", "text": "How did my SIP do?", "at": "2026-10-20T09:00:01Z" },
    { "role": "assistant", "text": "Your SIP is up 12%…", "charts": [ … ], "at": "2026-10-20T09:00:04Z" }
  ],
  "created_at": "2026-10-20T09:00:01Z",
  "updated_at": "2026-10-20T09:00:04Z"
}
```

`charts` is present only on assistant messages that produced one. Returns `404` if the conversation does
not exist **or** belongs to a different user (we don't reveal which). `conversationId` matches
`^[A-Za-z0-9_-]{8,64}$`.

## 3. Get a user's token usage

| | |
| --- | --- |
| **Method & path** | `GET {base}/internal/users/{userId}/usage` |
| **Sends back** | the usage object (below) |

```json
{
  "user_id": "12345",
  "unit": "tokens",
  "used": 18450,
  "limit": 50000,
  "remaining": 31550,
  "blocked": false,
  "reset_at": "2026-10-22T00:00:00Z",
  "lifetime_tokens": 2450300,
  "messages": 1840
}
```

- `used` / `remaining` / `reset_at` describe the current window (`USAGE_WINDOW_HOURS`).
- `limit` is `USAGE_LIMIT_TOKENS` (0 = no limit); `remaining` is `null` when there is no limit.
- `blocked` is `true` only when a limit is set and spent — the chat API then refuses to answer until `reset_at`.
- `lifetime_tokens` / `messages` are all-time totals.

---

## Errors & conventions

| Status | When |
| --- | --- |
| `401` | missing / wrong `X-Api-Key` |
| `404` | conversation not found / not owned by `userId` |
| `422` | malformed `userId` or `conversationId` |
| `503` | `SERVICE_API_KEY` not configured |

Timestamps are ISO 8601 UTC.
