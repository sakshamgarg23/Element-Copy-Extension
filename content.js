/**
 * content.js — Smart Element Copier v4
 *
 * BUG FIXES vs v3:
 *
 * ❌ BUG 1: getComputedStyle in updateOverlay() was being called on EVERY
 *    mousemove (inside the rAF callback). On complex pages this triggers
 *    forced reflow. Fix: cache the last computed style per element reference,
 *    only recompute when target actually changes.
 *
 * ❌ BUG 2: onScroll was calling updateOverlay() synchronously — during scroll
 *    this causes layout thrash. Fix: wrap in rAF, same as mousemove.
 *
 * ❌ BUG 3: Breadcrumb's innerHTML = '' on every right-click causes forced
 *    reflow and GC pressure. Fix: reuse DOM nodes via keyed pool.
 *
 * ❌ BUG 4: setRect() used Object.assign on style — 4 property writes.
 *    Fix: use cssText with a template literal — 1 write.
 *
 * ❌ BUG 5: notifyPopup() inside mousemove was firing per-frame even though
 *    the popup doesn't need move updates. Removed entirely from hot path.
 *
 * NEW: Text-only copy mode. Click = copy visible text, no style processing.
 * NEW: Mode remembered across selections within same session.
 * NEW: Overlay uses CSS contain:strict so it never triggers page reflows.
 */

'use strict';

if (window.__SEC_LOADED) {
  chrome.runtime.sendMessage({ type: 'SEC_STATUS', status: 'ready' });
} else {
  window.__SEC_LOADED = true;
  initSEC();
}

