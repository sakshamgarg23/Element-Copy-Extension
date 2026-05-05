/**
 * popup.js — Smart Element Copier v6
 *
 * NEW IN V6:
 * • History panel — shows last 10 copies with mode, size, source
 * • History clear button
 * • historyToggleBtn in header toggles between main and history panels
 * • Alt+Shift+C shortcut hint shown in footer
 */

'use strict';

const $ = id => document.getElementById(id);

const actionBtn         = $('actionBtn');
const actionIcon        = $('actionIcon');
const actionLabel       = $('actionLabel');
const statusDot         = $('statusDot');
const statusText        = $('statusText');
const statusHint        = $('statusHint');
const statsPill         = $('statsPill');
const statsText         = $('statsText');
const tipIdle           = $('tipIdle');
const tipSelecting      = $('tipSelecting');
const tipProcessing     = $('tipProcessing');
const tipProcessingText = $('tipProcessingText');
const tipSuccess        = $('tipSuccess');
const tipError          = $('tipError');
const downloadBtn       = $('downloadBtn');
const footerHint        = $('footerHint');
const bundleToggle      = $('bundleToggle');
const historyToggleBtn  = $('historyToggleBtn');
const mainPanel         = $('mainPanel');
const historyPanel      = $('historyPanel');
const historyList       = $('historyList');
const historyEmpty      = $('historyEmpty');
const historyClearBtn   = $('historyClearBtn');

const local = {
  active:       false,
  mode:         'html',
  bundleImages: false,
  lastHtml:     null,
  showHistory:  false,
};

// ─── Icons ────────────────────────────────────────────────────────────────────

const ICON = {
  cursor: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-7 1-4 7-3-17z"/></svg>`,
  stop:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
  loader: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  text:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  tw:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.5 2 3.5 7.5 5 12c1.5-3 4.5-4.5 6-3-2.314 2.314-3 5.5-1.5 8.5C5.5 21 2 18 2 12 2 6.48 6.48 2 12 2z"/><path d="M12 22c5.5 0 8.5-5.5 7-10-1.5 3-4.5 4.5-6 3 2.314-2.314 3-5.5 1.5-8.5C18.5 3 22 6 22 12c0 5.52-4.48 10-10 10z"/></svg>`,
  bs:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 17V7h5.5a3 3 0 0 1 0 6H7m5.5 0H7v4"/></svg>`,
  svg:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8l4 4-4 4"/></svg>`,
};

const MODE_META = {
  html:      { label:'Start Selecting', btnClass:'',         icon:'cursor', outputLabel:'HTML'      },
  document:  { label:'Start Selecting', btnClass:'',         icon:'cursor', outputLabel:'Document'  },
  jsx:       { label:'Start Selecting', btnClass:'',         icon:'cursor', outputLabel:'React JSX' },
  text:      { label:'Copy Text',       btnClass:'txt-mode', icon:'text',   outputLabel:'Text'      },
  tailwind:  { label:'Export Tailwind', btnClass:'tw-mode',  icon:'tw',     outputLabel:'Tailwind'  },
  bootstrap: { label:'Export Bootstrap',btnClass:'bs-mode',  icon:'bs',     outputLabel:'Bootstrap' },
  svg:       { label:'Copy SVG Code',   btnClass:'svg-mode', icon:'svg',    outputLabel:'SVG'       },
};

// ─── Mode selector ────────────────────────────────────────────────────────────

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (local.active) return;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    local.mode = btn.dataset.mode;
    updateActionIdle();
  });
});

// ─── Bundle toggle ────────────────────────────────────────────────────────────

$('bundleImagesToggle').addEventListener('click', () => {
  local.bundleImages = !local.bundleImages;
  bundleToggle.classList.toggle('on', local.bundleImages);
});

// ─── History panel toggle ─────────────────────────────────────────────────────

historyToggleBtn.addEventListener('click', () => {
  local.showHistory = !local.showHistory;
  historyToggleBtn.classList.toggle('active', local.showHistory);
  mainPanel.classList.toggle('hidden', local.showHistory);
  historyPanel.classList.toggle('hidden', !local.showHistory);
  if (local.showHistory) loadHistory();
});

historyClearBtn.addEventListener('click', async () => {
  await send({ type: 'SEC_CLEAR_HISTORY' });
  renderHistory([]);
});

async function loadHistory() {
  const res = await send({ type: 'SEC_GET_HISTORY' });
  renderHistory(res?.history || []);
}

function renderHistory(list) {
  // Clear existing items (keep #historyEmpty)
  [...historyList.children].forEach(c => {
    if (c !== historyEmpty) c.remove();
  });

  if (!list.length) {
    historyEmpty.style.display = 'block';
    return;
  }
  historyEmpty.style.display = 'none';

  const LABELS = { html:'HTML', document:'Doc', jsx:'JSX', text:'Text', tailwind:'TW', bootstrap:'BS5', svg:'SVG' };

  list.forEach(item => {
    const size = !item.bytes ? '' : item.bytes < 1024
      ? `${item.bytes}B` : `${(item.bytes/1024).toFixed(1)}KB`;

    const ago = timeAgo(item.ts);
    const domain = (() => { try { return new URL(item.tabUrl).hostname; } catch { return ''; } })();
    const title = item.tabTitle || domain || 'Unknown page';

    const row = document.createElement('div');
    row.className = 'history-item';
    row.title = `Copied from: ${item.tabUrl}`;
    row.innerHTML = `
      <span class="history-badge m-${item.mode}">${LABELS[item.mode] || item.mode}</span>
      <div class="history-info">
        <div class="history-title">${escHtml(title)}</div>
        <div class="history-meta">${ago}${domain ? ' · ' + escHtml(domain) : ''}</div>
      </div>
      <span class="history-size">${size}</span>
    `;
    historyList.appendChild(row);
  });
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400)return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Action button ────────────────────────────────────────────────────────────

