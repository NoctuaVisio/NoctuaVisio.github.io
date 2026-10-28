// Shrinks a GLB without needing a new decoder in the browser.
//
// The landing hero was a 55 MB file: 1.8M triangles, 1.1M vertices, and a
// TEXCOORD_0 on every primitive although none of the four materials carries a
// texture. A first-time visitor downloaded all of it before the hero appeared.
//
// Deliberately NOT Draco or meshopt compression: both would need a decoder
// registered on all five GLTFLoader call sites, and a model that fails to
// decode is a blank hero. Everything used here is either plain glTF or
// KHR_mesh_quantization, which three.js reads natively.
//
// Produces two files so the quality call is made on real numbers:
//   .clean.glb  — prune + weld + quantize. Same shape, smaller encoding.
//   .light.glb  — the above plus decimation to RATIO of the triangles.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, quantize, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { statSync } from 'node:fs';

const [, , inPath, cleanPath, lightPath, ratioArg] = process.argv;
const RATIO = Number(ratioArg || 0.25);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const mb = (p) => (statSync(p).size / 1048576).toFixed(2) + ' MB';

function count(doc) {
  let tris = 0, verts = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += idx ? idx.getCount() / 3 : 0;
      verts += pos ? pos.getCount() : 0;
    }
  }
  return { tris: Math.round(tris), verts };
}

await MeshoptSimplifier.ready;

const src = await io.read(inPath);
const before = count(src);
console.log('input      ', mb(inPath), before.tris.toLocaleString(), 'tris',
            before.verts.toLocaleString(), 'verts');

// prune with keepAttributes:false is what drops the unused UVs: it walks the
// materials and removes vertex attributes nothing reads.
await src.transform(
  prune({ keepAttributes: false, keepIndices: false }),
  dedup(),
  weld(),
);

// Written out before quantize so the light variant can be simplified from the
// same welded document rather than from quantized integers.
const cleanDoc = await io.read(inPath);
await cleanDoc.transform(
  prune({ keepAttributes: false, keepIndices: false }),
  dedup(),
  weld(),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeColor: 8, quantizeTexcoord: 12 }),
);
await io.write(cleanPath, cleanDoc);
console.log('clean      ', mb(cleanPath), JSON.stringify(count(cleanDoc)));

await src.transform(
  simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: 0.0015 }),
  prune({ keepAttributes: false, keepIndices: false }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeColor: 8, quantizeTexcoord: 12 }),
);
await io.write(lightPath, src);
const after = count(src);
console.log('light      ', mb(lightPath), after.tris.toLocaleString(), 'tris',
            after.verts.toLocaleString(), 'verts',
            '(ratio ' + RATIO + ')');
