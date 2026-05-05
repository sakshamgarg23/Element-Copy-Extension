/**
 * core-engine.js — Smart Element Copier v6
 *
 * EXTRACTION PIPELINE:
 * ──────────────────────────────────────────────────────────────
 * 1. TREE WALK (buildCloneAsync)
 *    • Iterative stack walk (not recursive) with MessageChannel yield to stay
 *      within frame budget. Chunk size auto-tunes to TARGET_FRAME_MS.
 *    • Per-element: cloneNode(false) → fixAssets → extractDiffedStyles →
 *      register in StyleSheet → materializePseudos (::before/::after)
 *
 * 2. STYLE EXTRACTION (extractDiffedStyles)
 *    • Reads longhands via getComputedStyle — never shorthands, to avoid
 *      the shorthand+longhand duplication bug.
 *    • Filters: WORTHLESS values → per-tag browser defaults → inherited values
 *      that match parent context. Only the delta is kept.
 *    • CSS custom properties (var(--x)) are resolved by walking ancestors.
 *    • optimizeStyles() collapses longhands → shorthands, prunes invisible
 *      borders, collapses border-radius, and drops no-op transitions.
 *
 * 3. STYLE DEDUPLICATION (StyleSheet)
 *    • FNV-1a hash of the CSS string → shared class name (_sXX).
 *    • All rules are scoped under a unique root class (._secXXXXXX) to
 *      prevent conflicts when the output is pasted into another page.
 *
 * 4. PSEUDO-ELEMENT MATERIALISATION (materializePseudos)
 *    • ::before / ::after become real <span data-sec-pseudo> nodes with
 *      their computed styles registered as regular classes.
 *
 * 5. STYLESHEET EXTRAS (captureExtras)
 *    • @font-face — only for families actually used in the subtree.
 *    • @keyframes — only for animation-name values found in the subtree.
 *    • @media — rules whose selectors match the subtree, re-scoped.
 *    • :hover/:focus/:active etc. — harvested from CSSOM (computed styles
 *      can't represent interactive states), re-scoped under root class.
 *
 * 6. ASSET HANDLING
 *    • All src/href URLs resolved to absolute.
 *    • Optional base64 bundling via Promise.allSettled fetch pipeline.
 *
 * 7. FRAMEWORK SERIALISERS
 *    • React JSX — attribute name remapping + style object conversion.
 *    • Tailwind — computed values mapped to nearest utility class;
 *      unmapped styles fall back to inline style=.
 *    • Bootstrap 5 — same strategy.
 */

'use strict';

// ─── CSS Properties — ONLY the ones that matter ──────────────────────────────
// We use LONGHANDS only — then collapse them to shorthands after.
// This avoids the shorthand+longhand duplication problem entirely.

const PROPS = [
  // Layout
  'display','position','z-index','float','clear','box-sizing',
  'overflow-x','overflow-y',
  'width','height','min-width','max-width','min-height','max-height',
  'aspect-ratio',
  // Flexbox
  'flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis',
  'justify-content','align-items','align-content','align-self','order',
  // Grid
  'grid-template-columns','grid-template-rows','grid-template-areas',
  'grid-column','grid-row','grid-area','column-gap','row-gap',
  // Position
  'top','right','bottom','left',
  // Spacing — longhands only (we collapse to shorthand later)
  'margin-top','margin-right','margin-bottom','margin-left',
  'padding-top','padding-right','padding-bottom','padding-left',
  // Typography
  'font-family','font-size','font-weight','font-style','font-variant','font-stretch',
  'line-height','letter-spacing','word-spacing',
  'text-align','text-decoration','text-transform','text-indent',
  'text-overflow','white-space','word-break','color','direction',
  // Background
  'background-color','background-image','background-repeat',
  'background-position','background-size','background-attachment',
  // Border — longhands (collapsed to shorthand if all sides equal)
  'border-top-width','border-right-width','border-bottom-width','border-left-width',
  'border-top-style','border-right-style','border-bottom-style','border-left-style',
  'border-top-color','border-right-color','border-bottom-color','border-left-color',
  // Radius
  'border-top-left-radius','border-top-right-radius',
  'border-bottom-right-radius','border-bottom-left-radius',
  // Effects
  'box-shadow','opacity','cursor',
  'transform','transition','animation',
  'filter','backdrop-filter','mix-blend-mode',
  'clip-path',
  'object-fit','object-position','vertical-align',
  // Interaction
  'pointer-events','user-select','visibility','resize',
  // Table
  'table-layout','border-collapse','border-spacing',
  // Outline
  'outline-width','outline-style','outline-color',
  // List
  'list-style-type','list-style-position',
];

// Values that are ALWAYS meaningless regardless of property.
// NOTE: 'none', 'normal', 'auto', '0px' are intentionally excluded —
// they are valid computed values (e.g. text-decoration:none, margin:auto, font-style:normal)
// and are filtered by the per-tag defaults cache + INHERITABLE check instead.
const WORTHLESS = new Set([
  '', 'rgba(0, 0, 0, 0)', 'transparent', 'currentcolor', 'currentColor',
  'unset', 'revert', 'initial',
]);

// Identity transform values — no visual effect
const IDENTITY_TRANSFORMS = new Set([
  'none','matrix(1, 0, 0, 1, 0, 0)','matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
  'translate(0px, 0px)','translate(0px)','translateX(0px)','translateY(0px)',
  'scale(1)','scale(1, 1)','rotate(0deg)','skew(0deg)','skew(0deg, 0deg)',
]);

// CSS properties that inherit — children skip if parent already set same value
const INHERITABLE = new Set([
  'color','font-family','font-size','font-weight','font-style','font-variant',
  'font-stretch','line-height','letter-spacing','word-spacing','text-align',
  'text-transform','text-indent','white-space','direction','word-break',
  'list-style-type','list-style-position','cursor','visibility',
]);

const VOID_TAGS  = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const SKIP_TAGS  = new Set(['SCRIPT','NOSCRIPT','TEMPLATE','STYLE']);
const PSEUDO_ELS = ['::before','::after'];

const COMMON_TAGS = [
  'div','span','p','a','button','input','img','ul','ol','li',
  'h1','h2','h3','h4','h5','h6','section','article','nav','header',
  'footer','main','aside','form','label','select','textarea','table',
  'thead','tbody','tr','td','th','figure','blockquote','pre','code',
  'strong','em','small','svg','path','iframe','video','audio',
];

const TARGET_FRAME_MS = 8;
let _chunkSize = 80;

// ─── Reusable MessageChannel Yield ───────────────────────────────────────────

const _yieldChannel = (() => {
  const queue = [];
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => queue.shift()?.();
  return { queue, port2 };
})();

function yieldToMain() {
  return new Promise(r => { _yieldChannel.queue.push(r); _yieldChannel.port2.postMessage(null); });
}

// ─── Default Style Cache (pre-warmed) ────────────────────────────────────────

const _defaultStyleCache = new Map();

