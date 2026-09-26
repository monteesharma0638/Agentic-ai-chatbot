/**
 * MF Chat widget core — framework-free chat UI for the mutual fund assistant.
 *
 * Streams replies over SSE (POST + fetch streaming), renders markdown safely,
 * shows live tool activity and draws NAV / SIP charts. Bundled into
 * embed.js by build.mjs; see embed.js for the script-tag integration.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';

// Register only what line charts need, keeping the bundle small.
Chart.register(LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend);

const DEFAULT_SUGGESTIONS = [
  'What was the NAV of Parag Parikh Flexi Cap on 23 March 2020?',
  '₹10,000 monthly SIP in HDFC Mid Cap since Jan 2019 — what is it worth today?',
  'Top 5 small cap funds by 3-year returns',
  'Estimate the value of ₹5 lakh in a Nifty 50 index fund after 10 years',
];

const ERRORS = {
  401: 'Your session has expired. Please refresh the page to keep chatting.',
  403: 'You do not have access to the assistant.',
  429: "You're sending messages too quickly. Please wait a moment.",
  network: 'Could not reach the assistant. Check your connection and try again.',
  generic: 'Something went wrong. Please try again.',
};

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
}

function shortDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
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
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 10h8M8 13h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/**
 * @param {HTMLElement} root
 * @param {object} opts
 * @param {string} opts.streamUrl         POST endpoint returning text/event-stream
 * @param {string} [opts.historyUrl]      GET template with {id}, returns {messages:[...]}
 * @param {string} [opts.resetUrl]        DELETE template with {id}
 * @param {object|Function} [opts.headers] Extra request headers (e.g. CSRF token)
 * @param {Function} [opts.body]          Returns extra JSON fields merged into each request
 * @param {'floating'|'inline'} [opts.mode]
 * @param {string} [opts.storageKey]      localStorage key for the conversation id
 */
