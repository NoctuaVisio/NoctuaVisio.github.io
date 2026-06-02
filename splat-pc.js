// PlayCanvas-based Gaussian Splat loader. Sits beside scene-core.js (which
// is three.js-only) and is invoked instead of three.js when an asset's
// `kind === 'splat'`. The two engines coexist via stacked canvases — see
// /asset/index.html and /admin/edit/index.html for the #glCanvas (three.js)
// vs #pcCanvas (PlayCanvas) toggle.
//
// Why PlayCanvas and not three.js + @mkkellogg/gaussian-splats-3d?
//   - mkkellogg lags PlayCanvas on PLY format support: splat-transform 2.x
//     (chunk + packed_* + element sh) silently parses zero splats. PlayCanvas
//     IS the tool author, so it handles every variant.
//   - PlayCanvas has built-in picker (Picker.getWorldPointAsync → Vec3) and
//     orthographic gsplat support (shader branches on `isOrtho` uniform) —
//     unblocks Top view + click-to-place-point in future phases.
//
// Phase 1 scope (this file): only swap the renderer for splat. Top view
// stays disabled, no picking, no inspections. Future phases enable those.
//
// Public API:
//   await loadSplatPC({ canvas, url, name, modelRotation, modelOffset, lang, els })
//     - Returns { app, entity, camera }; caller can keep refs but the module
//       also caches the active app so a subsequent call tears down the old one.
//   destroyPcApp()  — explicit teardown when swapping back to GLB.
//   isPcActive(canvas) — true when the given canvas already hosts a PC app.

let _pcLib    = null;
let _pcApp    = null;
let _pcCanvas = null;
let _pcCamera = null;
let _pcEntity = null;
let _pcTheme  = 'dark';
let _pcView   = 'free';   // 'free' | 'top'
// Grid color is held in a ref-style object so the update handler reads the
// current value each frame and theme swaps don't require re-binding listeners.
const _gridColor = { value: null };
// Orbit state is mutated by the orbit handler AND by setSplatTopView/Free —
// having a shared ref lets the view-switch reposition the camera without
// taking ownership of the orbit closure.
const _orbitState = { pivot: null, yaw: 0, pitch: -20, distance: 8, update: null };

async function loadPcLib() {
  if (!_pcLib) {
    _pcLib = await import('https://cdn.jsdelivr.net/npm/playcanvas@2.19.1/build/playcanvas.mjs');
  }
  return _pcLib;
}

// Theme-driven colors mirror the three.js side (see scene-core.js SCENE_BG_*
// and GRID_*_A constants) so the dark/light split feels identical between
// the two engines.
function bgColorForTheme(pc, theme) {
  return theme === 'light'
    ? new pc.Color(0.80, 0.80, 0.80, 1)   // #cccccc
    : new pc.Color(0.04, 0.04, 0.04, 1);  // #0a0a0a
}
function gridColorForTheme(pc, theme) {
  return theme === 'light'
    ? new pc.Color(0.69, 0.69, 0.69, 1)   // #b0b0b0
    : new pc.Color(0.16, 0.16, 0.16, 1);  // #2a2a2a
}

export function isPcActive(canvas) {
  return !!_pcApp && _pcCanvas === canvas;
}

export function destroyPcApp() {
  if (_pcApp) {
    try { _pcApp.destroy(); } catch (_) {}
    _pcApp = null;
  }
  _pcCanvas = null;
  _pcCamera = null;
  _pcEntity = null;
  _gridColor.value = null;
}

// Sync the active splat entity's transform from external state (editor
// sliders, asset JSON re-apply, etc). Accepts the same shapes used by the
// three.js side so callers don't have to convert.
//   rotation: { x, y, z } in RADIANS (matches three.js Euler)
//   offset:   { x, y, z }
//   scale:    number (uniform)
export function setSplatTransform({ rotation, offset, scale } = {}) {
  if (!_pcEntity) return;
  if (rotation) {
    const RAD2DEG = 180 / Math.PI;
    _pcEntity.setLocalEulerAngles(
      (rotation.x || 0) * RAD2DEG,
      (rotation.y || 0) * RAD2DEG,
      (rotation.z || 0) * RAD2DEG,
    );
  }
  if (offset) _pcEntity.setLocalPosition(offset.x || 0, offset.y || 0, offset.z || 0);
  if (typeof scale === 'number' && isFinite(scale) && scale > 0) {
    _pcEntity.setLocalScale(scale, scale, scale);
  }
}

