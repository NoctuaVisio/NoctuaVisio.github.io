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
  _picker = null; _pickerW = 0; _pickerH = 0;
  _markers.length = 0;
  for (const k of Object.keys(_markerMats)) delete _markerMats[k];
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

// Project each marker's entity-local position to screen pixels via the active
// camera, returning { id, x, y, visible } per point. Editor calls this every
// frame and shoves the values into the HTML marker overlay so the same
// styled DOM nodes serve splat and GLB markers identically.
//
// `visible` is false when the point is behind the camera near plane (negative
// z in NDC). Screen coords are in CSS pixels relative to #pcCanvas's box.
export function getSplatMarkerScreens(points) {
  if (!_pcApp || !_pcCamera || !_pcLib || !_pcEntity || !_pcCanvas || !Array.isArray(points)) return [];
  const pc = _pcLib;
  const wt = _pcEntity.getWorldTransform();
  const local  = new pc.Vec3();
  const world  = new pc.Vec3();
  const screen = new pc.Vec3();
  const rect = _pcCanvas.getBoundingClientRect();
  const out = [];
  // PC's worldToScreen leaves screen.z as raw clip-space z (NOT divided by w),
  // so it's not a reliable "in front of camera" signal — especially in ortho.
  // Instead we cull via: (a) view-space depth from the manual view matrix
  // (positive = in front of camera for both projection types), (b) finite
  // screen pixels. Lets the overlay sit correctly in Top splat view, which
  // was the bug: ortho frame produced negative clip-z and my old check
  // dropped every marker.
  const viewMat = _pcCamera.camera._camera ? _pcCamera.camera._camera.viewMatrix : null;
  const viewSpace = new pc.Vec3();
  for (const pt of points) {
    if (!pt || !pt.position) { out.push({ id: pt && pt.id, visible: false }); continue; }
    local.set(pt.position.x || 0, pt.position.y || 0, pt.position.z || 0);
    wt.transformPoint(local, world);
    _pcCamera.camera.worldToScreen(world, screen);
    let inFront = true;
    if (viewMat) {
      viewMat.transformPoint(world, viewSpace);
      // PC's camera looks down -Z in view space, so points in front have
      // viewSpace.z negative. (+ generous near margin to avoid edge popping.)
      inFront = viewSpace.z < 0;
    }
    const visible = inFront && isFinite(screen.x) && isFinite(screen.y);
    // depth: positive distance from camera (smaller = closer). Camera looks
    // down -Z in view space so -viewSpace.z gives a stable monotonic value
    // for both perspective and ortho. Overlay uses it to z-order markers so
    // the nearer one paints over the farther one.
    const depth = viewMat ? -viewSpace.z : 0;
    out.push({
      id: pt.id,
      x: screen.x,
      y: screen.y,
      visible,
      depth,
    });
  }
  return out;
}

// Pick a 3D world point from canvas coordinates, then invert the splat
// entity's world transform to return it in entity-local space — that's the
// coord system inspection JSONs persist points in, so callers can push the
// returned vec straight into POINTS[].position.
// Returns { x, y, z } or null when the click missed the splat.
//
// Implementation notes (matched against PC's official picking.example.mjs):
//   - Picker constructed with depth=true so getWorldPointAsync works
//   - app.scene.gsplat.enableIds = true is set in loadSplatPC (required)
//   - We render at 0.25x scale for speed (still pixel-accurate for our markers)
//   - prepare() takes the World layer explicitly; default is okay but layers
//     param keeps perf in check on bigger scenes
export async function pickSplatLocalPoint(clientX, clientY) {
  if (!_pcApp || !_pcCamera || !_pcLib || !_pcEntity) return null;
  const pc = _pcLib;
  const canvas = _pcCanvas;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const PICK_SCALE = 0.25;
  const targetW = Math.max(1, Math.round(rect.width  * PICK_SCALE));
  const targetH = Math.max(1, Math.round(rect.height * PICK_SCALE));
  if (!_picker) _picker = new pc.Picker(_pcApp, targetW, targetH, true);
  if (_pickerW !== targetW || _pickerH !== targetH) {
    _picker.resize(targetW, targetH);
    _pickerW = targetW; _pickerH = targetH;
  }
  const worldLayer = _pcApp.scene.layers.getLayerByName('World');
  _picker.prepare(_pcCamera.camera, _pcApp.scene, worldLayer ? [worldLayer] : undefined);
  const wp = await _picker.getWorldPointAsync(x * PICK_SCALE, y * PICK_SCALE);
  if (!wp) return null;
  // World → local: apply the inverse world matrix to the picked point.
  const inv = _pcEntity.getWorldTransform().clone().invert();
  const local = new pc.Vec3();
  inv.transformPoint(wp, local);
  return { x: local.x, y: local.y, z: local.z };
}

