# Adding the assistant to your Laravel app

No controllers, routes, packages or PHP classes are needed. The Node.js service does
all the work; Laravel only prints a `<script>` tag.

## 1. Add two lines to `.env`

```env
MF_CHAT_URL=http://127.0.0.1:3000          # where agent-service runs (https://chat.yourdomain.com in production)
MF_CHAT_SECRET=paste-the-same-value-as-WIDGET_TOKEN_SECRET
```

`MF_CHAT_SECRET` must be identical to `WIDGET_TOKEN_SECRET` in `agent-service/.env`.

## 2. Register them in `config/services.php`

Add this entry inside the returned array (next to `mailgun`, `ses`, …):

```php
'mf_chat' => [
    'url' => env('MF_CHAT_URL'),
    'secret' => env('MF_CHAT_SECRET'),
],
```

Then run `php artisan config:clear` (or `config:cache` in production).

## 3. Add the snippet

Copy [`mf-chat.blade.php`](mf-chat.blade.php) to `resources/views/partials/mf-chat.blade.php`
and include it once in your main layout, just before `</body>`:

```blade
@include('partials.mf-chat')
```

A chat button appears in the bottom-right corner on every page.

## 4. Allow your site in the Node service

In `agent-service/.env`, list the URL(s) your Laravel app is served from:

```env
ALLOWED_ORIGINS=http://127.0.0.1:8000,https://app.yourdomain.com
```

## Optional

**Fund detail pages.** Let users ask about "this fund":

```blade
@include('partials.mf-chat', ['mfChatSchemeCode' => $fund->scheme_code, 'mfChatSchemeName' => $fund->name])
```

Or from JavaScript, e.g. in a single-page flow:

```html
<script>MfChat.setContext({ scheme_code: 122639, scheme_name: 'Parag Parikh Flexi Cap Fund' })</script>
```

**Open the chat from your own button:**

```html
<button onclick="MfChat.open()">Ask our assistant</button>
<button onclick="MfChat.ask('Compare the top 3 large cap funds')">Compare large caps</button>
```

**Embed inline instead of floating** (on a page that doesn't also include the partial via the layout):

```blade
<div id="fund-chat" style="height: 600px"></div>
@include('partials.mf-chat', ['mfChatMode' => 'inline', 'mfChatTarget' => '#fund-chat'])
```

**Branding:** add `data-accent="#4f46e5"` and/or `data-theme="light"` to the script tag.

**Button wording and first-visit hello:** the floating button reads "Ask about funds", and new
visitors see a short hello bubble above it once. Change the wording with
`data-launcher-text="Need help?"`, or turn the hello off with `data-teaser="false"`.
The greeting uses the logged-in user's first name from the token, and the assistant's name
comes from `ASSISTANT_NAME` in `agent-service/.env`.

**Guests:** logged-out visitors get no token. They can chat only if `ALLOW_ANONYMOUS=true`
in `agent-service/.env`; otherwise the widget asks them to sign in.

**"My portfolio" questions:** these are answered by the Node service reading your database
directly (read-only). See `PORTFOLIO_*` in the main README. The snippet itself never
sends holdings.

**Content-Security-Policy:** if your app sends a CSP header, allow the chat origin in
`script-src` and `connect-src`.
