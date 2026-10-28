// Thin compatibility layer over NoctuaData.
//
// Every read now lives in noctua-data.js, which also decides whether this page
// is talking to the API or to the committed JSON files. This file stays because
// the viewer, admin and landing all call NoctuaInspections.* — renaming those
// call sites buys nothing and risks a lot.
//
// 1 inspection : 1 asset. No redundancy on disk; composition happens in the
// backend when there is one, in the browser when there is not.
(function (global) {
  'use strict';

  function data() {
    if (!global.NoctuaData) {
      throw new Error('noctua-data.js must be loaded before inspection-resolver.js');
    }
    return global.NoctuaData;
  }

  //  - inspection: the inspection as stored.
  //  - asset: the asset it belongs to (null on a legacy inspection).
  //  - composed: legacy shape — model/rotation/thumb/requireLogin/project from
  //    the asset; points/route/date/asset and anything else from the inspection.
  const fetchInspection = (slug) => data().getInspection(slug);
  const fetchAsset = (slug) => data().getAsset(slug);
  const fetchInspectionResolved = (slug) => data().getInspectionResolved(slug);

  global.NoctuaInspections = { fetchInspection, fetchAsset, fetchInspectionResolved };
})(typeof window !== 'undefined' ? window : globalThis);
