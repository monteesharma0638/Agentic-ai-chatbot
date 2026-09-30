/**
 * MF Chat widget core — framework-free chat UI for the mutual fund assistant.
 *
 * Streams replies over SSE (POST + fetch streaming), renders markdown safely,
 * shows live tool activity and draws NAV / SIP charts. Bundled into
 * embed.js by build.mjs; see embed.js for the script-tag integration.
 *
 * Written for everyday investors rather than experts: the assistant greets
 * first, offers questions to tap, says what it is doing while it works, and
 * every error comes with a way forward.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';

// Register only what line charts need, keeping the bundle small.
Chart.register(LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend);

const GENERAL_SUGGESTIONS = [
  'What is a SIP, and how does it work?',
  'If I had started a ₹5,000 monthly SIP in HDFC Mid Cap in 2020, what would it be worth today?',
  'Which small cap funds did best in the last 3 years?',
  'How much could ₹1 lakh grow to in 10 years in a Nifty 50 index fund?',
];
const PORTFOLIO_SUGGESTION = 'How are my investments doing?';
const FUND_PAGE_SUGGESTIONS = [
  'How has this fund done over the last 5 years?',
  'What if I had started a ₹5,000 monthly SIP in this fund 3 years ago?',
  'How risky is this fund? Please explain simply.',
  'What is NAV, in simple words?',
];

const ERRORS = {
  401: 'Your session has timed out. Refresh the page to keep chatting.',
  403: 'The assistant is not available for your account.',
  429: "That's a lot of questions at once. Wait a few seconds, then tap Try again.",
  network: "Couldn't connect. Check your internet connection, then tap Try again.",
  generic: "The answer didn't come through this time. Tap Try again.",
};
/** Errors that retrying the same message won't fix. */
const FINAL_ERRORS = new Set(['blocked', 'auth_required', 'message_too_long', 'invalid_request', 'origin_not_allowed']);
const SLOW_AFTER_MS = 10_000;

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Renders markdown into a bubble; a closing italic-only paragraph (the risk line) is shown as a quiet note.
 * Answers never send people to other websites: links and images are dropped (their text is kept).
 */
function renderInto(bubble, text) {
  bubble.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), { FORBID_TAGS: ['a', 'img'] });
  const last = bubble.lastElementChild;
  if (last?.tagName === 'P' && last.childNodes.length === 1 && last.firstChild.nodeName === 'EM') {
    last.classList.add('mfc-note');
  }
}