// Repaint the PC scene to match a theme change. Called from the asset viewer
// and editor's existing NoctuaHub onThemeChange listener.
export function setPcTheme(theme) {
  _pcTheme = theme;
  if (!_pcApp || !_pcCamera || !_pcLib) return;
  _pcCamera.camera.clearColor = bgColorForTheme(_pcLib, theme);
  _gridColor.value            = gridColorForTheme(_pcLib, theme);
}

export function getPcView() { return _pcView; }

// Compute the world-axis-aligned bbox of the current splat by transforming
// all 8 corners of the entity-local customAabb through the entity's world
// matrix. Center-only transform doesn't work — under rotation/non-uniform
// scale the extents on each world axis change. Returns { center, halfExtents }
// (both pc.Vec3) or null when the splat isn't loaded yet.
function computeSplatWorldAabb(pc) {
  if (!_pcEntity || !_pcEntity.gsplat) return null;
  const aabb = _pcEntity.gsplat.customAabb;
  if (!aabb) return null;
  const wt = _pcEntity.getWorldTransform();
  const cx = aabb.center.x, cy = aabb.center.y, cz = aabb.center.z;
  const hx = aabb.halfExtents.x, hy = aabb.halfExtents.y, hz = aabb.halfExtents.z;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const tmp = new pc.Vec3();
  for (let bx = 0; bx < 2; bx++) {
    for (let by = 0; by < 2; by++) {
      for (let bz = 0; bz < 2; bz++) {
        tmp.set(
          cx + (bx ? hx : -hx),
          cy + (by ? hy : -hy),
          cz + (bz ? hz : -hz),
        );
        wt.transformPoint(tmp, tmp);
        if (tmp.x < minX) minX = tmp.x; if (tmp.x > maxX) maxX = tmp.x;
        if (tmp.y < minY) minY = tmp.y; if (tmp.y > maxY) maxY = tmp.y;
        if (tmp.z < minZ) minZ = tmp.z; if (tmp.z > maxZ) maxZ = tmp.z;
      }
    }
  }
  return {
    center:      new pc.Vec3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
    halfExtents: new pc.Vec3((maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2),
  };
}

// Top view (orthographic from above) for splat — possible because PC's gsplat
// shader branches on an `isOrtho` uniform (see scene-core.js docs). Mirrors
// the three.js SceneCore.setTopView shape so the editor wires both paths
// through a single button.
export function setSplatTopView() {
  if (!_pcApp || !_pcCamera || !_pcLib || !_pcEntity) return false;
  const pc = _pcLib;
  const cam = _pcCamera.camera;
  const wb = computeSplatWorldAabb(pc);
  let cx, cy, cz, halfRange;
  if (wb) {
    cx = wb.center.x; cy = wb.center.y; cz = wb.center.z;
    halfRange = Math.max(wb.halfExtents.x, wb.halfExtents.z) * 1.1;
  } else {
    cx = 0; cy = 0; cz = 0; halfRange = 8;
  }
  cam.projection  = pc.PROJECTION_ORTHOGRAPHIC;
  cam.orthoHeight = halfRange;
  // Re-center the pivot on the model's actual bbox center so panning starts
  // from a sane spot, not wherever the user last dragged.
  _orbitState.pivot.set(cx, cy, cz);
  _orbitState.distance = 100;
  _pcCamera.setPosition(cx, cy + 100, cz);
  _pcCamera.lookAt(cx, cy, cz);
  _pcView = 'top';
  return true;
}
export function setSplatFreeView() {
  if (!_pcApp || !_pcCamera || !_pcLib) return false;
  const pc = _pcLib;
  _pcCamera.camera.projection = pc.PROJECTION_PERSPECTIVE;
  _pcView = 'free';
  // Reframe perspective off the current world bbox so the camera distance
  // matches the model's current size (post-scale/rotation) instead of
  // inheriting the 100-unit distance Top left behind.
  const wb = computeSplatWorldAabb(pc);
  if (wb) {
    _orbitState.pivot.copy(wb.center);
    _orbitState.distance = Math.max(8, wb.halfExtents.length() * 2.5);
  }
  _orbitState.pitch = -20;
  _orbitState.yaw   = 0;
  if (_orbitState.update) _orbitState.update();
  return true;
}

export async function loadSplatPC(opts) {
  const { canvas, url, name = 'splat', modelRotation, modelOffset, modelScale, theme = 'dark', lang = 'en', els = {} } = opts;
  if (!canvas) throw new Error('loadSplatPC: canvas is required');
  _pcTheme = theme;

  const pc = await loadPcLib();

  // Tear down the previous PC app (if any) so a fresh load doesn't stack
  // two renderers on the same canvas.
  destroyPcApp();

  // GraphicsDevice — antialiasing is wasteful on splats (each gaussian is
  // already a smooth blob) and the PlayCanvas docs explicitly recommend off.
  const device = await pc.createGraphicsDevice(canvas, {
    deviceTypes: ['webgl2', 'webgl1'],
    antialias: false,
  });
  device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

  const appOptions = new pc.AppOptions();
  appOptions.graphicsDevice = device;
  // We roll our own orbit input (see attachOrbit below) so we deliberately
  // skip pc.Mouse / pc.TouchDevice to avoid double-binding listeners.
  //
  // RenderComponentSystem + TextureHandler are included even though the only
  // visible content is a splat: PlayCanvas's SOG container holds .webp
  // textures (means_l/u, scales, color, sh) that the SogParser needs the
  // texture pipeline to decode. With just GSplatHandler the parse silently
  // produces a GSplatSogResource whose instance is never built — exactly
  // what the diagnostic dump showed (hasInstance: false, customAabb missing).
  appOptions.componentSystems = [
    pc.RenderComponentSystem,
    pc.CameraComponentSystem,
    pc.GSplatComponentSystem,
  ];
  appOptions.resourceHandlers = [
    pc.TextureHandler,
    pc.ContainerHandler,
    pc.GSplatHandler,
  ];

  const app = new pc.AppBase(canvas);
  app.init(appOptions);

  // FILLMODE_NONE so the canvas obeys its CSS sizing (we have flex-driven
  // layout). RESOLUTION_AUTO syncs the WebGL framebuffer to the canvas's
  // current CSS size on each tick.
  app.setCanvasFillMode(pc.FILLMODE_NONE);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);

  // Camera — keep linear tone mapping (the default). ACES requires an HDR
  // pipeline (pc.CameraFrame + PIXELFORMAT_RGBA16F render targets) which we
  // don't run; without it ACES crushes the splat colors, opening visible
  // "black holes" and washed-out splats. Linear matches the simple PC demo.
  const camera = new pc.Entity('camera');
  camera.addComponent('camera', {
    clearColor: bgColorForTheme(pc, theme),
    nearClip: 0.01,
    farClip: 1000,
    fov: 45,
  });
  camera.setPosition(5, 5, 5);
  camera.lookAt(0, 0, 0);
  app.root.addChild(camera);

  // Grid: a real Mesh entity (line topology, BasicMaterial) rather than
  // app.drawLine — the immediate-mode lines render AFTER the splat layer and
  // splats don't write opaque depth (additive blend), so depth-tested lines
  // drawn after the splat aren't occluded by it. Putting the grid on the
  // World layer makes it render BEFORE splats, so the splat's alpha-blended
  // pixels naturally cover the grid where the splat exists.
  _gridColor.value = gridColorForTheme(pc, theme);
  buildGridEntity(pc, app, device);

  // Quality knobs:
  //   alphaClip = 0          — no per-pixel cutoff (default 0.4 punches holes
  //                            through low-alpha splats and lets the bg show).
  //   alphaClipForward 1/255 — tiny forward cutoff just to skip fully-zero pixels.
  //   dataFormat = LARGE     — full-precision splat data, less popcorn than the
  //                            compact path (more VRAM but stable).
  //   minPixelSize/Contrib   — left small (0/0) so dense detail isn't culled.
  //   renderer = WORKBUFFER  — most stable sort path; AUTO sometimes picks a
  //                            faster mode that pops more on quick camera moves.
  try {
    const gs = app.scene && app.scene.gsplat;
    if (gs) {
      gs.alphaClip         = 0;
      gs.alphaClipForward  = 1 / 255;
      gs.lodBehindPenalty  = 3;
      gs.antiAlias         = false;
      if (pc.GSPLATDATA_LARGE         !== undefined) gs.dataFormat = pc.GSPLATDATA_LARGE;
      if (pc.GSPLAT_RENDERER_WORKBUFFER !== undefined) gs.renderer  = pc.GSPLAT_RENDERER_WORKBUFFER;
      else if (pc.GSPLAT_RENDERER_AUTO  !== undefined) gs.renderer  = pc.GSPLAT_RENDERER_AUTO;
    }
  } catch (_) {}

  // Resize observer mirrors the three.js setup so the canvas tracks #viewer.
  const ro = new ResizeObserver(() => app.resizeCanvas());
  ro.observe(canvas);
  app.on('destroy', () => ro.disconnect());

  // Force a layout/reflow read so canvas.clientWidth/Height reflect the
  // post-CSS-swap size before PC initializes its render targets. Without
  // this, the canvas can read as 0×0 on the first frame (display:none →
  // display:block happens just before this call in the asset viewer).
  void canvas.getBoundingClientRect();

  // Start the render loop BEFORE loading the asset — the gsplat component
  // builds its internal instance lazily on the first frame after the asset
  // is attached, so it has to actually tick for that to happen. Previously
  // we called start() at the end; entity.gsplat.instance stayed null and
  // nothing rendered (the bbox read returned undefined too).
  app.start();
  app.resizeCanvas();

  if (els.sub)  els.sub.textContent  = lang === 'pt' ? 'Baixando splat…' : 'Downloading splat…';
  if (els.fill) els.fill.style.width = '30%';

  // Load the splat via the standard Asset → load → wait pattern. The
  // GSplatHandler dispatches PLY vs SOG vs SPLAT by FILENAME, not URL —
  // since our GCS URLs are <hash>.<ext>, extract the filename from the URL
  // path (or use the caller-supplied name if it carries the extension).
  //   - .ply (incl. compressed PLY 2.x) → ply parser
  //   - .sog                            → sog parser
  //   - .splat / .ksplat                → respective parsers
  const urlTail   = String(url).split('?')[0].split('#')[0].split('/').pop() || '';
  const hasExt    = /\.(ply|sog|splat|ksplat)$/i;
  const filename  = hasExt.test(name) ? name : (hasExt.test(urlTail) ? urlTail : `${name}.ply`);
  const splatAsset = new pc.Asset(filename, 'gsplat', { url, filename });
  app.assets.add(splatAsset);
  await new Promise((resolve, reject) => {
    splatAsset.once('load', resolve);
    splatAsset.once('error', err => reject(new Error(typeof err === 'string' ? err : (err && err.message) || 'load failed')));
    app.assets.load(splatAsset);
  });

  // Splat entity + transform
  const entity = new pc.Entity('splat');
  entity.addComponent('gsplat', { asset: splatAsset });
  if (modelRotation) {
    const RAD2DEG = 180 / Math.PI;
    entity.setLocalEulerAngles(
      (modelRotation.x || 0) * RAD2DEG,
      (modelRotation.y || 0) * RAD2DEG,
      (modelRotation.z || 0) * RAD2DEG,
    );
  }
  if (modelOffset) {
    entity.setLocalPosition(modelOffset.x || 0, modelOffset.y || 0, modelOffset.z || 0);
  }
  if (typeof modelScale === 'number' && isFinite(modelScale) && modelScale > 0) {
    entity.setLocalScale(modelScale, modelScale, modelScale);
  }
  app.root.addChild(entity);

  // Wait one frame so the gsplat component constructs its instance, then
  // read `customAabb` — that's the public API the PC viewer example uses
  // (instance.meshInstance is internal and may be undefined here).
  await new Promise(resolve => requestAnimationFrame(resolve));

  let pivot = new pc.Vec3(0, 0, 0);
  let dist  = 8;
  const aabb = entity.gsplat && entity.gsplat.customAabb;
  if (aabb) {
    pivot = aabb.center.clone();
    dist  = Math.max(aabb.halfExtents.length() * 2, 4);
  } else {
    console.warn('[splat-pc] customAabb missing one frame after addComponent — using default camera framing');
  }
  camera.setPosition(pivot.x + dist * 0.6, pivot.y + dist * 0.4, pivot.z + dist * 0.7);
  camera.lookAt(pivot.x, pivot.y, pivot.z);

  const detachOrbit = attachOrbit(canvas, camera, pivot, dist, pc);
  app.on('destroy', detachOrbit);

  if (els.overlay) els.overlay.classList.add('hidden');
  if (els.vinfo)   els.vinfo.textContent = 'splat (pc)';

  _pcApp    = app;
  _pcCanvas = canvas;
  _pcCamera = camera;
  _pcEntity = entity;

  // Debug handle — mirrors the three.js scene's window.__splatInternals so
  // future bug reports have a consistent inspection point.
  try { window.__pcSplat = { app, entity, camera, asset: splatAsset }; } catch (_) {}

  return { app, entity, camera };
}

