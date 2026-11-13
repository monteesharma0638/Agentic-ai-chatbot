# Chat storage API (Laravel)

Endpoints the Laravel server provides so the widget can **store and retrieve chats**. Called by the
browser widget directly, authenticated by a JWT sent on every request.

`{base}` = your Laravel app, e.g. `https://app.yourdomain.com`.

## Auth

Every request must carry a **JWT** in the `Authorization` header; the API validates it on each request
and rejects anything missing, invalid or expired with `401`.

```
Authorization: Bearer <jwt>
```

The token is signed (HS256) with your shared secret. The user id comes from its `sub` claim and must
match the `userId` in the path, or the API returns `403`. `exp` (Unix seconds) sets expiry — an expired
token is `401`. `conversationId` matches `^[A-Za-z0-9_-]{8,64}$`; it is minted by `agent-service` and
returned in its `done` event.

---

## 1. Save messages — after each reply

The widget sends the user message and the assistant reply together.

| | |
| --- | --- |
| **Method & path** | `POST {base}/api/chat/{userId}/conversations/{conversationId}/messages` |
| **Takes** | path `userId`, `conversationId`; JSON body (below) |
| **Sends back** | `{ "ok": true, "conversation_id": "ab12cd34", "saved": 2, "updated_at": "2026-10-20T09:00:04Z" }` |

**Request body:**

```json
{
  "messages": [
    { "role": "user", "text": "How did my SIP do?", "at": "2026-10-20T09:00:01Z" },
    { "role": "assistant", "text": "Your SIP is up 12%…",
      "charts": [ { "kind": "line", "title": "SIP growth", "series": [ … ] } ],
      "at": "2026-10-20T09:00:04Z", "client_id": "a1b2c3" }
  ]
}
```

- `charts` is opaque — store and return it verbatim.
- `client_id` is optional; skip a message whose `client_id` was already saved (idempotent retries).

## 2. Get a conversation — on page load

| | |
| --- | --- |
| **Method & path** | `GET {base}/api/chat/{userId}/conversations/{conversationId}` |
| **Takes** | path `userId`, `conversationId` |
| **Sends back** | the conversation (below) |

```json
{
  "conversation_id": "ab12cd34",
  "messages": [
    { "role": "user", "text": "How did my SIP do?", "charts": null, "at": "2026-10-20T09:00:01Z" },
    { "role": "assistant", "text": "Your SIP is up 12%…", "charts": [ … ], "at": "2026-10-20T09:00:04Z" }
  ],
  "updated_at": "2026-10-20T09:00:04Z"
}
```

Return `404` if the conversation does not exist **or** is not owned by `userId` (don't reveal which).

## 3. List conversations — optional (history panel)

| | |
| --- | --- |
| **Method & path** | `GET {base}/api/chat/{userId}/conversations?limit=20&cursor=<opaque>` |
| **Takes** | path `userId`; query `limit`, `cursor` |
| **Sends back** | conversations + `next_cursor` (below) |

```json
{
  "conversations": [
    { "conversation_id": "ab12cd34", "title": "SIP returns", "preview": "Your SIP is up 12%…", "updated_at": "2026-10-20T09:00:04Z" }
  ],
  "next_cursor": null
}
```

## 4. Delete a conversation — the widget's "New chat"

| | |
| --- | --- |
| **Method & path** | `DELETE {base}/api/chat/{userId}/conversations/{conversationId}` |
| **Takes** | path `userId`, `conversationId` |
| **Sends back** | `204`, no body |

---

## Conventions

**Error envelope** — every error is:

```json
{ "error": "not_found", "message": "…" }
```

| Status | When |
| --- | --- |
| `401` | missing / invalid / expired token |
| `403` | path `userId` ≠ the token's `sub` |
| `404` | conversation not found / not owned |
| `422` | malformed body |
| `429` | rate-limited |

**CORS** — allow your site's origin(s), headers `Authorization, Content-Type`, methods
`GET, POST, DELETE, OPTIONS`.

**Timestamps** — ISO 8601 UTC everywhere.
