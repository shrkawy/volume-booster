// Service worker: keeps track of which tabs are boosted and owns the
// offscreen document where the actual audio processing runs.

const OFFSCREEN_PATH = 'offscreen.html';
let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Processes captured tab audio to raise its volume with a limiter.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function closeOffscreenIfIdle() {
  const tabs = await getTabs();
  if (Object.keys(tabs).length === 0 && (await hasOffscreen())) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

// Per-tab state lives in session storage so it survives service-worker restarts.
async function getTabs() {
  const { tabs } = await chrome.storage.session.get('tabs');
  return tabs || {};
}

async function setTab(tabId, value) {
  const tabs = await getTabs();
  if (value) tabs[tabId] = value;
  else delete tabs[tabId];
  await chrome.storage.session.set({ tabs });
}

function setBadge(tabId, boost) {
  const text = boost ? String(Math.round(boost * 100)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (boost) chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

async function startTab({ tabId, streamId, boost, protect }) {
  await ensureOffscreen();
  const res = await sendToOffscreen({ type: 'start', tabId, streamId, boost, protect });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start audio processing.');
  await setTab(tabId, { boost, protect });
  setBadge(tabId, boost);
}

async function updateTab({ tabId, boost, protect }) {
  const tabs = await getTabs();
  if (!tabs[tabId]) return;
  await sendToOffscreen({ type: 'update', tabId, boost, protect });
  await setTab(tabId, { boost, protect });
  setBadge(tabId, boost);
}

async function stopTab(tabId) {
  const tabs = await getTabs();
  if (!tabs[tabId]) return;
  if (await hasOffscreen()) {
    await sendToOffscreen({ type: 'stop', tabId }).catch(() => {});
  }
  await setTab(tabId, null);
  setBadge(tabId, null);
  await closeOffscreenIfIdle();
}

const handlers = {
  async getState({ tabId }) {
    const tabs = await getTabs();
    // If the browser dropped the offscreen document, the stored state is stale.
    if (tabs[tabId] && !(await hasOffscreen())) {
      await setTab(tabId, null);
      setBadge(tabId, null);
      return { active: false };
    }
    return tabs[tabId] ? { active: true, ...tabs[tabId] } : { active: false };
  },
  async start(msg) {
    await startTab(msg);
    return { ok: true };
  },
  async update(msg) {
    await updateTab(msg);
    return { ok: true };
  },
  async stop({ tabId }) {
    await stopTab(tabId);
    return { ok: true };
  },
  async captureEnded({ tabId }) {
    await setTab(tabId, null);
    setBadge(tabId, null);
    await closeOffscreenIfIdle();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'background' || !handlers[msg.type]) return false;
  handlers[msg.type](msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopTab(tabId).catch(() => {});
});
