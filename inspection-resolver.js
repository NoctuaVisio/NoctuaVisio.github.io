// Resolver compartilhado: lê inspections/<slug>.json + assets/<slug>.json
// e devolve uma view "composta" no SHAPE LEGACY (com model/rotation/thumb/
// requireLogin/project preenchidos do asset). Quem lê hoje (viewer, admin,
// landing) só troca o fetch direto por esta função e continua usando os
// mesmos nomes de campo.
//
// Inspection nova: só { asset, points, route?, date?, … }.
// Inspection legacy (sem `asset`): devolvida como veio — `composed === inspection`.
//
// 1 inspection : 1 asset. Sem redundância no disco; composição em memória.
(function (global) {
  'use strict';

  async function fetchJSON(url, init) {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, init || {}));
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  // Session-storage handoff: when a caller just committed a resource via the
  // GitHub API moments ago, the matching /<kind>/<slug>.json isn't served by
  // GitHub Pages yet (~30s propagation). Stashing the object under a
  // well-known key lets the next page hydrate immediately without waiting on
  // the CDN. Key is consumed on read so it doesn't leak into later sessions.
  function takeStash(kind, slug) {
    try {
      const key = `${kind}-bootstrap-${slug}`;
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      sessionStorage.removeItem(key);
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  async function fetchInspection(slug, init) {
    const stash = takeStash('inspection', slug);
    if (stash) return stash;
    return fetchJSON(`/inspections/${slug}.json`, init);
  }
  async function fetchAsset(slug, init) {
    const stash = takeStash('asset', slug);
    if (stash) return stash;
    return fetchJSON(`/assets/${slug}.json`, init);
  }

  // Devolve { inspection, asset, composed }.
  //  - inspection: JSON cru de inspections/<slug>.json.
  //  - asset: JSON de assets/<assetSlug>.json (null em inspection legacy).
  //  - composed: shape antigo pronto pra usar — model/rotation/thumb/requireLogin/project
  //              vêm do asset; points/route/date/asset/extras vêm da inspection.
  async function fetchInspectionResolved(slug, init) {
    const inspection = await fetchInspection(slug, init);
    if (!inspection.asset) return { inspection, asset: null, composed: inspection };
    const asset = await fetchAsset(inspection.asset, init);
    const composed = Object.assign(
      {},
      asset,            // model, modelName, modelRotation, modelOffset, modelScale, thumbnail, requireLogin, createdAt
      inspection,       // points, route, date, asset, e o que mais existir
      { project: asset.name },   // legacy: `project` vem do nome do asset
    );
    return { inspection, asset, composed };
  }

  global.NoctuaInspections = { fetchInspection, fetchAsset, fetchInspectionResolved };
})(typeof window !== 'undefined' ? window : globalThis);
