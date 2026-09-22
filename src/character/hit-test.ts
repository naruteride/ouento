import type { CubismModel } from '@framework/model/cubismmodel';

/** One byte per pixel, in the original decoded image's top-to-bottom row order. */
export type TextureAlpha = { width: number; height: number; alpha: Uint8Array };

/** Interaction policy: very faint antialiasing/shadows do not capture desktop clicks. */
export const HIT_ALPHA_THRESHOLD = 0.05;
const EDGE_EPSILON = 1e-7;

/**
 * CPU hit test in the current Cubism model coordinate system. Geometry must already
 * have been updated for the displayed frame. No persistent geometry cache or GPU read.
 *
 * Combines drawables/offscreen groups in the pinned SDK's render order, using alpha
 * only. Texture/mask raster sampling is an estimate: the CPU texture plane can be
 * downscaled, and GPU mask filtering, RGBA8 rounding and edge coverage differ.
 * Missing or malformed metadata fails through; no GPU readback is performed.
 */
export function hitTestModel(
  model: CubismModel,
  x: number,
  y: number,
  textures: ReadonlyArray<TextureAlpha | undefined>,
): boolean {
  return (sampleModelAlpha(model, x, y, textures) ?? 0) > HIT_ALPHA_THRESHOLD;
}

/** Final alpha at one model-space point; null means that the point cannot be evaluated safely. */
export function sampleModelAlpha(
  model: CubismModel,
  x: number,
  y: number,
  textures: ReadonlyArray<TextureAlpha | undefined>,
): number | null {
  if (!model || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    return compositeAlpha(model, x, y, textures);
  } catch {
    // A stale model or incomplete Core metadata must never intercept desktop input.
    return null;
  }
}

// Web Core 06.00.0001 / Framework 5-r.5 enum values. Keep the SDK import type-only:
// importing CubismModel at runtime would require initializing Core for this pure CPU helper.
const OVER = 0,
  PRESERVE = 1,
  OUT = 2,
  CONJOINT_OVER = 3,
  DISJOINT_OVER = 4;
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;
// Core interpolation can overshoot even for valid official assets (Haru reaches
// 1.0000499). Keep alpha normalized without treating that as corrupt metadata.
const normalizedOpacity = (value: number): number | null =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;

function blendMode(color: number, alpha: number): number | null {
  if (
    !Number.isInteger(color) ||
    color < -1 ||
    color > 17 ||
    !Number.isInteger(alpha) ||
    alpha < -1 ||
    alpha > 4
  )
    return null;
  if (color === -1 || alpha === -1) return OVER;
  // AddCompatible=1 and MultiplyCompatible=2 retain destination alpha (ZERO, ONE).
  if (color === 1 || color === 2) return PRESERVE;
  return alpha;
}

function composite(mode: number, source: number, destination: number): number {
  switch (mode) {
    case PRESERVE:
      return destination; // Atop also has exactly the destination's alpha.
    case OUT:
      return destination * (1 - source);
    case CONJOINT_OVER:
      return Math.max(source, destination);
    case DISJOINT_OVER:
      return Math.min(1, source + destination);
    default:
      return source + destination * (1 - source);
  }
}

