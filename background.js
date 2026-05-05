/**
 * background.js — Smart Element Copier v6
 *
 * NEW IN V6:
 * ──────────────────────────────────────────────────────────────
 * 1. chrome.storage.session for tab state (survives SW restart)
 * 2. Copy history stored in chrome.storage.local (last 10 exports)
 * 3. Context menu: right-click → "Copy element as…" sub-menu
 * 4. Keyboard command support (Alt+Shift+C toggles picker)
 */

'use strict';

// ─── Context Menu Setup ───────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id:'sec-root',        title:'Copy element with Smart Copier', contexts:['all'] });
    chrome.contextMenus.create({ id:'sec-html',        parentId:'sec-root', title:'Clean HTML',   contexts:['all'] });
    chrome.contextMenus.create({ id:'sec-jsx',         parentId:'sec-root', title:'React JSX',    contexts:['all'] });
    chrome.contextMenus.create({ id:'sec-tailwind',    parentId:'sec-root', title:'Tailwind CSS', contexts:['all'] });
    chrome.contextMenus.create({ id:'sec-bootstrap',   parentId:'sec-root', title:'Bootstrap 5',  contexts:['all'] });
    chrome.contextMenus.create({ id:'sec-text',        parentId:'sec-root', title:'Text Only',    contexts:['all'] });
    chrome.contextMenus.create({ id:'sec-svg',         parentId:'sec-root', title:'SVG Code',     contexts:['all'] });
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const modeMap = {
    'sec-html': 'html', 'sec-jsx': 'jsx', 'sec-tailwind': 'tailwind',
    'sec-bootstrap': 'bootstrap', 'sec-text': 'text', 'sec-svg': 'svg',
  };
  const mode = modeMap[info.menuItemId];
  if (!mode) return;
  try {
    await ensureInjected(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'SEC_START', mode, bundleImages: false });
  } catch {}
});

// ─── Keyboard Command ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'activate-picker') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id) return;
  try {
    await ensureInjected(tab.id);
    const state = await getSessionState(tab.id);
    const msg = state?.active
      ? { type: 'SEC_STOP' }
      : { type: 'SEC_START', mode: 'html', bundleImages: false };
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {}
});

// ─── Session State ────────────────────────────────────────────────────────────

async function getSessionState(tabId) {
  try {
    const res = await chrome.storage.session.get(`tab_${tabId}`);
    return res[`tab_${tabId}`] || null;
  } catch { return null; }
}

async function setSessionState(tabId, state) {
  try { await chrome.storage.session.set({ [`tab_${tabId}`]: state }); } catch {}
}

async function clearSessionState(tabId) {
  try { await chrome.storage.session.remove(`tab_${tabId}`); } catch {}
}

// ─── Copy History ─────────────────────────────────────────────────────────────

const HISTORY_KEY = 'sec_history';
const HISTORY_MAX = 10;

async function addToHistory(entry) {
  try {
    const res  = await chrome.storage.local.get(HISTORY_KEY);
    const list = res[HISTORY_KEY] || [];
    list.unshift(entry);
    if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
    await chrome.storage.local.set({ [HISTORY_KEY]: list });
  } catch {}
}

// ─── Script Injection ─────────────────────────────────────────────────────────

async function ensureInjected(tabId) {
  const pong = await chrome.tabs.sendMessage(tabId, { type: 'SEC_PING' }).catch(() => null);
  if (pong?.ok) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['core-engine.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'SEC_START' || msg.type === 'SEC_STOP' || msg.type === 'SEC_PING') {
    handleFromPopup(msg, sendResponse);
    return true;
  }

  if (msg.type === 'SEC_STATUS' || msg.type === 'SEC_PROGRESS') {
    const tabId = sender.tab?.id;
    if (tabId) {
      const isActive = msg.status === 'selecting' || msg.status === 'processing';
      setSessionState(tabId, { active: isActive, status: msg.status, mode: msg.mode });
      updateBadge(tabId, msg.status);
      if (msg.status === 'copied') {
        addToHistory({
          ts:       Date.now(),
          mode:     msg.mode,
          bytes:    msg.bytes,
          elapsed:  msg.elapsedMs,
          tabUrl:   sender.tab?.url || '',
          tabTitle: sender.tab?.title || '',
        });
      }
    }
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  if (msg.type === 'SEC_STORE_HTML') {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return false;
  }

  if (msg.type === 'SEC_CLIPBOARD_WRITE') {
    handleClipboardRelay(msg.text, sender.tab?.id, sendResponse);
    return true;
  }

  if (msg.type === 'SEC_GET_HISTORY') {
    chrome.storage.local.get(HISTORY_KEY)
      .then(res => sendResponse({ ok: true, history: res[HISTORY_KEY] || [] }))
      .catch(() => sendResponse({ ok: true, history: [] }));
    return true;
  }

  if (msg.type === 'SEC_CLEAR_HISTORY') {
    chrome.storage.local.remove(HISTORY_KEY)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

// ─── Popup Message Handler ────────────────────────────────────────────────────

async function handleFromPopup(msg, sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
        url.startsWith('edge://') || url.startsWith('about:') || url.startsWith('data:')) {
      throw new Error('Cannot run on this page type');
    }

    if (msg.type === 'SEC_START') await ensureInjected(tab.id);

    const response = await chrome.tabs.sendMessage(tab.id, msg).catch(() => null);
    sendResponse({ ok: true, ...(response || {}) });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ─── Clipboard Relay ──────────────────────────────────────────────────────────

async function handleClipboardRelay(text, tabId, sendResponse) {
  if (!tabId) { sendResponse({ ok: false, error: 'No tab context' }); return; }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (t) => {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus({ preventScroll: true });
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      },
      args: [text],
    });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ─── Badge Management ─────────────────────────────────────────────────────────

const BADGE = {
  selecting:  { text:'●', color:'#3b82f6' },
  processing: { text:'…', color:'#f59e0b' },
  copied:     { text:'✓', color:'#10b981' },
  error:      { text:'!', color:'#ef4444' },
  idle:       { text:'',  color:'#666666' },
  cancelled:  { text:'',  color:'#666666' },
  stopped:    { text:'',  color:'#666666' },
};

function updateBadge(tabId, status) {
  const cfg = BADGE[status] || BADGE.idle;
  chrome.action.setBadgeText({ tabId, text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
  if (status === 'copied' || status === 'error') {
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 3000);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearSessionState(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(tabId => clearSessionState(tabId));