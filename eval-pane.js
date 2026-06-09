// /eval-pane.js — shared evaluation-pane subsystem used by both
// /admin/edit (editing) and /inspection/ (read-only public viewer).
//
// Owns the entire eval UI: the rail Avaliação panel content (dashboard,
// done banner, defect cards), the bottom photo gallery, the on-canvas
// photo overlay (image + polygons + zoom + nav), and the THREE.Group of
// tile markers projected onto the model. Both pages call mountEvalPane()
// once and feed it photos / task data; the module renders identical UI
// in both contexts. Editing surfaces are gated by `readonly: false` +
// `callbacks` for the operator actions; `readonly: true` strips them
// out, leaving the same data view.
//
// HTML/CSS rules used by the markup live in /eval-pane.css — both pages
// must <link rel="stylesheet" href="/eval-pane.css">.

import * as THREE        from 'three';
import { Line2 }         from 'three/addons/lines/Line2.js';
import { LineGeometry }  from 'three/addons/lines/LineGeometry.js';
import { LineMaterial }  from 'three/addons/lines/LineMaterial.js';
import {
  esc, tagColor, tagLabel,
  renderEvalDefectCardHtml, drawEvalPhotoOnCanvas,
  cropEvalDefectAnnotated,
  renderEvalDashboardHtml, renderEvalDoneBannerHtml,
  EVAL_SEV_HEX_BY_SEV,
} from '/inspection-detail.js';

// ── Tile materials (THREE) ──────────────────────────────────────────────
// One set PER verdict so adjacent tiles render in distinct colours. Each
// set carries both an `idle` and an `active` variant (active is thicker +
// brighter, with a more opaque fill) — same recipe the editor uses, so
// setActivePhoto can swap material refs to highlight the selected tile.
const _tileMatsByVerdict = new Map();
const _VERDICT_HEX = { has_defects: 0xd04141, clean: 0x3aa55c, skipped: 0xd6a23c };
function _tileMatsFor(verdict) {
  const key = verdict || 'idle';
  if (_tileMatsByVerdict.has(key)) return _tileMatsByVerdict.get(key);
  const res = new THREE.Vector2(window.innerWidth, window.innerHeight);
  const accHex = _VERDICT_HEX[verdict] != null ? _VERDICT_HEX[verdict] : 0xff6600;
  const acc = new THREE.Color(accHex);
  const mats = {
    haloIdle:   new LineMaterial({ color: new THREE.Color(0xffffff), transparent: true, opacity: 0.85, linewidth: 6, resolution: res, depthWrite: false, depthTest: false }),
    haloActive: new LineMaterial({ color: new THREE.Color(0xffffff), transparent: true, opacity: 1.00, linewidth: 8, resolution: res, depthWrite: false, depthTest: false }),
    accIdle:    new LineMaterial({ color: acc, transparent: true, opacity: 0.95, linewidth: 3, resolution: res, depthWrite: false, depthTest: false }),
    accActive:  new LineMaterial({ color: acc, transparent: true, opacity: 1.00, linewidth: 5, resolution: res, depthWrite: false, depthTest: false }),
    fillIdle:   new THREE.MeshBasicMaterial({ color: acc, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    fillActive: new THREE.MeshBasicMaterial({ color: acc, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }),
  };
  _tileMatsByVerdict.set(key, mats);
  return mats;
}
let _resizeHooked = false;
function _hookResize() {
  if (_resizeHooked) return;
  window.addEventListener('resize', () => {
    for (const mats of _tileMatsByVerdict.values()) {
      mats.haloIdle.resolution.set(window.innerWidth, window.innerHeight);
      mats.haloActive.resolution.set(window.innerWidth, window.innerHeight);
      mats.accIdle.resolution.set(window.innerWidth, window.innerHeight);
      mats.accActive.resolution.set(window.innerWidth, window.innerHeight);
    }
  });
  _resizeHooked = true;
}

// Builds a THREE.Group of tile markers from evalPhotos. Each photo with
// f.source.xzCell becomes a 4-corner XZ-axis-aligned rect with halo +
// accent line + fill mesh. The fill mesh is the raycaster pick target;
// userData.photoIdx tells the click handler which photo it represents.
function buildTileGroup(photos, modelBox) {
  const usable = (photos || []).filter(p => p && p.source && p.source.xzCell);
  if (!usable.length || !modelBox) return { group: null, picks: [] };
  _hookResize();
  const diag = Math.hypot(modelBox.max.x - modelBox.min.x, modelBox.max.y - modelBox.min.y, modelBox.max.z - modelBox.min.z);
  const y = modelBox.max.y + diag * 0.01;
  const group = new THREE.Group();
  group.name = 'evalTiles';
  const picks = [];
  usable.forEach((p) => {
    const mats = _tileMatsFor(p.verdict);
    const photoIdx = photos.indexOf(p);
    const { x0, z0, x1, z1 } = p.source.xzCell;
    const flat = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, x0, y, z0];
    // Three layered children per tile, in the same order setActivePhoto
    // walks: [halo, accent, fill]. All three carry photoIdx so the
    // material-swap loop can pick the right material per role.
    const haloGeo = new LineGeometry(); haloGeo.setPositions(flat);
    const halo = new Line2(haloGeo, mats.haloIdle); halo.computeLineDistances(); halo.renderOrder = 1000;
    halo.userData.photoIdx = photoIdx;
    halo.userData.matIdle  = mats.haloIdle;
    halo.userData.matActive = mats.haloActive;
    group.add(halo);
    const accGeo = new LineGeometry(); accGeo.setPositions(flat);
    const accent = new Line2(accGeo, mats.accIdle); accent.computeLineDistances(); accent.renderOrder = 1001;
    accent.userData.photoIdx = photoIdx;
    accent.userData.matIdle  = mats.accIdle;
    accent.userData.matActive = mats.accActive;
    group.add(accent);
    const fy = y - 0.0005;
    const fillPos = new Float32Array([
      x0, fy, z0, x1, fy, z0, x1, fy, z1,
      x0, fy, z0, x1, fy, z1, x0, fy, z1,
    ]);
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.BufferAttribute(fillPos, 3));
    const fill = new THREE.Mesh(fillGeo, mats.fillIdle);
    fill.renderOrder = 999;
    fill.userData.photoIdx = photoIdx;
    fill.userData.matIdle  = mats.fillIdle;
    fill.userData.matActive = mats.fillActive;
    group.add(fill);
    picks.push(fill);
  });
  return { group, picks };
}

