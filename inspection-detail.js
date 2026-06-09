// Shared inspection-detail helpers — extracted so the asset viewer, the
// inspection viewer, and the admin editor all render the same body HTML
// and tag/photo helpers when the user clicks a marker. Pages own the
// detail-panel mount (mountViewerUI in /viewer-ui.js) and supply the slot
// HTML (admin/edit adds edit/move/remove buttons; the read-only viewers
// leave it empty). Everything else is here.
//
// Today this is consumed by /asset/ (read-only inspection preview on top of
// the asset model). Follow-up: migrate /inspection/ and /admin/edit/ to
// import from here instead of carrying their own copies (the memory's
// "unify everything" principle calls this out as a follow-up).

export const TAG_CURATED = [
  'Fissura','Furo','Corrosão','Infiltração','Desplacamento','Armadura exposta',
  'Eflorescência','Manchas de umidade','Deformação','Vazamento','Oxidação'
];
export const TAG_FIXED = {
  fissura:  { fg:'#a5b4fc', bg:'rgba(99,102,241,.15)' },
  furo:     { fg:'#facc15', bg:'rgba(250,204,21,.15)' },
  corrosao: { fg:'#ef4444', bg:'rgba(239,68,68,.15)' },
};

export const SEV_HEX = {
  critical:'#ef4444', high:'#f97316', medium:'#facc15', low:'#10b981',
};

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

export function tagKey(t) {
  return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}

export const TAG_CURATED_ORDER = TAG_CURATED.map(tagKey);

export function tagLabel(t) {
  const k = tagKey(t);
  if (!k) return '';
  if (typeof window !== 'undefined' && window.NoctuaI18n) {
    const tr = window.NoctuaI18n.t('type.' + k);
    if (tr && tr !== 'type.' + k) return tr;
  }
  return TAG_CURATED.find(c => tagKey(c) === k) || String(t).trim();
}

export function tagColor(t) {
  const k = tagKey(t);
  if (TAG_FIXED[k]) return TAG_FIXED[k];
  // Stable hashed color for unknown tags so the same string keeps the same hue.
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { fg:`hsl(${hue} 70% 75%)`, bg:`hsla(${hue} 70% 50% / .15)` };
}

export function tagChip(t) {
  const c = tagColor(t);
  return `<span class="chip" style="background:${c.bg};color:${c.fg}">${esc(tagLabel(t))}</span>`;
}

export function pointTags(pt) {
  if (Array.isArray(pt.tags)) return pt.tags.filter(Boolean);
  if (pt.type) return [pt.type];
  return [];
}

export function tagChips(pt) {
  return pointTags(pt).map(tagChip).join(' ');
}

// Canvas-rendered placeholder photo used when a point has no real image.
// Same patterns/colors per tag as the inspection viewer's original so
// timelines feel consistent.
const PATTERNS = {
  fissura: (ctx, cx, cy, r) => {
    ctx.strokeStyle = '#a5b4fc'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r*0.3);
    ctx.bezierCurveTo(cx - r*0.5, cy - r*0.6, cx + r*0.3, cy + r*0.2, cx + r, cy + r*0.3);
    ctx.stroke();
  },
  furo: (ctx, cx, cy, r) => {
    const g = ctx.createRadialGradient(cx, cy, r*0.05, cx, cy, r*0.6);
    g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(250,204,21,0.4)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r*0.6, 0, Math.PI*2); ctx.fill();
  },
  corrosao: (ctx, cx, cy, r) => {
    ctx.fillStyle = 'rgba(239,68,68,0.45)';
    for (let i = 0; i < 14; i++) {
      const a = Math.random()*Math.PI*2, d = Math.random()*r*0.7;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a)*d, cy + Math.sin(a)*d, 2 + Math.random()*3, 0, Math.PI*2); ctx.fill();
    }
  },
};