function prewarmDefaultStyles() {
  try {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:none;visibility:hidden;';
    document.body.appendChild(iframe);
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    doc.open(); doc.write('<!DOCTYPE html><body>'); doc.close();
    for (const tag of COMMON_TAGS) {
      try {
        const el = doc.createElement(tag);
        doc.body.appendChild(el);
        const cs = win.getComputedStyle(el);
        const d = {};
        for (const p of PROPS) d[p] = cs.getPropertyValue(p);
        _defaultStyleCache.set(tag, d);
        doc.body.removeChild(el);
      } catch { _defaultStyleCache.set(tag, {}); }
    }
    document.body.removeChild(iframe);
  } catch {}
}

function getDefaults(tag) {
  if (_defaultStyleCache.has(tag)) return _defaultStyleCache.get(tag);
  _defaultStyleCache.set(tag, {});
  return {};
}

if (document.body) prewarmDefaultStyles();
else document.addEventListener('DOMContentLoaded', prewarmDefaultStyles, { once: true });

// ─── FNV-1a ──────────────────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(36);
}

// ─── SVG className helpers ────────────────────────────────────────────────────
// SVG elements have className as SVGAnimatedString (read-only .baseVal/.animVal)
// Writing .className directly throws "has only a getter". Use these helpers.

function getClassName(el) {
  if (!el) return '';
  const cn = el.className;
  if (typeof cn === 'string') return cn;
  if (cn && typeof cn.baseVal === 'string') return cn.baseVal; // SVGAnimatedString
  return '';
}

function setClassName(el, value) {
  if (!el) return;
  const cn = el.className;
  if (typeof cn === 'string') {
    el.className = value;
  } else if (cn && typeof cn.baseVal === 'string') {
    // SVG element — write via setAttribute to avoid the getter-only trap
    el.setAttribute('class', value);
  } else {
    try { el.setAttribute('class', value); } catch {}
  }
}

// ─── URL Resolution ───────────────────────────────────────────────────────────

function resolveURL(url) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
  try { return new URL(url, document.baseURI).href; } catch { return url; }
}

function resolveURLsInValue(v) {
  if (!v || v.length < 5 || !v.includes('url(')) return v;
  return v.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (_, q, raw) => `url(${q}${resolveURL(raw)}${q})`);
}

// ─── CSS Optimizer ───────────────────────────────────────────────────────────
//
// This is the core of v5. Takes a raw styles object and returns a CLEAN one:
// 1. Filters identity/worthless values
// 2. Collapses 4-side longhands → shorthands
// 3. Prunes invisible borders
// 4. Removes redundant overflow-x/y when both are same value

function optimizeStyles(raw) {
  const s = {};

  for (const [prop, val] of Object.entries(raw)) {
    if (!val || WORTHLESS.has(val)) continue;

    // Identity transform filter
    if (prop === 'transform' && IDENTITY_TRANSFORMS.has(val.trim())) continue;

    // Transform-origin only matters if transform is non-identity
    if (prop === 'transform-origin' && !s['transform'] && !raw['transform']) continue;

    // Transition: skip 'all 0s ease 0s' (no-op)
    if (prop === 'transition' && (val === 'all 0s ease 0s' || val === 'all 0s')) continue;

    // Animation: skip 'none 0s ease 0s 1 normal none running'
    if (prop === 'animation' && val.startsWith('none')) continue;

    s[prop] = val;
  }

  // ── Shorthand collapse: margin ────────────────────────────────────────────
  const mt = s['margin-top'], mr = s['margin-right'],
        mb = s['margin-bottom'], ml = s['margin-left'];
  if (mt !== undefined || mr !== undefined || mb !== undefined || ml !== undefined) {
    const t = mt||'0px', r = mr||'0px', b = mb||'0px', l = ml||'0px';
    delete s['margin-top']; delete s['margin-right'];
    delete s['margin-bottom']; delete s['margin-left'];
    // Collapse to shortest form
    if (t===r && r===b && b===l) {
      if (t !== '0px') s['margin'] = t;
    } else if (t===b && r===l) {
      s['margin'] = `${t} ${r}`;
    } else if (r===l) {
      s['margin'] = `${t} ${r} ${b}`;
    } else {
      s['margin'] = `${t} ${r} ${b} ${l}`;
    }
    if (s['margin'] === '0px' || s['margin'] === '0px 0px') delete s['margin'];
  }

  // ── Shorthand collapse: padding ───────────────────────────────────────────
  const pt = s['padding-top'], pr = s['padding-right'],
        pb = s['padding-bottom'], pl = s['padding-left'];
  if (pt !== undefined || pr !== undefined || pb !== undefined || pl !== undefined) {
    const t = pt||'0px', r = pr||'0px', b = pb||'0px', l = pl||'0px';
    delete s['padding-top']; delete s['padding-right'];
    delete s['padding-bottom']; delete s['padding-left'];
    if (t===r && r===b && b===l) {
      if (t !== '0px') s['padding'] = t;
    } else if (t===b && r===l) {
      s['padding'] = `${t} ${r}`;
    } else if (r===l) {
      s['padding'] = `${t} ${r} ${b}`;
    } else {
      s['padding'] = `${t} ${r} ${b} ${l}`;
    }
    if (s['padding'] === '0px' || s['padding'] === '0px 0px') delete s['padding'];
  }

  // ── Border pruning ────────────────────────────────────────────────────────
  // If all borders are style=none or width=0, drop all border props
  const bSides = ['top','right','bottom','left'];
  const bWidths = bSides.map(sd => s[`border-${sd}-width`] || '0px');
  const bStyles = bSides.map(sd => s[`border-${sd}-style`] || 'none');
  const bColors = bSides.map(sd => s[`border-${sd}-color`]);

  const allInvisible = bSides.every((_, i) =>
    bStyles[i] === 'none' || bWidths[i] === '0px'
  );

  if (allInvisible) {
    // Drop all border longhands — border is invisible, no need to emit it
    for (const sd of bSides) {
      delete s[`border-${sd}-width`];
      delete s[`border-${sd}-style`];
      delete s[`border-${sd}-color`];
    }
  } else {
    // Try to collapse to shorthand if all 4 sides are equal
    const allEqualWidth = bWidths.every(v => v === bWidths[0]);
    const allEqualStyle = bStyles.every(v => v === bStyles[0]);
    const allEqualColor = bColors.every(v => v === bColors[0]);

    if (allEqualWidth && allEqualStyle && allEqualColor) {
      for (const sd of bSides) {
        delete s[`border-${sd}-width`];
        delete s[`border-${sd}-style`];
        delete s[`border-${sd}-color`];
      }
      s['border'] = `${bWidths[0]} ${bStyles[0]} ${bColors[0] || ''}`.trim();
    }
  }

  // ── Border radius collapse ────────────────────────────────────────────────
  const rtl = s['border-top-left-radius'];
  const rtr = s['border-top-right-radius'];
  const rbr = s['border-bottom-right-radius'];
  const rbl = s['border-bottom-left-radius'];
  if (rtl || rtr || rbr || rbl) {
    const tl = rtl||'0px', tr = rtr||'0px', br = rbr||'0px', bl = rbl||'0px';
    delete s['border-top-left-radius']; delete s['border-top-right-radius'];
    delete s['border-bottom-right-radius']; delete s['border-bottom-left-radius'];
    if (tl===tr && tr===br && br===bl) {
      if (tl !== '0px') s['border-radius'] = tl;
    } else {
      s['border-radius'] = `${tl} ${tr} ${br} ${bl}`;
    }
  }

  // ── Overflow collapse ─────────────────────────────────────────────────────
  const ox = s['overflow-x'], oy = s['overflow-y'];
  if (ox && oy && ox === oy) {
    delete s['overflow-x']; delete s['overflow-y'];
    if (ox !== 'visible') s['overflow'] = ox;
  }

  // ── Background cleanup ────────────────────────────────────────────────────
  // Drop background-color if it's the same as transparent
  if (s['background-color'] === 'rgba(0, 0, 0, 0)' ||
      s['background-color'] === 'transparent') {
    delete s['background-color'];
  }
  // Drop background props that are defaults when no real background is set
  if (!s['background-color'] && !s['background-image']) {
    delete s['background-repeat'];
    delete s['background-position'];
    delete s['background-size'];
    delete s['background-attachment'];
  }

  // ── font shorthand collapse ───────────────────────────────────────────────
  // Only emit font-family if it actually differs and is meaningful
  if (s['font-family']) {
    const ff = s['font-family'];
    // Strip fallback-* fonts added by some frameworks (not real system fonts)
    s['font-family'] = ff.replace(/,?\s*fallback-[^,"]*/g, '').trim().replace(/,\s*$/, '').trim();
    if (!s['font-family']) delete s['font-family'];
  }

  return s;
}

// ─── CSS Custom Property (Variable) Resolution ───────────────────────────────
//
// Computed values may still contain var(--x) on some browsers/properties.
// We resolve them by walking up the element's ancestor chain to find the
// actual --custom-property value defined on the closest ancestor.

function resolveCSSVars(value, el) {
  if (!value || !value.includes('var(')) return value;
  return value.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\s*\)/g, (match, varName, fallback) => {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      try {
        const resolved = window.getComputedStyle(node).getPropertyValue(varName).trim();
        if (resolved) return resolved;
      } catch {}
      node = node.parentElement;
    }
    return fallback ? fallback.trim() : match; // keep original if unresolvable
  });
}