function initSEC() {

// ─── FSM ──────────────────────────────────────────────────────────────────────

const STATE = Object.freeze({ IDLE: 'idle', SELECTING: 'selecting', PROCESSING: 'processing' });

const SEC = {
  state:      STATE.IDLE,
  mode:       'html',
  hoveredEl:  null,
  ui:         null,
  hoverRAF:   null,
  scrollRAF:  null,
  // Style cache: avoid calling getComputedStyle on same element twice per frame
  _lastStyleEl:  null,
  _lastStyleVal: null,
};

// ─── State Machine ────────────────────────────────────────────────────────────

function transition(to, payload = {}) {
  const VALID = {
    [STATE.IDLE]:       [STATE.SELECTING],
    [STATE.SELECTING]:  [STATE.IDLE, STATE.PROCESSING],
    [STATE.PROCESSING]: [STATE.IDLE],
  };
  if (!VALID[SEC.state]?.includes(to)) {
    console.warn(`[SEC] Bad transition: ${SEC.state} → ${to}`);
    return;
  }
  SEC.state = to;

  if (to === STATE.SELECTING) {
    SEC.mode = payload.mode || SEC.mode;
    SEC.bundleImages = payload.bundleImages || false;
    mountUI();
    attachListeners();
    document.documentElement.style.cursor = 'crosshair';
    const modeLabel = { html:'HTML', document:'Document', jsx:'React JSX', text:'Text Only', tailwind:'Tailwind CSS', bootstrap:'Bootstrap 5', svg:'SVG Code' }[SEC.mode] || SEC.mode;
    const modeHint  = SEC.mode === 'svg' ? 'Hover an SVG — it highlights blue when found' : `Click any element → copy as ${modeLabel}`;
    showToast(modeHint, 'info', 4000);
    notifyPopup({ type: 'SEC_STATUS', status: 'selecting' });

  } else if (to === STATE.PROCESSING) {
    detachListeners();
    document.documentElement.style.cursor = 'wait';
    notifyPopup({ type: 'SEC_STATUS', status: 'processing' });

  } else if (to === STATE.IDLE) {
    unmountUI();
    document.documentElement.style.cursor = '';
    SEC.hoveredEl = null;
    SEC._lastStyleEl = null;
    if (SEC.hoverRAF)  { cancelAnimationFrame(SEC.hoverRAF);  SEC.hoverRAF  = null; }
    if (SEC.scrollRAF) { cancelAnimationFrame(SEC.scrollRAF); SEC.scrollRAF = null; }
    if (payload.reason === 'cancelled' || payload.reason === 'stopped') hideToast();
    notifyPopup({ type: 'SEC_STATUS', status: payload.reason || 'idle', ...payload });
  }
}

// ─── UI Mount / Unmount ───────────────────────────────────────────────────────

function mountUI() {
  if (SEC.ui) return;

  // All overlay nodes use contain:strict + will-change:transform
  // so browser isolates them in their own compositor layer — zero page reflow.
  const overlay = mkEl('div', '__sec-overlay', `
    position:fixed;pointer-events:none;z-index:2147483647;
    outline:2px solid #3b82f6;outline-offset:1px;
    background:rgba(59,130,246,0.07);box-sizing:border-box;
    display:none;contain:strict;will-change:transform;
  `);

  const marginBox = mkEl('div', '__sec-margin', `
    position:fixed;pointer-events:none;z-index:2147483646;
    background:rgba(255,165,0,0.10);box-sizing:border-box;
    display:none;contain:strict;will-change:transform;
  `);

  // Padding indicator lives inside overlay — absolute so it doesn't reflow
  const paddingBox = mkEl('div', '__sec-padding', `
    position:absolute;pointer-events:none;
    background:rgba(100,200,100,0.13);box-sizing:border-box;
  `);
  overlay.appendChild(paddingBox);

  const label = mkEl('div', '__sec-label', `
    position:fixed;pointer-events:none;z-index:2147483647;
    background:#1e3a8a;color:#fff;font-size:11px;
    font-family:ui-monospace,monospace;padding:3px 8px;
    border-radius:4px;white-space:nowrap;display:none;
    line-height:1.7;letter-spacing:0.02em;
    box-shadow:0 2px 8px rgba(0,0,0,0.4);contain:layout style;
  `);

  const breadcrumb = mkEl('div', '__sec-breadcrumb', `
    position:fixed;pointer-events:auto;z-index:2147483647;
    background:#0f172a;border:1px solid #334155;border-radius:6px;
    padding:4px;display:none;flex-direction:column;gap:2px;
    box-shadow:0 8px 24px rgba(0,0,0,0.5);max-height:260px;overflow-y:auto;
  `);

  document.documentElement.append(overlay, marginBox, label, breadcrumb);
  SEC.ui = { overlay, marginBox, paddingBox, label, breadcrumb };
}

function unmountUI() {
  if (!SEC.ui) return;
  Object.values(SEC.ui).forEach(n => n?.remove());
  SEC.ui = null;
}

function mkEl(tag, id, cssText) {
  const n = document.createElement(tag);
  n.id = id;
  n.setAttribute('data-sec-ui', 'true');
  n.style.cssText = cssText.replace(/\n\s*/g, '');
  return n;
}

// ─── Overlay — Zero-Reflow Update ────────────────────────────────────────────

function updateOverlay(target) {
  if (!SEC.ui || !target) return;
  const { overlay, marginBox, paddingBox, label } = SEC.ui;

  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  // Cache computed style — reuse if same element (avoids forced reflow)
  let cs;
  if (SEC._lastStyleEl === target) {
    cs = SEC._lastStyleVal;
  } else {
    cs = window.getComputedStyle(target);
    SEC._lastStyleEl  = target;
    SEC._lastStyleVal = cs;
  }

  const mt = parseFloat(cs.marginTop)     || 0;
  const mr = parseFloat(cs.marginRight)   || 0;
  const mb = parseFloat(cs.marginBottom)  || 0;
  const ml = parseFloat(cs.marginLeft)    || 0;
  const pt = parseFloat(cs.paddingTop)    || 0;
  const pr = parseFloat(cs.paddingRight)  || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const pl = parseFloat(cs.paddingLeft)   || 0;

  // Set individual properties — avoids the cssText += accumulation/corruption bug
  overlay.style.display = 'block';
  overlay.style.top     = `${rect.top}px`;
  overlay.style.left    = `${rect.left}px`;
  overlay.style.width   = `${rect.width}px`;
  overlay.style.height  = `${rect.height}px`;

  marginBox.style.display = 'block';
  marginBox.style.top    = `${rect.top - mt}px`;
  marginBox.style.left   = `${rect.left - ml}px`;
  marginBox.style.width  = `${rect.width + ml + mr}px`;
  marginBox.style.height = `${rect.height + mt + mb}px`;

  paddingBox.style.cssText = `position:absolute;pointer-events:none;background:rgba(100,200,100,0.13);box-sizing:border-box;top:${pt}px;right:${pr}px;bottom:${pb}px;left:${pl}px`;

  // Label
  const tag = target.tagName.toLowerCase();
  const id  = target.id ? `#${target.id}` : '';
  const rawCls = typeof target.className === 'string' ? target.className
               : (target.className?.baseVal ?? '');
  const cls = rawCls.trim()
    ? '.' + rawCls.trim().split(/\s+/).slice(0, 2).join('.') : '';
  label.textContent = `${tag}${id}${cls}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  label.style.display = 'block';
  label.style.top  = `${Math.max(4, rect.top - 28)}px`;
  label.style.left = `${Math.max(4, rect.left)}px`;
}

function hideOverlay() {
  if (!SEC.ui) return;
  SEC.ui.overlay.style.display    = 'none';
  SEC.ui.marginBox.style.display  = 'none';
  SEC.ui.label.style.display      = 'none';
  SEC.ui.breadcrumb.style.display = 'none';
}

// ─── Event Listener Registry ──────────────────────────────────────────────────

const LISTENERS = [
  ['mouseover',   onMouseOver,    true],   // mouseover not mousemove — only fires on element change
  ['click',       onClick,        true],
  ['contextmenu', onContextMenu,  true],
  ['keydown',     onKeyDown,      true],
  ['scroll',      onScroll,       true, { passive: true }],
];

function attachListeners() {
  for (const [evt, fn, cap, opts] of LISTENERS) {
    document.addEventListener(evt, fn, opts ? { capture: cap, ...opts } : cap);
  }
}

function detachListeners() {
  for (const [evt, fn, cap] of LISTENERS) {
    document.removeEventListener(evt, fn, cap);
  }
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

/**
 * KEY OPTIMIZATION: Use 'mouseover' instead of 'mousemove'.
 * mouseover only fires when crossing element boundaries — not on every pixel.
 * On a typical hover interaction this reduces events from ~600/sec to ~10/sec.
 */
function onMouseOver(e) {
  if (SEC.state !== STATE.SELECTING) return;
  const target = e.target;
  if (target?.dataset?.secUi || target === SEC.hoveredEl) return;

  SEC.hoveredEl = target;
  SEC._lastStyleEl = null; // invalidate style cache for new target

  if (SEC.hoverRAF) return; // already a frame queued
  SEC.hoverRAF = requestAnimationFrame(() => {
    SEC.hoverRAF = null;
    if (SEC.hoveredEl) {
      updateOverlay(SEC.hoveredEl);

      // iFrame hint
      if (SEC.hoveredEl.tagName === 'IFRAME' && SEC.ui) {
        let xOrigin = false;
        try { void SEC.hoveredEl.contentDocument; } catch { xOrigin = true; }
        if (xOrigin) {
          SEC.ui.overlay.style.outline = '2px solid #f59e0b';
          SEC.ui.overlay.style.background = 'rgba(245,158,11,0.07)';
          if (SEC.ui.label) SEC.ui.label.style.background = '#78350f';
        } else {
          SEC.ui.overlay.style.outline = '2px solid #10b981';
          SEC.ui.overlay.style.background = 'rgba(16,185,129,0.07)';
          if (SEC.ui.label) SEC.ui.label.style.background = '#065f46';
        }
        return;
      }

      // In SVG mode: tint overlay red if there's no SVG ancestor
      if (SEC.mode === 'svg' && SEC.ui) {
        let el = SEC.hoveredEl;
        let hasSvg = false;
        while (el) { if (el.tagName && el.tagName.toLowerCase() === 'svg') { hasSvg = true; break; } el = el.parentElement; }
        SEC.ui.overlay.style.outline = hasSvg ? '2px solid #3b82f6' : '2px solid #ef4444';
        SEC.ui.overlay.style.background = hasSvg ? 'rgba(59,130,246,0.07)' : 'rgba(239,68,68,0.07)';
        if (SEC.ui.label) SEC.ui.label.style.background = hasSvg ? '#1e3a8a' : '#7f1d1d';
      } else if (SEC.ui) {
        SEC.ui.overlay.style.outline = '2px solid #3b82f6';
        SEC.ui.overlay.style.background = 'rgba(59,130,246,0.07)';
        if (SEC.ui.label) SEC.ui.label.style.background = '#1e3a8a';
      }
    }
  });
}


function onScroll() {
  // rAF-debounced: scroll fires many times per frame, we only need one update
  if (SEC.scrollRAF) return;
  SEC.scrollRAF = requestAnimationFrame(() => {
    SEC.scrollRAF = null;
    if (SEC.hoveredEl) updateOverlay(SEC.hoveredEl);
  });
}

function onClick(e) {
  if (SEC.state !== STATE.SELECTING) return;
  if (e.target?.dataset?.secUi) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const target = SEC.hoveredEl || e.target;
  if (!target || target === document.documentElement || target === document.body) return;

  // iFrame: check accessibility before attempting extraction
  if (target.tagName === 'IFRAME') {
    try {
      void target.contentDocument; // throws if cross-origin
    } catch {
      showToast('Cross-origin iframe — cannot access its content (browser security)', 'error', 4000);
      return;
    }
  }

  // SVG mode guard: if no SVG ancestor, warn and don't extract
  if (SEC.mode === 'svg') {
    let el = target;
    let svgFound = false;
    while (el) { if (el.tagName && el.tagName.toLowerCase() === 'svg') { svgFound = true; break; } el = el.parentElement; }
    if (!svgFound) {
      showToast('That\'s not an SVG — hover over an icon or illustration', 'error', 3000);
      return;
    }
  }

  hideBreadcrumb();
  beginExtraction(target);
}

function onContextMenu(e) {
  if (SEC.state !== STATE.SELECTING) return;
  if (e.target?.dataset?.secUi) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const target = SEC.hoveredEl || e.target;
  if (!target) return;
  showBreadcrumb(target, e.clientX, e.clientY);
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    hideBreadcrumb();
    if (SEC.state === STATE.SELECTING) transition(STATE.IDLE, { reason: 'cancelled' });
  }
  // Alt+C — instant copy of currently hovered element
  if ((e.altKey || e.metaKey) && e.key === 'c' && SEC.state === STATE.SELECTING) {
    const target = SEC.hoveredEl;
    if (target && target !== document.documentElement && target !== document.body) {
      e.preventDefault();
      e.stopPropagation();
      hideBreadcrumb();
      beginExtraction(target);
    }
  }
}

// ─── Breadcrumb Ancestor Picker ───────────────────────────────────────────────

// Reuse button DOM nodes to avoid GC thrash on repeated right-clicks
const _btnPool = [];

function getBreadcrumbBtn() {
  return _btnPool.pop() || (() => {
    const b = document.createElement('button');
    b.setAttribute('data-sec-ui', 'true');
    return b;
  })();
}

function showBreadcrumb(startEl, x, y) {
  const { breadcrumb } = SEC.ui;

  // Return existing buttons to pool
  while (breadcrumb.firstChild) {
    const child = breadcrumb.firstChild;
    breadcrumb.removeChild(child);
    if (child.tagName === 'BUTTON') _btnPool.push(child);
  }

  // Header row with label + close button
  const headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:2px 6px 4px;border-bottom:1px solid #1e293b;margin-bottom:2px';
  headerRow.setAttribute('data-sec-ui', 'true');

  const headerLabel = document.createElement('span');
  headerLabel.textContent = 'Select ancestor';
  headerLabel.style.cssText = 'color:#64748b;font-size:10px;font-family:ui-monospace,monospace;letter-spacing:0.05em;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('data-sec-ui', 'true');
  closeBtn.style.cssText = 'background:none;border:none;color:#475569;cursor:pointer;font-size:11px;padding:1px 3px;border-radius:3px;line-height:1;';
  closeBtn.onmouseenter = () => { closeBtn.style.color = '#e2e8f0'; };
  closeBtn.onmouseleave = () => { closeBtn.style.color = '#475569'; };
  closeBtn.onclick = (ev) => { ev.stopPropagation(); hideBreadcrumb(); };

  headerRow.appendChild(headerLabel);
  headerRow.appendChild(closeBtn);
  breadcrumb.appendChild(headerRow);

  // Ancestor buttons
  const ancestors = [];
  let cur = startEl;
  while (cur && cur !== document.documentElement) {
    ancestors.push(cur);
    cur = cur.parentElement;
  }

  const fragment = document.createDocumentFragment();
  for (const ancestor of ancestors) {
    const tag = ancestor.tagName.toLowerCase();
    const id  = ancestor.id ? `#${ancestor.id}` : '';
    const rawCls = typeof ancestor.className === 'string' ? ancestor.className
                 : (ancestor.className?.baseVal ?? '');
    const cls = rawCls.trim()
      ? '.' + rawCls.trim().split(/\s+/)[0] : '';

    const btn = getBreadcrumbBtn();
    btn.textContent = `${tag}${id}${cls}`;
    btn.style.cssText = `
      display:block;width:100%;text-align:left;
      background:${ancestor === startEl ? '#1e40af' : 'transparent'};
      color:${ancestor === startEl ? '#fff' : '#94a3b8'};
      border:none;padding:4px 8px;border-radius:4px;
      font-family:ui-monospace,monospace;font-size:11px;
      cursor:pointer;white-space:nowrap;
    `.replace(/\n\s*/g, '');

    // Capture ancestor in closure properly
    const captured = ancestor;
    btn.onmouseenter = () => { btn.style.background = '#1e3a8a'; btn.style.color = '#fff'; updateOverlay(captured); };
    btn.onmouseleave = () => { btn.style.background = captured === startEl ? '#1e40af' : 'transparent'; btn.style.color = captured === startEl ? '#fff' : '#94a3b8'; };
    btn.onclick = (ev) => { ev.stopPropagation(); hideBreadcrumb(); beginExtraction(captured); };

    fragment.appendChild(btn);
  }
  breadcrumb.appendChild(fragment);

  const bw = 210;
  const bh = Math.min(ancestors.length * 30 + 32, 260);
  breadcrumb.style.cssText = `
    position:fixed;pointer-events:auto;z-index:2147483647;
    background:#0f172a;border:1px solid #334155;border-radius:6px;
    padding:4px;display:flex;flex-direction:column;gap:2px;
    box-shadow:0 8px 24px rgba(0,0,0,0.5);max-height:260px;overflow-y:auto;
    top:${Math.min(y, window.innerHeight - bh - 8)}px;
    left:${Math.min(x, window.innerWidth - bw - 8)}px;
    width:${bw}px;
  `.replace(/\n\s*/g, '');
}