export function generateMockPhoto(pt) {
  const colMap = { critical:'#ef4444', high:'#f97316', medium:'#facc15', low:'#10b981' };
  const col = colMap[pt.severity] || '#facc15';
  const W = 320, H = 200;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#111111'; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 800; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.04})`;
    ctx.fillRect(Math.random()*W, Math.random()*H, 1, 1);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 1;
  for (let y = 0; y < H; y += 4) {
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  }
  const cx = W*0.42, cy = H*0.52;
  ctx.fillStyle = '#222222';
  ctx.beginPath(); ctx.roundRect(cx-55, cy-45, 110, 90, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.stroke();
  PATTERNS[tagKey(pointTags(pt)[0])]?.(ctx, cx, cy, 40);
  ctx.fillStyle = col+'cc'; ctx.beginPath(); ctx.roundRect(8,8,60,20,4); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(pt.severity || '').toUpperCase(), 38, 18);
  ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.beginPath(); ctx.roundRect(W-46,8,38,20,4); ctx.fill();
  ctx.fillStyle = col; ctx.font = 'bold 11px monospace';
  ctx.fillText((pt.score ?? '—')+'/100', W-27, 18);
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.beginPath(); ctx.roundRect(8,H-28,W-16,20,4); ctx.fill();
  ctx.fillStyle = '#888888'; ctx.font = '9px monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText((pt.id || '—')+' · '+(pt.location || ''), 14, H-18);
  ctx.strokeStyle = col+'99'; ctx.lineWidth = 2;
  [[8,8],[W-8,8],[8,H-8],[W-8,H-8]].forEach(([bx,by])=>{
    const dx = bx<W/2?1:-1, dy = by<H/2?1:-1;
    ctx.beginPath();
    ctx.moveTo(bx+dx*12,by); ctx.lineTo(bx,by); ctx.lineTo(bx,by+dy*12);
    ctx.stroke();
  });
  return cv.toDataURL('image/png');
}

// Build the detail-panel content for an inspection point. Returns the args
// the caller should pass to viewer-ui's openDetail. The `t` helper handles
// i18n lookups (key, fallback) → string; pass NoctuaI18n.t-style if you have
// it, or a default fallback function. embeddedDefaultPhoto lets pages drop in
// a baked-in placeholder image instead of regenerating the canvas mock.
export function buildDetailArgs(pt, { t, embeddedDefaultPhoto } = {}) {
  const _t = typeof t === 'function' ? t : (k, fb) => fb;
  const photoSrc = (pt.image && pt.image !== 'mock')
    ? pt.image
    : (embeddedDefaultPhoto || generateMockPhoto(pt));
  const col = SEV_HEX[pt.severity] || SEV_HEX.medium;
  const p = pt.position || { x: 0, y: 0, z: 0 };

  const bodyHtml = `
    <div class="ring-wrap">
      <div class="ring-rel">
        <canvas id="ring" width="96" height="96"></canvas>
        <div class="ring-num" style="color:${col}">${esc(pt.score ?? '—')}</div>
      </div>
      <div class="ring-lbl">${esc(_t('viewer.detail.criticality','Criticidade'))} — <b>${esc(_t('sev.'+pt.severity, pt.severity || ''))}</b></div>
    </div>
    <div class="dcard">
      <div class="dct">${esc(_t('viewer.detail.identification','Identificação'))}</div>
      <div class="drow"><span>${esc(_t('viewer.detail.id','ID'))}</span><span class="dv">${esc(pt.id ?? '—')}</span></div>
      <div class="drow"><span>${esc(_t('viewer.detail.type','Tipo'))}</span><span class="dv" style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end">${tagChips(pt)}</span></div>
      <div class="drow"><span>${esc(_t('viewer.detail.location','Localização'))}</span><span class="dv">${esc(pt.location ?? '—')}</span></div>
      <div class="drow"><span>${esc(_t('viewer.detail.detected','Detectado'))}</span><span class="dv">${esc(pt.detected ?? '—')}</span></div>
    </div>
    <div class="dcard">
      <div class="dct">${esc(_t('viewer.detail.position','Posição 3D (metros)'))}</div>
      <div class="coord-box">x: ${Number(p.x ?? 0).toFixed(3)}&nbsp;&nbsp;y: ${Number(p.y ?? 0).toFixed(3)}&nbsp;&nbsp;z: ${Number(p.z ?? 0).toFixed(3)}</div>
    </div>
    <div class="dcard">
      <div class="dct">${esc(_t('viewer.detail.dimensions','Dimensões'))}</div>
      <div class="drow"><span>${esc(_t('viewer.detail.area','Área'))}</span><span class="dv">${esc(pt.area ?? '—')}</span></div>
      <div class="drow"><span>${esc(_t('viewer.detail.depth','Profundidade'))}</span><span class="dv">${esc(pt.depth ?? '—')}</span></div>
    </div>
    <div class="dcard">
      <div class="dct">${esc(_t('viewer.detail.action','Ação Recomendada'))}</div>
      <div style="font-size:11px;color:var(--green);font-weight:600;line-height:1.5">${esc(pt.action ?? '—')}</div>
    </div>
  `;
  return {
    photo:    photoSrc,
    photoCap: _t('viewer.detail.photo_label','Foto de Inspeção'),
    bodyHtml,
  };
}