// ─── @font-face Capture ──────────────────────────────────────────────────────
//
// Scans all document stylesheets for @font-face rules and returns only
// the ones whose font-family is actually referenced by the extracted subtree.

function captureFontFaces(rootEl) {
  const usedFamilies = new Set();

  // Collect all font-family values used in the subtree
  const walk = (el) => {
    if (el.nodeType !== Node.ELEMENT_NODE) return;
    try {
      const ff = window.getComputedStyle(el).getPropertyValue('font-family');
      if (ff) ff.split(',').forEach(f => usedFamilies.add(f.trim().replace(/^["']|["']$/g, '').toLowerCase()));
    } catch {}
    for (const child of el.children) walk(child);
  };
  walk(rootEl);

  if (!usedFamilies.size) return '';

  const blocks = [];
  try {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      for (const rule of rules) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        const family = rule.style.getPropertyValue('font-family')
          .trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (usedFamilies.has(family)) {
          // Resolve relative src() URLs to absolute
          const text = rule.cssText.replace(
            /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g,
            (_, q, raw) => `url(${q}${resolveURL(raw)}${q})`
          );
          blocks.push(text);
        }
      }
    }
  } catch {}

  return blocks.length ? blocks.join('\n') + '\n' : '';
}

// ─── @media Query Capture ────────────────────────────────────────────────────
//
// Walks all stylesheets and captures @media rules whose selectors match any
// element in the extracted subtree. Each matching selector is re-scoped under
// the root scope class so the rules only apply inside the extracted block.

function captureMediaQueries(rootEl, scopeId) {
  const classes = new Set();
  const ids     = new Set();
  const tags    = new Set();

  const collectSelectors = (el) => {
    if (el.nodeType !== Node.ELEMENT_NODE) return;
    tags.add(el.tagName.toLowerCase());
    if (el.id) ids.add(el.id);
    const cn = typeof el.className === 'string' ? el.className : (el.className?.baseVal ?? '');
    cn.trim().split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
    for (const child of el.children) collectSelectors(child);
  };
  collectSelectors(rootEl);

  const mediaBlocks = [];

  const matchesSubtree = (selectorText) => {
    try {
      if (rootEl.matches(selectorText)) return true;
      if (rootEl.querySelector(selectorText)) return true;
    } catch {}
    const tokens = selectorText.match(/[.#]?[\w-]+/g) || [];
    for (const tok of tokens) {
      if (tok.startsWith('.') && classes.has(tok.slice(1))) return true;
      if (tok.startsWith('#') && ids.has(tok.slice(1))) return true;
      if (tags.has(tok)) return true;
    }
    return false;
  };

  // Scope a selector string under the root scope class (handles comma lists)
  const scopeSel = (sel) =>
    sel.split(',').map(s => `.${scopeId} ${s.trim()}`).join(', ');

  try {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.type !== CSSRule.MEDIA_RULE) continue;
        const matchingRules = [];
        for (const inner of rule.cssRules) {
          if (inner.type !== CSSRule.STYLE_RULE) continue;
          if (!matchesSubtree(inner.selectorText)) continue;
          const decl = inner.style.cssText;
          if (!decl) continue;
          matchingRules.push(`${scopeSel(inner.selectorText)} { ${decl} }`);
        }
        if (matchingRules.length) {
          mediaBlocks.push(`@media ${rule.conditionText} {\n  ${matchingRules.join('\n  ')}\n}`);
        }
      }
    }
  } catch {}

  return mediaBlocks.length ? mediaBlocks.join('\n') + '\n' : '';
}

// ─── @keyframes Capture ──────────────────────────────────────────────────────
//
// Finds every @keyframes block referenced by any animation-name in the subtree.
// Without this, animated elements lose their animations when extracted.

function captureKeyframes(rootEl) {
  const usedNames = new Set();

  const walk = (el) => {
    if (el.nodeType !== Node.ELEMENT_NODE) return;
    try {
      const name = window.getComputedStyle(el).getPropertyValue('animation-name');
      if (name && name !== 'none') {
        name.split(',').forEach(n => { const t = n.trim(); if (t && t !== 'none') usedNames.add(t); });
      }
    } catch {}
    for (const child of el.children) walk(child);
  };
  walk(rootEl);

  if (!usedNames.size) return '';

  const blocks = [];
  try {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.type === CSSRule.KEYFRAMES_RULE && usedNames.has(rule.name)) {
          blocks.push(rule.cssText);
          usedNames.delete(rule.name); // avoid duplicates from multiple sheets
        }
      }
    }
  } catch {}

  return blocks.join('\n');
}

