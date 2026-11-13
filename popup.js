// Popup UI. Plain DOM, no framework: it opens instantly and uses almost no memory.

const MIN = 100;
const MAX = 250;
const STEP = 5;
const START_DEG = -135;
const SWEEP_DEG = 270;
const CX = 110;
const CY = 110;
const R = 88;
const LED_STEPS = [0.25, 1.25, 2.25, 3, 4.5, 6];

const $ = (id) => document.getElementById(id);
const els = {
  power: $('power'),
  dial: $('dial'),
  arc: $('arc'),
  knob: $('knob'),
  ticks: $('ticks'),
  num: $('num'),
  db: $('db'),
  protect: $('protect'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  leds: [...$('leds').children],
  error: $('error'),
  tabTitle: $('tabTitle'),
  tabSub: $('tabSub'),
  fav: $('fav'),
  favFallback: $('favFallback'),
  presets: [...document.querySelectorAll('.presets button')],
};

const state = {
  tabId: null,
  value: 150,
  protect: true,
  active: false,
  restricted: false,
  starting: null,
};

/* ---------- messaging ---------- */

function toBackground(type, data = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, tabId: state.tabId, ...data });
}

// Coalesce rapid changes (dragging the dial fires ~60 events/s) into one
// in-flight message at a time, always ending on the latest value.
let sending = false;
let dirty = false;
async function syncSettings() {
  if (sending) {
    dirty = true;
    return;
  }
  sending = true;
  try {
    do {
      dirty = false;
      const boost = state.value / 100;
      chrome.storage.local.set({ lastBoost: boost, protect: state.protect });
      if (state.active) await toBackground('update', { boost, protect: state.protect });
    } while (dirty);
  } catch {
    /* popup closing or engine gone; next open re-syncs */
  } finally {
    sending = false;
  }
}

/* ---------- geometry ---------- */

function polar(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

const valueToDeg = (v) => START_DEG + ((v - MIN) / (MAX - MIN)) * SWEEP_DEG;

function buildTicks() {
  const ns = els.ticks.namespaceURI; // the SVG namespace, read from the page
  const frag = document.createDocumentFragment();
  for (let v = MIN; v <= MAX; v += 12.5) {
    const major = v % 25 === 0;
    const [x1, y1] = polar(valueToDeg(v), 100);
    const [x2, y2] = polar(valueToDeg(v), major ? 107 : 104);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('class', major ? 'tick major' : 'tick');
    line.dataset.v = String(v);
    frag.appendChild(line);
  }
  els.ticks.appendChild(frag);
  els.tickLines = [...els.ticks.children];
}

/* ---------- rendering ---------- */

function render() {
  const v = state.value;
  const p = ((v - MIN) / (MAX - MIN)) * 100;
  els.arc.style.strokeDasharray = `${p} 100`;
  const [kx, ky] = polar(valueToDeg(v), R);
  els.knob.setAttribute('cx', kx.toFixed(2));
  els.knob.setAttribute('cy', ky.toFixed(2));
  for (const t of els.tickLines) t.classList.toggle('lit', Number(t.dataset.v) <= v);

  els.num.textContent = String(v);
  const db = 20 * Math.log10(v / 100);
  els.db.textContent = v === MIN ? 'Original volume' : `+${db.toFixed(1)} dB`;
  els.dial.setAttribute('aria-valuenow', String(v));
  els.dial.setAttribute('aria-valuetext', `${v} percent`);
  els.dial.style.setProperty('--glow-scale', String(0.85 + (p / 100) * 0.3));
  for (const b of els.presets) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v));

  els.power.setAttribute('aria-checked', String(state.active));
  els.protect.setAttribute('aria-checked', String(state.protect));
  document.body.classList.toggle('on', state.active);

  if (!state.restricted) {
    els.tabSub.textContent = state.active ? `Boosting to ${v}%` : 'Off — turn the dial to boost';
  }
  if (!state.active) setStatus('', state.restricted ? 'Unavailable on this page' : 'Off', 0);
}

let lastStatusKey = '';
function setStatus(level, text, leds) {
  const key = level + text + leds;
  if (key === lastStatusKey) return; // avoid needless DOM writes
  lastStatusKey = key;
  els.statusDot.className = 'dot' + (level ? ' ' + level : '');
  els.statusText.textContent = text;
  els.leds.forEach((led, i) => led.classList.toggle('on', i < leds));
}

function renderMeter(m) {
  if (!m) return;
  const red = Math.max(0, m.reductionDb);
  // Bars 1-3 (green) cover 0-3 dB, 4-5 (amber) 3-6 dB, 6 (red) beyond: same bands as the status dot.
  const leds = LED_STEPS.filter((s) => red > s).length;
  if (m.peakDb < -60) setStatus('ok', 'Waiting for sound', 0);
  else if (red < 0.5) setStatus('ok', 'Clean — no limiting needed', leds);
  else if (red < 3) setStatus('ok', `Clean — gentle limiting (−${red.toFixed(1)} dB)`, leds);
  else if (red < 6) setStatus('warn', `Limiting −${red.toFixed(1)} dB · still clean`, leds);
  else setStatus('hot', `Working hard −${red.toFixed(1)} dB · try a lower boost`, leds);
}

function showError(text) {
  els.error.textContent = text || '';
  els.error.hidden = !text;
}

/* ---------- actions ---------- */

