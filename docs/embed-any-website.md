# Adding the chat to any website

One `<script>` tag in the header or footer that every page shares puts the chat button on the
whole site. It works on plain HTML, WordPress, Shopify, Google Tag Manager and Laravel.
For a Laravel app with logged-in users, use [`laravel-embed/`](../laravel-embed/README.md)
instead: it prints this same tag and adds the user's sign-in token.

## 1. Paste the tag once

```html
<script src="https://chat.yourdomain.com/embed.js" defer></script>
```

Replace `https://chat.yourdomain.com` with wherever agent-service runs (your Vercel URL or VPS domain).

Put it inside `<head>` or just before `</body>` in the template every page uses. Either works:
`defer` keeps it from slowing the page down, and the button appears once the page has loaded.

| Site | Where to paste it |
| --- | --- |
| Plain HTML / any templating | The shared header or footer include |
| WordPress | A "header and footer code" plugin (footer section), or `footer.php` of a child theme before `</body>` |
| Shopify | Online Store → Themes → Edit code → `layout/theme.liquid`, before `</body>` |
| Google Tag Manager | New tag → Custom HTML → paste the tag → trigger **All Pages** |

### Inside the page instead of floating

[`html-embed/chat-inline.html`](../html-embed/chat-inline.html) is the dashboard's "Ask AI" card with the
same HTML (input box included), made to work: answers stream into the card, with charts, and it scrolls with
the page instead of staying fixed to the window. Paste it in place of that card. It uses the site's
`css/style.css` for its look and talks to the chat server directly, without `embed.js`. The floating tag above
is kept as [`html-embed/chat-floating.html`](../html-embed/chat-floating.html); both can be on the same page
and continue the same conversation.

## 2. Allow the website on the server

In `agent-service/.env` (or Vercel → Settings → Environment Variables):

```env
ALLOWED_ORIGINS=https://yourwebsite.com,https://www.yourwebsite.com
ALLOW_ANONYMOUS=true
```

- `ALLOWED_ORIGINS`: every address the site is served from, exactly as in the browser's address bar,
  no trailing slash. `www` and non-`www` count as different sites, and so does each subdomain.
- `ALLOW_ANONYMOUS=true` lets visitors chat without logging in. Without it, visitors with no
  token see "Please log in to chat with the assistant."

Restart the service (VPS) or redeploy (Vercel) after changing these.

## How it behaves across the site

- The chat opens from an orb at the bottom centre of every page. On pages with the app's left sidebar
  (`.rr-sidebar`), the orb and the chat centre on the content beside it.
