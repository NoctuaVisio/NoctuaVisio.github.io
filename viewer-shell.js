// Unified shell for every 3D-viewer page. Lays out a Unity/Blender-style
// chrome around the canvas:
//
//   [header — owned by page]
//   ┌──┬─────────────────────────────┬──────────┐
//   │  │                             │          │
//   │R │       canvas + overlays     │ inspector│
//   │  │                             │          │
//   └──┴─────────────────────────────┴──────────┘
//   [status bar — owned by shell]
//
// On mobile (≤ 768px) the rail becomes a bottom bar and the inspector
// becomes a slide-up bottom sheet — CSS in /viewer.css owns the flip.
//
// Why this lives in its own module: every viewer page (inspection, asset,
// admin/edit) needs the same chrome; previously each page baked its own
// header+sidebar+footer and they drifted constantly (different toggle
// button styles, different mobile behaviour or none, inspection had a
// persistent right rail that fought the canvas on phones).
//
// Usage:
//   import { mountViewerShell } from '/viewer-shell.js';
//   const shell = mountViewerShell({
//     canvasContainer: document.getElementById('viewer'),
//     insertAfter:     document.querySelector('header'),
//     panels: [
//       { id: 'overview', title: 'Overview', iconSvg: '<svg…/>',
//         bodyHtml: '<div…/>' },
//       …
//     ],
//     toggles: [
//       { id: 'markers', title: 'Markers', iconSvg: '<svg…/>',
//         initial: true, onChange: (on) => {…} },
//       …
//     ],
//     modes: {
//       initial: 'free',
//       items: [
//         { id: 'free', title: 'Free view', iconSvg: '<svg…/>', onSelect: () => {…} },
//         { id: 'top',  title: 'Top view',  iconSvg: '<svg…/>', onSelect: () => {…} },
//       ],
//     },
//     defaultPanel: 'overview',   // or null to start collapsed
//   });
//
//   shell.panel('overview').setBody(html);
//   shell.panel('overview').activate();
//   shell.toggle('markers').set(false);
//   shell.mode().activate('top');
//   shell.setStatus([{ label: 'Vertices', value: '47k' }, …]);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class')          node.className = v;
    else if (k === 'html')      node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else                        node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function mountViewerShell({
  canvasContainer,
  insertAfter,
  panels = [],
  panelsLabel = null,
  toggles = [],
  togglesLabel = null,
  modes = null,
  modesLabel = null,
  actions = [],
  actionSections = null,   // [{ label, items: [...] }, ...] — overrides `actions` when present
  defaultPanel = null,
} = {}) {
  if (!canvasContainer) throw new Error('mountViewerShell: canvasContainer required');

  // ── DOM scaffold ────────────────────────────────────────────────────
  const shellEl     = el('div', { class: 'v-shell' });
  const railEl      = el('aside', { class: 'v-rail', 'aria-label': 'View tools' });
  const canvasSlot  = el('main', { class: 'v-canvas' });
  const inspector   = el('aside', { class: 'v-inspector', 'data-collapsed': 'true' });
  const statusbar   = el('div', { class: 'v-statusbar' });

  const inspHead = el('div', { class: 'v-inspector-head' });
  const inspTitle = el('div', { class: 'v-inspector-title' });
  const inspClose = el('button', { class: 'v-inspector-close', 'aria-label': 'Close panel', html: '&times;' });
  inspHead.append(inspTitle, inspClose);
  const inspBody = el('div', { class: 'v-inspector-body' });
  inspector.append(inspHead, inspBody);

  // ── Rail buttons ────────────────────────────────────────────────────
  const panelButtons = new Map();   // id → button
  const panelBodies  = new Map();   // id → .v-pane div
  const panelMeta    = new Map();   // id → { title, …  }
  const toggleState  = new Map();   // id → { btn, on, onChange }
  let modeButtons    = new Map();   // id → button
  let activePanelId  = null;
  let activeModeId   = modes ? modes.initial : null;

  function makeRailBtn(opts) {
    const b = el('button', {
      class: 'v-rail-btn',
      'data-label': opts.title || '',
      title: opts.title || '',
      type: 'button',
    });
    // dataMode lets the page hide rail buttons that don't apply in the
    // current editor mode (admin/edit uses body.mode-asset / mode-inspection
    // / mode-task with a CSS rule that hides elements whose data-mode
    // disagrees). New items can opt-in by passing { dataMode: 'inspection' }.
    if (opts.dataMode) b.setAttribute('data-mode', opts.dataMode);
    b.innerHTML = opts.iconSvg || '';
    if (typeof opts.onClick === 'function') b.addEventListener('click', opts.onClick);
    return b;
  }

  // Section "labels" render as a tiny divider bar between rail groups —
  // visible text proved hard to read in a 44px column and prone to clipping.
  // The bar is hoverable; its `title` attribute carries the section name and
  // gets re-translated by NoctuaI18n via `data-i18n-title` when the user
  // toggles language. Accepts a literal string OR `{ i18n, fallback }`.
  function sectionLabel(spec) {
    if (!spec) return null;
    const text = (typeof spec === 'string') ? spec : (spec.fallback || spec.i18n || '');
    const i18nKey = (typeof spec === 'object' && spec.i18n) ? spec.i18n : null;
    const attrs = { class: 'v-rail-section-label', title: text };
    if (i18nKey) attrs['data-i18n-title'] = i18nKey;
    const lbl = el('div', attrs);
    // textContent is intentionally empty — the bar is visual only. Tooltip
    // surfaces the name on hover for users who want to know.
    return lbl;
  }

  // Panels group (REPORTS)
  if (panels.length) {
    const labelNode = sectionLabel(panelsLabel);
    if (labelNode) railEl.appendChild(labelNode);
    const group = el('div', { class: 'v-rail-group', 'data-role': 'panels' });
    for (const p of panels) {
      panelMeta.set(p.id, p);
      const btn = makeRailBtn({
        title: p.title,
        iconSvg: p.iconSvg,
        dataMode: p.dataMode,
        onClick: () => togglePanel(p.id),
      });
      panelButtons.set(p.id, btn);
      group.appendChild(btn);

      const pane = el('div', { class: 'v-pane', 'data-pane': p.id });
      if (p.bodyHtml) pane.innerHTML = p.bodyHtml;
      panelBodies.set(p.id, pane);
      inspBody.appendChild(pane);
    }
    railEl.appendChild(group);
  }

  // Toggles group (visibility flags) — VIEW
  if (toggles.length) {
    const labelNode = sectionLabel(togglesLabel);
    if (labelNode) railEl.appendChild(labelNode);
    const group = el('div', { class: 'v-rail-group', 'data-role': 'toggles' });
    for (const t of toggles) {
      const btn = makeRailBtn({
        title: t.title,
        iconSvg: t.iconSvg,
        dataMode: t.dataMode,
        onClick: () => setToggle(t.id, !toggleState.get(t.id).on),
      });
      toggleState.set(t.id, { btn, on: !!t.initial, onChange: t.onChange });
      if (t.initial) btn.classList.add('on');
      group.appendChild(btn);
    }
    railEl.appendChild(group);
  }

  // Mode group (mutually exclusive — e.g. Free / Top) — CAMERA
  if (modes && Array.isArray(modes.items) && modes.items.length) {
    const labelNode = sectionLabel(modesLabel);
    if (labelNode) railEl.appendChild(labelNode);
    const group = el('div', { class: 'v-rail-group', 'data-role': 'modes' });
    for (const m of modes.items) {
      const btn = makeRailBtn({
        title: m.title,
        iconSvg: m.iconSvg,
        dataMode: m.dataMode,
        onClick: () => setMode(m.id),
      });
      btn.dataset.mode = m.id;
      btn._onSelect = m.onSelect;
      modeButtons.set(m.id, btn);
      if (m.id === activeModeId) btn.classList.add('on');
      group.appendChild(btn);
    }
    railEl.appendChild(group);
  }

  // Action sections — page owns categorization. Prefer `actionSections`
  // ([{ label, items: [...] }, ...]) for explicit grouping; fall back to
  // the flat `actions` array (with optional per-item `divider:true`) when
  // not provided.
  let actionButtons = new Map();   // id → button
  function appendActions(items) {
    const group = el('div', { class: 'v-rail-group', 'data-role': 'actions' });
    for (const a of items) {
      if (a.divider) group.appendChild(el('div', { class: 'v-rail-divider' }));
      const btn = makeRailBtn({
        title: a.title,
        iconSvg: a.iconSvg,
        dataMode: a.dataMode,
        onClick: () => { if (typeof a.onClick === 'function') a.onClick(); },
      });
      actionButtons.set(a.id, btn);
      group.appendChild(btn);
    }
    railEl.appendChild(group);
  }
  if (Array.isArray(actionSections) && actionSections.length) {
    for (const sec of actionSections) {
      if (!sec.items || !sec.items.length) continue;
      const labelNode = sectionLabel(sec.label);
      if (labelNode) railEl.appendChild(labelNode);
      appendActions(sec.items);
    }
  } else if (Array.isArray(actions) && actions.length) {
    appendActions(actions);
  }

  // ── Behavior wiring ─────────────────────────────────────────────────
  function activatePanel(id) {
    if (!panelButtons.has(id)) return;
    activePanelId = id;
    for (const [pid, btn] of panelButtons) btn.classList.toggle('active-panel', pid === id);
    for (const [pid, pane] of panelBodies) pane.classList.toggle('on', pid === id);
    inspTitle.textContent = (panelMeta.get(id) && panelMeta.get(id).title) || '';
    inspector.dataset.collapsed = 'false';
  }
  function closePanel() {
    activePanelId = null;
    for (const btn of panelButtons.values()) btn.classList.remove('active-panel');
    inspector.dataset.collapsed = 'true';
  }
  function togglePanel(id) {
    if (activePanelId === id) closePanel();
    else                      activatePanel(id);
  }
  inspClose.addEventListener('click', closePanel);

  function setToggle(id, on) {
    const st = toggleState.get(id); if (!st) return;
    st.on = !!on;
    st.btn.classList.toggle('on', st.on);
    if (typeof st.onChange === 'function') st.onChange(st.on);
  }

  function setMode(id) {
    if (!modeButtons.has(id)) return;
    // Mutually-exclusive: toggle one on, others off; call onSelect of new one.
    activeModeId = id;
    for (const [mid, btn] of modeButtons) btn.classList.toggle('on', mid === id);
    const btn = modeButtons.get(id);
    if (btn && typeof btn._onSelect === 'function') btn._onSelect();
  }

  // ── Mount ───────────────────────────────────────────────────────────
  // Move the canvas container into the canvas slot. The page keeps its
  // own references — the node is the same, just relocated.
  canvasSlot.appendChild(canvasContainer);
  shellEl.append(railEl, canvasSlot, inspector);

  // Insert shell + status bar into the document just after the page header
  // (or fall back to appending to <body>).
  const after = insertAfter || document.body.lastElementChild;
  after.parentNode.insertBefore(shellEl,  after.nextSibling);
  after.parentNode.insertBefore(statusbar, shellEl.nextSibling);

  // Body flex layout so shell fills the viewport between header + statusbar.
  document.body.classList.add('v-shell-page');

  if (defaultPanel) activatePanel(defaultPanel);

  // ── Public API ──────────────────────────────────────────────────────
  function panel(id) {
    const pane = panelBodies.get(id);
    if (!pane) return null;
    return {
      el: pane,
      setBody:   (html) => { pane.innerHTML = html; },
      activate:  () => activatePanel(id),
      close:     () => { if (activePanelId === id) closePanel(); },
    };
  }
  function toggle(id) {
    const st = toggleState.get(id);
    if (!st) return null;
    return {
      get: () => st.on,
      set: (v) => setToggle(id, v),
    };
  }
  function mode() {
    return {
      get: () => activeModeId,
      activate: (id) => setMode(id),
      disable: (id, disabled = true) => {
        const btn = modeButtons.get(id); if (!btn) return;
        btn.disabled = !!disabled;
        if (disabled) btn.setAttribute('disabled', '');
        else btn.removeAttribute('disabled');
      },
    };
  }
  function action(id) {
    const btn = actionButtons.get(id);
    if (!btn) return null;
    return {
      el: btn,
      setActive: (on) => btn.classList.toggle('on', !!on),
      isActive: () => btn.classList.contains('on'),
    };
  }

  function setStatus(items) {
    statusbar.innerHTML = '';
    items.forEach((it, i) => {
      if (i > 0 && (!it || !it.skipSep)) statusbar.appendChild(el('div', { class: 'v-stat-sep' }));
      if (!it) return;
      const stat = el('span', { class: 'v-stat' });
      if (it.label) { const lbl = document.createElement('span'); lbl.textContent = it.label + ':'; stat.append(lbl, ' '); }
      const val = el('b'); val.textContent = it.value ?? '';
      stat.appendChild(val);
      statusbar.appendChild(stat);
    });
  }

  // Hide a section label when the immediately-following rail group has zero
  // visible buttons (all kids hidden via data-mode + body.mode-X). Pages
  // should call this after switching modes so labeled-but-empty sections
  // don't leave the rail dotted with floating headers.
  function refreshSectionVisibility() {
    railEl.querySelectorAll('.v-rail-section-label').forEach(label => {
      const group = label.nextElementSibling;
      if (!group || !group.classList.contains('v-rail-group')) return;
      const hasVisible = Array.from(group.querySelectorAll('.v-rail-btn'))
        .some(btn => getComputedStyle(btn).display !== 'none');
      label.style.display = hasVisible ? '' : 'none';
    });
  }

  return {
    elements: { shell: shellEl, rail: railEl, canvas: canvasSlot, inspector, statusbar },
    panel, toggle, mode, action, setStatus,
    refreshSectionVisibility,
    activatePanel, closePanel,
    destroy() {
      shellEl.remove(); statusbar.remove();
      document.body.classList.remove('v-shell-page');
    },
  };
}