export function mountMfChat(root, opts) {
  const o = {
    mode: 'floating',
    title: 'Fund Assistant',
    subtitle: 'NAVs, returns, SIPs & comparisons',
    placeholder: 'Ask about any mutual fund…',
    disclaimer: 'AI assistant, not investment advice. Mutual fund investments are subject to market risks.',
    suggestions: DEFAULT_SUGGESTIONS,
    storageKey: 'mf-chat:conversation',
    credentials: 'same-origin',
    ...opts,
  };
  if (!o.streamUrl) throw new Error('mountMfChat: streamUrl is required');

  const store = {
    get: () => {
      try {
        return localStorage.getItem(o.storageKey);
      } catch {
        return null;
      }
    },
    set: (v) => {
      try {
        v ? localStorage.setItem(o.storageKey, v) : localStorage.removeItem(o.storageKey);
      } catch {
        /* storage unavailable */
      }
    },
  };

  let conversationId = store.get();
  let controller = null;
  const charts = [];

  // ---------- DOM ----------
  root.classList.add('mfc-root', `mfc-${o.mode}`);
  root.innerHTML = '';

  const launcher = el('button', 'mfc-launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', `Open ${o.title}`);
  launcher.innerHTML = ICONS.chat;

  const panel = el('section', 'mfc-panel');
  panel.setAttribute('aria-label', o.title);

  const header = el('header', 'mfc-header');
  const heading = el('div', 'mfc-heading');
  heading.append(el('strong', 'mfc-title', o.title), el('span', 'mfc-subtitle', o.subtitle));
  const resetBtn = el('button', 'mfc-icon-btn');
  resetBtn.type = 'button';
  resetBtn.title = 'New chat';
  resetBtn.setAttribute('aria-label', 'Start a new chat');
  resetBtn.innerHTML = ICONS.reset;
  const closeBtn = el('button', 'mfc-icon-btn mfc-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close chat');
  closeBtn.innerHTML = ICONS.close;
  header.append(heading, resetBtn, closeBtn);

  const log = el('div', 'mfc-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  const empty = el('div', 'mfc-empty');
  const emptyTitle = el('p', 'mfc-empty-title', 'Ask anything about Indian mutual funds');
  const chips = el('div', 'mfc-suggestions');
  for (const s of o.suggestions) {
    const chip = el('button', 'mfc-chip', s);
    chip.type = 'button';
    chip.addEventListener('click', () => send(s));
    chips.append(chip);
  }
  empty.append(emptyTitle, chips);

  const form = el('form', 'mfc-composer');
  const input = el('textarea', 'mfc-input');
  input.rows = 1;
  input.placeholder = o.placeholder;
  input.maxLength = 2000;
  input.setAttribute('aria-label', 'Message');
  const sendBtn = el('button', 'mfc-send');
  sendBtn.type = 'submit';
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.innerHTML = ICONS.send;
  form.append(input, sendBtn);

  const footer = el('p', 'mfc-disclaimer', o.disclaimer);
  panel.append(header, log, form, footer);
  root.append(panel);
  if (o.mode === 'floating') root.append(launcher);
  log.append(empty);

  // ---------- helpers ----------
  const scrollToEnd = () => {
    log.scrollTop = log.scrollHeight;
  };

  const setBusy = (busy) => {
    root.classList.toggle('mfc-busy', busy);
    sendBtn.innerHTML = busy ? ICONS.stop : ICONS.send;
    sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    sendBtn.type = busy ? 'button' : 'submit';
  };

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };

  function addMessage(role, text = '') {
    empty.remove();
    const wrap = el('div', `mfc-msg mfc-${role}`);
    const bubble = el('div', 'mfc-bubble');
    if (role === 'assistant') {
      bubble.innerHTML = text ? renderMarkdown(text) : '';
    } else {
      bubble.textContent = text;
    }
    wrap.append(bubble);
    log.append(wrap);
    scrollToEnd();
    return { wrap, bubble };
  }

  function addChart(container, chart) {
    const figure = el('figure', 'mfc-chart');
    const caption = el('figcaption');
    caption.append(el('span', 'mfc-chart-title', chart.title));
    if (chart.subtitle) caption.append(el('span', 'mfc-chart-sub', chart.subtitle));
    const box = el('div', 'mfc-chart-box');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${chart.title} chart`);
    box.append(canvas);
    figure.append(caption, box);
    container.append(figure);

    const css = getComputedStyle(root);
    const palette = [css.getPropertyValue('--mfc-accent').trim() || '#0b7a5a', css.getPropertyValue('--mfc-chart-2').trim() || '#8a94a6'];
    const muted = css.getPropertyValue('--mfc-muted').trim() || '#6b7280';
    const labels = chart.series[0].points.map((p) => shortDate(p[0]));
    charts.push(
      new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: chart.series.map((s, i) => ({
            label: s.name,
            data: s.points.map((p) => p[1]),
            borderColor: palette[i % palette.length],
            backgroundColor: palette[i % palette.length],
            borderWidth: 2,
            borderDash: chart.series.length > 1 && i === 0 ? [4, 4] : [],
            pointRadius: 0,
            pointHitRadius: 8,
            tension: 0.2,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: chart.series.length > 1, labels: { color: muted, boxWidth: 12 } },
            tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ₹${inr.format(ctx.parsed.y)}` } },
          },
          scales: {
            x: { ticks: { color: muted, maxTicksLimit: 5, maxRotation: 0 }, grid: { display: false } },
            y: { ticks: { color: muted, maxTicksLimit: 5, callback: (v) => inr.format(v) }, grid: { color: 'rgba(127,127,127,.15)' } },
          },
        },
      }),
    );
    scrollToEnd();
  }

  function addError(message) {
    const { wrap, bubble } = addMessage('assistant');
    wrap.classList.add('mfc-error');
    bubble.textContent = message;
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
    addMessage('user', message);
    const { wrap, bubble } = addMessage('assistant');
    wrap.classList.add('mfc-pending');
    // A single status chip: each new step replaces the previous one.
    const activity = el('div', 'mfc-activity');
    activity.setAttribute('role', 'status');
    const running = new Map(); // tool call id -> label
    const showStatus = (label) => {
      activity.replaceChildren(el('span', 'mfc-tool mfc-running', `${label}…`));
      if (!activity.isConnected) wrap.insertBefore(activity, bubble);
      scrollToEnd();
    };
    const hideStatus = () => activity.remove();
    let reply = '';
    let frame = 0;
    const paint = () => {
      frame = 0;
      bubble.innerHTML = renderMarkdown(reply);
      scrollToEnd();
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
        try {
          const j = await res.json();
          if (j.message) msg = j.message;
        } catch {
          /* non-JSON error body */
        }
        throw Object.assign(new Error(msg), { shown: true });
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
            showStatus(running.size ? [...running.values()].at(-1) : 'Preparing answer');
            break;
          case 'chart':
            addChart(wrap, ev.chart);
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
            throw Object.assign(new Error(ev.message || ERRORS.generic), { shown: true });
        }
      }
      if (frame) cancelAnimationFrame(frame);
      paint();
      if (!reply.trim()) bubble.textContent = ERRORS.generic;
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!reply) wrap.remove();
        else paint();
      } else {
        if (!reply) wrap.remove();
        addError(err.shown ? err.message : ERRORS.network);
      }
    } finally {
      wrap.classList.remove('mfc-pending');
      hideStatus();
      controller = null;
      setBusy(false);
      input.focus();
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
        const { wrap } = addMessage(m.role, m.text);
        for (const c of m.charts ?? []) addChart(wrap, c);
      }
    } catch {
      /* history is best-effort */
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
    log.innerHTML = '';
    log.append(empty);
    input.focus();
  }

  const open = () => {
    root.classList.add('mfc-open');
    launcher.setAttribute('aria-expanded', 'true');
    setTimeout(() => input.focus(), 50);
  };
  const close = () => {
    root.classList.remove('mfc-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  };

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
  input.addEventListener('input', autosize);
  resetBtn.addEventListener('click', reset);
  launcher.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && o.mode === 'floating') close();
  });

  loadHistory();

  return {
    open,
    close,
    reset,
    send,
    destroy() {
      controller?.abort();
      charts.forEach((c) => c.destroy());
      root.innerHTML = '';
    },
  };
}