// Build a 60×60 grid as a real entity on the World layer. Renders BEFORE the
// splat (which lives in the Splat/Immediate layer) so the splat's alpha-blended
// pixels naturally cover the grid where the splat exists. Color follows the
// theme via the _gridColor ref — we sync material.color in an update tick.
function buildGridEntity(pc, app, device) {
  const HALF = 30;
  const positions = [];
  for (let i = -HALF; i <= HALF; i++) {
    // Lines parallel to Z axis (vary X)
    positions.push(i, 0, -HALF, i, 0, HALF);
    // Lines parallel to X axis (vary Z)
    positions.push(-HALF, 0, i, HALF, 0, i);
  }
  const indices = [];
  for (let i = 0; i < positions.length / 3; i++) indices.push(i);

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setIndices(indices);
  mesh.update(pc.PRIMITIVE_LINES);

  // pc.BasicMaterial was removed in PC 2.x. StandardMaterial with diffuse=0
  // and emissive=color renders unlit colored lines (no lights in our scene,
  // so the diffuse contribution stays black and emissive is the final color).
  const material = new pc.StandardMaterial();
  const color    = _gridColor.value || new pc.Color(0.16, 0.16, 0.16, 1);
  material.diffuse.set(0, 0, 0);
  material.emissive.copy(color);
  material.useLighting = false;
  material.update();

  const node     = new pc.GraphNode();
  const meshInst = new pc.MeshInstance(mesh, material, node);

  const gridEntity = new pc.Entity('grid');
  gridEntity.addComponent('render', { meshInstances: [meshInst] });
  app.root.addChild(gridEntity);

  // Theme change updates the ref; sync emissive from it each frame.
  const sync = () => {
    if (_gridColor.value && !material.emissive.equals(_gridColor.value)) {
      material.emissive.copy(_gridColor.value);
      material.update();
    }
  };
  app.on('update', sync);
  app.on('destroy', () => app.off('update', sync));
}

