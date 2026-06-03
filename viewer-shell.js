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
  toggles = [],
  modes = null,
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
    b.innerHTML = opts.iconSvg || '';
    if (typeof opts.onClick === 'function') b.addEventListener('click', opts.onClick);
    return b;
  }

  // Panels group
  if (panels.length) {
    const group = el('div', { class: 'v-rail-group', 'data-role': 'panels' });
    for (const p of panels) {
      panelMeta.set(p.id, p);
      const btn = makeRailBtn({
        title: p.title,
        iconSvg: p.iconSvg,
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

  railEl.appendChild(el('div', { class: 'v-rail-sp' }));

  // Toggles group (visibility flags)
  if (toggles.length) {
    const group = el('div', { class: 'v-rail-group', 'data-role': 'toggles' });
    for (const t of toggles) {
      const btn = makeRailBtn({
        title: t.title,
        iconSvg: t.iconSvg,
        onClick: () => setToggle(t.id, !toggleState.get(t.id).on),
      });
      toggleState.set(t.id, { btn, on: !!t.initial, onChange: t.onChange });
      if (t.initial) btn.classList.add('on');
      group.appendChild(btn);
    }
    railEl.appendChild(group);
    railEl.appendChild(el('div', { class: 'v-rail-divider' }));
  }

  // Mode group (mutually exclusive — e.g. Free / Top)
  if (modes && Array.isArray(modes.items) && modes.items.length) {
    const group = el('div', { class: 'v-rail-group', 'data-role': 'modes' });
    for (const m of modes.items) {
      const btn = makeRailBtn({
        title: m.title,
        iconSvg: m.iconSvg,
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

  return {
    elements: { shell: shellEl, rail: railEl, canvas: canvasSlot, inspector, statusbar },
    panel, toggle, mode, setStatus,
    activatePanel, closePanel,
    destroy() {
      shellEl.remove(); statusbar.remove();
      document.body.classList.remove('v-shell-page');
    },
  };
}