function hideBreadcrumb() {
  if (SEC.ui?.breadcrumb) SEC.ui.breadcrumb.style.display = 'none';
}

// ─── On-Page Toast Notification ──────────────────────────────────────────────

let _toastEl = null;
let _toastTimer = null;

function showToast(msg, type = 'info', durationMs = 2800) {
  // Create toast container if not yet present
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.id = '__sec-toast';
    _toastEl.setAttribute('data-sec-ui', 'true');
    _toastEl.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'right:20px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:9px',
      'padding:10px 15px',
      'border-radius:8px',
      'font-family:ui-sans-serif,system-ui,sans-serif',
      'font-size:13px',
      'font-weight:500',
      'line-height:1.4',
      'max-width:320px',
      'box-shadow:0 4px 20px rgba(0,0,0,0.45)',
      'pointer-events:none',
      'transition:opacity 0.2s ease,transform 0.2s ease',
      'will-change:opacity,transform',
      'contain:layout style',
    ].join(';');
    document.documentElement.appendChild(_toastEl);
  }

  // Colors per type
  const COLORS = {
    info:    { bg:'#1e40af', border:'#3b82f6', icon:'ℹ' },
    success: { bg:'#065f46', border:'#10b981', icon:'✓' },
    error:   { bg:'#7f1d1d', border:'#ef4444', icon:'✕' },
    working: { bg:'#78350f', border:'#f59e0b', icon:'⟳' },
  };
  const c = COLORS[type] || COLORS.info;

  _toastEl.style.background = c.bg;
  _toastEl.style.border = `1px solid ${c.border}`;
  _toastEl.style.color = '#fff';
  _toastEl.innerHTML = `<span style="font-size:15px;flex-shrink:0">${c.icon}</span><span>${msg}</span>`;
  _toastEl.style.opacity = '1';
  _toastEl.style.transform = 'translateY(0)';

  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (_toastEl) {
      _toastEl.style.opacity = '0';
      _toastEl.style.transform = 'translateY(6px)';
    }
  }, durationMs);
}