// Minimal orbit camera — left-drag rotates, right-drag pans, wheel zooms.
// Returns a teardown function. We roll our own (rather than pulling
// @playcanvas/scripts) to keep the dependency footprint to just the engine.
// State (pivot/yaw/pitch/distance) lives in the shared _orbitState ref so
// setSplatTopView/Free can reposition the camera without touching this closure.
function attachOrbit(canvas, camera, initialPivot, initialDist, pc) {
  _orbitState.pivot = new pc.Vec3().copy(initialPivot);
  _orbitState.distance = initialDist;
  _orbitState.yaw   = 0;
  _orbitState.pitch = -20;
  const pivot = _orbitState.pivot;
  let mode  = 0;    // 0=idle, 1=orbit, 2=pan
  let lastX = 0, lastY = 0;

  // Seed yaw/pitch/distance from the initial camera position so the first
  // user interaction doesn't snap.
  const initialPos = camera.getPosition();
  const sx = initialPos.x - pivot.x, sy = initialPos.y - pivot.y, sz = initialPos.z - pivot.z;
  _orbitState.distance = Math.sqrt(sx * sx + sy * sy + sz * sz) || initialDist;
  _orbitState.pitch    = Math.asin(sy / _orbitState.distance) * 180 / Math.PI;
  _orbitState.yaw      = Math.atan2(sx, sz)                   * 180 / Math.PI;

  const update = () => {
    const yawR   = _orbitState.yaw   * Math.PI / 180;
    const pitchR = _orbitState.pitch * Math.PI / 180;
    const cp = Math.cos(pitchR), sp = Math.sin(pitchR);
    const cy = Math.cos(yawR),   sy = Math.sin(yawR);
    camera.setPosition(
      pivot.x + _orbitState.distance * cp * sy,
      pivot.y + _orbitState.distance * sp,
      pivot.z + _orbitState.distance * cp * cy,
    );
    camera.lookAt(pivot.x, pivot.y, pivot.z);
  };
  _orbitState.update = update;

  const onDown = e => {
    if (e.button === 2) mode = 2;
    else if (e.button === 0) mode = 1;
    else return;
    lastX = e.clientX; lastY = e.clientY;
    e.preventDefault();
  };
  const onMove = e => {
    if (!mode) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (mode === 1 && _pcView !== 'top') {
      _orbitState.yaw   -= dx * 0.4;
      _orbitState.pitch  = Math.max(-89, Math.min(89, _orbitState.pitch - dy * 0.4));
    } else if (mode === 2 || (mode === 1 && _pcView === 'top')) {
      // Pan in camera-local axes so the pivot tracks the cursor direction.
      const right = camera.right;
      const up    = camera.up;
      const speed = (_pcView === 'top' ? camera.camera.orthoHeight * 0.003 : _orbitState.distance * 0.0015);
      pivot.x += -dx * speed * right.x + dy * speed * up.x;
      pivot.y += -dx * speed * right.y + dy * speed * up.y;
      pivot.z += -dx * speed * right.z + dy * speed * up.z;
    }
    if (_pcView === 'top') {
      // Pan only moves the pivot; keep camera looking straight down.
      camera.setPosition(pivot.x, 100, pivot.z);
      camera.lookAt(pivot.x, 0, pivot.z);
    } else {
      update();
    }
  };
  const onUp = () => { mode = 0; };
  const onWheel = e => {
    e.preventDefault();
    if (_pcView === 'top') {
      camera.camera.orthoHeight = Math.max(0.5, Math.min(500, camera.camera.orthoHeight * (1 + e.deltaY * 0.001)));
    } else {
      _orbitState.distance *= 1 + e.deltaY * 0.001;
      _orbitState.distance = Math.max(0.1, Math.min(1000, _orbitState.distance));
      update();
    }
  };
  const onCtx = e => e.preventDefault();

  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onUp);
  canvas.addEventListener('wheel',     onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onCtx);

  update();

  return () => {
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup',   onUp);
    canvas.removeEventListener('wheel',     onWheel);
    canvas.removeEventListener('contextmenu', onCtx);
  };
}
