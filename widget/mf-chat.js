/**
 * MF Chat widget core — framework-free chat UI for the mutual fund assistant.
 *
 * Streams replies over SSE (POST + fetch streaming), renders markdown safely,
 * shows live tool activity and draws NAV / SIP charts. Bundled into
 * embed.js by build.mjs; see embed.js for the script-tag integration.
 *
 * Written for everyday investors rather than experts: the assistant greets
 * first, asks a few quick questions so its answers fit the person, offers
 * questions to tap, says what it is doing while it works, and every error
 * comes with a way forward.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CategoryScale, Chart, Filler, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import assistantPicture from './assets/assistant.jpg';

// Register only what line charts need, keeping the bundle small.
Chart.register(LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);

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

/**
 * Asked once, before the first chat, so answers fit the person: the same facts the assistant needs before any
 * planning suggestion (age, goal, time, and how they'd feel about a fall). The values are what the server accepts.
 */
const QUESTIONS = [
  {
    key: 'age',
    title: 'How old are you?',
    options: [
      ['18-35', '18–35 years'],
      ['36-50', '36–50 years'],
      ['50+', 'Over 50'],
    ],
  },
  {
    key: 'experience',
    title: 'Have you invested in mutual funds before?',
    options: [
      ['new', "No, I'm new to this"],
      ['some', 'Yes, a little'],
      ['regular', 'Yes, I invest regularly'],
    ],
  },
  {
    key: 'goal',
    title: 'What are you mainly investing for?',
    options: [
      ['wealth', 'Growing my wealth'],
      ['big_goal', 'A big goal: a home, education or a wedding'],
      ['retirement', 'Retirement'],
      ['tax', 'Saving tax'],
      ['income', 'A regular income'],
    ],
  },
  {
    key: 'horizon',
    title: 'When might you need this money?',
    options: [
      ['under_3y', 'Within 3 years'],
      ['3_7y', 'In 3 to 7 years'],
      ['over_7y', 'After 7 years or more'],
    ],
  },
  {
    key: 'reaction',
    title: 'If your investment fell 20% in a few months, what would you do?',
    options: [
      ['sell', 'Take my money out'],
      ['wait', 'Worry, but wait it out'],
      ['buy_more', 'Stay calm, or even invest more'],
    ],
  },
];
const PROFILE_KEYS = ['age', 'experience', 'goal', 'horizon', 'reaction', 'risk'];
const POINTS = {
  age: { '18-35': 5, '36-50': 3, '50+': 1 },
  horizon: { under_3y: 1, '3_7y': 3, over_7y: 5 },
  reaction: { sell: 1, wait: 3, buy_more: 5 },
};
const RISK_TEXT = {
  conservative: "you'd rather keep your money steady, even if it grows slowly.",
  moderate: "you're okay with some ups and downs for better growth over time.",
  aggressive: "you're comfortable with bigger ups and downs for higher growth over many years.",
};

/** A gentle read of comfort with risk from age, time and the reaction to a fall; someone who'd sell in a fall is never "aggressive". */
function riskOf(a) {
  if (!a.age || !a.horizon || !a.reaction) return undefined;
  const score = POINTS.age[a.age] + POINTS.horizon[a.horizon] + POINTS.reaction[a.reaction];
  if (a.reaction === 'sell' || score <= 7) return 'conservative';
  if (score >= 12 && a.reaction === 'buy_more') return 'aggressive';
  return 'moderate';
}

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
/** Pause before the next question appears, as if the assistant were replying. */
const REVEAL_MS = 350;

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
function renderInto(target, text) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), { FORBID_TAGS: ['a', 'img'] });
  const last = target.lastElementChild;
  if (last?.tagName === 'P' && last.childNodes.length === 1 && last.firstChild.nodeName === 'EM') {
    last.classList.add('mfc-note');
  }
}

/** 09:41 AM */
const clock = (date = new Date()) =>
  date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();

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