// Legacy: used to create 3D sphere entities in the PC scene for each marker.
// Now the editor renders markers via an HTML overlay (positioned per frame
// via getSplatMarkerScreens) so we get the score number + halo + glow that
// the user expects from the GLB visual. Keeping this function as a no-op
// teardown so old callers don't break if they still pass in a points list.
export function setSplatMarkers(/* points */) {
  if (!_pcApp || !_pcLib || !_pcEntity) return;
  // Defensive teardown — older versions of this fn created sphere entities.
  for (const m of _markers) m.destroy();
  _markers.length = 0;
}

// Picker is created lazily on first pick to avoid allocating an FBO before
// the user actually clicks. Marker mats are cached per-severity so swapping
// points doesn't churn the material list.
let _picker  = null;
let _pickerW = 0;
let _pickerH = 0;
const _markers     = [];
const _markerMats  = {};

export function getPcView() { return _pcView; }

// Splat world-AABB for callers outside this module (e.g. imggen's bbox-based
// provisional positions). Returns { min: {x,y,z}, max: {x,y,z} } when a splat
// is loaded, null otherwise. Plain object — no PlayCanvas types — so it works
// without importing the PC lib on the consumer side.
export function getSplatWorldBox() {
  if (!_pcLib) return null;
  const wb = computeSplatWorldAabb(_pcLib);
  if (!wb) return null;
  const c = wb.center, h = wb.halfExtents;
  return {
    min: { x: c.x - h.x, y: c.y - h.y, z: c.z - h.z },
    max: { x: c.x + h.x, y: c.y + h.y, z: c.z + h.z },
  };
}

// Project a WORLD point to canvas-relative screen pixels. Used by the ortho
// alignment overlay so a flat rectangle in world coords can be rendered as a
// CSS-positioned <img> on top of the splat — there's no THREE.Mesh to
// project, since the three.js canvas is hidden in splat mode.
// Returns { x, y, visible } or null when no splat is loaded.
export function worldToScreenSplat(wx, wy, wz) {
  if (!_pcApp || !_pcCamera || !_pcLib || !_pcCanvas) return null;
  const pc = _pcLib;
  const world  = new pc.Vec3(wx, wy, wz);
  const screen = new pc.Vec3();
  _pcCamera.camera.worldToScreen(world, screen);
  // Same in-front-of-camera check as getSplatMarkerScreens (view-space z<0
  // for both perspective and ortho, since PC cameras look down -Z).
  const viewMat = _pcCamera.camera._camera ? _pcCamera.camera._camera.viewMatrix : null;
  let visible = isFinite(screen.x) && isFinite(screen.y);
  if (viewMat) {
    const vs = new pc.Vec3();
    viewMat.transformPoint(world, vs);
    visible = visible && vs.z < 0;
  }
  return { x: screen.x, y: screen.y, visible };
}

// Pick a WORLD point from canvas coordinates. Like pickSplatLocalPoint but
// returns world coords directly (no inverse-world transform). Imggen needs
// this for ortho alignment pivots and for "raycast Y" replacement on splats.
// Returns { x, y, z } or null when the click missed the splat.
export async function pickSplatWorldPoint(clientX, clientY) {
  if (!_pcApp || !_pcCamera || !_pcLib || !_pcEntity) return null;
  const pc = _pcLib;
  const canvas = _pcCanvas;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const PICK_SCALE = 0.25;
  const targetW = Math.max(1, Math.round(rect.width  * PICK_SCALE));
  const targetH = Math.max(1, Math.round(rect.height * PICK_SCALE));
  if (!_picker) _picker = new pc.Picker(_pcApp, targetW, targetH, true);
  if (_pickerW !== targetW || _pickerH !== targetH) {
    _picker.resize(targetW, targetH);
    _pickerW = targetW; _pickerH = targetH;
  }
  const worldLayer = _pcApp.scene.layers.getLayerByName('World');
  _picker.prepare(_pcCamera.camera, _pcApp.scene, worldLayer ? [worldLayer] : undefined);
  const wp = await _picker.getWorldPointAsync(x * PICK_SCALE, y * PICK_SCALE);
  if (!wp) return null;
  return { x: wp.x, y: wp.y, z: wp.z };
}

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
  // lookAt straight down is degenerate (the default up vector +Y is parallel
  // to the view direction). Pass an explicit up = -Z so worldToScreen and the
  // gsplat shader get a well-defined camera frame; otherwise markers project
  // to NaN and you see an empty overlay in Top view.
  _pcCamera.lookAt(cx, cy, cz, 0, 0, -1);
  _pcView = 'top';
  return true;
}
// Single source of truth for "default free view" camera placement. Used by
// both loadSplatPC (initial framing) AND setSplatFreeView (re-frame on Top→
// Free) so pressing Free always returns you to exactly where the model
// loaded — no jump in distance or angle.
//
// PITCH 30° → camera comfortably above pivot, looking down. (The previous
// 23° + low offset put the camera so close to the pivot that tall models
// like the forklift extended above the camera, making it feel like you were
// looking up from below.) YAW 35° → standard 3/4 isometric.
// DIST 0.9 × bbox diagonal, min 3 — tight framing without near-plane clip.
const FREE_PITCH_DEG = 30;
const FREE_YAW_DEG   = 35;