// ─── Pseudo-class Rule Capture ────────────────────────────────────────────────
//
// Scans all stylesheets for :hover, :focus, :active, :checked etc. rules that
// match elements in our subtree. Emits them scoped under the root class so they
// are portable and conflict-free. Computed styles cannot capture these states,
// so we must harvest them directly from the page's CSSOM.

function capturePseudoClassRules(rootEl, scopeId) {
  const TRACKED_PSEUDOS = [
    ':hover', ':focus', ':focus-visible', ':focus-within', ':active',
    ':checked', ':disabled', ':enabled', ':visited', ':placeholder',
    '::placeholder', '::selection', ':first-child', ':last-child',
    ':nth-child', ':not(', ':is(', ':where(',
  ];

  const blocks = [];

  const matchesBase = (part) => {
    // Strip all pseudo-classes/elements, then check if base selector matches tree
    const base = part.replace(/::?[\w-]+(\([^)]*\))?/g, '').trim();
    if (!base) return true; // universal selector — always include
    try {
      return rootEl.matches(base) || !!rootEl.querySelector(base);
    } catch {
      return false;
    }
  };

  try {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.type !== CSSRule.STYLE_RULE) continue;
        const sel = rule.selectorText;
        if (!TRACKED_PSEUDOS.some(p => sel.includes(p))) continue;
        const decl = rule.style?.cssText;
        if (!decl) continue;

        // Process each comma-separated part independently
        const matchingParts = sel.split(',').map(s => s.trim()).filter(matchesBase);
        if (!matchingParts.length) continue;

        const scoped = matchingParts.map(s => `.${scopeId} ${s}`).join(', ');
        blocks.push(`${scoped} { ${decl} }`);
      }
    }
  } catch {}

  return blocks.join('\n');
}

// ─── Style Extractor ─────────────────────────────────────────────────────────

function extractDiffedStyles(el, parentCtx) {
  let computed;
  try { computed = window.getComputedStyle(el); }
  catch { return { styles: {}, childCtx: parentCtx }; }

  const tag = el.tagName.toLowerCase();
  const defaults = getDefaults(tag);
  const childCtx = Object.create(parentCtx);
  const raw = {};

  for (const prop of PROPS) {
    let value = computed.getPropertyValue(prop);
    if (!value || WORTHLESS.has(value)) continue;
    if (value === defaults[prop]) continue;
    if (INHERITABLE.has(prop) && parentCtx[prop] === value) continue;

    // Resolve CSS custom properties that leaked through as var(--x)
    value = resolveCSSVars(value, el);
    raw[prop] = resolveURLsInValue(value);
    if (INHERITABLE.has(prop)) childCtx[prop] = value;
  }

  // Run optimizer to clean up the raw styles
  const styles = optimizeStyles(raw);

  return { styles, childCtx };
}

// ─── StyleSheet ───────────────────────────────────────────────────────────────

class StyleSheet {
  constructor() {
    this._rules     = new Map();
    this._counter   = 0;
    this._fontFace  = '';
    this._media     = '';
    this._pseudos   = '';
    this._keyframes = '';
    // Unique scope class isolates extracted CSS — prevents conflicts when pasted elsewhere
    this._scopeId   = `_sec${Math.random().toString(36).slice(2, 8)}`;
  }

  register(styles) {
    const entries = Object.entries(styles);
    if (!entries.length) return '';
    const css  = entries.map(([p,v]) => `${p}:${v}`).join(';');
    const hash = fnv1a(css);
    if (!this._rules.has(hash)) {
      this._rules.set(hash, { cls: `_s${(this._counter++).toString(36)}`, css });
    }
    return this._rules.get(hash).cls;
  }

  captureExtras(rootEl) {
    this._fontFace  = captureFontFaces(rootEl);
    this._media     = captureMediaQueries(rootEl, this._scopeId);
    this._pseudos   = capturePseudoClassRules(rootEl, this._scopeId);
    this._keyframes = captureKeyframes(rootEl);
  }

  serialize() {
    const sid = this._scopeId;
    // All generated rules are scoped under the root class — they only apply inside the wrapper
    const rules = this._rules.size
      ? `<style>\n${[...this._rules.values()].map(({cls,css}) => `.${sid} .${cls}{${css}}`).join('\n')}\n</style>`
      : '';
    const raw = [this._fontFace, this._keyframes, this._media, this._pseudos].filter(Boolean).join('\n');
    const extras = raw ? `<style>\n${raw}\n</style>` : '';
    return [extras, rules].filter(Boolean).join('\n');
  }

  get size()    { return this._rules.size; }
  get scopeId() { return this._scopeId; }
}

// ─── Pseudo-element Materializer ──────────────────────────────────────────────

