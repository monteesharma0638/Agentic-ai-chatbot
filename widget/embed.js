/**
 * Drop-in embed for any website (Laravel Blade, WordPress, plain HTML, …). One tag in the shared
 * header or footer puts the chat on every page (see docs/embed-any-website.md):
 *
 *   <script src="https://chat.example.com/embed.js" data-token="…" defer></script>
 *
 * The conversation, and whether the chat is open, carry over as visitors move between pages,
 * including on sites that swap <body> instead of reloading (Turbo, Livewire wire:navigate, pjax).
 *
 * Attributes (all optional):
 *   data-token        Signed user token (see laravel-embed/README.md). Omit for guest mode.
 *   data-mode         "floating" (default) or "inline"
 *   data-target       CSS selector of the container for inline mode
 *   data-title / data-subtitle
 *   data-launcher-text Words on the floating button (default "Ask about funds")
 *   data-teaser       "false" to skip the one-time hello bubble above the button
 *   data-accent       Brand colour, e.g. "#4f46e5"
 *   data-theme        "light" | "dark" (default: follows the OS)
 *   data-scheme-code  AMFI scheme code of the fund page being viewed ("this fund")
 *   data-scheme-name
 *   data-open         Open the chat panel on load
 *   data-manual       Don't auto-start; call window.MfChat.init({...}) yourself
 *
 * JavaScript API: MfChat.open(), .close(), .ask(text), .setContext({scheme_code, scheme_name}), .reset()
 *
 * The UI renders inside a Shadow DOM, so the host page's CSS (Tailwind,
 * Bootstrap, …) cannot break it and its CSS cannot leak into the page.
 */
import css from './mf-chat.css';
import { mountMfChat } from './mf-chat.js';

const script = document.currentScript;

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Stable anonymous id for guest mode (per browser). */
function visitorId() {
  try {
    let id = localStorage.getItem('mf-chat:visitor');
    if (!id) {
      id = randomId();
      localStorage.setItem('mf-chat:visitor', id);
    }
    return id;
  } catch {
    visitorId.fallback ??= randomId();
    return visitorId.fallback;
  }
}

/**
 * Reads the user id and first name from the token payload, only to namespace local storage and
 * greet the user by name; the server verifies the token itself.
 */
function tokenClaims(token) {
  try {
    const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const { uid, name } = JSON.parse(new TextDecoder().decode(bytes));
    const first = typeof name === 'string' ? name.trim().split(/\s+/)[0] : '';
    return { uid: uid ?? 'user', name: first ? first[0].toUpperCase() + first.slice(1) : '' };
  } catch {
    return { uid: 'user', name: '' };
  }
}

/**
 * Puts the floating widget back when the site replaces <body> or its children during navigation
 * (Turbo, Livewire wire:navigate, pjax, …). Moving the host keeps the Shadow DOM, so an open chat
 * and a streaming answer continue on the new page.
 */
function keepAttached(host) {
  let body = null;
  const observer = new MutationObserver(reattach);
  function reattach() {
    if (!document.body) return;
    if (!host.isConnected) document.body.append(host);
    if (body !== document.body) {
      body = document.body;
      observer.disconnect();
      observer.observe(document.documentElement, { childList: true });
      observer.observe(body, { childList: true });
    }
  }
  reattach();
}

let instance = null;
/** Context set via MfChat.setContext() before the widget finished loading. */
let pendingContext;

function init(options = {}) {
  if (instance) return window.MfChat;
  const d = script?.dataset ?? {};
  const opt = (key) => options[key] ?? d[key];

  const apiBase = String(opt('apiBase') ?? (script?.src ? new URL(script.src).origin : location.origin)).replace(/\/$/, '');
  const token = opt('token') || '';
  const mode = opt('mode') === 'inline' ? 'inline' : 'floating';
  let context =
    options.context ??
    pendingContext ??
    (d.schemeCode ? { page: 'fund-detail', scheme_code: Number(d.schemeCode), ...(d.schemeName && { scheme_name: d.schemeName }) } : null);

  let host;
  if (mode === 'inline') {
    const target = opt('target');
    host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error(`MfChat: inline target "${target}" not found`);
  } else {
    host = document.createElement('div');
    host.id = 'mf-chat-host';
    // Page rules can still reach the host element itself (`body > div { transform: … }` would trap the
    // fixed panel, `div:empty { display: none }` would hide it); inline !important beats them.
    host.style.setProperty('all', 'initial', 'important');
    document.body.append(host);
    keepAttached(host);
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  shadow.append(style, root);

  const accent = opt('accent');
  if (accent) {
    root.style.setProperty('--mfc-accent', accent);
    root.style.setProperty('--mfc-user-bg', accent);
  }
  const theme = opt('theme');
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;

  const claims = token ? tokenClaims(token) : { uid: 'guest', name: '' };
  const teaser = opt('teaser');
  instance = mountMfChat(root, {
    mode,
    ...(opt('title') && { title: opt('title') }),
    ...(opt('subtitle') && { subtitle: opt('subtitle') }),
    ...(opt('launcherText') && { launcherText: opt('launcherText') }),
    teaser: teaser !== false && teaser !== 'false',
    userName: claims.name,
    signedIn: Boolean(token),
    getContext: () => context,
    storageKey: `mf-chat:conversation:${claims.uid}`,
    configUrl: `${apiBase}/api/widget/config`,
    streamUrl: `${apiBase}/api/chat/stream`,
    historyUrl: `${apiBase}/api/conversations/{id}`,
    resetUrl: `${apiBase}/api/conversations/{id}`,
    credentials: 'omit',
    headers: () => (token ? { Authorization: `Bearer ${token}` } : { 'X-Visitor-Id': visitorId() }),
    body: () => (context ? { context } : {}),
  });

  if (opt('open') !== undefined && opt('open') !== 'false') instance.open();

  Object.assign(window.MfChat, {
    setContext(next) {
      context = next ?? null;
      instance.refreshWelcome();
    },
  });
  return window.MfChat;
}

// Already loaded: the tag is on the page twice, or the site re-ran it after swapping <body>
// (Turbo, Livewire). Keep the first instance, which keepAttached() carries over.
if (!window.MfChat?.init) {
  window.MfChat = {
    init,
    open: () => instance?.open(),
    close: () => instance?.close(),
    reset: () => instance?.reset(),
    ask: (text) => {
      instance?.open();
      return instance?.send(text);
    },
    setContext: (next) => {
      pendingContext = next ?? null;
    },
  };

  if (script && !('manual' in script.dataset)) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
    else init();
  }
}
