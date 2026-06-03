// Shared point-info UI for every 3D viewer (landing, /asset/, /inspection/,
// /admin/edit/). Owns:
//   - hover tooltip      (#noctua-tip)
//   - slide-in detail    (#noctua-detail) — bottom-sheet on mobile
//   - lightbox           (#noctua-lightbox)
//
// Before this module each page had its own copy of this UI (different HTML,
// different CSS, inspection's right panel was always-visible and broke on
// mobile). Funnelling through one factory means the info-display experience
// is identical everywhere and the mobile layout works by default.
//
// CSS lives in /viewer.css under the matching ids.
//
// Usage:
//   import { mountViewerUI } from '/viewer-ui.js';
//   const ui = mountViewerUI({ viewer: viewerEl, t });
//   ui.showTip(pt, ev, '<div class="ttitle">…</div>…');
//   ui.openDetail(pt, { photo: 'data:image/png;…' | null, bodyHtml, slotHtml });
//   ui.closeDetail();
//
// The HTML inside bodyHtml/slotHtml is page-specific — this module doesn't
// know what fields the inspection vs editor surface; it just hosts the
// container, manages open/close + photo + lightbox + responsive layout.

// All styling lives in /viewer.css — every consumer page links that file.
// We deliberately don't inject any fallback CSS here: a previous fallback
// `#noctua-detail.open{transform:translateX(0)}` was getting appended AFTER
// /viewer.css (style tag injected post-DOM-load), winning specificity ties
// and overriding the mobile bottom-sheet rule with the desktop slide-from-
// right one. The fix is to trust /viewer.css and require it.

// Lightbox is global (one per page) — multiple viewers on the same page would
// share it, which is what we want anyway.
let _lightboxEl = null;
let _lightboxImg = null;
function ensureLightbox() {
  if (_lightboxEl) return _lightboxEl;
  _lightboxEl = document.createElement('div');
  _lightboxEl.id = 'noctua-lightbox';
  _lightboxEl.innerHTML = '<img alt="">';
  _lightboxImg = _lightboxEl.querySelector('img');
  _lightboxEl.addEventListener('click', closeLightbox);
  document.body.appendChild(_lightboxEl);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
  });
  return _lightboxEl;
}
export function openLightbox(src) {
  if (!src) return;
  ensureLightbox();
  _lightboxImg.src = src;
  _lightboxEl.classList.add('vis');
}
export function closeLightbox() {
  if (!_lightboxEl) return;
  _lightboxEl.classList.remove('vis');
}
// Expose so inline onclick="…" in legacy markup keeps working during migration.
if (typeof window !== 'undefined') {
  window.openLightbox = openLightbox;
  window.closeLightbox = closeLightbox;
}

export function mountViewerUI({ viewer, t } = {}) {
  if (!viewer) throw new Error('mountViewerUI: viewer element is required');
  ensureLightbox();
  // viewer must be position:relative/absolute so the tip/detail anchor inside.
  const cs = getComputedStyle(viewer);
  if (cs.position === 'static') viewer.style.position = 'relative';

  const tr = (key, fallback) => (typeof t === 'function' ? (t(key, fallback) || fallback) : fallback);

  // ── Tooltip ────────────────────────────────────────────────────────────
  const tipEl = document.createElement('div');
  tipEl.id = 'noctua-tip';
  viewer.appendChild(tipEl);

  function showTip(pt, ev, html) {
    if (!html) return;
    tipEl.innerHTML = html;
    // Position relative to the viewer's bounding box; clamp inside.
    const vr = viewer.getBoundingClientRect();
    let tx = (ev?.clientX ?? vr.left + 40) - vr.left + 14;
    let ty = (ev?.clientY ?? vr.top  + 40) - vr.top  - 10;
    tipEl.style.left = tx + 'px';
    tipEl.style.top  = ty + 'px';
    tipEl.classList.add('vis');
    // After paint, re-measure and clamp so a wide tooltip doesn't escape.
    requestAnimationFrame(() => {
      const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
      if (tx + tw + 8 > vr.width)  tx = Math.max(8, vr.width  - tw - 8);
      if (ty + th + 8 > vr.height) ty = Math.max(8, vr.height - th - 8);
      tipEl.style.left = tx + 'px';
      tipEl.style.top  = ty + 'px';
    });
  }
  function hideTip() { tipEl.classList.remove('vis'); }

  // ── Detail panel (slide-in / bottom-sheet) ─────────────────────────────
  const detEl = document.createElement('div');
  detEl.id = 'noctua-detail';
  detEl.innerHTML = `
    <button class="ndet-close" aria-label="Close">&times;</button>
    <div class="ndet-photo-wrap" style="display:none">
      <img class="ndet-photo" alt="">
      <div class="ndet-photo-cap"></div>
    </div>
    <div class="ndet-body"></div>
    <div class="ndet-slot"></div>
  `;
  viewer.appendChild(detEl);

  const detCloseBtn = detEl.querySelector('.ndet-close');
  const detPhotoWrap = detEl.querySelector('.ndet-photo-wrap');
  const detPhotoImg  = detEl.querySelector('.ndet-photo');
  const detPhotoCap  = detEl.querySelector('.ndet-photo-cap');
  const detBody      = detEl.querySelector('.ndet-body');
  const detSlot      = detEl.querySelector('.ndet-slot');

  detCloseBtn.addEventListener('click', closeDetail);
  detPhotoImg.addEventListener('click', () => {
    if (detPhotoImg.src) openLightbox(detPhotoImg.src);
  });

  let _isOpen = false;
  let _currentPt = null;
  let _onClose = null;

  function openDetail(pt, { photo, bodyHtml = '', slotHtml = '', photoCap } = {}) {
    _currentPt = pt;
    if (photo && photo !== 'mock') {
      detPhotoImg.src = photo;
      detPhotoImg.alt = pt && pt.id ? String(pt.id) : '';
      detPhotoCap.textContent = photoCap || tr('viewer.detail.photo_label', 'Inspection photo — click to zoom');
      detPhotoWrap.style.display = '';
    } else {
      detPhotoImg.removeAttribute('src');
      detPhotoWrap.style.display = 'none';
    }
    detBody.innerHTML = bodyHtml;
    detSlot.innerHTML = slotHtml;
    detEl.classList.add('open');
    _isOpen = true;
  }
  function closeDetail() {
    detEl.classList.remove('open');
    _isOpen = false;
    _currentPt = null;
    if (typeof _onClose === 'function') _onClose();
  }
  function isDetailOpen() { return _isOpen; }
  function currentPoint() { return _currentPt; }
  function onClose(fn) { _onClose = fn; }

  // Esc closes detail (consistent with the landing).
  const onKey = e => {
    if (e.key === 'Escape' && _isOpen) closeDetail();
  };
  document.addEventListener('keydown', onKey);

  function destroy() {
    document.removeEventListener('keydown', onKey);
    tipEl.remove();
    detEl.remove();
  }

  return {
    showTip, hideTip,
    openDetail, closeDetail, isDetailOpen, currentPoint, onClose,
    openLightbox, closeLightbox,
    destroy,
    // Surface DOM nodes for pages that want to bolt extra behavior on
    // (e.g. the editor highlighting the slot when in move-mode).
    elements: { tip: tipEl, detail: detEl, slot: detSlot, body: detBody, photo: detPhotoImg },
  };
}