- The first time someone opens it, the assistant asks five quick questions (age, experience, goal, when
  they need the money, how they'd feel about a 20% fall) so its answers fit them. They can skip, and change
  their answers later from the greeting. The answers stay in that browser and go with each message.
- The chat is dark by default and turns light while the page's `<body>` has the class `light-theme`
  (the app's theme toggle), switching as soon as the visitor toggles.
- A conversation continues as the visitor moves between pages. Signed-in chats are stored in MongoDB and
  can be reloaded later; the browser only remembers which conversation to resume.
- If the visitor leaves the chat open and clicks to another page, it is still open there
  (same browser tab only).
- It keeps working on sites that change pages without a full reload: Turbo, Livewire
  `wire:navigate`, pjax, and React or Vue apps.
- It draws inside its own Shadow DOM, so the site's CSS can't break it and its CSS can't leak out.
- Including the tag twice on a page is harmless; the second copy is ignored.

## Options

Add any of these attributes to the tag:

```html
<script src="https://chat.yourdomain.com/embed.js"
        data-launcher-text="Need help?"
        data-onboarding="false"
        defer></script>
```

| Attribute | What it does |
| --- | --- |
| `data-accent` | Colour of the keyboard focus ring, e.g. `#7c5cff` |
| `data-theme` | `light`, `dark`, or `auto` (follows the visitor's device). Default: follows the page's `light-theme` class, dark otherwise |
| `data-title` | Name in the chat header (default: `ASSISTANT_NAME`) |
| `data-launcher-text` | Tooltip and label of the orb (default "Ask" + `ASSISTANT_NAME`) |
| `data-teaser="false"` | Turn off the one-time hello bubble above the orb |
| `data-onboarding="false"` | Skip the quick questions before the first chat |
| `data-voice="false"` | Turn off speaking questions (mic) and hearing replies. On by default where the browser supports it |
| `data-voice-lang` | Speech language for dictation and spoken replies (default `en-IN`) |
| `data-attachments="false"` | Turn off attaching images / PDFs to a message |
| `data-offset-x` | Move the orb and chat sideways from the window centre, in px (e.g. `40`); overrides the sidebar check |
| `data-open` | Open the chat when the page loads |
| `data-scheme-code` / `data-scheme-name` | On a fund's page, so visitors can ask about "this fund" |
| `data-token` | Signed-in user token (next section) |

From your own JavaScript: `MfChat.open()`, `MfChat.close()`, `MfChat.ask('Compare large cap funds')`,
`MfChat.setContext({ scheme_code: 122639, scheme_name: 'Parag Parikh Flexi Cap Fund' })`.

## Logged-in users on a site that isn't Laravel

"My portfolio" questions and greeting people by name need a token that proves who is logged in.
The token is a **standard JSON Web Token (JWT), HS256**:
`base64url(header).base64url(payload).base64url(signature)`, with the user id in the `sub` claim.
Mint it **on your server** for each page view, signed with the same value as `WIDGET_TOKEN_SECRET`,
then hand that string to the widget. In Node.js:

```js
import { createHmac } from 'node:crypto';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const header = b64({ alg: 'HS256', typ: 'JWT' });
const payload = b64({
  sub: String(user.id),        // the id every chat + usage row is stored under
  name: user.firstName,        // optional — only used to greet them
  exp: Math.floor(Date.now() / 1000) + 12 * 3600,
});
const data = `${header}.${payload}`;
const signature = createHmac('sha256', process.env.WIDGET_TOKEN_SECRET).update(data).digest('base64url');
const token = `${data}.${signature}`;
```

### Passing the token to the widget

Use whichever embed you have — pass the `token` string from above:

- **Floating script tag:** add `data-token="<token>"` to the `embed.js` tag, or call
  `MfChat.init({ token: '<token>' })` from your own JavaScript.
- **Inline page** ([`html-embed/chat-inline.html`](../html-embed/chat-inline.html)): add
  `data-token="<token>"` to its `<script data-api="…">` tag — your server renders the token into that
  attribute (omit it for guests).

### What is and isn't secret

- The **token** is a bearer credential meant to live in the browser — putting it in `data-token` (or the
  inline page's `TOKEN`) is exactly its job. It is per-user and short-lived (set `exp`).
- The widget base64-decodes only the middle (payload) segment, to read the public `sub`/`name` claims so it
  can greet the user and keep each person's saved conversation separate. It does **not** verify the token and
  **never sees the signing secret** — the secret is not part of the token, only a signature computed from it is.
- Your **`WIDGET_TOKEN_SECRET`** signs and verifies tokens. Keep it only on your servers — never in `embed.js`,
  the inline HTML, a `data-` attribute, or any other file sent to the browser.
- The agent-service re-verifies every token server-side (signature, HS256, expiry) and trusts only the `sub`
  it recovers there, so a token edited in the browser is rejected no matter what the page displayed.
- Never let a page cache or CDN store pages that contain a token: every visitor would get the same person's
  identity. Logged-out visitors get no token and chat as guests.

### A quick token for testing

To try signed-in mode without wiring up your signing server, mint a demo token with the shared secret:

- From the repo root (after `npm run build`):
  `npm run -s token -w agent-service -- demo-user "Asha"` prints a JWT (valid 1 hour) for user id
  `demo-user`. Paste it as `data-token`.
- Or, with the playground enabled, open `/playground` (it signs test tokens for any id), or fetch
  `GET /dev/token?uid=demo-user` from the running service.

## If it doesn't work

Open the browser's developer console (F12) on your site:

| You see | Fix |
| --- | --- |
| "blocked by CORS policy", or `403` on `/api/...` | Add the site's exact address to `ALLOWED_ORIGINS` |
| "Please log in to chat" in the chat | Set `ALLOW_ANONYMOUS=true`, or pass a `data-token` |
| "violates the following Content Security Policy" | Add the chat address to the site's `script-src` and `connect-src` |
| No button, and the site uses Cloudflare Rocket Loader | Add `data-cfasync="false"` to the tag so Rocket Loader leaves it alone |

`https://chat.yourdomain.com/health` should say `"status":"ok"`.