const dateOf = (iso) => new Date(`${iso}T00:00:00Z`);
/** 2020-03-23 → 23 Mar 2020 */
const longDate = (iso) =>
  dateOf(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** 2020-03-23 → Mar 2020 */
const monthYear = (iso) => dateOf(iso).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** ₹84,862 / ₹2.38 lakh / ₹1.2 crore, the way amounts are said in India. */
function rupeesText(v) {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${+(v / 1e7).toFixed(2)} crore`;
  if (a >= 1e5) return `₹${+(v / 1e5).toFixed(2)} lakh`;
  return `₹${inr.format(Math.round(v))}`;
}

/** Axis labels in lakh / crore, the way Indian investors read amounts. */
function compactInr(v) {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${+(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${+(v / 1e5).toFixed(2)} L`;
  return `₹${inr.format(v)}`;
}

function greeting(name) {
  const h = new Date().getHours();
  const part = h >= 4 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : h >= 17 ? 'Good evening' : 'Hello';
  return name ? `${part}, ${name}!` : `${part}!`;
}

/** Parses a fetch() SSE body into {event, data} objects. */
async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

const ICONS = {
  // The assistant's face: a sprout, for money that grows over time.
  sprout:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M12 13c0-3.9-2.9-6.5-7-6.5 0 3.9 2.9 6.5 7 6.5z" fill="currentColor"/><path d="M12 11.5c0-3.6 2.6-6.5 7-6.5 0 3.9-2.9 6.5-7 6.5z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15V6a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  share:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

function avatar(extra = '') {
  const node = el('span', `mfc-avatar ${extra}`.trim());
  node.innerHTML = ICONS.sprout;
  return node;
}

/**
 * @param {HTMLElement} root
 * @param {object} opts
 * @param {string} opts.streamUrl         POST endpoint returning text/event-stream
 * @param {string} [opts.historyUrl]      GET template with {id}, returns {messages:[...]}
 * @param {string} [opts.resetUrl]        DELETE template with {id}
 * @param {string} [opts.configUrl]       GET endpoint returning {assistant_name, portfolio}
 * @param {object|Function} [opts.headers] Extra request headers (e.g. CSRF token)
 * @param {Function} [opts.body]          Returns extra JSON fields merged into each request
 * @param {Function} [opts.getContext]    Returns the page context ({scheme_code}) for "this fund" suggestions
 * @param {'floating'|'inline'} [opts.mode]
 * @param {string} [opts.storageKey]      localStorage key for the conversation id
 * @param {string} [opts.userName]        First name, used in the greeting
 * @param {boolean} [opts.signedIn]       Offer "my investments" questions
 * @param {boolean} [opts.teaser]         Show a one-time hello above the launcher (floating mode)
 */
export function mountMfChat(root, opts) {
  const o = {
    mode: 'floating',
    subtitle: 'Answers in simple words',
    placeholder: 'Type your question…',
    launcherText: 'Ask about funds',
    disclaimer:
      'Information only, not investment advice. Mutual fund investments are subject to market risks, read all scheme related documents carefully.',
    storageKey: 'mf-chat:conversation',
    credentials: 'same-origin',
    teaser: true,
    ...opts,
  };
  if (!o.streamUrl) throw new Error('mountMfChat: streamUrl is required');

  const storage = (key) => ({
    get: () => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (v) => {
      try {
        v ? localStorage.setItem(key, v) : localStorage.removeItem(key);
      } catch {
        /* storage unavailable */
      }
    },
  });
  const store = storage(o.storageKey);
  const teaserSeen = storage('mf-chat:teaser-seen');

  let conversationId = store.get();
  let controller = null;
  const charts = [];
  const features = { assistantName: '', portfolio: false };
  // Touch devices: don't pop the keyboard up over an answer the person is about to read.
  const finePointer = window.matchMedia?.('(pointer: fine)').matches ?? true;

  // ---------- DOM ----------
  root.classList.add('mfc-root', `mfc-${o.mode}`);
  root.innerHTML = '';

  const launcher = el('button', 'mfc-launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-expanded', 'false');
  const launcherClose = el('span', 'mfc-launcher-close');
  launcherClose.innerHTML = ICONS.close;
  launcher.append(avatar(), el('span', 'mfc-launcher-text', o.launcherText), launcherClose);

  const panel = el('section', 'mfc-panel');

  const header = el('header', 'mfc-header');
  const heading = el('div', 'mfc-heading');
  const titleEl = el('strong', 'mfc-title', o.title ?? '');
  const subtitleEl = el('span', 'mfc-subtitle');
  subtitleEl.append(el('i', 'mfc-online'), document.createTextNode(o.subtitle));
  heading.append(titleEl, subtitleEl);
  const resetBtn = el('button', 'mfc-text-btn mfc-new');
  resetBtn.type = 'button';
  resetBtn.innerHTML = ICONS.plus;
  resetBtn.append('New chat');
  const closeBtn = el('button', 'mfc-icon-btn mfc-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close chat');
  closeBtn.innerHTML = ICONS.close;
  header.append(avatar('mfc-avatar-lg'), heading, resetBtn, closeBtn);

  const log = el('div', 'mfc-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  // The assistant speaks first: a greeting and a few questions to tap.
  const welcome = el('div', 'mfc-msg mfc-assistant mfc-welcome');

  const form = el('form', 'mfc-composer');
  const input = el('textarea', 'mfc-input');
  input.rows = 1;
  input.placeholder = o.placeholder;
  input.maxLength = 2000;
  input.setAttribute('aria-label', 'Your question');
  input.setAttribute('enterkeyhint', 'send');
  const sendBtn = el('button', 'mfc-send');
  form.append(input, sendBtn);

  const footer = el('p', 'mfc-disclaimer', o.disclaimer);
  panel.append(header, log, form, footer);
  root.append(panel);
  if (o.mode === 'floating') root.append(launcher);

  const syncTitle = () => {
    const title = o.title || features.assistantName || 'Fund Assistant';
    titleEl.textContent = title;
    panel.setAttribute('aria-label', title);
  };
  // Without an explicit title, wait for the assistant's name rather than flashing a placeholder.
  if (o.title) syncTitle();

  // ---------- helpers ----------
  const scrollToEnd = () => {
    log.scrollTop = log.scrollHeight;
  };
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;

  const syncSend = () => {
    const busy = Boolean(controller);
    sendBtn.innerHTML = busy ? ICONS.stop : ICONS.send;
    sendBtn.setAttribute('aria-label', busy ? 'Stop answering' : 'Send');
    sendBtn.type = busy ? 'button' : 'submit';
    sendBtn.disabled = !busy && !input.value.trim();
  };
  const setBusy = (busy) => {
    root.classList.toggle('mfc-busy', busy);
    syncSend();
  };

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };

  function suggestions() {
    if (o.suggestions) return o.suggestions;
    if (o.getContext?.()?.scheme_code) return FUND_PAGE_SUGGESTIONS;
    return o.signedIn && features.portfolio ? [PORTFOLIO_SUGGESTION, ...GENERAL_SUGGESTIONS.slice(0, 3)] : GENERAL_SUGGESTIONS;
  }

  function renderWelcome() {
    const body = el('div', 'mfc-body');
    const bubble = el('div', 'mfc-bubble');
    const name = features.assistantName;
    bubble.append(
      el('p', 'mfc-greeting', greeting(o.userName)),
      el(
        'p',
        '',
        `${name ? `I'm ${name}, and I` : 'I'} can help you understand mutual funds in simple words. ` +
          'Ask me how a fund has done, what a SIP could be worth today, or what a term like NAV means.',
      ),
      el('p', 'mfc-hint', 'Tap a question below, or type your own.'),
    );
    const chips = el('div', 'mfc-suggestions');
    for (const s of suggestions()) {
      const chip = el('button', 'mfc-chip', s);
      chip.type = 'button';
      chip.addEventListener('click', () => send(s));
      chips.append(chip);
    }
    body.append(bubble, chips);
    welcome.replaceChildren(avatar(), body);
  }

  /** Re-renders the greeting (e.g. after the settings load or the page context changes) while it is still showing. */
  function refreshWelcome() {
    if (welcome.isConnected) renderWelcome();
  }

  function addMessage(role, text = '') {
    welcome.remove();
    root.classList.add('mfc-has-messages');
    const wrap = el('div', `mfc-msg mfc-${role}`);
    const bubble = el('div', 'mfc-bubble');
    let body = wrap;
    if (role === 'assistant') {
      body = el('div', 'mfc-body');
      body.append(bubble);
      wrap.append(avatar(), body);
      if (text) renderInto(bubble, text);
    } else {
      bubble.textContent = text;
      wrap.append(bubble);
    }
    log.append(wrap);
    scrollToEnd();
    return { wrap, body, bubble };
  }

  function actionButton(icon, label) {
    const btn = el('button', 'mfc-action');
    btn.type = 'button';
    btn.innerHTML = icon;
    const text = el('span', '', label);
    btn.append(text);
    return { btn, text };
  }

  /** Copy, plus the device's own share menu where there is one, under a finished answer. */
  function addActions(body, bubble) {
    const bar = el('div', 'mfc-actions');
    const answerText = () => bubble.innerText.trim();

    const copy = actionButton(ICONS.copy, 'Copy');
    copy.btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(answerText());
        copy.text.textContent = 'Copied';
      } catch {
        copy.text.textContent = "Couldn't copy";
      }
      setTimeout(() => (copy.text.textContent = 'Copy'), 2000);
    });

    bar.append(copy.btn);
    if (typeof navigator.share === 'function') {
      const share = actionButton(ICONS.share, 'Share');
      share.btn.addEventListener('click', () => navigator.share({ text: answerText() }).catch(() => {}));
      bar.append(share.btn);
    }
    body.append(bar);
  }

  function addChart(container, chart) {
    const figure = el('figure', `mfc-chart mfc-chart-${chart.kind}`);
    const caption = el('figcaption');
    caption.append(el('span', 'mfc-chart-title', chart.title));
    if (chart.subtitle) caption.append(el('span', 'mfc-chart-sub', chart.subtitle));
    figure.append(caption);
    container.append(figure);
    if (chart.kind === 'bar') drawBars(figure, chart);
    else if (chart.kind === 'donut') drawDonut(figure, chart);
    else drawLine(figure, chart);
    scrollToEnd();
  }

  /** Bars as HTML rows, so long fund names wrap on a phone and every value is readable text. */
  function drawBars(figure, chart) {
    const format = chart.unit === 'pct' ? (v) => `${inr.format(v)}%` : rupeesText;
    const max = Math.max(...chart.bars.map((b) => Math.abs(b.value))) || 1;
    const list = el('div', 'mfc-bars');
    list.setAttribute('role', 'list');
    for (const b of chart.bars) {
      const row = el('div', `mfc-bar-row${b.muted ? ' mfc-bar-muted' : ''}`);
      row.setAttribute('role', 'listitem');
      const line = el('div', 'mfc-bar-line');
      const fill = el('span', 'mfc-bar');
      fill.style.setProperty('--f', String(Math.abs(b.value) / max));
      line.append(fill, el('span', 'mfc-bar-value', format(b.value)));
      row.append(el('span', 'mfc-bar-label', b.label), line);
      list.append(row);
    }
    figure.append(list);
  }

  /** A pie (donut) for "where your money is": slices in a fixed, colour-blind-checked order, with a legend. */
  function drawDonut(figure, chart) {
    const total = chart.slices.reduce((s, x) => s + x.value, 0);
    if (!(total > 0)) return;
    const share = (v) => `${Math.round((v / total) * 100)}%`;
    const colour = (slice, i) => (slice.other ? 'var(--mfc-cat-other)' : `var(--mfc-cat-${i + 1})`);

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${chart.title}: ${chart.slices.map((s) => `${s.label} ${share(s.value)}`).join(', ')}`);
    const ring = document.createElementNS(NS, 'g');
    ring.setAttribute('transform', 'rotate(-90 50 50)');
    const r = 40;
    const circumference = 2 * Math.PI * r;
    const gap = chart.slices.length > 1 ? 1.4 : 0; // ~2px of background between slices at the drawn size
    let offset = 0;
    chart.slices.forEach((s, i) => {
      const length = (s.value / total) * circumference;
      const arc = document.createElementNS(NS, 'circle');
      arc.setAttribute('class', 'mfc-slice');
      for (const [k, v] of Object.entries({ cx: 50, cy: 50, r, 'stroke-dasharray': `${Math.max(length - gap, 0.3)} ${circumference}`, 'stroke-dashoffset': -offset })) {
        arc.setAttribute(k, String(v));
      }
      arc.style.setProperty('--c', colour(s, i));
      const tip = document.createElementNS(NS, 'title');
      tip.textContent = `${s.label}: ${rupeesText(s.value)} (${share(s.value)})`;
      arc.append(tip);
      ring.append(arc);
      offset += length;
    });
    svg.append(ring);

    const dial = el('div', 'mfc-donut-dial');
    dial.append(svg);
    if (chart.center_label) {
      const centre = el('div', 'mfc-donut-centre');
      centre.append(el('strong', '', chart.center_label), el('span', '', 'in total'));
      dial.append(centre);
    }

    const legend = el('ul', 'mfc-legend');
    chart.slices.forEach((s, i) => {
      const item = el('li');
      const swatch = el('i', 'mfc-swatch');
      swatch.style.setProperty('--c', colour(s, i));
      const text = el('span', 'mfc-legend-text');
      text.append(el('span', 'mfc-legend-label', s.label), el('span', 'mfc-legend-amount', rupeesText(s.value)));
      item.append(swatch, text, el('strong', 'mfc-legend-share', share(s.value)));
      legend.append(item);
    });

    const layout = el('div', 'mfc-donut');
    layout.append(dial, legend);
    figure.append(layout);
  }

  function drawLine(figure, chart) {
    const box = el('div', 'mfc-chart-box');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Chart: ${chart.title}`);
    box.append(canvas);
    figure.append(box);

    const css = getComputedStyle(root);
    const accent = css.getPropertyValue('--mfc-accent').trim() || '#0b7a5a';
    const quiet = css.getPropertyValue('--mfc-chart-2').trim() || '#9aa5a0';
    const muted = css.getPropertyValue('--mfc-muted').trim() || '#62706b';
    const dates = chart.series[0].points.map((p) => p[0]);
    const last = chart.series.length - 1;
    charts.push(
      new Chart(canvas, {
        type: 'line',
        data: {
          labels: dates,
          // The last series is the headline (e.g. "What it grew to"); earlier ones are grey context.
          datasets: chart.series.map((s, i) => ({
            label: s.name,
            data: s.points.map((p) => p[1]),
            borderColor: i === last ? accent : quiet,
            backgroundColor: i === last ? accent : quiet,
            borderWidth: 2,
            borderCapStyle: 'round',
            borderJoinStyle: 'round',
            pointRadius: 0,
            pointHitRadius: 10,
            tension: 0.2,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: chart.series.length > 1, labels: { color: muted, boxWidth: 12, boxHeight: 2 } },
            tooltip: {
              callbacks: {
                title: (items) => longDate(dates[items[0].dataIndex]),
                label: (ctx) => ` ${ctx.dataset.label}: ₹${inr.format(ctx.parsed.y)}`,
              },
            },
          },
          scales: {
            x: {
              ticks: { color: muted, maxTicksLimit: 4, maxRotation: 0, callback: (v) => monthYear(dates[v]) },
              grid: { display: false },
            },
            y: { ticks: { color: muted, maxTicksLimit: 5, callback: compactInr }, grid: { color: 'rgba(127,127,127,.15)' } },
          },
        },
      }),
    );
    scrollToEnd();
  }

  function addError(message, action) {
    const { wrap, body, bubble } = addMessage('assistant');
    wrap.classList.add('mfc-error');
    bubble.textContent = message;
    if (action) {
      const btn = el('button', 'mfc-retry', action.label);
      btn.type = 'button';
      btn.addEventListener('click', action.run);
      body.append(btn);
    }
    return wrap;
  }

  const headers = () => ({
    'Content-Type': 'application/json',
    // JSON first so backends (e.g. Laravel) answer auth/CSRF/validation failures with JSON, not redirects.
    Accept: 'application/json, text/event-stream',
    ...(typeof o.headers === 'function' ? o.headers() : o.headers),
  });

  // ---------- actions ----------
  async function send(text) {
    const message = (text ?? input.value).trim();
    if (!message || controller) return;
    input.value = '';
    autosize();
    const { wrap: userWrap } = addMessage('user', message);
    const { wrap, body, bubble } = addMessage('assistant');
    wrap.classList.add('mfc-pending');
    const typing = el('span', 'mfc-typing');
    typing.setAttribute('aria-label', 'Typing');
    typing.append(el('i'), el('i'), el('i'));
    bubble.append(typing);

    let reply = '';
    let frame = 0;
    // One status line under the bubble: each new step replaces the previous one.
    const activity = el('div', 'mfc-status');
    activity.setAttribute('role', 'status');
    const running = new Map(); // tool call id -> label
    let label = '';
    let slow = false;
    const showStatus = (next) => {
      label = next ?? label;
      const lines = [];
      if (label) lines.push(el('span', 'mfc-step', `${label}…`));
      if (slow && !reply) lines.push(el('span', 'mfc-slow', 'Taking a little longer than usual. Thanks for waiting.'));
      activity.replaceChildren(...lines);
      if (!activity.isConnected && lines.length) body.insertBefore(activity, bubble.nextSibling);
      scrollToEnd();
    };
    const hideStatus = () => activity.remove();
    const slowTimer = setTimeout(() => {
      slow = true;
      if (!reply) showStatus();
    }, SLOW_AFTER_MS);

    const paint = () => {
      frame = 0;
      // Follow the answer only if the reader hasn't scrolled up to read the start of it.
      const stick = nearBottom();
      renderInto(bubble, reply);
      if (stick) scrollToEnd();
    };

    controller = new AbortController();
    setBusy(true);
    try {
      const extra = typeof o.body === 'function' ? o.body() : {};
      const res = await fetch(o.streamUrl, {
        method: 'POST',
        headers: headers(),
        credentials: o.credentials,
        body: JSON.stringify({ ...extra, message, ...(conversationId && { conversation_id: conversationId }) }),
        signal: controller.signal,
      });
      const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');
      if (!res.ok || !res.body || !isStream) {
        let msg = ERRORS[res.status] ?? ERRORS.generic;
        let code;
        try {
          const j = await res.json();
          if (j.message) msg = j.message;
          code = j.error;
        } catch {
          /* non-JSON error body */
        }
        throw Object.assign(new Error(msg), { shown: true, status: res.status, code });
      }

      for await (const ev of readSse(res)) {
        switch (ev.type) {
          case 'meta':
            conversationId = ev.conversation_id;
            store.set(conversationId);
            break;
          case 'tool_start':
            running.set(ev.id, ev.label);
            showStatus(ev.label);
            break;
          case 'tool_end':
            running.delete(ev.id);
            showStatus(running.size ? [...running.values()].at(-1) : 'Putting your answer together');
            break;
          case 'chart':
            addChart(body, ev.chart);
            break;
          case 'delta':
            hideStatus();
            reply += ev.text;
            if (!frame) frame = requestAnimationFrame(paint);
            break;
          case 'rewind':
            // The server switched models mid-answer; drop the partial text it is regenerating.
            reply = ev.reply;
            if (!frame) frame = requestAnimationFrame(paint);
            break;
          case 'done':
            reply = ev.reply || reply;
            break;
          case 'error':
            throw Object.assign(new Error(ev.message || ERRORS.generic), { shown: true, code: ev.code });
        }
      }
      if (frame) cancelAnimationFrame(frame);
      if (!reply.trim()) throw Object.assign(new Error(ERRORS.generic), { shown: true });
      paint();
      addActions(body, bubble);
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      if (err.name === 'AbortError') {
        if (!reply) wrap.remove();
        else paint();
      } else {
        if (!reply) wrap.remove();
        else paint();
        const sessionEnded = err.status === 401 && err.code !== 'auth_required';
        const final = sessionEnded || err.status === 403 || FINAL_ERRORS.has(err.code);
        const errWrap = addError(
          err.shown ? err.message : ERRORS.network,
          sessionEnded
            ? { label: 'Refresh page', run: () => location.reload() }
            : final
              ? null
              : {
                  label: 'Try again',
                  run: () => {
                    if (controller) return;
                    userWrap.remove();
                    wrap.remove();
                    errWrap.remove();
                    send(message);
                  },
                },
        );
      }
    } finally {
      clearTimeout(slowTimer);
      wrap.classList.remove('mfc-pending');
      hideStatus();
      controller = null;
      setBusy(false);
      if (finePointer) input.focus();
    }
  }

  async function loadHistory() {
    if (!conversationId || !o.historyUrl) return;
    try {
      const res = await fetch(o.historyUrl.replace('{id}', encodeURIComponent(conversationId)), {
        headers: { Accept: 'application/json', ...(typeof o.headers === 'function' ? o.headers() : o.headers) },
        credentials: o.credentials,
      });
      if (res.status === 404) return store.set(null);
      if (!res.ok) return;
      const { messages = [] } = await res.json();
      for (const m of messages) {
        const { body, bubble } = addMessage(m.role, m.text);
        if (m.role !== 'assistant') continue;
        for (const c of m.charts ?? []) addChart(body, c);
        addActions(body, bubble);
      }
    } catch {
      /* history is best-effort */
    }
  }

  async function loadSettings() {
    if (!o.configUrl) return;
    try {
      const res = await fetch(o.configUrl, { headers: { Accept: 'application/json' }, credentials: o.credentials });
      if (!res.ok) return;
      const c = await res.json();
      features.assistantName = typeof c.assistant_name === 'string' ? c.assistant_name : '';
      features.portfolio = Boolean(c.portfolio);
    } catch {
      /* settings only personalise the greeting */
    }
  }

  function reset() {
    controller?.abort();
    if (conversationId && o.resetUrl) {
      fetch(o.resetUrl.replace('{id}', encodeURIComponent(conversationId)), {
        method: 'DELETE',
        headers: headers(),
        credentials: o.credentials,
      }).catch(() => {});
    }
    conversationId = null;
    store.set(null);
    charts.splice(0).forEach((c) => c.destroy());
    log.replaceChildren();
    root.classList.remove('mfc-has-messages');
    renderWelcome();
    log.append(welcome);
    if (finePointer) input.focus();
  }

  // ---------- one-time hello above the launcher ----------
  let teaser = null;
  let teaserTimer = 0;
  const hideTeaser = () => {
    clearTimeout(teaserTimer);
    teaser?.remove();
    teaser = null;
  };
  if (o.mode === 'floating' && o.teaser && !teaserSeen.get()) {
    teaserTimer = setTimeout(() => {
      if (root.classList.contains('mfc-open')) return;
      teaserSeen.set('1');
      teaser = el('div', 'mfc-teaser');
      const bodyBtn = el('button', 'mfc-teaser-body');
      bodyBtn.type = 'button';
      bodyBtn.append(
        avatar(),
        el('span', '', `Hi${o.userName ? ` ${o.userName}` : ''}! Have a question about mutual funds? Ask me, I'll explain in simple words.`),
      );
      bodyBtn.addEventListener('click', open);
      const dismiss = el('button', 'mfc-icon-btn mfc-teaser-close');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.innerHTML = ICONS.close;
      dismiss.addEventListener('click', hideTeaser);
      teaser.append(bodyBtn, dismiss);
      root.append(teaser);
    }, 6000);
  }

  const isOpen = () => root.classList.contains('mfc-open');
  function open() {
    hideTeaser();
    root.classList.add('mfc-open');
    launcher.setAttribute('aria-expanded', 'true');
    // The label text is hidden while open (the launcher becomes a close button).
    launcher.setAttribute('aria-label', 'Close chat');
    if (finePointer) setTimeout(() => input.focus(), 50);
  }
  function close() {
    root.classList.remove('mfc-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.removeAttribute('aria-label');
    launcher.focus();
  }

  // ---------- events ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  sendBtn.addEventListener('click', () => {
    if (controller) controller.abort();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => {
    autosize();
    syncSend();
  });
  resetBtn.addEventListener('click', reset);
  launcher.addEventListener('click', () => (isOpen() ? close() : open()));
  closeBtn.addEventListener('click', close);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && o.mode === 'floating' && isOpen()) close();
  });

  syncSend();
  // A late settings response still personalises the title and greeting.
  const settings = loadSettings().then(() => {
    syncTitle();
    refreshWelcome();
  });
  // Greet once the assistant's name is known and any earlier chat has loaded (or after a short wait).
  Promise.race([Promise.all([settings, loadHistory()]), new Promise((r) => setTimeout(r, 1500))]).then(() => {
    syncTitle();
    if (root.classList.contains('mfc-has-messages')) return;
    renderWelcome();
    log.append(welcome);
  });

  return {
    open,
    close,
    reset,
    send,
    refreshWelcome,
    destroy() {
      controller?.abort();
      hideTeaser();
      charts.forEach((c) => c.destroy());
      root.innerHTML = '';
    },
  };
}
