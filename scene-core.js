// Shared three.js scene logic for viewer and admin (and, eventually, the
// landing's model carousel). Each consumer passes a `ctx` object holding
// the scene/camera/controls/modelRoot references it owns; these functions
// mutate that ctx in place so the caller stays in sync.
//
// `ctx` shape:
//   {
//     canvas,                  // HTMLCanvasElement (for aspect ratio in Top)
//     scene,                   // THREE.Scene
//     renderer,                // THREE.WebGLRenderer (not used here but lives in ctx)
//     perspCamera, orthoCamera,// the two cameras
//     camera,                  // current active camera (the consumer must
//                              //   re-read ctx.camera after setFreeView/Top
//                              //   if it caches it)
//     controls,                // OrbitControls
//     modelRoot,               // currently loaded model (or null)
//     grid,                    // current GridHelper (or null)
//     viewMode,                // 'free' | 'top'
//     currentTheme,            // 'dark' | 'light'
//   }

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Gaussian-splat loader is dynamically imported on first use so the GLB-only
// pages don't pay the bundle cost. Cached after first load.
let _SplatsLibPromise = null;
function loadSplatsLib() {
  if (!_SplatsLibPromise) {
    _SplatsLibPromise = import(
      'https://cdn.jsdelivr.net/npm/@mkkellogg/gaussian-splats-3d@0.4.7/build/gaussian-splats-3d.module.js'
    );
  }
  return _SplatsLibPromise;
}

// True when the URL points to a Gaussian-splat file we can render via the
// splats lib (.splat / .ply / .ksplat / .compressed.ply).
export function isSplatUrl(url) {
  if (!url) return false;
  const s = String(url).toLowerCase().split('?')[0].split('#')[0];
  return s.endsWith('.splat') || s.endsWith('.ply') || s.endsWith('.ksplat');
}

const SCENE_BG_DARK  = 0x0a0a0a;
const SCENE_BG_LIGHT = 0xcccccc;
const GRID_DARK_A    = 0x2a2a2a;
const GRID_DARK_B    = 0x1a1a1a;
const GRID_LIGHT_A   = 0xb0b0b0;
const GRID_LIGHT_B   = 0xa0a0a0;
const FOG_DENSITY    = 0.016;

export function applySceneTheme(ctx, theme) {
  ctx.currentTheme = theme;
  const isLight = theme === 'light';
  const sceneBg = isLight ? SCENE_BG_LIGHT : SCENE_BG_DARK;
  ctx.scene.background = new THREE.Color(sceneBg);
  if (ctx.viewMode !== 'top' && ctx.modelKind !== 'splat') {
    ctx.scene.fog = new THREE.FogExp2(sceneBg, FOG_DENSITY);
  } else if (ctx.modelKind === 'splat') {
    ctx.scene.fog = null;
  }
  if (ctx.grid) ctx.scene.remove(ctx.grid);
  ctx.grid = new THREE.GridHelper(
    60, 60,
    isLight ? GRID_LIGHT_A : GRID_DARK_A,
    isLight ? GRID_LIGHT_B : GRID_DARK_B
  );
  ctx.scene.add(ctx.grid);
}

export function setFreeView(ctx) {
  const wasTop = ctx.viewMode === 'top';
  ctx.viewMode = 'free';
  ctx.camera = ctx.perspCamera;
  ctx.controls.object = ctx.perspCamera;
  ctx.controls.enableRotate = true;
  ctx.controls.mouseButtons = {
    LEFT:   THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT:  THREE.MOUSE.PAN,
  };
  // Skip fog when a splat is loaded — gaussians fade with distance enough on
  // their own, and exp fog crushes them into the background color.
  if (ctx.modelKind !== 'splat') {
    const fogColor = ctx.currentTheme === 'light' ? SCENE_BG_LIGHT : SCENE_BG_DARK;
    ctx.scene.fog = new THREE.FogExp2(fogColor, FOG_DENSITY);
  } else {
    ctx.scene.fog = null;
  }
  // Only re-angle when coming from Top (which leaves the camera straight
  // overhead). Otherwise keep the user's framing.
  if (wasTop && ctx.modelRoot) {
    const target = ctx.controls.target;
    const dist = Math.max(8, ctx.perspCamera.position.distanceTo(target));
    ctx.perspCamera.position.set(
      target.x + dist * 0.6,
      target.y + dist * 0.4,
      target.z + dist * 0.7
    );
  }
  ctx.controls.update();
}