// Group points by tag for charts/donuts/stats. Returns an array of
// { key, raw, count, score } sorted by the curated tag order first, with
// unknown tags appended in insertion order. Caller supplies the points
// array (typically the page's POINTS global).
export function tagGroupsFor(points) {
  const order = [], meta = {};
  (points || []).forEach(p => {
    pointTags(p).forEach(t => {
      const k = tagKey(t); if (!k) return;
      if (!meta[k]) { meta[k] = { key: k, raw: t, count: 0, score: 0 }; order.push(k); }
      meta[k].count++;
      meta[k].score += (p.score || 0);
    });
  });
  order.sort((a, b) => {
    const ia = TAG_CURATED_ORDER.indexOf(a), ib = TAG_CURATED_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return 0;
  });
  return order.map(k => meta[k]);
}

// Format an inspection's saved-at timestamp for the timeline cards. New
// inspections save full ISO ("2026-06-04T14:30:25.123Z"); older ones only
// stored YYYY-MM-DD. Strategy: if the string has a 'T' (or any time info),
// render as "YYYY-MM-DD HH:MM" so two same-day inspections are
// distinguishable. Otherwise leave as the original date. Returns the raw
// fallback string (often '—') when input is missing/garbage.
export function formatInspectionDateTime(input, { fallback = '—' } = {}) {
  if (input == null || input === '') return fallback;
  const s = String(input);
  // Date-only inputs (no time component) stay as-is — adding a fake "00:00"
  // would lie about precision.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;     // unrecognized format → show raw so the
                                        // user can at least see it
  const pad = (n) => String(n).padStart(2, '0');
  // Render in local time — what the user is reading on their screen, not
  // server-side UTC. Sorting upstream uses the raw ISO so localization here
  // is purely for display.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Paint the score-ring canvas inside the body HTML. Call after openDetail
// runs so the canvas is in the DOM. theme: 'light' | 'dark' (controls the
// track color).
export function paintScoreRing(pt, { theme = 'dark' } = {}) {
  const cv = document.getElementById('ring');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const col = SEV_HEX[pt.severity] || SEV_HEX.medium;
  const score = Math.max(0, Math.min(100, Number(pt.score ?? 0)));
  ctx.clearRect(0, 0, 96, 96);
  ctx.beginPath(); ctx.arc(48, 48, 36, 0, Math.PI * 2);
  ctx.strokeStyle = theme === 'light' ? '#d4d4d4' : '#2a2a2a';
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(48, 48, 36, -Math.PI / 2, -Math.PI / 2 + (score / 100) * Math.PI * 2);
  ctx.strokeStyle = col; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.stroke();
}

// Reads point.area ("1.23 m²" / "0.075 m²" / "—") into a number of
// square metres, or null if missing. Used by the eval-photo backfill to
// size the synthetic defect polygon when the original poly isn't in the
// inspection JSON.
export function parseEvalAreaM2(s) {
  if (s == null || s === '—') return null;
  const m = String(s).match(/^\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Normalizes inspection.evalPhotos[] for display by either the editor's
// inspection-mode pane or the public viewer. The first generation of
// evalPhotos commits carried only { id, url, name, source } — no
// verdict, no defects[]. Re-saves through the new schema stamp
// verdict+defects+poly, but every old inspection on disk lacks them.
//
// The legacy data we DO have on disk is POINTS — each defect that
// became an inspection point retains source.kind='ortho' + source.nx/ny
// (centroid in ortho norm space). We back the verdict out of "is there
// any point whose centroid falls in this photo's footprint?", and
// synthesize defect entries (with a square polygon sized from
// point.area) so the photo overlay still has something to draw.
//
// Pass `evaluatedAt` so photos with no linked points can resolve to
// 'clean' (the inspection was finalized) instead of 'pending' (it
// wasn't, so we can't claim it). 'skipped' is collapsed into 'pending'
// — the public viewer has no actionable difference between them, and
// the editor doesn't take this path (it has the live task).
export function normalizeEvalPhotos(evalPhotos, points, opts = {}) {
  const { evaluatedAt = false } = opts;
  if (!Array.isArray(evalPhotos)) return [];
  const allPoints = Array.isArray(points) ? points : [];
  return evalPhotos.map(p => {
    const ph = p.source || {};
    const w  = (ph.x1 != null && ph.x0 != null) ? (ph.x1 - ph.x0) : 0;
    const h  = (ph.y1 != null && ph.y0 != null) ? (ph.y1 - ph.y0) : 0;
    const linkedPoints = (w > 0 && h > 0) ? allPoints.filter(pt => {
      if (!pt || !pt.source || pt.source.kind !== 'ortho') return false;
      const nx = pt.source.nx, ny = pt.source.ny;
      return typeof nx === 'number' && typeof ny === 'number'
          && nx >= ph.x0 && nx <= ph.x1
          && ny >= ph.y0 && ny <= ph.y1;
    }) : [];
    const haveDefects = Array.isArray(p.defects) && p.defects.length > 0;
    // 'skipped' → null (public view has no actionable difference; lets
    // it follow the "evaluated → clean / not evaluated → pending" path).
    const stamped = p.verdict === 'skipped' ? null : p.verdict;
    const verdict = stamped
      || (haveDefects || linkedPoints.length ? 'has_defects'
        : evaluatedAt ? 'clean'
        : null);
    const xz = ph.xzCell;
    const photoAreaM2 = (xz && typeof xz.x0 === 'number')
      ? Math.abs((xz.x1 - xz.x0) * (xz.z1 - xz.z0))
      : 0;
    const polyHalfFor = (areaStr) => {
      const a = parseEvalAreaM2(areaStr);
      if (a != null && photoAreaM2 > 0) {
        const side = Math.sqrt(a / photoAreaM2);
        return Math.min(0.48, Math.max(0.015, side / 2));
      }
      return 0.04;
    };
    const defects = haveDefects ? p.defects : linkedPoints.map(pt => {
      const cx = (pt.source.nx - ph.x0) / w;
      const cy = (pt.source.ny - ph.y0) / h;
      const half = polyHalfFor(pt.area);
      return {
        id: pt.id,
        sev: pt.severity,
        score: pt.score,
        tags: Array.isArray(pt.tags) ? pt.tags : [],
        poly: [
          { nx: Math.max(0, cx - half), ny: Math.max(0, cy - half) },
          { nx: Math.min(1, cx + half), ny: Math.max(0, cy - half) },
          { nx: Math.min(1, cx + half), ny: Math.min(1, cy + half) },
          { nx: Math.max(0, cx - half), ny: Math.min(1, cy + half) },
        ],
        position: pt.position,
        area: pt.area,
        action: pt.action,
      };
    });
    return { ...p, verdict, defects };
  });
}

// ── Evaluation defect card / polygon canvas (shared between editor and
// public viewer so the read-only review matches the editing UI 1:1) ────

// Severity palette used by the polygon overlay + numbered chip. Same
// colours the editor uses for tile tints; the viewer needs them in CSS
// (#hex) form for canvas strokes.
export const EVAL_SEV_HEX_BY_SEV = {
  critical: '#d04141',
  high:     '#ff6600',
  medium:   '#d6a23c',
  low:      '#3aa55c',
};

// Renders a single defect card using the editor's `.evp-defect` markup,
// optionally in read-only mode (inputs/buttons stripped, values rendered
// as static spans). The editor and viewer feed differently-shaped photo
// records:
//   editor: f.img is an HTMLImageElement, defects carry runtime fields
//           (position/area filled by _evalAutoFillDefect).
//   viewer: photo.url + defects[{poly,tags,sev}] off inspection.evalPhotos;
//           no img bitmap yet → no thumb on first render.
// `opts` gives the caller a hook for thumb generation (igCropDefectAnnotated
// in the editor) and i18n. All optional — sensible defaults rendered when
// missing.
export function renderEvalDefectCardHtml(d, i, opts = {}) {
  const {
    readonly = false,
    thumbSrc = '',
    t = (k, fb) => fb,
    sevScoreDefault = { critical: 85, high: 65, medium: 45, low: 20 },
    sevLabel = (s) => t('sev.' + s, s),
    tagsHtml = '',
    actionPh = t('admin.modal.add.action.ph', 'ex: Injeção de resina'),
    tagsPh   = t('admin.imggen.tags_ph', 'tags'),
  } = opts;
  const sev   = d.sev || 'medium';
  const score = (d.score != null) ? d.score : (sevScoreDefault[sev] || 45);
  const pos   = d.position ? `${d.position.x}, ${d.position.y}, ${d.position.z}` : '—';
  const area  = esc(d.area || '—');
  const id    = esc(d.id || ('#' + (i + 1)));
  const action = esc(d.action || '');
  const thumb = thumbSrc ? `<img src="${thumbSrc}" alt="">` : '';
  const sevOptions = ['critical', 'high', 'medium', 'low'].map(s =>
    `<option value="${s}" ${sev === s ? 'selected' : ''}>${esc(sevLabel(s))}</option>`
  ).join('');
  const closeBtn = readonly
    ? ''
    : `<button class="evp-defect-x" type="button" onclick="_evalRemoveDef(${i})" aria-label="remove">×</button>`;
  const tagBlock = readonly
    ? `<div class="tageditor evp-readonly-tags">${tagsHtml || '<span class="evp-readonly" style="color:var(--tx3);font-style:italic">—</span>'}</div>`
    : `<div class="tageditor" onclick="this.querySelector('input').focus()">
         ${tagsHtml}<input class="ig-taginput" list="igTagBank" placeholder="${esc(tagsPh)}" onkeydown="_evalDefTagKey(event,${i})" onblur="_evalDefAddTag(${i},this.value)">
       </div>`;
  const sevControl = readonly
    ? `<span class="evp-readonly" style="color:${EVAL_SEV_HEX_BY_SEV[sev] || '#ff6600'};font-weight:700">${esc(sevLabel(sev))}</span>`
    : `<select class="aminp" onchange="_evalDefSetSev(${i}, this.value)">${sevOptions}</select>`;
  const scoreControl = readonly
    ? `<span class="evp-readonly">${score}</span>`
    : `<input class="aminp" type="number" min="0" max="100" step="1" value="${score}" oninput="_evalDefSetField(${i},'score',this.value === '' ? null : +this.value)">`;
  const actionControl = readonly
    ? `<span class="evp-readonly">${action || '—'}</span>`
    : `<input class="aminp" type="text" value="${action}" placeholder="${esc(actionPh)}" oninput="_evalDefSetField(${i},'action',this.value)">`;
  return `<div class="evp-defect" data-i="${i}">
    ${closeBtn}
    <div class="evp-defect-title">${id}</div>
    <div class="evp-defect-head">
      ${thumb}
      ${tagBlock}
    </div>
    <div class="evp-defect-grid">
      <label>${esc(t('admin.modal.add.sev', 'Severidade'))}</label>
      ${sevControl}
      <label>${esc(t('admin.point.score', 'Score'))}</label>
      ${scoreControl}
      <label>${esc(t('admin.point.position', 'Posição'))}</label>
      <span class="evp-readonly mono">${esc(pos)}</span>
      <label>${esc(t('admin.point.area', 'Área'))}</label>
      <span class="evp-readonly">${area}</span>
      <label>${esc(t('admin.modal.add.action', 'Ação'))}</label>
      ${actionControl}
    </div>
  </div>`;
}

// Same dashboard the editor renders in pane-photoLocations when no photo
// is selected: 4 stat rows (pending/clean/defective/skipped) + a footer
// with the total marked-defect count. Used by both editor (live counts as
// the operator works) and public viewer (frozen counts from evalPhotos[]).
export function renderEvalDashboardHtml(photos, opts = {}) {
  const { t = (k, fb) => fb } = opts;
  const total = photos.length;
  let clean = 0, defective = 0, skipped = 0;
  for (const p of photos) {
    if (p.verdict === 'clean') clean++;
    else if (p.verdict === 'has_defects') defective++;
    else if (p.verdict === 'skipped') skipped++;
  }
  const pending = total - clean - defective - skipped;
  const totalDefects = photos.reduce((s, p) => s + (Array.isArray(p.defects) ? p.defects.length : 0), 0);
  const row = (cls, count, label) => {
    const pct = total ? Math.round((count / total) * 100) : 0;
    return `<div class="evp-dash-row ${cls}"><span class="num">${count}</span><span class="lbl">${esc(label)}</span><span class="pct">${pct}%</span></div>`;
  };
  return `<div class="evp-dash-title">${esc(t('admin.eval.dash_title', 'Progresso da avaliação'))}</div>` +
    `<div class="evp-dash-grid">` +
      row('pending',   pending,   t('admin.eval.dash_pending', 'Pendentes')) +
      row('clean',     clean,     t('admin.eval.dash_clean',   'Sem defeito')) +
      row('defective', defective, t('admin.eval.dash_defect',  'Com defeito')) +
      row('skipped',   skipped,   t('admin.eval.dash_skipped', 'Puladas')) +
    `</div>` +
    `<div class="evp-dash-foot">${totalDefects} ${esc(t('admin.eval.dash_total_def', 'defeitos marcados no total'))}</div>`;
}

// Done banner — green panel the editor shows when task.status === 'done'.
// Read-only context (viewer) passes { appliedCount, appliedAt } from the
// inspection's evaluatedAt + points-from-eval count to render the same
// summary without the Reopen button.
export function renderEvalDoneBannerHtml({ appliedCount = 0, t = (k, fb) => fb, withReopen = false } = {}) {
  const title = t('admin.eval.done_title', 'Avaliação concluída');
  const summary = appliedCount
    ? `${appliedCount} ${t('admin.eval.done_applied', 'ponto(s) aplicado(s) na inspeção.')}`
    : t('admin.eval.done_clean', 'Nenhum defeito marcado — fechada como sem ocorrências.');
  const reopenBtn = withReopen
    ? `<button class="ambtn sec" id="evalActReopen" type="button">${esc(t('admin.eval.reopen', 'Reabrir avaliação'))}</button>`
    : '';
  return `<div class="evp-dash-done">
    <div class="evp-done-title">${esc(title)}</div>
    <div class="evp-done-sub">${summary}</div>
    ${reopenBtn}
  </div>`;
}

// Annotated crop of a single defect from a fully-loaded image. Mirrors
// admin/edit's igCropDefectAnnotated so the editor and the viewer's side
// panel show the same per-defect thumbnail. Returns a JPEG dataURL.
// `img` must already have loaded (img.complete && naturalWidth > 0).
export function cropEvalDefectAnnotated(img, poly, maxSide, sev) {
  if (!img || !poly || !poly.length) return '';
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  poly.forEach(p => { x0 = Math.min(x0, p.nx); y0 = Math.min(y0, p.ny); x1 = Math.max(x1, p.nx); y1 = Math.max(y1, p.ny); });
  const pad = 0.06;
  const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad);
  const bx1 = Math.min(1, x1 + pad), by1 = Math.min(1, y1 + pad);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  if (!W || !H) return '';
  const sx = Math.round(bx0 * W), sy = Math.round(by0 * H);
  const sw = Math.max(1, Math.round((bx1 - bx0) * W));
  const sh = Math.max(1, Math.round((by1 - by0) * H));
  const k  = Math.min(1, maxSide / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * k));
  const dh = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas'); c.width = dw; c.height = dh;
  const ctx = c.getContext('2d');
  try { ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh); }
  catch (_) { return ''; }   // tainted canvas (CORS) → no thumb
  const bw = bx1 - bx0, bh = by1 - by0;
  const sevColor = EVAL_SEV_HEX_BY_SEV[sev] || '#ff6600';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  poly.forEach((p, i) => {
    const nx = (p.nx - bx0) / bw, ny = (p.ny - by0) / bh;
    if (i) ctx.lineTo(nx * dw, ny * dh); else ctx.moveTo(nx * dw, ny * dh);
  });
  ctx.closePath();
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.stroke();
  ctx.fillStyle = sevColor + '33'; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = sevColor; ctx.stroke();
  try { return c.toDataURL('image/jpeg', 0.85); }
  catch (_) { return ''; }
}

// Draws photo + each defect polygon onto a 2D canvas using the same recipe
// as the editor's _drawEvalPhotoCanvas (white halo + sev-coloured stroke +
// 20% sev-coloured fill + numbered chip at centroid). Defect poly verts
// are normalized 0..1 over the image.
export function drawEvalPhotoOnCanvas(canvas, img, defects = []) {
  if (!canvas || !img) return;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  (defects || []).forEach((d, i) => {
    const verts = d.poly || [];
    if (!verts.length) return;
    const sevColor = EVAL_SEV_HEX_BY_SEV[d.sev] || '#ff6600';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    verts.forEach((p, k) => {
      const x = p.nx * canvas.width, y = p.ny * canvas.height;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.stroke();
    ctx.fillStyle = sevColor + '33'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = sevColor; ctx.stroke();
    let cx = 0, cy = 0;
    verts.forEach(p => { cx += p.nx; cy += p.ny; });
    cx = (cx / verts.length) * canvas.width;
    cy = (cy / verts.length) * canvas.height;
    ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = sevColor; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Inter,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(i + 1, cx, cy);
  });
}
