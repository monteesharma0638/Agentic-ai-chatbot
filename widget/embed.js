/**
 * Drop-in embed for any website (Laravel Blade, WordPress, plain HTML, …). One tag in the shared
 * header or footer puts the chat on every page (see docs/embed-any-website.md):
 *
 *   <script src="https://mcp-server-ten-eta.vercel.app/embed.js" data-token="…" defer></script>
 *
 * The conversation, and whether the chat is open, carry over as visitors move between pages,
 * including on sites that swap <body> instead of reloading (Turbo, Livewire wire:navigate, pjax).
 *
 * The floating button is an orb at the bottom centre of the page. When the page has the app's left
 * sidebar (.rr-sidebar), the orb and the chat centre on the content beside it instead of the window.
 *
 * Attributes (all optional):
 *   data-token        Signed user token (see laravel-embed/README.md). Omit for guest mode.
 *   data-mode         "floating" (default) or "inline"
 *   data-target       CSS selector of the container for inline mode
 *   data-title / data-subtitle
 *   data-launcher-text Tooltip and label of the orb (default "Ask <assistant name>")
 *   data-teaser       "false" to skip the one-time hello bubble above the orb
 *   data-onboarding   "false" to skip the quick questions asked before the first chat
 *   data-voice        "false" to turn off speaking questions and hearing replies (on by default where supported)
 *   data-voice-lang   Speech language for dictation and spoken replies (default "en-IN")
 *   data-attachments  "false" to turn off attaching images / PDFs (on by default)
 *   data-accent       Focus-ring colour, e.g. "#7c5cff"
 *   data-theme        "light" | "dark" | "auto" (follows the OS). Default: light while the page's <body> has
 *                     the class "light-theme" (the app's theme toggle), dark otherwise.
 *   data-offset-x     Shift the orb and chat from the window centre, in px (e.g. "40"); overrides the sidebar check
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

/**
 * Fonts declared inside a Shadow DOM aren't loaded, so the widget's typeface is requested from the page
 * (skipped when the page already loads it, as the app does).
 */
function loadFont() {
  if (document.querySelector('link[href*="Plus+Jakarta+Sans"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';
  document.head.append(link);
}

/**
 * Calls `fn` now, whenever <body>'s classes change, and when the site swaps <body> during navigation
 * (Turbo, Livewire wire:navigate, pjax, …).
 */
function watchBody(fn) {
  let body = null;
  const classes = new MutationObserver(fn);
  const bind = () => {
    if (!document.body || body === document.body) return;
    body = document.body;
    classes.disconnect();
    classes.observe(body, { attributes: true, attributeFilter: ['class'] });
    fn();
  };
  new MutationObserver(bind).observe(document.documentElement, { childList: true });
  bind();
}

/** Half the width of the app's fixed left sidebar, so the orb sits in the middle of the content beside it. */
function sidebarOffset() {
  const rect = document.querySelector('.rr-sidebar')?.getBoundingClientRect();
  return rect && rect.left <= 0 && rect.right > 0 && rect.right < window.innerWidth / 2 ? rect.right / 2 : 0;
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
  loadFont();

  const accent = opt('accent');
  if (accent) root.style.setProperty('--mfc-accent', accent);
  const theme = opt('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'auto') root.dataset.theme = theme;
  else watchBody(() => (root.dataset.theme = document.body.classList.contains('light-theme') ? 'light' : 'dark'));

  if (mode === 'floating') {
    const fixed = opt('offsetX');
    const place = () => root.style.setProperty('--mfc-offset-x', `${Number(fixed ?? sidebarOffset()) || 0}px`);
    place();
    if (fixed === undefined) {
      let frame = 0;
      window.addEventListener('resize', () => (frame ||= requestAnimationFrame(() => ((frame = 0), place()))));
      // The sidebar may be added with the rest of a swapped <body>.
      watchBody(place);
    }
  }

  const claims = token ? tokenClaims(token) : { uid: 'guest', name: '' };
  const flag = (key) => opt(key) !== false && opt(key) !== 'false';
  instance = mountMfChat(root, {
    mode,
    ...(opt('title') && { title: opt('title') }),
    ...(opt('subtitle') && { subtitle: opt('subtitle') }),
    ...(opt('launcherText') && { launcherText: opt('launcherText') }),
    teaser: flag('teaser'),
    onboarding: flag('onboarding'),
    voice: flag('voice'),
    attachments: flag('attachments'),
    ...(opt('voiceLang') && { voiceLang: opt('voiceLang') }),
    userName: claims.name,
    signedIn: Boolean(token),
    getContext: () => context,
    storageKey: `mf-chat:conversation:${claims.uid}`,
    profileKey: `mf-chat:profile:${claims.uid}`,
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
