// Minimal GLB (binary glTF 2.0) reader for the handwritten model viewer
// (spec 023). three.js ran fine on web but its uniform/active-info
// diagnostics hit flutter_angle gaps on the iOS simulator, so the demo
// model is served by this instead — it needs a deliberately small slice of
// the format:
//
//   * the mesh's POSITION / NORMAL accessors and the index accessor
//   * each primitive's baseColorFactor as a flat material color
//   * joints/weights are IGNORED on purpose: without a skeleton applied an
//     accessor's raw positions ARE the bind pose (Xbot renders as a T-pose),
//     which is exactly what a static viewer wants
//
// Only tightly packed buffer views are handled; anything interleaved is
// rejected loudly (constitution V) rather than read as garbage.
export interface GlbPrimitive {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** baseColorFactor rgb, linear space as stored. */
  color: [number, number, number];
}

export interface GlbModel {
  primitives: GlbPrimitive[];
  /** Union of every POSITION accessor's min/max — the viewer centers on it. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

export function parseGlb(bytes: Uint8Array): GlbModel {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('not a GLB file (bad magic)');
  }
  // header is 12 bytes; then 8-byte chunk headers
  let p = 12;
  let json: any = null;
  let bin: Uint8Array | null = null;
  while (p < bytes.byteLength) {
    const len = view.getUint32(p, true);
    const type = view.getUint32(p + 4, true);
    p += 8;
    const chunk = bytes.subarray(p, p + len);
    p += len;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(chunk));
    } else if (type === CHUNK_BIN) {
      bin = chunk;
    }
  }
  if (!json || !bin) {
    throw new Error('GLB is missing its JSON or BIN chunk');
  }
  // accessor byteOffsets are relative to the BIN chunk — reading them
  // through a view over the whole FILE lands tens of thousands of bytes
  // early, i.e. in garbage (the 0x502 this viewer shipped with)
  const binView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  const readAccessor = (index: number): Float32Array | Uint32Array => {
    const acc = json.accessors[index];
    const comps = COMPONENTS[acc.type];
    if (!comps) {
      throw new Error(`accessor ${index}: unsupported type ${acc.type}`);
    }
    const dv = acc.bufferView ?? 0;
    const bv = json.bufferViews[dv];
    if (bv.byteStride && bv.byteStride !== comps * componentSize(acc.componentType)) {
      throw new Error(
        `accessor ${index}: interleaved buffer views are not supported ` +
          `(byteStride ${bv.byteStride})`,
      );
    }
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const count = acc.count * comps;
    switch (acc.componentType) {
      case 5126: { // FLOAT
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          out[i] = binView.getFloat32(base + i * 4, true);
        }
        return out;
      }
      case 5123: { // UNSIGNED_SHORT
        const out = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
          out[i] = binView.getUint16(base + i * 2, true);
        }
        return out;
      }
      case 5125: { // UNSIGNED_INT
        const out = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
          out[i] = binView.getUint32(base + i * 4, true);
        }
        return out;
      }
      default:
        throw new Error(
          `accessor ${index}: unsupported componentType ${acc.componentType}`,
        );
    }
  };

  const colorOf = (materialIndex: number | undefined): [number, number, number] => {
    const mat = materialIndex === undefined ? undefined : json.materials?.[materialIndex];
    const rgb = mat?.pbrMetallicRoughness?.baseColorFactor;
    if (!rgb) return [0.8, 0.8, 0.8];
    return [rgb[0], rgb[1], rgb[2]];
  };

  const primitives: GlbPrimitive[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.mode !== undefined && prim.mode !== 4) {
        // 4 = TRIANGLES; lines/points/strips are out of scope for the viewer
        throw new Error(`primitive mode ${prim.mode} is not TRIANGLES`);
      }
      const positions = readAccessor(prim.attributes.POSITION) as Float32Array;
      const normals = readAccessor(prim.attributes.NORMAL) as Float32Array;
      const indices = readAccessor(prim.indices) as Uint32Array;
      primitives.push({
        positions,
        normals,
        indices,
        color: colorOf(prim.material),
      });
      const posAcc = json.accessors[prim.attributes.POSITION];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], posAcc.min?.[axis] ?? Infinity);
        max[axis] = Math.max(max[axis], posAcc.max?.[axis] ?? -Infinity);
      }
    }
  }

  if (!primitives.length) {
    throw new Error('GLB has no triangle primitives');
  }
  return { primitives, bounds: { min, max } };
}

function componentSize(componentType: number): number {
  switch (componentType) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      throw new Error(`unknown componentType ${componentType}`);
  }
}