function hideToast() {
  if (_toastEl) {
    _toastEl.style.opacity = '0';
    _toastEl.style.transform = 'translateY(6px)';
  }
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
}

// Flash the selected element briefly before extracting
function flashElement(el) {
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = '2px solid #10b981';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
  }, 350);
}

// ─── Extraction Pipeline ──────────────────────────────────────────────────────

async function beginExtraction(element) {
  flashElement(element);
  transition(STATE.PROCESSING);
  hideOverlay();

  try {
    const engine = window.__SmartElementCopierEngine;
    if (!engine) throw new Error('Core engine not loaded — try reloading the extension');

    showToast('Extracting element…', 'working', 10000);

    const result = await engine.exportElement(element, {
      mode: SEC.mode,
      bundleImages: SEC.bundleImages,
      onProgress: (n) => notifyPopup({ type: 'SEC_PROGRESS', nodes: n }),
    });

    await writeClipboard(result.html);

    // Forward HTML to popup for the download button (fire-and-forget)
    notifyPopup({ type: 'SEC_STORE_HTML', html: result.html });

    const MODE_LABELS = { html:'HTML', document:'Document', jsx:'React JSX', text:'Text', tailwind:'Tailwind CSS', bootstrap:'Bootstrap 5', svg:'SVG Code' };
    const label = MODE_LABELS[SEC.mode] || SEC.mode;
    const size  = result.stats.bytes < 1024
      ? `${result.stats.bytes}B`
      : `${(result.stats.bytes / 1024).toFixed(1)}KB`;

    // Get rendered dimensions of the extracted element
    let dimStr = '';
    try {
      const r = element.getBoundingClientRect();
      if (r.width && r.height) dimStr = ` · ${Math.round(r.width)}×${Math.round(r.height)}px`;
    } catch {}

    showToast(`Copied as ${label} · ${size}${dimStr}`, 'success', 3000);

    transition(STATE.IDLE, {
      reason:        'copied',
      mode:          SEC.mode,
      bytes:         result.stats.bytes,
      sharedClasses: result.stats.sharedClasses,
      elapsedMs:     result.stats.elapsedMs,
    });

  } catch (err) {
    console.error('[SEC] Extraction failed:', err);
    showToast(`Error: ${err.message}`, 'error', 4000);
    transition(STATE.IDLE, { reason: 'error', error: err.message });
  }
}