// Single thumb in the bottom gallery — same .v-eval-thumb markup the
// editor uses. `status` is the in-flight upload state for the editor's
// draft list (queued/uploading/error); for read-only viewer photos it's
// always '' and the verdict alone drives the dot colour.
function renderThumbHtml(photo, idx, opts = {}) {
  const { status = '' } = opts;
  const v = photo && photo.verdict;
  const upCls = status === 'queued' || status === 'uploading' ? 's-upload'
              : status === 'error' ? 's-error' : '';
  const verdictCls = v === 'has_defects' ? 's-defect'
                   : v === 'clean'       ? 's-clean'
                   : v === 'skipped'     ? 's-skip'
                   : '';
  const cls = (upCls || verdictCls);
  const n = Array.isArray(photo && photo.defects) ? photo.defects.length : 0;
  const statusInner = (v === 'has_defects' && n) ? `<span class="v-eval-status">${n}</span>`
                    : (v === 'clean' || v === 'skipped' || upCls) ? `<span class="v-eval-status"></span>`
                    : '';
  const bg = String(photo && photo.url || '').replace(/'/g, "\\'");
  return `<div class="v-eval-thumb ${cls}" data-idx="${idx}" style="background-image:url('${bg}')" title="${esc((photo && photo.name) || '')}">${statusInner}</div>`;
}

// Pane HTML template — the same structure admin/edit's pane-photoLocations
// uses, minus the editing-specific buttons (Mark all clean / Submit /
// Save progress / Reopen) which the caller adds via callbacks when
// `readonly: false`. The shared structure lets the viewer's pane look
// identical without duplicating markup.
const PANE_TEMPLATE_HTML = `
  <div class="evp evp-eval" data-role="root">
    <div data-role="status-slot"></div>
    <div class="evp-meta" data-role="meta"></div>
    <div class="evp-dash" data-role="dash"></div>
    <div class="evp-dash-actions" data-role="dash-actions" style="display:none"></div>
    <div data-role="done-slot"></div>
    <div class="evp-photo-ui" data-role="photo-ui" style="display:none">
      <div class="evp-row" data-role="verdict-row" style="display:none">
        <button class="ambtn pri" data-role="primary" type="button"></button>
        <button class="ambtn sec" data-role="skip"    type="button"></button>
      </div>
      <div class="evp-hint" data-role="hint" style="display:none">
        <div class="evp-hint-main"></div>
        <div class="evp-hint-sub"></div>
      </div>
      <div class="evp-row" data-role="poly-row" style="display:none">
        <button class="ambtn sec" data-role="undo"  type="button" disabled></button>
        <button class="ambtn sec" data-role="clear" type="button" disabled></button>
      </div>
      <div class="evp-defects" data-role="defects"></div>
    </div>
  </div>
`;

// Photo overlay HTML — same DOM the editor's _ensureEvalPhotoOverlay
// builds. Class names match /eval-pane.css.
const OVERLAY_HTML = `
  <button class="eval-photo-close" type="button" aria-label="Fechar">×</button>
  <button class="eval-photo-prev"  type="button" aria-label="Anterior">‹</button>
  <button class="eval-photo-next"  type="button" aria-label="Próxima">›</button>
  <div class="eval-photo-frame">
    <div class="eval-photo-meta"></div>
    <div class="eval-photo-stage"><canvas class="eval-photo-canvas"></canvas></div>
  </div>
  <div class="eval-photo-zoom">
    <button type="button" data-role="zoom-out" aria-label="zoom out">−</button>
    <span class="val" data-role="zoom-val">100%</span>
    <button type="button" data-role="zoom-in" aria-label="zoom in">+</button>
    <button type="button" data-role="zoom-reset" aria-label="reset">⤬</button>
  </div>
`;

// Main entry point. Both pages call this once after the viewer-shell is
// mounted and the model is loading; the returned API lets the caller
// feed photos in / out and react to selection events.
//
// opts:
//   shell        — viewer-shell instance (must register a 'photoLocations' panel)
//   canvasHost   — where the gallery + overlay get appended (typically shell.elements.canvas)
//   scene        — THREE.Scene (tile group attaches here)
//   getModelBox  — () => { min:{x,y,z}, max:{x,y,z} } | null   (used to size tile y)
//   readonly     — true = no edit affordances rendered; viewer always passes true
//   t            — (key, fallback) => string                  (i18n)
//   callbacks    — editor hooks: { onPrimaryAction, onSetSkip, onDefUndo,
//                                  onDefClear, onCanvasClick(nx,ny), onActivePhoto(idx) }
//                  All optional. In read-only mode none are needed.
export function mountEvalPane(opts) {
  const {
    shell,
    canvasHost,
    // scene + canvas-host may not exist yet when mountEvalPane is called
    // (e.g. inspection viewer registers the pane before initThree runs).
    // Accept either a direct ref or a getter for late binding.
    scene = null,
    getScene = null,
    getModelBox = null,
    readonly = false,
    t = (k, fb) => fb,
    callbacks = {},
  } = opts;
  const _resolveScene = () => (typeof getScene === 'function' ? getScene() : scene);
  if (!shell || !shell.panel) throw new Error('mountEvalPane: shell required');
  const panel = shell.panel('photoLocations');
  if (!panel) throw new Error('mountEvalPane: shell needs panels:[{id:"photoLocations",...}]');

  // ── State ──────────────────────────────────────────────────────────────
  let _photos      = [];
  let _taskMeta    = null;   // { status, appliedCount, evaluatedAt, ... }
  let _activeIdx   = -1;
  let _tileGroup   = null;
  let _tilePicks   = [];
  let _overlayEl   = null;
  let _overlayCanvas = null;
  let _overlayMeta   = null;
  let _overlayZoomVal = null;
  let _imgCache    = new Map();
  let _zoom        = 1;
  const ZOOM_MIN   = 0.5;
  const ZOOM_MAX   = 6;

  // ── Pane DOM ───────────────────────────────────────────────────────────
  panel.el.innerHTML = PANE_TEMPLATE_HTML;
  const els = {
    root:        panel.el.querySelector('[data-role="root"]'),
    statusSlot:  panel.el.querySelector('[data-role="status-slot"]'),
    meta:        panel.el.querySelector('[data-role="meta"]'),
    dash:        panel.el.querySelector('[data-role="dash"]'),
    dashActions: panel.el.querySelector('[data-role="dash-actions"]'),
    doneSlot:    panel.el.querySelector('[data-role="done-slot"]'),
    photoUi:     panel.el.querySelector('[data-role="photo-ui"]'),
    verdictRow:  panel.el.querySelector('[data-role="verdict-row"]'),
    primary:     panel.el.querySelector('[data-role="primary"]'),
    skip:        panel.el.querySelector('[data-role="skip"]'),
    hint:        panel.el.querySelector('[data-role="hint"]'),
    polyRow:     panel.el.querySelector('[data-role="poly-row"]'),
    undo:        panel.el.querySelector('[data-role="undo"]'),
    clear:       panel.el.querySelector('[data-role="clear"]'),
    defects:     panel.el.querySelector('[data-role="defects"]'),
  };
  if (readonly) els.root.classList.add('evp-readonly');

  // Editing affordances. In read-only mode we leave them hidden and
  // never wire the handlers; the caller is also off the hook for the
  // callbacks themselves.
  if (!readonly) {
    els.verdictRow.style.display = '';
    els.hint.style.display = '';
    els.polyRow.style.display = '';
    els.primary.textContent = t('admin.eval.act_clean', 'Sem defeito');
    els.skip.textContent    = t('admin.eval.act_skip',  'Pular');
    els.undo.textContent    = t('admin.imggen.poly_undo',  'Desfazer');
    els.clear.textContent   = t('admin.imggen.poly_clear', 'Limpar');
    els.hint.children[0].textContent = t('admin.eval.draw_hint_main', 'Clique na foto pra marcar um defeito');
    els.hint.children[1].textContent = t('admin.eval.draw_hint_sub',  'Pressione Enter ou clique no primeiro vértice pra fechar · Backspace apaga o último');
    if (callbacks.onPrimaryAction) els.primary.onclick = callbacks.onPrimaryAction;
    if (callbacks.onSetSkip)       els.skip.onclick    = callbacks.onSetSkip;
    if (callbacks.onDefUndo)       els.undo.onclick    = callbacks.onDefUndo;
    if (callbacks.onDefClear)      els.clear.onclick   = callbacks.onDefClear;
  }

  // ── Gallery (bottom strip in canvasHost) ───────────────────────────────
  let _galleryEl = null;
  if (canvasHost) {
    _galleryEl = document.createElement('div');
    _galleryEl.className = 'v-eval-gallery';
    canvasHost.appendChild(_galleryEl);
  }
  function _renderGallery() {
    if (!_galleryEl) return;
    document.body.classList.toggle('has-eval-photos', _photos.length > 0);
    _galleryEl.innerHTML = _photos.map((p, i) => renderThumbHtml(p, i)).join('');
    _galleryEl.querySelectorAll('.v-eval-thumb').forEach(el => {
      el.addEventListener('click', () => {
        const i = parseInt(el.dataset.idx, 10);
        // Mirrors the editor's tile behaviour: first click activates,
        // second click on the active thumb opens the overlay. Same
        // mental model regardless of mode.
        if (i === _activeIdx) openPhotoView(i);
        else setActivePhoto(i);
      });
    });
    _markActiveThumb();
  }
  function _markActiveThumb() {
    if (!_galleryEl) return;
    _galleryEl.querySelectorAll('.v-eval-thumb').forEach(el =>
      el.classList.toggle('is-active', parseInt(el.dataset.idx, 10) === _activeIdx));
    const cur = _galleryEl.querySelector(`.v-eval-thumb[data-idx="${_activeIdx}"]`);
    if (cur) cur.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  // ── Pane state renderers ───────────────────────────────────────────────
  function _renderDashboardState() {
    if (els.photoUi)  els.photoUi.style.display = 'none';
    if (els.meta)     els.meta.style.display    = 'none';
    if (els.dash)     els.dash.style.display    = '';
    if (els.dashActions) els.dashActions.style.display = (els.dashActions.children.length ? '' : 'none');
    if (els.dash) els.dash.innerHTML = renderEvalDashboardHtml(_photos, { t });
    if (els.doneSlot) {
      if (_taskMeta && (_taskMeta.status === 'done' || _taskMeta.evaluatedAt)) {
        els.doneSlot.style.display = '';
        els.doneSlot.innerHTML = renderEvalDoneBannerHtml({
          appliedCount: _taskMeta.appliedCount || 0,
          t,
          withReopen: !!(callbacks.onReopen && !readonly),
        });
        if (!readonly && callbacks.onReopen) {
          const btn = els.doneSlot.querySelector('#evalActReopen');
          if (btn) btn.onclick = callbacks.onReopen;
        }
      } else {
        els.doneSlot.style.display = 'none';
        els.doneSlot.innerHTML = '';
      }
    }
  }
  function _renderPhotoState(idx) {
    const p = _photos[idx];
    if (!p) return;
    if (els.dash)        els.dash.style.display = 'none';
    if (els.dashActions) els.dashActions.style.display = 'none';
    if (els.doneSlot)    els.doneSlot.style.display = 'none';
    if (els.photoUi)     els.photoUi.style.display = '';
    if (els.meta) {
      els.meta.style.display = '';
      // Photo header — index/total + name AND a per-photo summary line so
      // an empty defect list isn't ambiguous ("no marks" vs "not scrolled
      // yet"). Mirrors the editor's pane header.
      const n = (p.defects || []).length;
      const verdict = p.verdict;
      const verdictLabel =
        verdict === 'has_defects' ? t('admin.eval.dash_defect',  'Com defeito')
      : verdict === 'clean'       ? t('admin.eval.dash_clean',   'Sem defeito')
      : verdict === 'skipped'     ? t('admin.eval.dash_skipped', 'Pulada')
      : t('admin.eval.dash_pending', 'Pendente');
      const verdictColor =
        verdict === 'has_defects' ? '#d04141'
      : verdict === 'clean'       ? '#3aa55c'
      : verdict === 'skipped'     ? '#d6a23c' : 'var(--tx3)';
      const summary = n
        ? `${n} ${t('admin.eval.dash_total_def', 'defeitos marcados')}`
        : (verdict === 'clean'   ? t('admin.eval.no_defects_clean',  'Foto marcada como sem defeitos.')
         : verdict === 'skipped' ? t('admin.eval.no_defects_skipped','Foto pulada.')
         : verdict === 'pending' || !verdict ? t('admin.eval.no_defects_pending','Foto ainda não avaliada.')
         : t('admin.eval.no_defects_generic', 'Sem defeitos marcados.'));
      els.meta.innerHTML =
        `<div><b>${idx + 1}</b> / ${_photos.length}${p.name ? ' — ' + esc(p.name) : ''}</div>` +
        `<div style="font-size:10px;font-weight:700;color:${verdictColor};margin-top:2px">${esc(verdictLabel)}</div>` +
        `<div style="font-size:10px;color:var(--tx2);font-style:italic;margin-top:1px">${esc(summary)}</div>`;
    }
    _renderDefectList(p);
  }
  function _renderDefectList(photo) {
    if (!els.defects) return;
    const img = _imgCache.get(photo.url) || null;
    const defects = photo.defects || [];
    if (!defects.length) {
      // Leave empty so the .evp-defects:empty::before "—" hint renders, AND
      // the meta header above already explains the verdict. Avoids a custom
      // empty-state placeholder that drifts from the editor's behaviour.
      els.defects.innerHTML = '';
      return;
    }
    els.defects.innerHTML = defects.map((d, i) => {
      const tagsHtml = (d.tags || []).map(tag => {
        const col = tagColor(tag);
        return `<span class="tagchip" style="background:${col.bg};color:${col.fg}">${esc(tagLabel(tag))}${readonly ? '' : `<button type="button" onclick="event.stopPropagation();window._evalCb_defTagRemove&&window._evalCb_defTagRemove(${i},${(d.tags||[]).indexOf(tag)})">×</button>`}</span>`;
      }).join('');
      let thumbSrc = '';
      if (img && img.complete && (img.naturalWidth || img.width)) {
        thumbSrc = cropEvalDefectAnnotated(img, d.poly || [], 120, d.sev);
      }
      return renderEvalDefectCardHtml(d, i, { readonly, tagsHtml, thumbSrc, t });
    }).join('');
  }

  // ── Photo overlay (lazy mount in canvasHost) ───────────────────────────
  function _ensureOverlay() {
    if (_overlayEl) return _overlayEl;
    const host = canvasHost || document.body;
    const ov = document.createElement('div');
    ov.className = 'eval-photo-overlay';
    ov.innerHTML = OVERLAY_HTML;
    host.appendChild(ov);
    _overlayEl      = ov;
    _overlayCanvas  = ov.querySelector('.eval-photo-canvas');
    _overlayMeta    = ov.querySelector('.eval-photo-meta');
    _overlayZoomVal = ov.querySelector('[data-role="zoom-val"]');
    ov.querySelector('.eval-photo-close').onclick = closePhotoView;
    ov.querySelector('.eval-photo-prev').onclick  = () => _nav(-1);
    ov.querySelector('.eval-photo-next').onclick  = () => _nav(1);
    ov.querySelector('[data-role="zoom-out"]').onclick   = () => _zoomBy(-0.25);
    ov.querySelector('[data-role="zoom-in"]').onclick    = () => _zoomBy(0.25);
    ov.querySelector('[data-role="zoom-reset"]').onclick = _zoomReset;
    // Ctrl/Cmd + wheel zooms anchored on the cursor; plain wheel pans
    // (stage has overflow:auto). Same gesture model the editor uses.
    _overlayCanvas.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      _zoomBy(e.deltaY > 0 ? -0.18 : 0.18, e);
    }, { passive: false });
    if (!readonly && callbacks.onCanvasClick) {
      _overlayCanvas.addEventListener('click', (e) => {
        const r = _overlayCanvas.getBoundingClientRect();
        const nx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const ny = Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height));
        callbacks.onCanvasClick(nx, ny);
      });
    }
    return ov;
  }
  // Zoom in/out around an anchor (cursor for Ctrl+wheel, stage center
  // for button clicks). Preserves the content pixel under the anchor
  // across the resize by adjusting stage scroll. Same recipe as the
  // editor's _evalZoomBy.
  function _zoomBy(delta, evt) {
    const cv = _overlayCanvas;
    const stage = cv ? cv.parentElement : null;
    const oldZoom = _zoom;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZoom + delta));
    if (newZoom === oldZoom) return;
    let canvasPX = null, canvasPY = null, stageX = null, stageY = null;
    if (stage && cv) {
      const stageRect = stage.getBoundingClientRect();
      if (evt) {
        const canvasRect = cv.getBoundingClientRect();
        canvasPX = evt.clientX - canvasRect.left;
        canvasPY = evt.clientY - canvasRect.top;
        stageX   = evt.clientX - stageRect.left;
        stageY   = evt.clientY - stageRect.top;
      } else {
        stageX = stage.clientWidth / 2;
        stageY = stage.clientHeight / 2;
        const canvasRect = cv.getBoundingClientRect();
        canvasPX = (stageRect.left + stageX) - canvasRect.left;
        canvasPY = (stageRect.top  + stageY) - canvasRect.top;
      }
    }
    _zoom = newZoom;
    if (_overlayZoomVal) _overlayZoomVal.textContent = `${Math.round(_zoom * 100)}%`;
    if (_activeIdx >= 0) {
      const photo = _photos[_activeIdx];
      const img = _imgCache.get(photo.url);
      if (img) _drawOverlay(photo, img);
    }
    if (stage && cv && canvasPX != null) {
      const ratio = newZoom / oldZoom;
      const offX = cv.offsetLeft;
      const offY = cv.offsetTop;
      stage.scrollLeft = offX + canvasPX * ratio - stageX;
      stage.scrollTop  = offY + canvasPY * ratio - stageY;
    }
  }
  function _zoomReset() {
    _zoom = 1;
    if (_overlayZoomVal) _overlayZoomVal.textContent = '100%';
    if (_activeIdx >= 0) {
      const photo = _photos[_activeIdx];
      const img = _imgCache.get(photo.url);
      if (img) _drawOverlay(photo, img);
    }
    const stage = _overlayCanvas ? _overlayCanvas.parentElement : null;
    if (stage) { stage.scrollLeft = 0; stage.scrollTop = 0; }
  }
  function _ensureImg(url, cb) {
    if (_imgCache.has(url)) { cb(_imgCache.get(url)); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { _imgCache.set(url, img); cb(img); };
    img.onerror = () => cb(null);
    img.src = url;
  }
  function _drawOverlay(photo, img) {
    if (!_overlayCanvas || !img) return;
    const stage = _overlayCanvas.parentElement;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (sw <= 0 || sh <= 0) return;
    // Fit-to-stage base size, then multiply by current zoom. Stage has
    // overflow:auto so the operator pans when the canvas overflows.
    // Mirrors the editor's _drawEvalPhotoCanvas.
    const ar = img.naturalWidth / img.naturalHeight;
    let baseW, baseH;
    if (sw / sh > ar) { baseH = sh - 20; baseW = baseH * ar; }
    else              { baseW = sw - 20; baseH = baseW / ar; }
    const w = Math.max(1, Math.round(baseW * _zoom));
    const h = Math.max(1, Math.round(baseH * _zoom));
    _overlayCanvas.width  = w;
    _overlayCanvas.height = h;
    _overlayCanvas.style.width  = w + 'px';
    _overlayCanvas.style.height = h + 'px';
    drawEvalPhotoOnCanvas(_overlayCanvas, img, photo.defects || []);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  function setPhotos(photos) {
    _photos = Array.isArray(photos) ? photos.slice() : [];
    _renderGallery();
    if (document.body.classList.contains('eval-pane-active')) _renderDashboardState();
    _rebuildTilesIfReady();
  }
  function setTaskMeta(meta) {
    _taskMeta = meta || null;
    if (document.body.classList.contains('eval-pane-active') && _activeIdx < 0) {
      _renderDashboardState();
    }
  }
  function setActivePhoto(idx) {
    _activeIdx = idx;
    _markActiveThumb();
    // Swap tile materials so the selected tile reads active (thicker stroke
    // + brighter halo + more opaque fill). Same recipe the editor uses in
    // its setActivePhoto. children: [halo, accent, fill].
    if (_tileGroup) {
      for (const tile of _tileGroup.children) {
        if (!tile.userData || !tile.userData.matIdle) continue;
        const isActive = tile.userData.photoIdx === idx;
        tile.material = isActive ? tile.userData.matActive : tile.userData.matIdle;
      }
    }
    if (typeof callbacks.onActivePhoto === 'function') callbacks.onActivePhoto(idx);
  }
  function openPhotoView(idx) {
    if (!_photos.length) return;
    if (idx < 0 || idx >= _photos.length) return;
    if (!document.body.classList.contains('eval-pane-active')) {
      panel.activate();
    }
    _activeIdx = idx;
    _ensureOverlay();
    _overlayEl.classList.add('vis');
    // Reset zoom whenever a different photo is shown — same as the editor
    // (a stale zoom from the previous photo confuses the operator).
    _zoom = 1;
    if (_overlayZoomVal) _overlayZoomVal.textContent = '100%';
    const photo = _photos[idx];
    _overlayMeta.textContent = `${idx + 1} / ${_photos.length}${photo.name ? ' — ' + photo.name : ''}`;
    _overlayEl.querySelector('.eval-photo-prev').disabled = idx === 0;
    _overlayEl.querySelector('.eval-photo-next').disabled = idx === _photos.length - 1;
    _renderPhotoState(idx);
    _ensureImg(photo.url, (img) => {
      if (_activeIdx !== idx) return;
      _drawOverlay(photo, img);
      _renderDefectList(photo);   // re-render once thumbs can be cropped
    });
    _markActiveThumb();
  }
  function closePhotoView() {
    if (_overlayEl) _overlayEl.classList.remove('vis');
    _activeIdx = -1;
    _markActiveThumb();
    if (document.body.classList.contains('eval-pane-active')) _renderDashboardState();
  }
  function _nav(dir) {
    if (_activeIdx < 0) return;
    const next = _activeIdx + dir;
    if (next < 0 || next >= _photos.length) { closePhotoView(); return; }
    openPhotoView(next);
  }
  function _rebuildTilesIfReady() {
    const sc = _resolveScene();
    if (!sc || !getModelBox) return;
    const box = getModelBox();
    if (!box) return;
    if (_tileGroup) {
      sc.remove(_tileGroup);
      _tileGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      _tileGroup = null;
      _tilePicks = [];
    }
    const built = buildTileGroup(_photos, box);
    if (built.group) {
      _tileGroup = built.group;
      _tilePicks = built.picks;
      _tileGroup.visible = document.body.classList.contains('eval-pane-active');
      sc.add(_tileGroup);
    }
  }
  function rebuildTiles() { _rebuildTilesIfReady(); }
  function getTilePicks() { return _tilePicks; }
  function setTilesVisible(on) { if (_tileGroup) _tileGroup.visible = !!on; }

  // ── Pane open/close listener (shell events) ────────────────────────────
  const shellEl = shell.elements && shell.elements.shell;
  if (shellEl) {
    shellEl.addEventListener('inspector:opened', (e) => {
      const on = e.detail && e.detail.panelId === 'photoLocations';
      document.body.classList.toggle('eval-pane-active', on);
      if (_tileGroup) _tileGroup.visible = on;
      if (on) {
        if (_activeIdx >= 0) _renderPhotoState(_activeIdx);
        else _renderDashboardState();
      } else {
        if (_overlayEl) _overlayEl.classList.remove('vis');
        _activeIdx = -1;
      }
    });
    shellEl.addEventListener('inspector:closed', () => {
      document.body.classList.remove('eval-pane-active');
      if (_tileGroup) _tileGroup.visible = false;
      if (_overlayEl) _overlayEl.classList.remove('vis');
      _activeIdx = -1;
    });
  }

  // Keyboard nav (arrow keys + esc) while overlay is open.
  window.addEventListener('keydown', (e) => {
    if (!_overlayEl || !_overlayEl.classList.contains('vis')) return;
    if (e.key === 'Escape')          { e.preventDefault(); closePhotoView(); }
    else if (e.key === 'ArrowLeft')  _nav(-1);
    else if (e.key === 'ArrowRight') _nav(1);
  });
  window.addEventListener('resize', () => {
    if (!_overlayEl || !_overlayEl.classList.contains('vis')) return;
    if (_activeIdx < 0) return;
    const photo = _photos[_activeIdx];
    const img = _imgCache.get(photo.url);
    if (img) _drawOverlay(photo, img);
  });

  // Re-renders every i18n-bearing surface of the pane with whatever the
  // `t` helper returns now. Wired to NoctuaI18n.onChange so a language
  // toggle flips the pane in place — no reload, no stale strings.
  function refresh() {
    // Static labels rebuilt from t() at mount time (verdict + draw hint
    // buttons in editor mode). Read again now.
    if (!readonly) {
      if (els.primary) els.primary.textContent = t('admin.eval.act_clean', 'Sem defeito');
      if (els.skip)    els.skip.textContent    = t('admin.eval.act_skip',  'Pular');
      if (els.undo)    els.undo.textContent    = t('admin.imggen.poly_undo',  'Desfazer');
      if (els.clear)   els.clear.textContent   = t('admin.imggen.poly_clear', 'Limpar');
      if (els.hint && els.hint.children[0]) els.hint.children[0].textContent = t('admin.eval.draw_hint_main', 'Clique na foto pra marcar um defeito');
      if (els.hint && els.hint.children[1]) els.hint.children[1].textContent = t('admin.eval.draw_hint_sub',  'Pressione Enter ou clique no primeiro vértice pra fechar · Backspace apaga o último');
    }
    // Dynamic content (dashboard, done banner, defect cards, photo
    // meta) — derived via inspection-detail helpers that take `t` per
    // call, so just re-running the renderers picks up new strings.
    if (document.body.classList.contains('eval-pane-active')) {
      if (_activeIdx >= 0) _renderPhotoState(_activeIdx);
      else                 _renderDashboardState();
    }
  }
  if (typeof window !== 'undefined' && window.NoctuaI18n && window.NoctuaI18n.onChange) {
    window.NoctuaI18n.onChange(refresh);
  }

  return {
    setPhotos, setTaskMeta, setActivePhoto,
    openPhotoView, closePhotoView,
    rebuildTiles, getTilePicks, setTilesVisible, refresh,
    get activeIdx() { return _activeIdx; },
    get photos()    { return _photos; },
    els,   // exposed for editor to plug in extra dash buttons (Save progress etc.)
  };
}
