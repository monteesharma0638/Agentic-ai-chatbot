/**
 * Drop-in embed for any website (Laravel Blade, plain HTML, …):
 *
 *   <script src="https://chat.example.com/embed.js" data-token="…" defer></script>
 *
 * Attributes (all optional):
 *   data-token        Signed user token (see laravel-embed/README.md). Omit for guest mode.
 *   data-mode         "floating" (default) or "inline"
 *   data-target       CSS selector of the container for inline mode
 *   data-title / data-subtitle
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

/** Reads the user id from the token payload (only to namespace local storage; the server verifies it). */
function tokenUserId(token) {
  try {
    const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).uid ?? 'user';
  } catch {
    return 'user';
  }
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
    document.body.append(host);
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

  const userKey = token ? tokenUserId(token) : 'guest';
  instance = mountMfChat(root, {
    mode,
    ...(opt('title') && { title: opt('title') }),
    ...(opt('subtitle') && { subtitle: opt('subtitle') }),
    storageKey: `mf-chat:conversation:${userKey}`,
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
    },
  });
  return window.MfChat;
}

if (window.MfChat?.init) {
  // Script included twice on the same page; keep the first instance.
  console.warn('MfChat: embed.js loaded more than once; ignoring the duplicate.');
} else {
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