function materializePseudos(source, clone, sheet) {
  for (const pseudo of PSEUDO_ELS) {
    let cs;
    try { cs = window.getComputedStyle(source, pseudo); } catch { continue; }
    const content = cs.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal' || content === '""') continue;
    const text = content.replace(/^["']|["']$/g, '');
    const span = document.createElement('span');
    span.setAttribute('data-sec-pseudo', pseudo);
    if (text) span.textContent = text;
    const raw = {};
    for (const p of PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && !WORTHLESS.has(v)) raw[p] = resolveURLsInValue(v);
    }
    raw['display'] = raw['display'] || 'inline';
    const cls = sheet.register(optimizeStyles(raw));
    if (cls) setClassName(span, cls);
    pseudo === '::before' ? clone.insertBefore(span, clone.firstChild) : clone.appendChild(span);
  }
}

// ─── Asset Fixer ─────────────────────────────────────────────────────────────

const _assetMap = new Map(); // original URL → resolved/base64

function fixAssets(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  for (const attr of ['src','poster','action','data']) {
    if (node.hasAttribute(attr)) {
      const v = node.getAttribute(attr);
      if (v && !v.startsWith('#') && !v.startsWith('javascript:')) {
        const resolved = resolveURL(v);
        node.setAttribute(attr, resolved);
        _assetMap.set(resolved, resolved); // track for potential bundling
      }
    }
  }

  if (node.hasAttribute('href')) {
    const h = node.getAttribute('href');
    if (h && !h.startsWith('#') && !h.startsWith('javascript:')) {
      node.setAttribute('href', resolveURL(h));
    }
  }

  if (node.hasAttribute('srcset')) {
    node.setAttribute('srcset', node.getAttribute('srcset')
      .split(',').map(p => {
        const parts = p.trim().split(/\s+/);
        return parts.length > 1 ? `${resolveURL(parts[0])} ${parts.slice(1).join(' ')}` : resolveURL(parts[0]);
      }).join(', '));
  }

  // Strip noise attributes
  const toRemove = [];
  for (const { name } of node.attributes) {
    if (name.startsWith('on') || /^data-(gtm|ga|track|analytics|layer|event)/.test(name)) {
      toRemove.push(name);
    }
  }
  for (const n of toRemove) node.removeAttribute(n);
}

// ─── Asset Bundler ────────────────────────────────────────────────────────────

/**
 * Fetch all image URLs in the cloned tree and replace with base64 data URLs.
 * Makes the HTML fully self-contained — works offline, no broken images.
 *
 * Uses Promise.allSettled so one failing image doesn't abort the rest.
 */
async function bundleAssets(cloneRoot) {
  const imgs = [...cloneRoot.querySelectorAll('[src]')].filter(el => {
    const src = el.getAttribute('src');
    return src && !src.startsWith('data:') && !src.startsWith('blob:');
  });

  if (!imgs.length) return;

  // Deduplicate by src
  const unique = new Map();
  for (const img of imgs) {
    const src = img.getAttribute('src');
    if (!unique.has(src)) unique.set(src, []);
    unique.get(src).push(img);
  }

  // Fetch all in parallel — capped at 6 concurrent (browser limit awareness)
  const entries = [...unique.entries()];
  const results = await Promise.allSettled(
    entries.map(async ([src]) => {
      try {
        const res = await fetch(src, { mode: 'cors', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const b64  = await blobToBase64(blob);
        return { src, b64 };
      } catch {
        return { src, b64: null }; // keep original URL on failure
      }
    })
  );

  // Apply results to cloned nodes
  const b64Map = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.b64) {
      b64Map.set(r.value.src, r.value.b64);
    }
  }

  for (const [src, nodes] of unique) {
    const b64 = b64Map.get(src);
    if (b64) {
      for (const n of nodes) n.setAttribute('src', b64);
    }
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ─── Tree Walker ─────────────────────────────────────────────────────────────

async function buildCloneAsync(root, sheet, options = {}) {
  const { onProgress } = options;
  const rootCtx   = Object.create(null);
  const rootClone = root.cloneNode(false);
  fixAssets(rootClone);

  const { styles: rootStyles, childCtx } = extractDiffedStyles(root, rootCtx);
  const rootCls = sheet.register(rootStyles);
  if (rootCls) setClassName(rootClone, [getClassName(rootClone), rootCls].filter(Boolean).join(' '));

  if (!VOID_TAGS.has(root.tagName.toLowerCase())) {
    materializePseudos(root, rootClone, sheet);
  }

  const stack = [];
  for (let i = root.childNodes.length - 1; i >= 0; i--) {
    stack.push({ source: root.childNodes[i], cloneParent: rootClone, ctx: childCtx });
  }

  let processed = 0;

  while (stack.length > 0) {
    const t0 = performance.now();
    let count = 0;

    while (stack.length > 0 && count < _chunkSize) {
      const { source, cloneParent, ctx } = stack.pop();
      count++;
      const result = processNode(source, sheet, ctx);
      if (!result) continue;
      cloneParent.appendChild(result.node);
      if (result.ctx && source.childNodes.length > 0) {
        for (let i = source.childNodes.length - 1; i >= 0; i--) {
          stack.push({ source: source.childNodes[i], cloneParent: result.node, ctx: result.ctx });
        }
      }
    }

    processed += count;
    onProgress?.(processed);

    const elapsed = performance.now() - t0;
    if (elapsed > 0) {
      _chunkSize = Math.max(20, Math.min(500, Math.round(_chunkSize * TARGET_FRAME_MS / elapsed)));
    }
    if (stack.length > 0) await yieldToMain();
  }

  return rootClone;
}

function processNode(source, sheet, ctx) {
  if (source.nodeType === Node.TEXT_NODE) return { node: source.cloneNode(false), ctx: null };
  if (source.nodeType !== Node.ELEMENT_NODE) return null;

  const tag = source.tagName;
  if (SKIP_TAGS.has(tag)) return null;

  // ── iFrame: try to inline its visible content ────────────────────────────
  if (tag === 'IFRAME') {
    try {
      const iDoc = source.contentDocument;
      const iBody = iDoc?.body;
      if (iBody && iDoc.location.href !== 'about:blank') {
        // Wrap iframe content in a div sized to match the iframe's dimensions
        const rect = source.getBoundingClientRect();
        const wrapper = document.createElement('div');
        wrapper.setAttribute('data-sec-iframe', 'true');
        wrapper.style.cssText = `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;overflow:hidden;position:relative;`;

        // Clone the iframe body's children into our wrapper
        for (const child of iBody.childNodes) {
          try { wrapper.appendChild(child.cloneNode(true)); } catch {}
        }

        // Also carry over any <style> tags from the iframe <head>
        const iHead = iDoc.head;
        if (iHead) {
          for (const style of iHead.querySelectorAll('style')) {
            try { wrapper.insertBefore(style.cloneNode(true), wrapper.firstChild); } catch {}
          }
        }

        const { styles, childCtx } = extractDiffedStyles(source, ctx);
        const cls = sheet.register(styles);
        if (cls) setClassName(wrapper, [getClassName(wrapper), cls].filter(Boolean).join(' '));
        return { node: wrapper, ctx: null }; // children already cloned raw; don't recurse
      }
    } catch {
      // Cross-origin iframe — fall through to render as placeholder
    }

    // Cross-origin or blank iframe — emit a visible placeholder
    const rect = source.getBoundingClientRect();
    const ph = document.createElement('div');
    ph.setAttribute('data-sec-iframe-xorigin', 'true');
    ph.style.cssText = `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;display:flex;align-items:center;justify-content:center;background:#1e293b;color:#64748b;font-family:ui-monospace,monospace;font-size:12px;border:1px dashed #334155;box-sizing:border-box;`;
    ph.textContent = '[cross-origin iframe]';
    return { node: ph, ctx: null };
  }
  // ────────────────────────────────────────────────────────────────────────────

  if (source.shadowRoot) {
    const ph = document.createElement(tag);
    ph.setAttribute('data-sec-shadow', 'true');
    const { styles } = extractDiffedStyles(source, ctx);
    const cls = sheet.register(styles);
    if (cls) setClassName(ph, cls);
    return { node: ph, ctx: null };
  }

  const clone = source.cloneNode(false);
  fixAssets(clone);

  const { styles, childCtx } = extractDiffedStyles(source, ctx);
  const cls = sheet.register(styles);
  if (cls) setClassName(clone, [getClassName(clone), cls].filter(Boolean).join(' '));

  if (!VOID_TAGS.has(tag.toLowerCase())) materializePseudos(source, clone, sheet);

  return { node: clone, ctx: childCtx };
}

// ─── Tailwind Mapper ─────────────────────────────────────────────────────────

const TW = {
  display: { flex:'flex',block:'block',inline:'inline','inline-flex':'inline-flex','inline-block':'inline-block','grid':'grid','none':'hidden' },
  position: { relative:'relative',absolute:'absolute',fixed:'fixed',sticky:'sticky' },
  'flex-direction': { row:'flex-row','row-reverse':'flex-row-reverse',column:'flex-col','column-reverse':'flex-col-reverse' },
  'flex-wrap': { wrap:'flex-wrap','nowrap':'flex-nowrap','wrap-reverse':'flex-wrap-reverse' },
  'justify-content': { 'flex-start':'justify-start','flex-end':'justify-end',center:'justify-center','space-between':'justify-between','space-around':'justify-around','space-evenly':'justify-evenly' },
  'align-items': { 'flex-start':'items-start','flex-end':'items-end',center:'items-center',stretch:'items-stretch',baseline:'items-baseline' },
  'align-self': { 'flex-start':'self-start','flex-end':'self-end',center:'self-center',stretch:'self-stretch',auto:'self-auto' },
  'text-align': { left:'text-left',right:'text-right',center:'text-center',justify:'text-justify' },
  'text-transform': { uppercase:'uppercase',lowercase:'lowercase',capitalize:'capitalize' },
  'text-overflow': { ellipsis:'text-ellipsis',clip:'text-clip' },
  'white-space': { nowrap:'whitespace-nowrap',pre:'whitespace-pre','pre-wrap':'whitespace-pre-wrap','pre-line':'whitespace-pre-line' },
  'overflow': { hidden:'overflow-hidden',auto:'overflow-auto',scroll:'overflow-scroll',visible:'overflow-visible' },
  'overflow-x': { hidden:'overflow-x-hidden',auto:'overflow-x-auto',scroll:'overflow-x-scroll' },
  'overflow-y': { hidden:'overflow-y-hidden',auto:'overflow-y-auto',scroll:'overflow-y-scroll' },
  'font-weight': { '100':'font-thin','200':'font-extralight','300':'font-light','400':'font-normal','500':'font-medium','600':'font-semibold','700':'font-bold','800':'font-extrabold','900':'font-black' },
  'font-style': { italic:'italic',oblique:'italic' },
  'object-fit': { contain:'object-contain',cover:'object-cover',fill:'object-fill','scale-down':'object-scale-down',none:'object-none' },
  'cursor': { pointer:'cursor-pointer',default:'cursor-default',text:'cursor-text','not-allowed':'cursor-not-allowed',wait:'cursor-wait',grab:'cursor-grab',grabbing:'cursor-grabbing' },
  'opacity': { '0':'opacity-0','0.5':'opacity-50','1':'opacity-100','0.25':'opacity-25','0.75':'opacity-75' },
  'vertical-align': { middle:'align-middle',top:'align-top',bottom:'align-bottom',baseline:'align-baseline' },
  'border-collapse': { collapse:'border-collapse',separate:'border-separate' },
};

// Numeric-to-Tailwind spacing map (px values → Tailwind scale)
const TW_SPACING = {
  '0px':'0','1px':'px','2px':'0.5','4px':'1','6px':'1.5','8px':'2','10px':'2.5',
  '12px':'3','14px':'3.5','16px':'4','20px':'5','24px':'6','28px':'7',
  '32px':'8','36px':'9','40px':'10','44px':'11','48px':'12','56px':'14',
  '64px':'16','80px':'20','96px':'24','128px':'32','160px':'40',
  '192px':'48','224px':'56','256px':'64','288px':'72','320px':'80','384px':'96',
};

const TW_FONT_SIZE = {
  '12px':'text-xs','14px':'text-sm','16px':'text-base','18px':'text-lg',
  '20px':'text-xl','24px':'text-2xl','30px':'text-3xl','36px':'text-4xl',
  '48px':'text-5xl','60px':'text-6xl','72px':'text-7xl','96px':'text-8xl','128px':'text-9xl',
};

const TW_ROUNDED = {
  '2px':'rounded-sm','4px':'rounded','6px':'rounded-md','8px':'rounded-lg',
  '12px':'rounded-xl','16px':'rounded-2xl','24px':'rounded-3xl','9999px':'rounded-full',
};

function stylesToTailwind(styles) {
  const classes = [];
  const unknown = {}; // styles with no Tailwind equivalent

  for (const [prop, val] of Object.entries(styles)) {
    let mapped = false;

    // Direct lookup
    if (TW[prop]?.[val]) {
      classes.push(TW[prop][val]);
      mapped = true;

    } else if (prop === 'font-size' && TW_FONT_SIZE[val]) {
      classes.push(TW_FONT_SIZE[val]); mapped = true;

    } else if (prop === 'border-radius' && TW_ROUNDED[val]) {
      classes.push(TW_ROUNDED[val]); mapped = true;

    } else if (prop === 'width') {
      if (val === '100%') { classes.push('w-full'); mapped = true; }
      else if (val === '50%') { classes.push('w-1/2'); mapped = true; }
      else if (TW_SPACING[val]) { classes.push(`w-${TW_SPACING[val]}`); mapped = true; }

    } else if (prop === 'height') {
      if (val === '100%') { classes.push('h-full'); mapped = true; }
      else if (TW_SPACING[val]) { classes.push(`h-${TW_SPACING[val]}`); mapped = true; }

    } else if (prop === 'margin') {
      const parts = val.split(' ');
      if (parts.length === 1 && TW_SPACING[parts[0]]) { classes.push(`m-${TW_SPACING[parts[0]]}`); mapped = true; }
      else if (parts.length === 2 && TW_SPACING[parts[0]] && TW_SPACING[parts[1]]) {
        classes.push(`my-${TW_SPACING[parts[0]]}`, `mx-${TW_SPACING[parts[1]]}`); mapped = true;
      }

    } else if (prop === 'padding') {
      const parts = val.split(' ');
      if (parts.length === 1 && TW_SPACING[parts[0]]) { classes.push(`p-${TW_SPACING[parts[0]]}`); mapped = true; }
      else if (parts.length === 2 && TW_SPACING[parts[0]] && TW_SPACING[parts[1]]) {
        classes.push(`py-${TW_SPACING[parts[0]]}`, `px-${TW_SPACING[parts[1]]}`); mapped = true;
      }

    } else if (prop === 'gap') {
      if (TW_SPACING[val]) { classes.push(`gap-${TW_SPACING[val]}`); mapped = true; }

    } else if (prop === 'background-color') {
      // Map transparent/white/black
      if (val === 'rgb(255, 255, 255)') { classes.push('bg-white'); mapped = true; }
      else if (val === 'rgb(0, 0, 0)') { classes.push('bg-black'); mapped = true; }

    } else if (prop === 'color') {
      if (val === 'rgb(255, 255, 255)') { classes.push('text-white'); mapped = true; }
      else if (val === 'rgb(0, 0, 0)') { classes.push('text-black'); mapped = true; }

    } else if (prop === 'box-shadow' && val === 'none') {
      classes.push('shadow-none'); mapped = true;

    } else if (prop === 'z-index') {
      const ZI = {'0':'z-0','10':'z-10','20':'z-20','30':'z-30','40':'z-40','50':'z-50'};
      if (ZI[val]) { classes.push(ZI[val]); mapped = true; }
    }

    if (!mapped) unknown[prop] = val;
  }

  return { classes, unknown };
}

// ─── Bootstrap Mapper ─────────────────────────────────────────────────────────

const BS_SPACING = {
  '0px':'0','4px':'1','8px':'2','12px':'','16px':'3','24px':'4','32px':'5',
};

function stylesToBootstrap(styles) {
  const classes = [];
  const unknown = {};

  for (const [prop, val] of Object.entries(styles)) {
    let mapped = false;

    if (prop === 'display') {
      const map = { flex:'d-flex',block:'d-block',inline:'d-inline','inline-flex':'d-inline-flex','inline-block':'d-inline-block',none:'d-none',grid:'d-grid' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'flex-direction') {
      const map = { row:'flex-row','row-reverse':'flex-row-reverse',column:'flex-column','column-reverse':'flex-column-reverse' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'justify-content') {
      const map = { 'flex-start':'justify-content-start','flex-end':'justify-content-end',center:'justify-content-center','space-between':'justify-content-between','space-around':'justify-content-around','space-evenly':'justify-content-evenly' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'align-items') {
      const map = { 'flex-start':'align-items-start','flex-end':'align-items-end',center:'align-items-center',stretch:'align-items-stretch',baseline:'align-items-baseline' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'text-align') {
      const map = { left:'text-start',right:'text-end',center:'text-center' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'font-weight') {
      const map = { '400':'fw-normal','700':'fw-bold','300':'fw-light','600':'fw-semibold','800':'fw-bolder' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'font-style') {
      if (val === 'italic') { classes.push('fst-italic'); mapped = true; }

    } else if (prop === 'overflow') {
      const map = { hidden:'overflow-hidden',auto:'overflow-auto',scroll:'overflow-scroll',visible:'overflow-visible' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'position') {
      const map = { relative:'position-relative',absolute:'position-absolute',fixed:'position-fixed',sticky:'position-sticky' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'margin') {
      const parts = val.split(' ');
      if (parts.length === 1 && BS_SPACING[parts[0]] !== undefined) {
        classes.push(`m-${BS_SPACING[parts[0]]}`); mapped = true;
      }

    } else if (prop === 'padding') {
      const parts = val.split(' ');
      if (parts.length === 1 && BS_SPACING[parts[0]] !== undefined) {
        classes.push(`p-${BS_SPACING[parts[0]]}`); mapped = true;
      }

    } else if (prop === 'border-radius') {
      const map = { '4px':'rounded-1','6px':'rounded-2','8px':'rounded-3','9999px':'rounded-pill' };
      if (map[val]) { classes.push(map[val]); mapped = true; }
      else if (val) { classes.push('rounded'); mapped = true; }

    } else if (prop === 'opacity') {
      const map = { '0':'opacity-0','0.25':'opacity-25','0.5':'opacity-50','0.75':'opacity-75','1':'opacity-100' };
      if (map[val]) { classes.push(map[val]); mapped = true; }

    } else if (prop === 'cursor') {
      if (val === 'pointer') { classes.push('cursor-pointer'); mapped = true; }

    } else if (prop === 'background-color') {
      if (val === 'rgb(255, 255, 255)') { classes.push('bg-white'); mapped = true; }
      else if (val === 'rgb(0, 0, 0)') { classes.push('bg-dark'); mapped = true; }

    } else if (prop === 'color') {
      if (val === 'rgb(255, 255, 255)') { classes.push('text-white'); mapped = true; }
      else if (val === 'rgb(0, 0, 0)') { classes.push('text-dark'); mapped = true; }
    }

    if (!mapped) unknown[prop] = val;
  }

  return { classes, unknown };
}

// ─── Framework Serializers ───────────────────────────────────────────────────

function serializeTailwind(cloneRoot, originalRoot) {
  // Re-walk the original and clone together to apply Tailwind classes
  applyFrameworkClasses(cloneRoot, originalRoot, stylesToTailwind, 'tailwind');
  return `<!-- Generated by Smart Element Copier v5 — Tailwind CSS -->\n<!-- Requires Tailwind CSS: https://tailwindcss.com -->\n${cloneRoot.outerHTML}`;
}

function serializeBootstrap(cloneRoot, originalRoot) {
  applyFrameworkClasses(cloneRoot, originalRoot, stylesToBootstrap, 'bootstrap');
  return `<!-- Generated by Smart Element Copier v5 — Bootstrap 5 -->\n<!-- Requires Bootstrap CSS: https://getbootstrap.com -->\n${cloneRoot.outerHTML}`;
}

/**
 * Walk the clone tree, re-extract computed styles from the ORIGINAL source tree,
 * map them to framework classes, and apply. Unknown styles go into style= attribute.
 */
function applyFrameworkClasses(clone, source, mapper, framework) {
  if (source.nodeType !== Node.ELEMENT_NODE || clone.nodeType !== Node.ELEMENT_NODE) return;
  if (SKIP_TAGS.has(source.tagName)) return;

  try {
    const computed = window.getComputedStyle(source);
    const raw = {};
    for (const p of PROPS) {
      const v = computed.getPropertyValue(p);
      if (v && !WORTHLESS.has(v)) raw[p] = v;
    }
    const optimized = optimizeStyles(raw);
    const { classes, unknown } = mapper(optimized);

    // Remove our internal _sXX classes, add framework classes
    const existing = getClassName(clone).split(' ').filter(c => !c.startsWith('_s'));
    setClassName(clone, existing.concat(classes).filter(Boolean).join(' '));

    // Unknown styles → inline style attr
    const unknownCSS = Object.entries(unknown).map(([p,v]) => `${p}:${v}`).join(';');
    if (unknownCSS) clone.setAttribute('style', unknownCSS);
    else clone.removeAttribute('style');

  } catch {}

  // Recurse
  const sourceChildren = [...source.childNodes].filter(n => n.nodeType === Node.ELEMENT_NODE);
  const cloneChildren  = [...clone.childNodes].filter(n => n.nodeType === Node.ELEMENT_NODE);

  for (let i = 0; i < Math.min(sourceChildren.length, cloneChildren.length); i++) {
    applyFrameworkClasses(cloneChildren[i], sourceChildren[i], mapper, framework);
  }
}

// ─── JSX Converter ───────────────────────────────────────────────────────────

const JSX_MAP = {
  'class':'className','for':'htmlFor','tabindex':'tabIndex','readonly':'readOnly',
  'maxlength':'maxLength','minlength':'minLength','colspan':'colSpan','rowspan':'rowSpan',
  'cellpadding':'cellPadding','cellspacing':'cellSpacing','frameborder':'frameBorder',
  'accesskey':'accessKey','enctype':'encType','contenteditable':'contentEditable',
  'crossorigin':'crossOrigin','autocomplete':'autoComplete','autofocus':'autoFocus',
  'autoplay':'autoPlay','usemap':'useMap','stroke-width':'strokeWidth',
  'stroke-linecap':'strokeLinecap','stroke-linejoin':'strokeLinejoin',
  'fill-rule':'fillRule','clip-rule':'clipRule','stop-color':'stopColor',
  'stop-opacity':'stopOpacity','viewbox':'viewBox','preserveaspectratio':'preserveAspectRatio',
};

function toJSX(html) {
  let jsx = html;
  jsx = jsx.replace(/\bstyle="([^"]*)"/g, (_, css) => {
    const obj = css.split(';').filter(s=>s.trim()).map(rule => {
      const ci = rule.indexOf(':');
      if (ci === -1) return null;
      const prop = rule.slice(0,ci).trim();
      const val  = rule.slice(ci+1).trim().replace(/"/g,"'");
      const camel = prop.replace(/^-([a-z])/,(_,c)=>c.toUpperCase()).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
      return val ? `${camel}:'${val}'` : null;
    }).filter(Boolean).join(',');
    return `style={{${obj}}}`;
  });
  for (const [h,j] of Object.entries(JSX_MAP)) {
    jsx = jsx.replace(new RegExp(`\\b${h}=`,'gi'), `${j}=`);
  }
  for (const tag of VOID_TAGS) {
    jsx = jsx.replace(new RegExp(`<(${tag})(\\s[^>]*?)?>`, 'gi'), '<$1$2 />');
  }
  return `// Auto-generated by Smart Element Copier v5\nimport React from 'react';\n\nexport default function CopiedElement() {\n  return (\n    ${jsx.split('\n').join('\n    ')}\n  );\n}\n`;
}

// ─── SVG Extractor ────────────────────────────────────────────────────────────

function exportSVG(el) {
  const t0 = performance.now();

  // Walk up to find the nearest SVG root if user clicked an inner path/circle/etc.
  let svgEl = el;
  while (svgEl && svgEl.tagName.toLowerCase() !== 'svg') {
    svgEl = svgEl.parentElement;
  }
  if (!svgEl) {
    // Friendly fallback — tell the user what happened
    throw new Error('No SVG here — hover over an SVG icon or illustration and try again');
  }

  // Clone so we don't mutate the page
  const clone = svgEl.cloneNode(true);

  // Ensure essential SVG attributes are present
  if (!clone.getAttribute('xmlns'))       clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Carry over width/height from computed size if not set as attributes
  if (!clone.getAttribute('width') || !clone.getAttribute('height')) {
    const rect = svgEl.getBoundingClientRect();
    if (!clone.getAttribute('width')  && rect.width)  clone.setAttribute('width',  Math.round(rect.width));
    if (!clone.getAttribute('height') && rect.height) clone.setAttribute('height', Math.round(rect.height));
  }

  // Remove any script tags from the clone for safety
  clone.querySelectorAll('script').forEach(s => s.remove());

  // Strip data-sec-ui markers that we injected
  clone.querySelectorAll('[data-sec-ui]').forEach(n => n.remove());

  // Inline computed fill/stroke from elements that rely purely on CSS
  // (so the SVG looks the same when pasted outside its original page context)
  const sourceEls = svgEl.querySelectorAll('*');
  const cloneEls  = clone.querySelectorAll('*');
  sourceEls.forEach((src, i) => {
    const cl = cloneEls[i];
    if (!cl) return;
    try {
      const cs = window.getComputedStyle(src);
      const fill   = cs.getPropertyValue('fill');
      const stroke = cs.getPropertyValue('stroke');
      // Only inline if the element doesn't already have an explicit attribute
      if (fill   && fill   !== 'none' && !src.getAttribute('fill'))   cl.setAttribute('fill',   fill);
      if (stroke && stroke !== 'none' && !src.getAttribute('stroke')) cl.setAttribute('stroke', stroke);
    } catch {}
  });

  // Pretty-print: add newlines between tags for readability
  const raw = new XMLSerializer().serializeToString(clone);
  // Normalize self-closing tags and prettify slightly
  const pretty = raw
    .replace(/></g, '>\n<')           // newline between tags
    .replace(/^\s*\n/gm, '')          // remove blank lines
    .replace(/(<svg[^>]*>)\n/, '$1\n'); // keep opening tag on one line

  const output = `<!-- Copied by Smart Element Copier v5 -->\n${pretty}`;

  return {
    html: output,
    stats: {
      mode: 'svg',
      bytes: output.length,
      sharedClasses: 0,
      elapsedMs: (performance.now() - t0).toFixed(1),
    },
  };
}

// ─── Text Extractor ──────────────────────────────────────────────────────────

function exportText(el) {
  const t0  = performance.now();
  const txt = (el.innerText ?? el.textContent ?? '').trim();
  return { html: txt, stats: { mode:'text', bytes:txt.length, sharedClasses:0, elapsedMs:(performance.now()-t0).toFixed(1) } };
}

// ─── Serializer ──────────────────────────────────────────────────────────────

function serialize(clone, source, sheet, mode) {
  if (mode === 'tailwind')  return serializeTailwind(clone, source);
  if (mode === 'bootstrap') return serializeBootstrap(clone, source);

  const sid        = sheet.scopeId;
  const styleBlock = sheet.serialize();

  // All non-framework modes wrap the element in a root scope div.
  // This is the isolation boundary: all generated CSS selectors start with .${sid},
  // so pasting the output into any page won't conflict with that page's existing styles.
  if (mode === 'jsx') {
    const wrapped = `<div className="${sid}">\n  ${clone.outerHTML}\n</div>`;
    return toJSX(`${styleBlock}\n${wrapped}`);
  }

  if (mode === 'document') {
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width,initial-scale=1">',
      '  <title>Extracted Element</title>',
      '  <style>*,*::before,*::after{box-sizing:border-box}</style>',
      `  ${styleBlock}`,
      '</head>',
      '<body>',
      `<div class="${sid}">`,
      clone.outerHTML,
      '</div>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  return `<!-- Smart Element Copier v6 -->\n${styleBlock}\n<div class="${sid}">\n${clone.outerHTML}\n</div>`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function exportElement(element, options = {}) {
  const { mode = 'html', onProgress, bundleImages = false } = options;

  if (mode === 'text') return exportText(element);
  if (mode === 'svg')  return exportSVG(element);

  const sheet = new StyleSheet();
  const t0    = performance.now();

  const clone = await buildCloneAsync(element, sheet, { onProgress });

  // Capture @font-face and @media rules used by this element's subtree
  sheet.captureExtras(element);

  // Optional: inline all images as base64
  if (bundleImages) await bundleAssets(clone);

  const html = serialize(clone, element, sheet, mode);

  return {
    html,
    stats: {
      mode,
      bytes: html.length,
      sharedClasses: sheet.size,
      elapsedMs: (performance.now() - t0).toFixed(1),
    },
  };
}

window.__SmartElementCopierEngine = {
  exportElement,
  exportText,
  exportSVG,
  _optimizeStyles: optimizeStyles,
  _stylesToTailwind: stylesToTailwind,
  _stylesToBootstrap: stylesToBootstrap,
};