/** Resolve nearest offscreen owners once per query, with linear cycle detection. */
function hierarchy(model: CubismModel, count: number) {
  const parts = model.getPartCount();
  const parents = model.getPartParentPartIndices();
  const owners = model.getOffscreenOwnerIndices();
  if (
    !validCount(parts) ||
    !parents ||
    parents.length !== parts ||
    !owners ||
    owners.length !== count
  )
    return null;
  const owned = new Int32Array(parts).fill(-1);
  for (let index = 0; index < count; index++) {
    const owner = owners[index];
    if (!Number.isInteger(owner) || owner < 0 || owner >= parts || owned[owner] !== -1) return null;
    owned[owner] = index;
  }
  for (const parent of parents)
    if (!Number.isInteger(parent) || parent < -1 || parent >= parts) return null;
  const nearest = new Int32Array(parts).fill(-1);
  const state = new Uint8Array(parts);
  for (let part = 0; part < parts; part++) {
    if (state[part] === 2) continue;
    const chain: number[] = [];
    let cursor = part;
    while (cursor !== -1 && state[cursor] !== 2) {
      if (state[cursor] === 1) return null;
      state[cursor] = 1;
      chain.push(cursor);
      cursor = parents[cursor];
    }
    while (chain.length) {
      const current = chain.pop()!;
      nearest[current] =
        owned[current] !== -1
          ? owned[current]
          : parents[current] === -1
            ? -1
            : nearest[parents[current]];
      state[current] = 2;
    }
  }
  const offscreenParents = Array.from(owners, (owner) =>
    parents[owner] === -1 ? -1 : nearest[parents[owner]],
  );
  return { parts, nearest, offscreenParents };
}

function compositeAlpha(
  model: CubismModel,
  x: number,
  y: number,
  textures: ReadonlyArray<TextureAlpha | undefined>,
): number | null {
  const count = model.getDrawableCount();
  const offscreenCount = model.getOffscreenCount();
  const modern = model.isBlendModeEnabled();
  if (
    !validCount(count) ||
    !validCount(offscreenCount) ||
    typeof modern !== 'boolean' ||
    (offscreenCount && !modern)
  )
    return null;
  const total = count + offscreenCount;
  const orders = model.getRenderOrders();
  if (!validCount(total) || !orders || orders.length !== total) return null;
  const sorted = new Int32Array(total).fill(-1);
  for (let index = 0; index < total; index++) {
    const order = orders[index];
    if (!Number.isInteger(order) || order < 0 || order >= total || sorted[order] !== -1)
      return null;
    sorted[order] = index;
  }
  const tree = offscreenCount ? hierarchy(model, offscreenCount) : null;
  if (offscreenCount && !tree) return null;
  const masks = model.getDrawableMasks();
  const maskCounts = model.getDrawableMaskCounts();
  const offscreenMasks = offscreenCount ? model.getOffscreenMasks() : [];
  const offscreenMaskCounts = offscreenCount ? model.getOffscreenMaskCounts() : [];
  if (
    !masks ||
    masks.length !== count ||
    !maskCounts ||
    maskCounts.length !== count ||
    !offscreenMasks ||
    offscreenMasks.length !== offscreenCount ||
    !offscreenMaskCounts ||
    offscreenMaskCounts.length !== offscreenCount
  )
    return null;
  // A mask drawable is often shared by several clipped drawables. Cache only for
  // this point/frame, since both vertices and UVs may change on the next update.
  const samples = new Map<number, number | null>();
  const sample = (index: number): number | null => {
    if (!Number.isInteger(index) || index < 0 || index >= count) return null;
    if (samples.has(index)) return samples.get(index)!;
    const alpha = drawableAlpha(model, index, x, y, textures);
    samples.set(index, alpha);
    return alpha;
  };

  const maskAlpha = (index: number, offscreen: boolean): number | null => {
    const maskCount = (offscreen ? offscreenMaskCounts : maskCounts)[index];
    const inverted = offscreen
      ? model.getOffscreenInvertedMask(index)
      : model.getDrawableInvertedMaskBit(index);
    if (!validCount(maskCount) || typeof inverted !== 'boolean') return null;
    if (maskCount > 0) {
      const sources = (offscreen ? offscreenMasks : masks)[index];
      if (!sources || sources.length !== maskCount) return null;
      let remaining = 1;
      for (let mask = 0; mask < maskCount; mask += 1) {
        const maskAlpha = sample(sources[mask]);
        if (maskAlpha === null) return null;
        // SDK setup-mask blending starts at white and multiplies by (1-alpha).
        // Its shader ignores the source's display opacity, visibility and masks.
        remaining *= 1 - maskAlpha;
      }
      return inverted ? remaining : 1 - remaining;
    }
    return 1;
  };
  // Slot zero is the root target; offscreen i uses i+1. Offscreen order entries open
  // transparent groups, and leaving a part's descendants submits that group to its parent.
  const targets = new Float64Array(offscreenCount + 1);
  let current = -1;
  const flushTo = (target: number): boolean => {
    while (current !== target) {
      if (current === -1 || !tree) return false; // The required group has not opened.
      const index = current;
      const parent = tree.offscreenParents[index];
      const opacity = normalizedOpacity(model.getOffscreenOpacity(index));
      const clipping = maskAlpha(index, true);
      const mode = blendMode(
        model.getOffscreenColorBlend(index),
        model.getOffscreenAlphaBlend(index),
      );
      if (opacity === null || clipping === null || mode === null) return false;
      const source = targets[index + 1] * opacity * clipping;
      targets[parent + 1] = composite(mode, source, targets[parent + 1]);
      current = parent;
    }
    return true;
  };
  for (const object of sorted) {
    if (object >= count) {
      const index = object - count;
      if (!tree || !flushTo(tree.offscreenParents[index])) return null;
      current = index;
      targets[index + 1] = 0;
      continue;
    }
    const index = object;
    const visible = model.getDrawableDynamicFlagIsVisible(index);
    if (typeof visible !== 'boolean') return null;
    if (!visible) continue; // SDK skips invisible drawables before offscreen submission.
    if (tree) {
      const part = model.getDrawableParentPartIndex(index);
      if (!Number.isInteger(part) || part < -1 || part >= tree.parts) return null;
      if (!flushTo(part === -1 ? -1 : tree.nearest[part])) return null;
    }
    const legacy = modern ? 0 : model.getDrawableBlendMode(index);
    if (!Number.isInteger(legacy) || legacy < 0 || legacy > 2) return null;
    const mode = modern
      ? blendMode(model.getDrawableColorBlend(index), model.getDrawableAlphaBlend(index))
      : legacy === 0
        ? OVER
        : PRESERVE;
    const opacity = normalizedOpacity(model.getDrawableOpacity(index));
    if (mode === null || opacity === null) return null;
    const clipping = maskAlpha(index, false);
    if (clipping === null) return null;
    if (mode === PRESERVE || opacity === 0 || clipping === 0) continue;
    const alpha = sample(index);
    if (alpha === null) return null;
    targets[current + 1] = composite(mode, alpha * opacity * clipping, targets[current + 1]);
  }
  return flushTo(-1) ? targets[0] : null;
}