/** #2fe08a → rgba(47, 224, 138, a), for the fade under a line; other colour formats get no fade. */
function withAlpha(hex, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'transparent';
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
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

/** Line icons in the style the app uses (Lucide). */
const icon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  back: icon('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  send: icon('<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>'),
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
  plus: icon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  copy: icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  share: icon('<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>'),
};

function avatar() {
  const node = el('span', 'mfc-avatar');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** The app's glass button: a frosted pill with a gradient edge and a sheen that sweeps across on hover. */
function glassButton(label, size = '') {
  const btn = el('button', `mfc-glass ${size}`.trim());
  btn.type = 'button';
  const content = el('span', 'mfc-glass-content');
  if (typeof label === 'string') content.textContent = label;
  else content.append(...label);
  btn.append(el('span', 'mfc-glass-border'), el('span', 'mfc-glass-highlight'), el('span', 'mfc-glass-shine'), content);
  return btn;
}

/**
 * @param {HTMLElement} root
 * @param {object} opts
 * @param {string} opts.streamUrl         POST endpoint returning text/event-stream
 * @param {string} [opts.historyUrl]      GET template with {id}, returns {messages:[...]}
 * @param {string} [opts.resetUrl]        DELETE template with {id}
 * @param {string} [opts.configUrl]       GET endpoint returning {assistant_name, app_name, portfolio}
 * @param {object|Function} [opts.headers] Extra request headers (e.g. CSRF token)
 * @param {Function} [opts.body]          Returns extra JSON fields merged into each request
 * @param {Function} [opts.getContext]    Returns the page context ({scheme_code}) for "this fund" suggestions
 * @param {'floating'|'inline'} [opts.mode]
 * @param {string} [opts.storageKey]      localStorage key for the conversation id
 * @param {string} [opts.profileKey]      localStorage key for the answers to the quick questions
 * @param {boolean} [opts.onboarding]     Ask the quick questions before the first chat (default true)
 * @param {string} [opts.userName]        First name, used in the greeting
 * @param {boolean} [opts.signedIn]       Offer "my investments" questions
 * @param {boolean} [opts.teaser]         Show a one-time hello above the launcher (floating mode)
 */
export function mountMfChat(root, opts) {
  const o = {
    mode: 'floating',
    subtitle: 'Answers in simple words',
    placeholder: 'Type a message…',
    disclaimer:
      'Information only, not investment advice. Mutual fund investments are subject to market risks, read all scheme related documents carefully.',
    storageKey: 'mf-chat:conversation',
    profileKey: 'mf-chat:profile',
    onboarding: true,
    credentials: 'same-origin',
    teaser: true,
    ...opts,
  };
  if (!o.streamUrl) throw new Error('mountMfChat: streamUrl is required');

  const storage = (key, area = 'localStorage') => ({
    get: () => {
      try {
        return window[area].getItem(key);
      } catch {
        return null;
      }
    },
    set: (v) => {
      try {
        v ? window[area].setItem(key, v) : window[area].removeItem(key);
      } catch {
        /* storage unavailable */
      }
    },
  });
  const store = storage(o.storageKey);
  const profileStore = storage(o.profileKey);
  const teaserSeen = storage('mf-chat:teaser-seen');
  // Per tab, so a chat left open carries over to the next page of the site but not to new tabs.
  const leftOpen = storage('mf-chat:open', 'sessionStorage');

  let conversationId = store.get();
  let controller = null;
  const charts = [];
  const features = { assistantName: '', appName: '', portfolio: false };
  // Touch devices: don't pop the keyboard up over an answer the person is about to read.
  const finePointer = window.matchMedia?.('(pointer: fine)').matches ?? true;

  /** Saved answers ({...answers, risk, done} or {skipped}), or null if the questions were never offered. */
  let profile = null;
  try {
    profile = JSON.parse(profileStore.get() || 'null');
  } catch {
    /* unreadable: ask again */
  }
  /** The questions being answered right now: their answers so far. */
  let intro = null;

  // ---------- DOM ----------
  root.classList.add('mfc-root', `mfc-${o.mode}`);
  root.style.setProperty('--mfc-logo', `url("${assistantPicture}")`);
  root.innerHTML = '';

  const launcher = el('button', 'mfc-launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.append(el('span', 'mfc-orb-face'));
  const tooltip = el('span', 'mfc-tooltip');
  tooltip.setAttribute('aria-hidden', 'true');

  const panel = el('section', 'mfc-panel');
  const card = el('div', 'mfc-card');

  const header = el('header', 'mfc-header');
  const closeBtn = el('button', 'mfc-back');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close chat');
  closeBtn.innerHTML = ICONS.back;
  const heading = el('div', 'mfc-heading');
  const titleEl = el('strong', 'mfc-title', o.title ?? '');
  const subtitleEl = el('span', 'mfc-subtitle');
  subtitleEl.append(el('i', 'mfc-online'), document.createTextNode(o.subtitle));
  heading.append(titleEl, subtitleEl);
  const plus = el('span');
  plus.innerHTML = ICONS.plus;
  const resetBtn = glassButton([plus.firstChild, 'New chat'], 'mfc-glass-xs mfc-new');
  header.append(closeBtn, heading, resetBtn);

  const log = el('div', 'mfc-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  // The assistant speaks first: a greeting and a few questions to tap.
  const welcome = el('div', 'mfc-msg mfc-assistant mfc-welcome');
  let welcomeAfterQuestions = false;

  const footer = el('div', 'mfc-footer');
  const form = el('form', 'mfc-composer');
  const bar = el('div', 'mfc-input-bar');
  const input = el('textarea', 'mfc-input');
  input.rows = 1;
  input.placeholder = o.placeholder;
  input.maxLength = 2000;
  input.setAttribute('aria-label', 'Your question');
  input.setAttribute('enterkeyhint', 'send');
  const sendBtn = el('button', 'mfc-send');
  bar.append(input, sendBtn);
  form.append(bar);
  footer.append(form, el('p', 'mfc-disclaimer', o.disclaimer));

  card.append(header, log, footer);
  panel.append(card);
  root.append(panel);
  if (o.mode === 'floating') root.append(launcher, tooltip);

  const launcherLabel = () => o.launcherText || (features.assistantName ? `Ask ${features.assistantName}` : 'Ask about funds');
  const syncTitle = () => {
    const title = o.title || features.assistantName || 'Fund Assistant';
    titleEl.textContent = title;
    panel.setAttribute('aria-label', title);
    tooltip.textContent = launcherLabel();
    if (!isOpen()) launcher.setAttribute('aria-label', launcherLabel());
  };
  // Without an explicit title, wait for the assistant's name rather than flashing a placeholder.
  if (o.title) syncTitle();
  else launcher.setAttribute('aria-label', launcherLabel());

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

  /** A message row (not yet in the log) with its bubble, text area and time; `wrap` lets the welcome reuse its element. */
  function messageRow(role, wrap = el('div', `mfc-msg mfc-${role}`)) {
    const bubble = el('div', 'mfc-bubble');
    const content = el('div', 'mfc-md');
    const time = el('div', 'mfc-time');
    bubble.append(content, time);
    let body = wrap;
    if (role === 'assistant') {
      body = el('div', 'mfc-body');
      body.append(bubble);
      wrap.append(avatar(), body);
    } else {
      wrap.append(bubble);
    }
    return { wrap, body, bubble, content, time };
  }

  /** 09:41 AM ✓ while sending, ✓✓ once the assistant has the message. */
  const stampUser = (time, at, delivered) => {
    time.textContent = `${clock(at)} ${delivered ? '✓✓' : '✓'}`;
  };

  function renderWelcome() {
    const { body, content, time } = messageRow('assistant', welcome);
    const name = features.assistantName;
    if (welcomeAfterQuestions && profile?.done) {
      const thanks = el('p', 'mfc-greeting', `Thanks${o.userName ? `, ${o.userName}` : ''}! I'll keep your answers in mind.`);
      content.append(thanks);
      if (profile.risk) {
        const summary = el('p');
        summary.append('From your answers, you seem to be a ', el('strong', '', `${profile.risk} investor`), `: ${RISK_TEXT[profile.risk]}`);
        content.append(summary);
      }
      content.append(el('p', '', 'What would you like to know?'));
    } else {
      content.append(
        el('p', 'mfc-greeting', `Hello${o.userName ? ` ${o.userName}` : ''}🙏, what's on your mind?`),
        el(
          'p',
          '',
          `${name ? `I'm ${name}, and I` : 'I'} can help you understand mutual funds in simple words. ` +
            'Ask me how a fund has done, what a SIP could be worth today, or what a term like NAV means.',
        ),
      );
    }
    content.append(el('p', 'mfc-hint', 'Tap a question below, or type your own.'));
    if (profile?.done && o.onboarding) {
      const change = el('button', 'mfc-link', 'Change my answers');
      change.type = 'button';
      change.addEventListener('click', changeAnswers);
      content.append(change);
    }
    time.textContent = clock();
    const chips = el('div', 'mfc-suggestions');
    for (const s of suggestions()) {
      const chip = glassButton(s, 'mfc-glass-sm');
      chip.addEventListener('click', () => send(s));
      chips.append(chip);
    }
    body.append(chips);
  }

  /** Re-renders the greeting (e.g. after the settings load or the page context changes) while it is still showing. */
  function refreshWelcome() {
    if (!welcome.isConnected) return;
    welcome.replaceChildren();
    renderWelcome();
  }

  function showWelcome() {
    welcome.replaceChildren();
    renderWelcome();
    log.append(welcome);
    scrollToEnd();
  }

  function addMessage(role, text = '', at) {
    welcome.remove();
    root.classList.add('mfc-has-messages');
    const row = messageRow(role);
    if (role === 'assistant') {
      if (text) renderInto(row.content, text);
      if (at) row.time.textContent = clock(new Date(at));
    } else {
      row.content.textContent = text;
      stampUser(row.time, at ? new Date(at) : new Date(), Boolean(at));
    }
    log.append(row.wrap);
    scrollToEnd();
    return row;
  }

  // ---------- quick questions before the first chat ----------
  const saveProfile = (next) => {
    profile = next;
    profileStore.set(JSON.stringify(next));
  };
  const needsQuestions = () => o.onboarding && !profile;

  /** Answers to send with each message: the saved ones, or those given so far. */
  function requestProfile() {
    const src = profile ?? intro?.answers;
    const out = {};
    for (const k of PROFILE_KEYS) if (src?.[k]) out[k] = src[k];
    return Object.keys(out).length ? out : null;
  }

  /** An assistant message in the question flow; these don't count as the conversation (no "New chat" yet). */
  function introBubble(className = '') {
    const row = messageRow('assistant');
    if (className) row.wrap.classList.add(className);
    row.wrap.classList.add('mfc-reveal');
    row.time.textContent = clock();
    log.append(row.wrap);
    return row;
  }
  function introReply(text) {
    const row = messageRow('user');
    row.content.textContent = text;
    stampUser(row.time, new Date(), true);
    log.append(row.wrap);
    scrollToEnd();
  }
  const later = (fn) => setTimeout(fn, REVEAL_MS);

  function startQuestions() {
    intro = { answers: {} };
    const { content } = introBubble();
    const name = features.assistantName;
    content.append(
      el('p', '', name ? `Hello! I am ${name}🙏🏽` : 'Hello!🙏🏽'),
      ...(features.appName ? [el('p', '', `Your investing companion at ${features.appName}.`)] : []),
      el('p', '', "I'm here to help you understand mutual funds and answer your questions in simple words."),
      el('p', '', 'A few quick questions first, so my answers fit you. It takes less than a minute.'),
      el('p', '', 'How would you like to begin?'),
    );
    const choices = el('div', 'mfc-choices');
    const fit = glassButton('Help me find my fit');
    const know = glassButton('I know what I want');
    choices.append(fit, el('span', 'mfc-or', 'OR'), know);
    content.append(choices);
    const choose = (label, next) => {
      fit.disabled = know.disabled = true;
      introReply(label);
      later(next);
    };
    fit.addEventListener('click', () => choose('Help me find my fit', () => ask(0)));
    know.addEventListener('click', () =>
      choose('I know what I want', () => {
        intro = null;
        saveProfile({ skipped: true });
        welcomeAfterQuestions = false;
        showWelcome();
      }),
    );
    scrollToEnd();
  }

  function ask(index) {
    if (!intro) return;
    const q = QUESTIONS[index];
    const { content } = introBubble('mfc-question');
    content.append(el('p', 'mfc-q-title', q.title));
    const group = el('div', 'mfc-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', q.title);
    for (const [value, label] of q.options) {
      const option = el('button', 'mfc-option');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(intro.previous?.[q.key] === value));
      option.append(el('span', 'mfc-dot'), el('span', '', label));
      option.addEventListener('click', () => {
        if (!intro) return;
        for (const b of group.children) {
          b.setAttribute('aria-checked', String(b === option));
          b.disabled = true;
        }
        intro.answers[q.key] = value;
        introReply(label);
        later(() => (index + 1 < QUESTIONS.length ? ask(index + 1) : finishQuestions()));
      });
      group.append(option);
    }
    content.append(group);
    scrollToEnd();
  }

  function finishQuestions() {
    if (!intro) return;
    const { answers } = intro;
    intro = null;
    const risk = riskOf(answers);
    saveProfile({ ...answers, ...(risk && { risk }), done: true });
    welcomeAfterQuestions = true;
    showWelcome();
  }

  function changeAnswers() {
    if (controller) return;
    const previous = profile;
    welcome.remove();
    introReply('Change my answers');
    intro = { answers: {}, previous };
    later(() => ask(0));
  }

  /** Typing instead of answering ends the questions; answers given so far are kept and the rest are skipped. */
  function endQuestions() {
    if (!intro) return;
    for (const b of log.querySelectorAll('.mfc-option, .mfc-choices .mfc-glass')) b.disabled = true;
    if (!intro.previous) saveProfile({ ...intro.answers, skipped: true });
    intro = null;
  }

  function actionButton(iconSvg, label) {
    const btn = el('button', 'mfc-action');
    btn.type = 'button';
    btn.innerHTML = iconSvg;
    const text = el('span', '', label);
    btn.append(text);
    return { btn, text };
  }

  /** Copy, plus the device's own share menu where there is one, under a finished answer. */
  function addActions(body, content) {
    const actions = el('div', 'mfc-actions');
    const answerText = () => content.innerText.trim();

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

    actions.append(copy.btn);
    if (typeof navigator.share === 'function') {
      const share = actionButton(ICONS.share, 'Share');
      share.btn.addEventListener('click', () => navigator.share({ text: answerText() }).catch(() => {}));
      actions.append(share.btn);
    }
    body.append(actions);
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

  /** Line colours come from the theme, so they're re-read whenever the theme changes. */
  function lineTheme() {
    const css = getComputedStyle(root);
    const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
      line: read('--mfc-line', '#2fe08a'),
      quiet: read('--mfc-chart-2', '#6b6880'),
      muted: read('--mfc-muted', '#7d7896'),
      grid: read('--mfc-grid', 'rgba(127,127,127,.15)'),
    };
  }

  function applyLineTheme(instance) {
    const t = lineTheme();
    const last = instance.data.datasets.length - 1;
    instance.data.datasets.forEach((d, i) => {
      const headline = i === last;
      d.borderColor = headline ? t.line : t.quiet;
      d.pointBackgroundColor = d.borderColor;
      // The headline (e.g. "What it grew to") fades into the card like the app's portfolio chart.
      d.fill = headline ? 'origin' : false;
      d.backgroundColor = headline
        ? ({ chart: c }) => {
            if (!c.chartArea) return 'transparent';
            const g = c.ctx.createLinearGradient(0, c.chartArea.top, 0, c.chartArea.bottom);
            g.addColorStop(0, withAlpha(t.line, 0.45));
            g.addColorStop(1, withAlpha(t.line, 0));
            return g;
          }
        : t.quiet;
    });
    instance.options.plugins.legend.labels.color = t.muted;
    instance.options.scales.x.ticks.color = t.muted;
    instance.options.scales.y.ticks.color = t.muted;
    instance.options.scales.y.grid.color = t.grid;
  }

  function drawLine(figure, chart) {
    const box = el('div', 'mfc-chart-box');
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Chart: ${chart.title}`);
    box.append(canvas);
    figure.append(box);

    const dates = chart.series[0].points.map((p) => p[0]);
    const instance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: dates,
        // The last series is the headline (e.g. "What it grew to"); earlier ones are grey context.
        datasets: chart.series.map((s) => ({
          label: s.name,
          data: s.points.map((p) => p[1]),
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
          legend: { display: chart.series.length > 1, labels: { boxWidth: 12, boxHeight: 2 } },
          tooltip: {
            callbacks: {
              title: (items) => longDate(dates[items[0].dataIndex]),
              label: (ctx) => ` ${ctx.dataset.label}: ₹${inr.format(ctx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 4, maxRotation: 0, callback: (v) => monthYear(dates[v]) },
            grid: { display: false },
          },
          y: { ticks: { maxTicksLimit: 5, callback: compactInr }, grid: {} },
        },
      },
    });
    applyLineTheme(instance);
    instance.update('none');
    charts.push(instance);
    scrollToEnd();
  }

  /** Repaints line charts in the current theme (the host page's theme toggle, or the OS switching). */
  function restyleCharts() {
    for (const c of charts) {
      applyLineTheme(c);
      c.update('none');
    }
  }
  new MutationObserver(restyleCharts).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', restyleCharts);

  function addError(message, action) {
    const { wrap, body, content, time } = addMessage('assistant');
    wrap.classList.add('mfc-error');
    content.textContent = message;
    time.textContent = clock();
    if (action) {
      const btn = glassButton(action.label, 'mfc-glass-sm mfc-retry');
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
    endQuestions();
    input.value = '';
    autosize();
    const { wrap: userWrap, time: userTime } = addMessage('user', message);
    const sentAt = new Date();
    const { wrap, body, content, time } = addMessage('assistant');
    wrap.classList.add('mfc-pending');
    const typing = el('span', 'mfc-typing');
    typing.setAttribute('aria-label', 'Typing');
    typing.append(el('i'), el('i'), el('i'));
    content.append(typing);

    let reply = '';
    let frame = 0;
    // One status line under the bubble: each new step replaces the previous one.
    const activity = el('div', 'mfc-status');
    activity.setAttribute('role', 'status');
    const running = new Map(); // tool call id -> label
    let label = '';
    let slow = false;
    const bubble = content.parentElement;
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
      renderInto(content, reply);
      if (stick) scrollToEnd();
    };

    controller = new AbortController();
    setBusy(true);
    try {
      const extra = typeof o.body === 'function' ? o.body() : {};
      const answers = requestProfile();
      const res = await fetch(o.streamUrl, {
        method: 'POST',
        headers: headers(),
        credentials: o.credentials,
        body: JSON.stringify({
          ...extra,
          ...(answers && { profile: answers }),
          message,
          ...(conversationId && { conversation_id: conversationId }),
        }),
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
            stampUser(userTime, sentAt, true);
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
      const stick = nearBottom();
      paint();
      time.textContent = clock();
      addActions(body, content);
      if (stick) scrollToEnd();
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
        const { body, content } = addMessage(m.role, m.text, m.at);
        if (m.role !== 'assistant') continue;
        for (const c of m.charts ?? []) addChart(body, c);
        addActions(body, content);
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
      features.appName = typeof c.app_name === 'string' ? c.app_name : '';
      features.portfolio = Boolean(c.portfolio);
    } catch {
      /* settings only personalise the greeting */
    }
  }

  /** First thing in an empty chat: the quick questions if they were never offered, otherwise the greeting. */
  function greet() {
    if (needsQuestions()) startQuestions();
    else showWelcome();
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
    intro = null;
    welcomeAfterQuestions = false;
    charts.splice(0).forEach((c) => c.destroy());
    log.replaceChildren();
    root.classList.remove('mfc-has-messages');
    greet();
    if (finePointer) input.focus();
  }

  // ---------- one-time hello above the orb ----------
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
      bodyBtn.addEventListener('click', () => open());
      const dismiss = el('button', 'mfc-icon-btn');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.innerHTML = ICONS.close;
      dismiss.addEventListener('click', hideTeaser);
      teaser.append(bodyBtn, dismiss);
      root.append(teaser);
    }, 6000);
  }

  function isOpen() {
    return root.classList.contains('mfc-open');
  }
  function open(focus = true) {
    hideTeaser();
    root.classList.add('mfc-open');
    launcher.setAttribute('aria-expanded', 'true');
    // While the chat is open, the orb closes it.
    launcher.setAttribute('aria-label', 'Close chat');
    if (o.mode === 'floating') leftOpen.set('1');
    if (focus && finePointer) setTimeout(() => input.focus(), 50);
  }
  function close() {
    leftOpen.set(null);
    root.classList.remove('mfc-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', launcherLabel());
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
  // Reopen a chat the visitor left open on the previous page, without taking focus from the new page.
  if (o.mode === 'floating' && leftOpen.get()) open(false);
  // A late settings response still personalises the title and greeting.
  const settings = loadSettings().then(() => {
    syncTitle();
    refreshWelcome();
  });
  // Greet once the assistant's name is known and any earlier chat has loaded (or after a short wait).
  Promise.race([Promise.all([settings, loadHistory()]), new Promise((r) => setTimeout(r, 1500))]).then(() => {
    syncTitle();
    if (root.classList.contains('mfc-has-messages') || log.childElementCount) return;
    greet();
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
