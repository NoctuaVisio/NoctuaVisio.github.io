// TIFF/GeoTIFF decode, off the main thread.
//
// Drone orthos arrive as .tif and <img> can't decode them, so UTIF does it in
// JS. That work is entirely synchronous and proportional to the *source*
// resolution: a 15000×12000 ortho means inflating ~700 MB of Deflate and then
// materialising 720 MB of RGBA. On the main thread that froze the whole admin
// page for minutes — hence this worker. The tab stays interactive and a decode
// that goes wrong kills a worker instead of the editor.
//
// The result is also downscaled here rather than on the caller's side, so the
// full-resolution pixels never cross the postMessage boundary.

// pako MUST be imported before UTIF: UTIF.js resolves `self.pako` at load time
// and closes over it, so it can never pick pako up afterwards, and every
// Deflate-compressed ortho (the default export out of Pix4D/ODM/Agisoft) needs
// pako.inflate. importScripts is synchronous and ordered, which is what we want.
importScripts(
  'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js',
  'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js'
);

function progress(stage, extra) {
  self.postMessage(Object.assign({ ok: true, stage }, extra || {}));
}

self.onmessage = async ev => {
  const { buffer, maxSide } = ev.data || {};
  try {
    if (!buffer) throw new Error('no buffer received');

    progress('decoding');
    const u8   = new Uint8Array(buffer);
    const ifds = UTIF.decode(u8);
    if (!ifds || !ifds.length) throw new Error('TIFF has no IFD');
    const ifd = ifds[0];
    UTIF.decodeImage(u8, ifd);
    const rgba = UTIF.toRGBA8(ifd);

    const w = ifd.width | 0, h = ifd.height | 0;
    if (!w || !h) throw new Error('TIFF reports zero dimensions');

    // UTIF can hand back a buffer with slack past w*h*4, which ImageData
    // rejects with "Length is not a non-zero multiple of 4". Copy into an
    // exactly-sized array.
    const expected = w * h * 4;
    const pixels   = new Uint8ClampedArray(expected);
    pixels.set(rgba.length === expected ? rgba : rgba.subarray(0, expected));

    const k  = Math.min(1, maxSide / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * k));
    const dh = Math.max(1, Math.round(h * k));

    if (k < 1) progress('resizing', { width: dw, height: dh, sourceWidth: w, sourceHeight: h });

    // createImageBitmap resizes without ever allocating a full-resolution
    // canvas — a 15000×12000 one is close to the browser's max canvas area
    // and the context comes back null past it.
    const source = new ImageData(pixels, w, h);
    const bitmap = k < 1
      ? await createImageBitmap(source, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' })
      : await createImageBitmap(source);

    const canvas = new OffscreenCanvas(dw, dh);
    const ctx    = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // SamplesPerPixel (tag 277) says whether there is a real alpha channel.
    // Only those orthos need PNG (masked edges); for plain RGB a PNG encode
    // costs an order of magnitude more time and lands several times larger,
    // all to store an alpha channel that is uniformly opaque.
    const spp  = (ifd.t277 && ifd.t277[0]) || 3;
    const type = spp >= 4 ? 'image/png' : 'image/jpeg';

    progress('encoding', { width: dw, height: dh, sourceWidth: w, sourceHeight: h });
    const blob = await canvas.convertToBlob(
      type === 'image/jpeg' ? { type, quality: 0.92 } : { type });

    self.postMessage({ ok: true, stage: 'done', blob, type,
                       width: dw, height: dh, sourceWidth: w, sourceHeight: h });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) || String(err) });
  }
};