function drawableAlpha(
  model: CubismModel,
  drawable: number,
  x: number,
  y: number,
  textures: ReadonlyArray<TextureAlpha | undefined>,
): number | null {
  const textureIndex = model.getDrawableTextureIndex(drawable);
  const texture = Number.isInteger(textureIndex) ? textures[textureIndex] : undefined;
  if (!validTexture(texture)) return null;
  const vertices = model.getDrawableVertices(drawable);
  const uvs = model.getDrawableVertexUvs(drawable);
  const indices = model.getDrawableVertexIndices(drawable);
  const vertexCount = model.getDrawableVertexCount(drawable);
  const indexCount = model.getDrawableVertexIndexCount(drawable);
  if (
    !vertices ||
    !uvs ||
    !indices ||
    !Number.isSafeInteger(vertexCount) ||
    vertexCount < 0 ||
    !Number.isSafeInteger(indexCount) ||
    indexCount < 0 ||
    indexCount % 3 !== 0 ||
    vertices.length < vertexCount * 2 ||
    uvs.length < vertexCount * 2 ||
    indices.length < indexCount
  )
    return null;
  if (!vertexCount || !indexCount) return 0;
  // Validate before the AABB exit: unknown inverted-mask geometry must not be
  // mistaken for a known empty area and make the clipped drawable clickable.
  for (let index = 0; index < indexCount; index += 1) {
    if (indices[index] >= vertexCount) return null;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const vx = vertices[vertex * 2];
    const vy = vertices[vertex * 2 + 1];
    if (
      !Number.isFinite(vx) ||
      !Number.isFinite(vy) ||
      !Number.isFinite(uvs[vertex * 2]) ||
      !Number.isFinite(uvs[vertex * 2 + 1])
    )
      return null;
    minX = Math.min(minX, vx);
    maxX = Math.max(maxX, vx);
    minY = Math.min(minY, vy);
    maxY = Math.max(maxY, vy);
  }
  if (
    x < minX - EDGE_EPSILON ||
    x > maxX + EDGE_EPSILON ||
    y < minY - EDGE_EPSILON ||
    y > maxY + EDGE_EPSILON
  )
    return 0;

  const culling = model.getDrawableCulling(drawable);
  let result = 0;
  for (let triangle = 0; triangle < indexCount; triangle += 3) {
    const ia = indices[triangle];
    const ib = indices[triangle + 1];
    const ic = indices[triangle + 2];
    const ax = vertices[ia * 2];
    const ay = vertices[ia * 2 + 1];
    const bx = vertices[ib * 2] - ax;
    const by = vertices[ib * 2 + 1] - ay;
    const cx = vertices[ic * 2] - ax;
    const cy = vertices[ic * 2 + 1] - ay;
    const determinant = bx * cy - by * cx;
    if (!Number.isFinite(determinant)) return null;
    const areaTolerance = Number.EPSILON * Math.max(bx * bx + by * by, cx * cx + cy * cy) * 16;
    if (Math.abs(determinant) <= areaTolerance || (culling && determinant < 0)) continue;
    const wb = ((x - ax) * cy - (y - ay) * cx) / determinant;
    const wc = (bx * (y - ay) - by * (x - ax)) / determinant;
    const wa = 1 - wb - wc;
    if (![wa, wb, wc].every(Number.isFinite)) return null;
    if (wa < -EDGE_EPSILON || wb < -EDGE_EPSILON || wc < -EDGE_EPSILON) continue;
    const u = wa * uvs[ia * 2] + wb * uvs[ib * 2] + wc * uvs[ic * 2];
    const v = wa * uvs[ia * 2 + 1] + wb * uvs[ib * 2 + 1] + wc * uvs[ic * 2 + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    result = Math.max(result, textureAlpha(texture, u, v));
  }
  return result;
}

function validTexture(texture: TextureAlpha | undefined): texture is TextureAlpha {
  return (
    !!texture &&
    Number.isSafeInteger(texture.width) &&
    texture.width > 0 &&
    Number.isSafeInteger(texture.height) &&
    texture.height > 0 &&
    Number.isSafeInteger(texture.width * texture.height) &&
    texture.alpha instanceof Uint8Array &&
    texture.alpha.length === texture.width * texture.height
  );
}

function textureAlpha(texture: TextureAlpha, u: number, v: number): number {
  // Both drawable and mask vertex shaders use (u, 1-v). The renderer uploads
  // ImageBitmap without a Y flip, so sampler t=0 contains the source's top row.
  // LINEAR filtering samples around texel centers, not at u*(width-1).
  const tx = clamp(u, 0, 1) * texture.width - 0.5;
  const ty = clamp(1 - v, 0, 1) * texture.height - 0.5;
  const left = Math.floor(tx);
  const top = Math.floor(ty);
  const fx = tx - left;
  const fy = ty - top;
  const at = (x: number, y: number) =>
    texture.alpha[clamp(y, 0, texture.height - 1) * texture.width + clamp(x, 0, texture.width - 1)];
  const upper = at(left, top) * (1 - fx) + at(left + 1, top) * fx;
  const lower = at(left, top + 1) * (1 - fx) + at(left + 1, top + 1) * fx;
  return (upper * (1 - fy) + lower * fy) / 255;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