// Returns true on success, false when there's no model yet (caller can
// surface a "load a model first" message).
export function setTopView(ctx) {
  if (!ctx.modelRoot) return false;
  ctx.viewMode = 'top';
  ctx.scene.fog = null;
  const target = ctx.controls.target;
  const box  = new THREE.Box3().setFromObject(ctx.modelRoot);
  const size = box.getSize(new THREE.Vector3());
  const aspect = ctx.canvas.clientWidth / ctx.canvas.clientHeight;
  const range  = Math.max(size.x, size.z) * 0.65;
  ctx.orthoCamera.left   = -range * aspect;
  ctx.orthoCamera.right  =  range * aspect;
  ctx.orthoCamera.top    =  range;
  ctx.orthoCamera.bottom = -range;
  ctx.orthoCamera.zoom = 1; ctx.orthoCamera.near = 1; ctx.orthoCamera.far = 500;
  ctx.orthoCamera.updateProjectionMatrix();
  ctx.orthoCamera.position.set(target.x, target.y + 100, target.z);
  ctx.orthoCamera.up.set(0, 0, -1);
  ctx.orthoCamera.lookAt(target);
  ctx.camera = ctx.orthoCamera;
  ctx.controls.object = ctx.orthoCamera;
  ctx.controls.enableRotate = false;
  ctx.controls.mouseButtons = {
    LEFT:   THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT:  THREE.MOUSE.PAN,
  };
  ctx.controls.update();
  return true;
}

// Shared GLB loader with progress UI + ETA + file size + framing on rotated
// bbox. Used by /asset/ and /inspection/ so the loading experience is
// identical (text, bar, ETA format, post-load camera target).
//
// opts:
//   url, name              — required
//   modelRotation, modelOffset — optional, applied before framing
//   lang                   — 'pt' | 'en' (for the progress text)
//   els: { overlay, sub, fill, vinfo }
//                          — DOM nodes (any may be null); overlay gets the
//                            `hidden` class on done; sub/fill drive progress;
//                            vinfo gets "<name> | <verts>k vertices"
//
// Resolves with { modelRoot, verts, scaledCenter, scale }. The inspection
// viewer needs scaledCenter+scale to size its marker positions; /asset/
// ignores those fields.
export function loadGLBProgress(ctx, opts) {
  const { url, name, modelRotation, modelOffset, lang = 'en', els = {} } = opts;
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    let loadStart = null;
    loader.load(url, gltf => {
      if (ctx.modelRoot) ctx.scene.remove(ctx.modelRoot);
      const root = gltf.scene;
      root.updateWorldMatrix(false, true);
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const scale = 10 / Math.max(size.x, size.y, size.z);
      const scaledCenter = center.clone().multiplyScalar(scale);
      root.position.sub(scaledCenter);
      root.scale.setScalar(scale);
      root.traverse(o => {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          if (o.material) o.material.side = THREE.FrontSide;
        }
      });
      ctx.scene.add(root);
      ctx.modelRoot = root;
      if (modelRotation) root.rotation.set(modelRotation.x || 0, modelRotation.y || 0, modelRotation.z || 0);
      if (modelOffset) {
        root.position.x += modelOffset.x || 0;
        root.position.y += modelOffset.y || 0;
        root.position.z += modelOffset.z || 0;
      }
      ctx.scene.updateMatrixWorld();
      // Frame the rotated/offset world bbox — keeps the camera pointing at
      // the model wherever rotation+offset end up putting it.
      const wb = new THREE.Box3().setFromObject(root);
      const wc = wb.getCenter(new THREE.Vector3());
      const ws = wb.getSize(new THREE.Vector3());
      const dist = ws.length() * 0.9;
      ctx.perspCamera.position.set(wc.x + dist * 0.6, wc.y + dist * 0.4, wc.z + dist * 0.7);
      ctx.controls.target.copy(wc); ctx.controls.update();
      let verts = 0;
      root.traverse(o => { if (o.isMesh) verts += o.geometry.attributes.position?.count || 0; });
      if (els.overlay) els.overlay.classList.add('hidden');
      if (els.vinfo) {
        const vertsLbl = lang === 'pt' ? 'vértices' : 'vertices';
        els.vinfo.textContent = `${name} | ${(verts / 1000).toFixed(0)}k ${vertsLbl}`;
      }
      resolve({ modelRoot: root, verts, scaledCenter, scale });
    }, xhr => {
      if (!loadStart) loadStart = performance.now();
      const loadedMB = (xhr.loaded / 1024 / 1024).toFixed(1);
      if (xhr.total) {
        const totalMB = (xhr.total / 1024 / 1024).toFixed(1);
        const pct = Math.round(xhr.loaded / xhr.total * 100);
        if (els.fill) els.fill.style.width = pct + '%';
        let etaText = '';
        const elapsed = (performance.now() - loadStart) / 1000;
        if (elapsed > 0.7 && xhr.loaded > 0) {
          const remaining = (xhr.total - xhr.loaded) / (xhr.loaded / elapsed);
          if (remaining > 1) {
            etaText = remaining < 60
              ? ` · ~${Math.round(remaining)}s`
              : ` · ~${Math.ceil(remaining / 60)}min`;
          }
        }
        if (els.sub) els.sub.textContent = `${loadedMB} / ${totalMB} MB · ${pct}%${etaText}`;
      } else {
        const lbl = lang === 'pt' ? `${loadedMB} MB carregados` : `${loadedMB} MB loaded`;
        if (els.sub) els.sub.textContent = lbl;
      }
    }, err => reject(err));
  });
}