actionBtn.addEventListener('click', async () => {
  if (local.active) {
    await send({ type: 'SEC_STOP' });
    applyState('idle');
    return;
  }
  actionBtn.disabled = true;
  const res = await send({ type: 'SEC_START', mode: local.mode, bundleImages: local.bundleImages });
  actionBtn.disabled = false;
  if (!res?.ok) {
    applyState('error', { error: res?.error || 'Could not activate on this page' });
  } else {
    applyState('selecting');
  }
});

// ─── Download ─────────────────────────────────────────────────────────────────

downloadBtn.addEventListener('click', () => {
  if (!local.lastHtml) return;
  const ext  = local.mode === 'jsx' ? 'jsx' : 'html';
  const mime = local.mode === 'jsx' ? 'text/plain' : 'text/html';
  const blob = new Blob([local.lastHtml], { type: mime });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href: url, download: `element-${Date.now()}.${ext}`,
  }).click();
  URL.revokeObjectURL(url);
});

// ─── UI State Machine ─────────────────────────────────────────────────────────

function updateActionIdle() {
  const m = MODE_META[local.mode] || MODE_META.html;
  actionBtn.className = `action-btn ${m.btnClass}`.trim();
  actionIcon.innerHTML = ICON[m.icon] || ICON.cursor;
  actionLabel.textContent = m.label;
}

function applyState(state, payload = {}) {
  [tipIdle, tipSelecting, tipProcessing, tipSuccess, tipError].forEach(t => {
    t.classList.remove('active'); t.classList.add('hidden');
  });
  downloadBtn.classList.add('hidden');
  statsPill.classList.add('hidden');
  statusHint.textContent = '';
  footerHint.textContent = '';

  const m = MODE_META[local.mode] || MODE_META.html;

  switch (state) {
    case 'idle':
      local.active = false;
      updateActionIdle();
      setStatus('ready', 'Ready to inspect');
      showTip(tipIdle);
      break;

    case 'selecting':
      local.active = true;
      actionBtn.className = 'action-btn stop';
      actionIcon.innerHTML = ICON.stop;
      actionLabel.textContent = 'Cancel';
      setStatus('active', local.mode === 'text' ? 'Click to copy text' : 'Hover & click an element');
      showTip(tipSelecting);
      break;

    case 'processing':
      actionBtn.className = 'action-btn processing';
      actionIcon.innerHTML = ICON.loader;
      actionLabel.textContent = 'Working…';
      const processingMsg = {
        text: 'Copying text…', tailwind: 'Converting to Tailwind…',
        bootstrap: 'Converting to Bootstrap…', jsx: 'Building component…',
        svg: 'Extracting SVG…',
      }[local.mode] || 'Extracting styles…';
      tipProcessingText.textContent = processingMsg;
      setStatus('processing', processingMsg);
      showTip(tipProcessing);
      break;

    case 'copied': {
      local.active = false;
      updateActionIdle();

      const { mode, bytes, sharedClasses, elapsedMs } = payload;
      const size = !bytes ? '' : bytes < 1024 ? `${bytes}B` : `${(bytes/1024).toFixed(1)}KB`;
      const label = MODE_META[mode]?.outputLabel || mode;

      setStatus('success', `Copied as ${label}`);
      statusHint.textContent = size;

      if (mode !== 'text' && sharedClasses !== undefined) {
        statsText.textContent = sharedClasses > 0
          ? `${sharedClasses} classes · ${elapsedMs}ms`
          : `${elapsedMs}ms`;
        statsPill.classList.remove('hidden');
      }

      tipSuccess.textContent = `✓ ${size} copied to clipboard`;
      showTip(tipSuccess);

      if (['html','document','jsx'].includes(mode) && local.lastHtml) {
        downloadBtn.classList.remove('hidden');
      }

      // Refresh history if panel is open
      if (local.showHistory) loadHistory();

      setTimeout(() => applyState('idle'), 4000);
      break;
    }

    case 'error':
      local.active = false;
      updateActionIdle();
      setStatus('error', 'Something went wrong');
      tipError.textContent = '⚠ ' + (payload.error || 'Unknown error');
      showTip(tipError);
      footerHint.textContent = 'Try reloading the tab';
      setTimeout(() => applyState('idle'), 5000);
      break;

    case 'cancelled':
    case 'stopped':
      applyState('idle');
      break;
  }
}

function setStatus(type, text) {
  statusDot.className = 'status-dot';
  statusText.textContent = text;
  if (type === 'active')     statusDot.classList.add('active');
  if (type === 'success')    statusDot.classList.add('success');
  if (type === 'error')      statusDot.classList.add('error');
  if (type === 'processing') statusDot.classList.add('processing');
}

function showTip(el) {
  el.classList.remove('hidden'); el.classList.add('active');
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false });
    });
  });
}

chrome.runtime.onMessage.addListener(msg => {
  if (!msg?.type) return;
  if (msg.type === 'SEC_STATUS') {
    switch (msg.status) {
      case 'selecting':  applyState('selecting');  break;
      case 'processing': applyState('processing'); break;
      case 'copied':     applyState('copied', msg); break;
      case 'cancelled':  applyState('cancelled');  break;
      case 'stopped':    applyState('stopped');    break;
      case 'error':      applyState('error', { error: msg.error }); break;
    }
  }
  if (msg.type === 'SEC_STORE_HTML') local.lastHtml = msg.html;
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  const res = await send({ type: 'SEC_PING' });
  if (res?.active) {
    if (res.mode) {
      local.mode = res.mode;
      document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === local.mode);
      });
    }
    applyState('selecting');
  } else {
    applyState('idle');
  }
})();