function splatFreeViewParams(pc) {
  const wb = computeSplatWorldAabb(pc);
  if (!wb) return null;
  const he = wb.halfExtents;
  const diag = Math.sqrt(he.x * he.x + he.y * he.y + he.z * he.z) * 2;
  return {
    pivot: wb.center,
    dist:  Math.max(3, diag * 0.9),
    pitch: FREE_PITCH_DEG,
    yaw:   FREE_YAW_DEG,
  };
}

// Apply free-view params to the orbit camera. Shared by loadSplatPC and
// setSplatFreeView — both paths land the camera at the EXACT same world
// position so the user never sees a jump between "just loaded" and "I pressed
// Free view".
function applyFreeViewToCamera(pc, params) {
  const { pivot, dist, pitch, yaw } = params;
  const pitchR = pitch * Math.PI / 180;
  const yawR   = yaw   * Math.PI / 180;
  const cp = Math.cos(pitchR), sp = Math.sin(pitchR);
  const cy = Math.cos(yawR),   sy = Math.sin(yawR);
  _pcCamera.setPosition(
    pivot.x + dist * cp * sy,
    pivot.y + dist * sp,
    pivot.z + dist * cp * cy,
  );
  _pcCamera.lookAt(pivot.x, pivot.y, pivot.z);
}