function setValue(v, fromUser) {
  v = Math.min(MAX, Math.max(MIN, Math.round(v / STEP) * STEP));
  if (v === state.value) return;
  state.value = v;
  render();
  if (!fromUser) return;
  if (!state.active && !state.restricted && v > MIN) turnOn();
  else syncSettings();
}

function turnOn() {
  if (state.restricted || state.active) return Promise.resolve();
  if (state.starting) return state.starting;
  showError('');
  els.power.classList.add('busy');
  state.starting = (async () => {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tabId });
      const res = await toBackground('start', {
        streamId,
        boost: state.value / 100,
        protect: state.protect,
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start.');
      state.active = true;
      render();
      syncSettings(); // catch anything changed while starting
      pollMeter();
    } catch (err) {
      showError(friendlyError(err));
    } finally {
      els.power.classList.remove('busy');
      state.starting = null;
    }
  })();
  return state.starting;
}

async function turnOff() {
  showError('');
  state.active = false;
  render();
  try {
    await toBackground('stop');
  } catch (err) {
    showError(friendlyError(err));
  }
}

const toggle = () => (state.active ? turnOff() : turnOn());

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/chrome:|Chrome pages|cannot be captured|not been invoked/i.test(msg)) {
    return "Chrome doesn't allow boosting this page.";
  }
  if (/active stream/i.test(msg)) {
    return 'Another extension or app is already capturing this tab. Stop it, then try again.';
  }
  return msg;
}

/* ---------- meter polling (only while the popup is open and boosting) ---------- */

let polling = false;
async function pollMeter() {
  if (polling) return;
  polling = true;
  while (state.active) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'getMeter', tabId: state.tabId });
      if (state.active) renderMeter(res && res.meter);
    } catch {
      /* engine not ready yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  polling = false;
}

/* ---------- dial input ---------- */

function valueFromPointer(e) {
  const rect = els.dial.getBoundingClientRect();
  const dx = e.clientX - rect.left - CX;
  const dy = e.clientY - rect.top - CY;
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (Math.abs(deg) > -START_DEG) {
    // In the gap under the dial: stick to whichever end we're nearer.
    return state.value >= (MIN + MAX) / 2 ? MAX : MIN;
  }
  return MIN + ((deg - START_DEG) / SWEEP_DEG) * (MAX - MIN);
}

function bindDial() {
  const dial = els.dial;
  dial.addEventListener('pointerdown', (e) => {
    if (state.restricted || e.button !== 0) return;
    dial.setPointerCapture(e.pointerId);
    setValue(valueFromPointer(e), true);
  });
  dial.addEventListener('pointermove', (e) => {
    if (dial.hasPointerCapture(e.pointerId)) setValue(valueFromPointer(e), true);
  });
  dial.addEventListener(
    'wheel',
    (e) => {
      if (state.restricted) return;
      e.preventDefault();
      setValue(state.value + (e.deltaY < 0 ? STEP : -STEP), true);
    },
    { passive: false }
  );
  dial.addEventListener('keydown', (e) => {
    if (state.restricted) return;
    const keys = {
      ArrowUp: state.value + STEP,
      ArrowRight: state.value + STEP,
      ArrowDown: state.value - STEP,
      ArrowLeft: state.value - STEP,
      PageUp: state.value + 25,
      PageDown: state.value - 25,
      Home: MIN,
      End: MAX,
    };
    if (e.key in keys) {
      e.preventDefault();
      setValue(keys[e.key], true);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  });
}

/* ---------- tab info ---------- */

// Browser-internal pages can't be captured. Other blocked pages (like the extension
// store) are caught when capture fails and get the same friendly message.
const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source|chrome-search):/i;

function showTab(tab) {
  els.tabTitle.textContent = tab.title || 'This tab';
  if (tab.favIconUrl && /^(https?|data):/i.test(tab.favIconUrl)) {
    els.fav.addEventListener('load', () => {
      els.fav.hidden = false;
      els.favFallback.style.display = 'none';
    });
    els.fav.src = tab.favIconUrl;
  }
  if (tab.url && RESTRICTED.test(tab.url)) {
    state.restricted = true;
    els.tabSub.textContent = "Chrome doesn't allow audio capture here";
    els.power.disabled = true;
    els.dial.setAttribute('aria-disabled', 'true');
    els.presets.forEach((b) => (b.disabled = true));
  }
}

/* ---------- init ---------- */

async function init() {
  buildTicks();
  bindDial();

  els.power.addEventListener('click', toggle);
  els.protect.addEventListener('click', () => {
    state.protect = !state.protect;
    render();
    syncSettings();
  });
  els.presets.forEach((b) => b.addEventListener('click', () => setValue(Number(b.dataset.v), true)));

  const [[tab], prefs] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get(['lastBoost', 'protect']),
  ]);
  if (typeof prefs.lastBoost === 'number') state.value = Math.round(prefs.lastBoost * 100);
  if (typeof prefs.protect === 'boolean') state.protect = prefs.protect;

  if (!tab) {
    state.restricted = true;
    render();
    return;
  }
  state.tabId = tab.id;
  showTab(tab);

  if (!state.restricted) {
    const s = await toBackground('getState').catch(() => null);
    if (s && s.active) {
      state.active = true;
      state.value = Math.round(s.boost * 100);
      state.protect = s.protect;
      pollMeter();
    }
  }
  render();
  els.dial.focus();
}

init();
