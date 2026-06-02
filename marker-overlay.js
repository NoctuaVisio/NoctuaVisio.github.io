// Shared HTML-overlay marker renderer. Used by:
//   - admin/edit/        (editor — three.js GLB + PlayCanvas splat)
//   - inspection/        (public inspection viewer — three.js GLB only today)
//   - index.html         (landing's hero model — three.js GLB)
//
// Why an HTML overlay instead of 3D sprites/meshes:
//   - PlayCanvas has no built-in Sprite (would need a custom shader).
//   - 3D sprites scale with perspective which makes far points illegible.
//   - HTML+CSS gives us crisp text, color glow and hover/selected states
//     "for free", and the same DOM nodes serve every engine because the
//     caller supplies a projection function (world → screen pixels).
//
// Public API:
//   import { createMarkerOverlay } from '/marker-overlay.js';
//   const ovl = createMarkerOverlay({
//     container: HTMLElement,                  // absolute-positioned, sits over the canvas
//     onSelect:  (pointId, mouseEvt) => {...}, // click handler; receives pt.id
//     onHover:   (pointId, mouseEvt) => {...}, // optional — fires on pointerenter
//     onLeave:   (pointId, mouseEvt) => {...}, // optional — fires on pointerleave
//   });
//   ovl.update(points, selectedId, projectFn);
//     // points     — array of inspection points { id, severity, score, ... }
//     // selectedId — currently-selected point id (or null)
//     // projectFn  — (pt) => { x, y, visible } in CSS pixels relative to
//     //              container's bounding box, or { visible: false }
//   ovl.clear();    — wipes all marker DOM nodes
//   ovl.destroy();  — clear + drop internal state

const STYLE_ID = 'noctua-marker-overlay-style';
const CSS = `
.ovl-marker{
  position:absolute;width:34px;height:34px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font:800 13px/1 'Inter',system-ui,sans-serif;color:#fff;
  border:2.5px solid rgba(255,255,255,.9);
  transform:translate(-50%,-50%);
  pointer-events:auto;cursor:pointer;user-select:none;
  transition:transform .12s ease,box-shadow .12s ease;
  will-change:transform,left,top;
}
.ovl-marker.selected{border-color:#fff}
/* Severity palette — medium uses a true yellow (#facc15) instead of the
   previous amber #f59e0b so it reads distinctly from high (#f97316 orange). */
.ovl-marker[data-sev=critical]{background:#ef4444;box-shadow:0 0 14px 2px rgba(239,68,68,.75)}
.ovl-marker[data-sev=high]    {background:#f97316;box-shadow:0 0 14px 2px rgba(249,115,22,.75)}
.ovl-marker[data-sev=medium]  {background:#facc15;box-shadow:0 0 14px 2px rgba(250,204,21,.75)}
.ovl-marker[data-sev=low]     {background:#10b981;box-shadow:0 0 14px 2px rgba(16,185,129,.75)}
.ovl-marker:hover{transform:translate(-50%,-50%) scale(1.12)}
.ovl-marker.selected{transform:translate(-50%,-50%) scale(1.25)}
.ovl-marker[data-sev=critical].selected{box-shadow:0 0 22px 4px rgba(239,68,68,.95)}
.ovl-marker[data-sev=high].selected    {box-shadow:0 0 22px 4px rgba(249,115,22,.95)}
.ovl-marker[data-sev=medium].selected  {box-shadow:0 0 22px 4px rgba(250,204,21,.95)}
.ovl-marker[data-sev=low].selected     {box-shadow:0 0 22px 4px rgba(16,185,129,.95)}
`;

function injectStyleOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createMarkerOverlay({ container, onSelect, onHover, onLeave } = {}) {
  if (!container) throw new Error('createMarkerOverlay: container is required');
  injectStyleOnce();

  // Make sure the container itself sits as an overlay. Callers can override
  // via their own CSS — these are just safe defaults.
  if (!container.style.position) container.style.position = 'absolute';
  container.style.pointerEvents = 'none';

  // Nodes keyed by point id so per-frame churn is just transform updates.
  const nodes = new Map();   // id → { el, sev, score, selected, visible }

  function ensureNode(pt) {
    let n = nodes.get(pt.id);
    if (n) return n;
    const el = document.createElement('div');
    el.className = 'ovl-marker';
    el.dataset.sev = pt.severity || 'medium';
    el.dataset.id  = String(pt.id);
    el.textContent = pt.score != null ? pt.score : '';
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (typeof onSelect === 'function') onSelect(pt.id, e);
    });
    if (typeof onHover === 'function') {
      el.addEventListener('pointerenter', e => onHover(pt.id, e));
    }
    if (typeof onLeave === 'function') {
      el.addEventListener('pointerleave', e => onLeave(pt.id, e));
    }
    container.appendChild(el);
    n = { el, sev: pt.severity, score: pt.score, selected: false, visible: true };
    nodes.set(pt.id, n);
    return n;
  }

  function update(points, selectedId, projectFn) {
    if (!Array.isArray(points)) points = [];
    const seen = new Set();
    for (const pt of points) {
      if (!pt || pt.id == null) continue;
      seen.add(pt.id);
      const n = ensureNode(pt);
      if (n.sev !== pt.severity) { n.el.dataset.sev = pt.severity || 'medium'; n.sev = pt.severity; }
      if (n.score !== pt.score)   { n.el.textContent = pt.score != null ? pt.score : '';   n.score = pt.score; }
      const isSel = pt.id === selectedId;
      if (n.selected !== isSel) { n.el.classList.toggle('selected', isSel); n.selected = isSel; }
      const proj = typeof projectFn === 'function' ? projectFn(pt) : { visible: false };
      const vis  = !!proj && !!proj.visible;
      if (n.visible !== vis) {
        n.el.style.display = vis ? '' : 'none';
        n.visible = vis;
      }
      if (vis && isFinite(proj.x) && isFinite(proj.y)) {
        n.el.style.left = `${proj.x}px`;
        n.el.style.top  = `${proj.y}px`;
      }
    }
    // Sweep nodes whose point disappeared.
    for (const [id, n] of nodes) {
      if (!seen.has(id)) { n.el.remove(); nodes.delete(id); }
    }
  }

  function clear() {
    for (const n of nodes.values()) n.el.remove();
    nodes.clear();
  }

  function destroy() {
    clear();
  }

  return { update, clear, destroy };
}