// ─── Clipboard — 4-Strategy Fallback Chain ────────────────────────────────────

async function writeClipboard(text) {
  // 1. Modern async API
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  // 2. ClipboardItem blob
  if (window.ClipboardItem && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) }),
      ]);
      return;
    } catch {}
  }
  // 3. execCommand (deprecated but broadly supported)
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (ok) return;
  // 4. Background service worker relay (for pages with strictest CSP)
  await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'SEC_CLIPBOARD_WRITE', text }, r => {
      chrome.runtime.lastError || !r?.ok
        ? reject(new Error(r?.error || 'All clipboard strategies exhausted'))
        : resolve();
    });
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function notifyPopup(msg) {
  try { chrome.runtime.sendMessage(msg); } catch { /* popup closed */ }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'SEC_START':
      if (SEC.state === STATE.IDLE) transition(STATE.SELECTING, { mode: msg.mode, bundleImages: msg.bundleImages });
      sendResponse({ ok: true, state: SEC.state });
      break;
    case 'SEC_STOP':
      if (SEC.state === STATE.SELECTING) transition(STATE.IDLE, { reason: 'stopped' });
      sendResponse({ ok: true });
      break;
    case 'SEC_PING':
      sendResponse({ ok: true, active: SEC.state !== STATE.IDLE, state: SEC.state, mode: SEC.mode });
      break;
    default:
      sendResponse({ ok: false });
  }
  return true;
});

} // end initSEC