export function setSplatFreeView() {
  if (!_pcApp || !_pcCamera || !_pcLib) return false;
  const pc = _pcLib;
  _pcCamera.camera.projection = pc.PROJECTION_PERSPECTIVE;
  _pcView = 'free';
  const params = splatFreeViewParams(pc);
  if (params) {
    _orbitState.pivot.copy(params.pivot);
    _orbitState.distance = params.dist;
    _orbitState.pitch    = params.pitch;
    _orbitState.yaw      = params.yaw;
    if (_orbitState.update) _orbitState.update();
  }
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
      // enableIds + Picker(..., true) is what makes getWorldPointAsync return
      // a Vec3 instead of null when the user clicks on a splat (PC encodes a
      // per-splat ID into the pick render target's color channel).
      gs.enableIds         = true;
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

  // Publish module refs BEFORE polling — computeSplatWorldAabb reads
  // _pcEntity and splatFreeViewParams reads it transitively. Without this,
  // the loop would spin against null forever and fall to the fallback
  // (camera at origin), which is exactly the "lá longe" / "dot in space"
  // bug the forklift hit.
  _pcApp    = app;
  _pcCanvas = canvas;
  _pcCamera = camera;
  _pcEntity = entity;

  // Wait for customAabb to populate before framing. Big splats can take
  // dozens of frames; using a fallback (origin + arbitrary distance) makes
  // the initial framing diverge from what Free button computes later, which
  // the user sees as a jump on first Free click. Hard guarantee: initial
  // camera == press Free, every time, no exceptions.
  let params = null;
  for (let i = 0; i < 300 && !params; i++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    params = splatFreeViewParams(pc);
  }
  if (!params) {
    console.warn('[splat-pc] customAabb never populated after 5s — falling back to origin framing');
    params = { pivot: new pc.Vec3(0, 0, 0), dist: 8, pitch: FREE_PITCH_DEG, yaw: FREE_YAW_DEG };
  }
  // Apply free-view params to the camera. attachOrbit (next) reads the
  // current camera position to seed _orbitState.pitch/yaw/distance, so the
  // orbit state starts in sync with what setSplatFreeView would set.
  applyFreeViewToCamera(pc, params);

  const detachOrbit = attachOrbit(canvas, camera, params.pivot, params.dist, pc);
  app.on('destroy', detachOrbit);

  if (els.overlay) els.overlay.classList.add('hidden');
  if (els.vinfo)   els.vinfo.textContent = 'splat (pc)';

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
      _orbitState.pitch  = Math.max(-89, Math.min(89, _orbitState.pitch + dy * 0.4));
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
      // Up = -Z so lookAt isn't degenerate when view direction == world up.
      camera.setPosition(pivot.x, 100, pivot.z);
      camera.lookAt(pivot.x, 0, pivot.z, 0, 0, -1);
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

  // Touch input — mobile browsers don't synthesize mousemove during drag, so
  // without these handlers the splat is unrotatable on phones/tablets. One
  // finger = orbit (or pan in Top view), two fingers = pan + pinch-to-zoom.
  // touch-action: none on #pcCanvas (set in the host page CSS) keeps the
  // browser from hijacking the gesture for page scroll/zoom.
  let pinchDist = 0;
  const pinchDistance = ts => Math.hypot(ts[1].clientX - ts[0].clientX, ts[1].clientY - ts[0].clientY);
  const onTouchStart = e => {
    if (e.touches.length === 1) {
      mode = 1;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    } else if (e.touches.length >= 2) {
      mode = 2;
      lastX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pinchDist = pinchDistance(e.touches);
    } else {
      return;
    }
    e.preventDefault();
  };
  const onTouchMove = e => {
    if (!mode) return;
    if (mode === 1 && e.touches.length === 1) {
      const dx = e.touches[0].clientX - lastX, dy = e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      if (_pcView !== 'top') {
        _orbitState.yaw   -= dx * 0.4;
        _orbitState.pitch  = Math.max(-89, Math.min(89, _orbitState.pitch + dy * 0.4));
        update();
      } else {
        const right = camera.right, up = camera.up;
        const speed = camera.camera.orthoHeight * 0.003;
        pivot.x += -dx * speed * right.x + dy * speed * up.x;
        pivot.y += -dx * speed * right.y + dy * speed * up.y;
        pivot.z += -dx * speed * right.z + dy * speed * up.z;
        camera.setPosition(pivot.x, 100, pivot.z);
        camera.lookAt(pivot.x, 0, pivot.z, 0, 0, -1);
      }
    } else if (mode === 2 && e.touches.length >= 2) {
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dx = mx - lastX, dy = my - lastY;
      lastX = mx; lastY = my;
      const newDist = pinchDistance(e.touches);
      if (pinchDist > 0 && newDist > 0) {
        const ratio = pinchDist / newDist;
        if (_pcView === 'top') {
          camera.camera.orthoHeight = Math.max(0.5, Math.min(500, camera.camera.orthoHeight * ratio));
        } else {
          _orbitState.distance = Math.max(0.1, Math.min(1000, _orbitState.distance * ratio));
        }
      }
      pinchDist = newDist;
      const right = camera.right, up = camera.up;
      const speed = (_pcView === 'top' ? camera.camera.orthoHeight * 0.003 : _orbitState.distance * 0.0015);
      pivot.x += -dx * speed * right.x + dy * speed * up.x;
      pivot.y += -dx * speed * right.y + dy * speed * up.y;
      pivot.z += -dx * speed * right.z + dy * speed * up.z;
      if (_pcView === 'top') {
        camera.setPosition(pivot.x, 100, pivot.z);
        camera.lookAt(pivot.x, 0, pivot.z, 0, 0, -1);
      } else {
        update();
      }
    }
    e.preventDefault();
  };
  const onTouchEnd = e => {
    if (e.touches.length === 0) {
      mode = 0;
      pinchDist = 0;
    } else if (e.touches.length === 1) {
      mode = 1;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      pinchDist = 0;
    }
  };

  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onUp);
  canvas.addEventListener('wheel',     onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onCtx);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
  canvas.addEventListener('touchend',   onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchEnd);

  update();

  return () => {
    canvas.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup',   onUp);
    canvas.removeEventListener('wheel',     onWheel);
    canvas.removeEventListener('contextmenu', onCtx);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove',  onTouchMove);
    canvas.removeEventListener('touchend',   onTouchEnd);
    canvas.removeEventListener('touchcancel', onTouchEnd);
  };
}
