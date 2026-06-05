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