// Gaussian-splat loader. Mirrors loadGLBProgress' shape (same opts, same
// resolve payload) so callers can swap loaders by URL extension without
// rewriting the surrounding flow.
//
// The splat library (@mkkellogg/gaussian-splats-3d) renders via a DropInViewer
// which is itself a THREE.Group — we treat it as the modelRoot, so rotation/
// offset reuse the GLB code path unchanged.
//
// KNOWN LIMITATIONS (Gaussian Splat assets vs GLB)
// ────────────────────────────────────────────────
// 1. TOP VIEW (orthographic) DOES NOT WORK.
//    The lib computes per-gaussian 2D screen-space ellipse extent using a
//    perspective projection (cov2D + depth-based size). Through an ortho
//    camera the gaussians either don't project at all or render at the
//    wrong size. The "Topo" button is kept visible but disabled (with a
//    tooltip) when a splat is loaded — see admin/edit/ and /asset/ wiring.
//
// 2. INSPECTIONS (raycast-based point placement) ARE NOT SUPPORTED.
//    Splats have no triangle mesh — only a cloud of translucent ellipsoids —
//    so `Raycaster.intersectObject(modelRoot)` returns []. To place points
//    on a splat we'd need depth-buffer readback (`gl.readPixels` on the
//    depth attachment) and reverse-project; the editor blocks inspection
//    mode for splat assets to avoid the broken click-to-place flow.
//
// 3. FOG IS DISABLED whenever a splat is loaded (`ctx.modelKind === 'splat'`)
//    because exp fog crushes gaussians into the background color. setFreeView
//    and applySceneTheme both honor this.
//
// 4. NO DOWNLOAD PROGRESS. The lib doesn't expose granular per-byte progress
//    in the public API; we drive an indeterminate bar (~30%) + "downloading
//    splat…" label and flip to done on resolve.
//
// 5. AUTO-NORMALIZATION IS SKIPPED. The SplatMesh's bbox is populated lazily,
//    so reading it right after addSplatScene resolves often returns empty
//    (which previously yielded scale = 10/0 = Infinity and an invisible
//    model). We now leave the splat at its native training-space scale and
//    just frame the camera off the bbox one frame later, with a fallback
//    distance of 8 at the origin when the bbox is still empty.
//
// 6. THUMBNAIL CAPTURE works for "current view" (same camera the splat is
//    being sorted against) and usually for the isometric capture (a fresh
//    PerspectiveCamera is passed via render() so DropInViewer's onBeforeRender
//    picks it up). Sort latency may produce a one-frame popcorn artifact —
//    capture twice if the first frame looks wrong.
export async function loadSplatProgress(ctx, opts) {
  const { url, name, ext, modelRotation, modelOffset, lang = 'en', els = {} } = opts;
  const GaussianSplats3D = await loadSplatsLib();
  if (els.sub) els.sub.textContent = lang === 'pt' ? 'Baixando splat…' : 'Downloading splat…';
  if (els.fill) els.fill.style.width = '30%';

  if (ctx.modelRoot) ctx.scene.remove(ctx.modelRoot);

  // Blob URLs (file picker) carry no extension, so the lib can't guess the
  // format — pass it explicitly when the caller knows it (or fall back to a
  // last-resort extension parse from name/url).
  const SF = GaussianSplats3D.SceneFormat || {};
  const extHint = (ext || '').toLowerCase()
    || (/\.([a-z0-9]+)(?:\?|#|$)/i.exec(name || '')?.[1] || '').toLowerCase()
    || (/\.([a-z0-9]+)(?:\?|#|$)/i.exec(url  || '')?.[1] || '').toLowerCase();
  let format;
  if (extHint === 'ply')         format = SF.Ply;
  else if (extHint === 'splat')  format = SF.Splat;
  else if (extHint === 'ksplat') format = SF.KSplat;

  // Minimal config: DropInViewer applies sane defaults. gpuAcceleratedSort:false
  // uses the CPU sort fallback (slower for huge scenes, but works everywhere —
  // the GPU path was silently failing on some browsers and leaving the scene
  // empty). sharedMemoryForWorkers:false avoids SharedArrayBuffer-gated paths.
  const viewer = new GaussianSplats3D.DropInViewer({
    gpuAcceleratedSort: false,
    sharedMemoryForWorkers: false,
  });
  const addOpts = { showLoadingUI: false };
  if (format !== undefined) addOpts.format = format;
  await viewer.addSplatScene(url, addOpts);

  // Splats arrive in their training-space coordinates. Don't auto-normalize:
  // the SplatMesh's bbox is computed lazily and Box3.setFromObject often comes
  // back empty here — the previous code divided 10 by that 0, ended up with
  // viewer.scale = Infinity, and the model rendered as NaN (invisible).
  ctx.scene.add(viewer);
  ctx.modelRoot = viewer;
  ctx.modelKind = 'splat';
  // Fog washes the splat out (alpha + depth-driven gaussians fade quickly).
  // Drop it for splat scenes; setFreeView reads ctx.modelKind to keep it off.
  ctx.scene.fog = null;
  if (modelRotation) viewer.rotation.set(modelRotation.x || 0, modelRotation.y || 0, modelRotation.z || 0);
  if (modelOffset) {
    viewer.position.set(modelOffset.x || 0, modelOffset.y || 0, modelOffset.z || 0);
  }

  // One frame later the splat geometry's bbox is populated; use it to frame
  // the camera. Fall back to a sensible default when the bbox is still empty.
  await new Promise(r => requestAnimationFrame(r));
  viewer.updateMatrixWorld(true);
  const wb = new THREE.Box3().setFromObject(viewer);
  let wc, dist;
  if (wb.isEmpty() || !isFinite(wb.min.x) || !isFinite(wb.max.x)) {
    wc   = new THREE.Vector3(0, 0, 0);
    dist = 8;
  } else {
    wc = wb.getCenter(new THREE.Vector3());
    const ws = wb.getSize(new THREE.Vector3());
    dist = Math.max(ws.length() * 0.9, 4);
  }
  ctx.perspCamera.position.set(wc.x + dist * 0.6, wc.y + dist * 0.4, wc.z + dist * 0.7);
  ctx.controls.target.copy(wc); ctx.controls.update();

  if (els.overlay) els.overlay.classList.add('hidden');
  if (els.vinfo) {
    els.vinfo.textContent = `${name} | splat`;
  }
  return { modelRoot: viewer, verts: 0, scaledCenter: new THREE.Vector3(), scale: 1 };
}

// Updates each point's _worldX/_worldY/_worldZ using the model's current
// world matrix — call this whenever the model transform (rotation, offset)
// changes so markers track the model.
export function recomputeMarkerWorlds(ctx, points) {
  if (!ctx.modelRoot) return;
  ctx.modelRoot.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  points.forEach(pt => {
    v.set(pt.position.x, pt.position.y, pt.position.z);
    v.applyMatrix4(ctx.modelRoot.matrixWorld);
    pt._worldX = v.x;
    pt._worldY = v.y;
    pt._worldZ = v.z;
  });
}
