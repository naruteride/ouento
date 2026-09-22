import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundle just the CPU algorithm; its CubismModel import is type-only.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/character/hit-test.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  target: 'es2022',
  logLevel: 'silent',
});
const { hitTestModel, sampleModelAlpha, HIT_ALPHA_THRESHOLD } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

const texture = (width, height, alpha) => ({ width, height, alpha: Uint8Array.from(alpha) });
const opaque = texture(1, 1, [255]);
const clear = texture(1, 1, [0]);

function mesh(overrides = {}) {
  return {
    vertices: [0, 0, 1, 0, 1, 1, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
    texture: 0,
    opacity: 1,
    visible: true,
    masks: [],
    inverted: false,
    culling: false,
    color: 0,
    alphaBlend: 0,
    legacyBlend: 0,
    part: -1,
    ...overrides,
  };
}

function model(drawables, options = {}) {
  const offscreens = options.offscreens ?? [];
  const parents = options.parents ?? [];
  return {
    getDrawableCount: () => drawables.length,
    getOffscreenCount: () => offscreens.length,
    isBlendModeEnabled: () => options.modern ?? offscreens.length > 0,
    getRenderOrders: () =>
      options.orders ??
      Int32Array.from({ length: drawables.length + offscreens.length }, (_, i) => i),
    getDrawableBlendMode: (i) => drawables[i].legacyBlend,
    getDrawableColorBlend: (i) => drawables[i].color,
    getDrawableAlphaBlend: (i) => drawables[i].alphaBlend,
    getDrawableParentPartIndex: (i) => drawables[i].part,
    getPartCount: () => parents.length,
    getPartParentPartIndices: () => Int32Array.from(parents),
    getOffscreenOwnerIndices: () => Int32Array.from(offscreens.map((offscreen) => offscreen.owner)),
    getOffscreenOpacity: (i) => offscreens[i].opacity,
    getOffscreenColorBlend: (i) => offscreens[i].color,
    getOffscreenAlphaBlend: (i) => offscreens[i].alphaBlend,
    getOffscreenMasks: () => offscreens.map((offscreen) => Int32Array.from(offscreen.masks)),
    getOffscreenMaskCounts: () =>
      Int32Array.from(offscreens.map((offscreen) => offscreen.masks.length)),
    getOffscreenInvertedMask: (i) => offscreens[i].inverted,
    getDrawableDynamicFlagIsVisible: (i) => drawables[i].visible,
    getDrawableOpacity: (i) => drawables[i].opacity,
    getDrawableTextureIndex: (i) => drawables[i].texture,
    getDrawableVertices: (i) => Float32Array.from(drawables[i].vertices),
    getDrawableVertexUvs: (i) => Float32Array.from(drawables[i].uvs),
    getDrawableVertexIndices: (i) => Uint16Array.from(drawables[i].indices),
    getDrawableVertexCount: (i) => drawables[i].vertices.length / 2,
    getDrawableVertexIndexCount: (i) => drawables[i].indices.length,
    getDrawableMasks: () => drawables.map((drawable) => Int32Array.from(drawable.masks)),
    getDrawableMaskCounts: () =>
      Int32Array.from(drawables.map((drawable) => drawable.masks.length)),
    getDrawableInvertedMaskBit: (i) => drawables[i].inverted,
    getDrawableCulling: (i) => drawables[i].culling,
  };
}

test('triangle coverage excludes AABB corners and includes shared edges and vertices', () => {
  const triangle = model([
    mesh({ vertices: [0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }),
  ]);
  assert.equal(hitTestModel(triangle, 0.2, 0.2, [opaque]), true);
  assert.equal(hitTestModel(triangle, 0.8, 0.8, [opaque]), false);
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [0.5, 0.5],
  ])
    assert.equal(hitTestModel(triangle, x, y, [opaque]), true);
  assert.equal(hitTestModel(triangle, -0.001, 0, [opaque]), false);
  assert.equal(hitTestModel(model([mesh()]), 0.5, 0.5, [opaque]), true);
});

test('UV interpolation uses shader 1-v and original image top-left row order', () => {
  const topLeft = texture(2, 2, [255, 0, 0, 0]);
  const square = model([mesh()]);
  assert.equal(hitTestModel(square, 0.25, 0.75, [topLeft]), true);
  assert.equal(hitTestModel(square, 0.25, 0.25, [topLeft]), false);
  assert.equal(hitTestModel(square, 0.75, 0.75, [topLeft]), false);
  assert.equal(hitTestModel(square, 0.75, 0.25, [topLeft]), false);
});

test('texture holes and transparency allow clicks through a fully covered mesh', () => {
  const hole = texture(3, 3, [255, 255, 255, 255, 0, 255, 255, 255, 255]);
  const square = model([mesh()]);
  assert.equal(hitTestModel(square, 0.5, 0.5, [hole]), false);
  assert.equal(hitTestModel(square, 1 / 6, 0.5, [hole]), true);
  assert.equal(hitTestModel(square, 0.5, 0.5, [clear]), false);
});

test('geometry holes remain empty even with an opaque atlas', () => {
  const separate = model([
    mesh({
      vertices: [0, 0, 0.2, 0, 0, 0.2, 0.8, 1, 1, 0.8, 1, 1],
      uvs: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 3, 4, 5],
    }),
  ]);
  assert.equal(hitTestModel(separate, 0.05, 0.05, [opaque]), true);
  assert.equal(hitTestModel(separate, 0.5, 0.5, [opaque]), false);
});

test('bilinear texel centers and clamped atlas edges match renderer sampling', () => {
  const square = model([mesh()]);
  const split = texture(2, 1, [255, 0]);
  assert.equal(hitTestModel(square, 0.5, 0.5, [split]), true); // LINEAR gives half alpha.
  assert.equal(hitTestModel(square, 0.75, 0.5, [split]), false);
  assert.equal(hitTestModel(square, 0, 0, [split]), true);
  assert.equal(hitTestModel(square, 1, 1, [split]), false);
  const outsideUv = model([mesh({ uvs: [-1, 2, -1, 2, -1, 2, -1, 2] })]);
  assert.equal(hitTestModel(outsideUv, 0.5, 0.5, [texture(2, 2, [255, 0, 0, 0])]), true);
});

test('invisible, faint or transparent top drawables do not block opaque drawables below', () => {
  assert.equal(hitTestModel(model([mesh({ visible: false })]), 0.5, 0.5, [opaque]), false);
  assert.equal(
    hitTestModel(model([mesh({ opacity: HIT_ALPHA_THRESHOLD })]), 0.5, 0.5, [opaque]),
    false,
  );
  assert.equal(
    hitTestModel(model([mesh({ opacity: 0.1 })]), 0.5, 0.5, [texture(1, 1, [64])]),
    false,
  );
  const layered = model([mesh(), mesh({ texture: 1 })]);
  assert.equal(hitTestModel(layered, 0.5, 0.5, [opaque, clear]), true);
});

test('normal and inverted masks respect geometric and texture holes', () => {
  const leftMask = mesh({
    texture: 1,
    visible: false,
    opacity: 0,
    vertices: [0, 0, 0.5, 0, 0.5, 1, 0, 1],
  });
  const normal = model([mesh({ masks: [1] }), leftMask]);
  assert.equal(hitTestModel(normal, 0.25, 0.5, [opaque, opaque]), true);
  assert.equal(hitTestModel(normal, 0.75, 0.5, [opaque, opaque]), false);
  const inverted = model([mesh({ masks: [1], inverted: true }), leftMask]);
  assert.equal(hitTestModel(inverted, 0.25, 0.5, [opaque, opaque]), false);
  assert.equal(hitTestModel(inverted, 0.75, 0.5, [opaque, opaque]), true);
  assert.equal(hitTestModel(normal, 0.25, 0.5, [opaque, clear]), false);
  assert.equal(hitTestModel(inverted, 0.25, 0.5, [opaque, clear]), true);
});

test('multiple masks use alpha union and mask texture alpha ignores display opacity', () => {
  const tiny = texture(1, 1, [10]); // Each mask alone is below the interaction threshold.
  const sources = [
    mesh({ texture: 1, visible: false, opacity: 0 }),
    mesh({ texture: 1, visible: false, opacity: 0 }),
  ];
  assert.equal(
    hitTestModel(model([mesh({ masks: [1] }), ...sources]), 0.5, 0.5, [opaque, tiny]),
    false,
  );
  assert.equal(
    hitTestModel(model([mesh({ masks: [1, 2] }), ...sources]), 0.5, 0.5, [opaque, tiny]),
    true,
  );
});

test('missing textures, invalid mask IDs and malformed alpha fail through even for inverted masks', () => {
  assert.equal(hitTestModel(model([mesh()]), 0.5, 0.5, []), false);
  assert.equal(hitTestModel(model([mesh()]), 0.5, 0.5, [texture(2, 2, [255])]), false);
  assert.equal(
    hitTestModel(model([mesh({ masks: [99], inverted: true })]), 0.5, 0.5, [opaque]),
    false,
  );
  assert.equal(
    hitTestModel(
      model([mesh({ masks: [1], inverted: true }), mesh({ texture: 1, visible: false })]),
      0.5,
      0.5,
      [opaque],
    ),
    false,
  );
  const brokenMask = mesh({
    visible: false,
    vertices: [2, 2, 3, 2, 3, 3, 2, 3],
    indices: [0, 1, 999],
  });
  assert.equal(
    hitTestModel(model([mesh({ masks: [1], inverted: true }), brokenMask]), 0.5, 0.5, [opaque]),
    false,
  );
});

test('nonfinite inputs, corrupt geometry, missing UVs and degenerate triangles do not hit', () => {
  const square = model([mesh()]);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(hitTestModel(square, value, 0.5, [opaque]), false);
    assert.equal(hitTestModel(square, 0.5, value, [opaque]), false);
    assert.equal(hitTestModel(model([mesh({ opacity: value })]), 0.5, 0.5, [opaque]), false);
  }
  for (const broken of [
    mesh({ vertices: [NaN, 0, 1, 0, 1, 1, 0, 1] }),
    mesh({ uvs: [] }),
    mesh({ indices: [0, 1, 999] }),
    mesh({ indices: [0, 1] }),
    mesh({ indices: [0, 0, 0] }),
  ]) {
    assert.equal(hitTestModel(model([broken]), 0.5, 0.5, [opaque]), false);
  }
});

test('winding is two-sided unless the drawable enables SDK CCW backface culling', () => {
  const reversed = mesh({ indices: [2, 1, 0, 3, 2, 0] });
  assert.equal(hitTestModel(model([reversed]), 0.5, 0.5, [opaque]), true);
  assert.equal(hitTestModel(model([{ ...reversed, culling: true }]), 0.5, 0.5, [opaque]), false);
  assert.equal(hitTestModel(model([mesh({ culling: true })]), 0.5, 0.5, [opaque]), true);
});

test('a later frame uses moved vertices instead of cached earlier hit geometry', () => {
  const drawable = mesh();
  const animated = model([drawable]);
  assert.equal(hitTestModel(animated, 0.5, 0.5, [opaque]), true);
  drawable.vertices = drawable.vertices.map((value, index) =>
    index % 2 === 0 ? value + 2 : value,
  );
  assert.equal(hitTestModel(animated, 0.5, 0.5, [opaque]), false);
  assert.equal(hitTestModel(animated, 2.5, 0.5, [opaque]), true);
});

const offscreen = (overrides = {}) => ({
  owner: 0,
  opacity: 1,
  color: 0,
  alphaBlend: 0,
  masks: [],
  inverted: false,
  ...overrides,
});
const near = (actual, expected) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('finite Core opacity interpolation overshoot is clamped without discarding the model', () => {
  // Observed from the official Haru Core model after update().
  const overshoot = 1.0000499486923218;
  near(sampleModelAlpha(model([mesh({ opacity: overshoot })]), 0.3, 0.4, [opaque]), 1);
  near(
    sampleModelAlpha(model([mesh({ opacity: 0.4 }), mesh({ opacity: -0.00005 })]), 0.3, 0.4, [
      opaque,
    ]),
    0.4,
  );
  const group = offscreen({ opacity: overshoot });
  const grouped = model([mesh({ part: 0, opacity: 0.4 })], {
    parents: [-1],
    offscreens: [group],
    orders: [1, 0],
  });
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque]), 0.4);
  group.opacity = -0.00005;
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque]), 0);
  for (const opacity of [NaN, Infinity, -Infinity]) {
    group.opacity = opacity;
    assert.equal(sampleModelAlpha(grouped, 0.3, 0.4, [opaque]), null);
  }
});

test('faint drawable alpha accumulates before the interaction threshold', () => {
  const one = model([mesh({ opacity: 0.03 })]);
  const two = model([mesh({ opacity: 0.03 }), mesh({ opacity: 0.03 })]);
  assert.equal(hitTestModel(one, 0.3, 0.4, [opaque]), false);
  near(sampleModelAlpha(two, 0.3, 0.4, [opaque]), 0.03 + 0.03 * 0.97);
  assert.equal(hitTestModel(two, 0.3, 0.4, [opaque]), true);
});

test('Out erases earlier alpha only where its geometry covers, and follows current render order', () => {
  const eraser = mesh({ alphaBlend: 2, vertices: [0, 0, 0.5, 0, 0.5, 1, 0, 1] });
  const options = { modern: true, orders: [0, 1] };
  const layered = model([mesh(), eraser], options);
  near(sampleModelAlpha(layered, 0.25, 0.4, [opaque]), 0);
  near(sampleModelAlpha(layered, 0.75, 0.4, [opaque]), 1);
  options.orders = [1, 0];
  near(sampleModelAlpha(layered, 0.25, 0.4, [opaque]), 1);
  eraser.opacity = 0.5;
  options.orders = [0, 1];
  near(sampleModelAlpha(layered, 0.25, 0.4, [opaque]), 0.5);
});

test('Atop preserves destination alpha; Conjoint and Disjoint use the SDK alpha equations', () => {
  near(sampleModelAlpha(model([mesh({ alphaBlend: 1 })], { modern: true }), 0.3, 0.4, [opaque]), 0);
  for (const [alphaBlend, expected] of [
    [0, 0.0592],
    [1, 0.04],
    [2, 0.0392],
    [3, 0.04],
    [4, 0.06],
  ]) {
    const layered = model(
      [mesh({ opacity: 0.04 }), mesh({ color: 6, opacity: 0.02, alphaBlend })],
      { modern: true },
    );
    near(sampleModelAlpha(layered, 0.3, 0.4, [opaque]), expected);
    assert.equal(hitTestModel(layered, 0.3, 0.4, [opaque]), expected > HIT_ALPHA_THRESHOLD);
  }
});

test('legacy additive/multiply and modern compatible modes preserve destination alpha', () => {
  for (const legacyBlend of [1, 2]) {
    near(sampleModelAlpha(model([mesh({ legacyBlend })]), 0.3, 0.4, [opaque]), 0);
    near(
      sampleModelAlpha(model([mesh({ opacity: 0.2 }), mesh({ legacyBlend })]), 0.3, 0.4, [opaque]),
      0.2,
    );
  }
  for (const color of [1, 2]) {
    const layered = model([mesh({ opacity: 0.2 }), mesh({ color, alphaBlend: 2 })], {
      modern: true,
    });
    near(sampleModelAlpha(layered, 0.3, 0.4, [opaque]), 0.2);
  }
});

test('nested offscreens composite children first, then apply each opacity and offscreen mask once', () => {
  const outer = offscreen({ owner: 0, opacity: 0.5, masks: [2] });
  const inner = offscreen({ owner: 1, opacity: 0.5 });
  const grouped = model(
    [mesh({ part: 1 }), mesh({ part: 1 }), mesh({ visible: false, opacity: 0, texture: 1 })],
    { parents: [-1, 0], offscreens: [outer, inner], orders: [2, 3, 4, 0, 1] },
  );
  const mask = texture(1, 1, [128]);
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque, mask]), (0.25 * 128) / 255);
  outer.inverted = true;
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque, mask]), (0.25 * 127) / 255);
  outer.opacity = 0;
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque, mask]), 0);
});

test('drawable clipping is applied before offscreen opacity and can erase the containing group', () => {
  const grouped = model(
    [
      mesh({ part: 0 }),
      mesh({ part: 0, alphaBlend: 2, masks: [2], inverted: true }),
      mesh({ visible: false, opacity: 0, vertices: [0, 0, 0.5, 0, 0.5, 1, 0, 1] }),
    ],
    { parents: [-1], offscreens: [offscreen({ opacity: 0.4 })], orders: [1, 2, 3, 0] },
  );
  near(sampleModelAlpha(grouped, 0.25, 0.4, [opaque]), 0.4);
  near(sampleModelAlpha(grouped, 0.75, 0.4, [opaque]), 0);
});

test('sibling offscreen Out/Atop modes use their parent destination and combined render order', () => {
  const erased = offscreen({ owner: 1, alphaBlend: 2 });
  const options = { parents: [-1, -1], offscreens: [offscreen(), erased], orders: [1, 3, 0, 2] };
  const grouped = model([mesh({ part: 0 }), mesh({ part: 1 })], options);
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque]), 0);
  options.orders = [3, 1, 2, 0];
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque]), 1);
  erased.alphaBlend = 1;
  options.offscreens[0].opacity = 0.2;
  options.orders = [1, 3, 0, 2];
  near(sampleModelAlpha(grouped, 0.3, 0.4, [opaque]), 0.2);
});

test('invalid render order, hierarchy, blend, opacity and destructive mask metadata fail through', () => {
  const broken = [
    model([mesh(), mesh()], { orders: [0, 0] }),
    model([mesh()], { orders: [-1] }),
    model([mesh()], { orders: [1] }),
    model([mesh()], { orders: [] }),
    model([mesh({ color: 100 })], { modern: true }),
    model([mesh({ alphaBlend: 100 })], { modern: true }),
    model([mesh({ legacyBlend: 100 })]),
    model([mesh(), mesh({ texture: 99 })]),
    model([mesh(), mesh({ alphaBlend: 2, masks: [99], inverted: true })], { modern: true }),
    model([mesh({ part: 0 })], { offscreens: [offscreen()], parents: [1, 0], orders: [1, 0] }),
    model([mesh({ part: 99 })], { offscreens: [offscreen()], parents: [-1], orders: [1, 0] }),
    model([mesh({ part: 0 })], {
      offscreens: [offscreen({ owner: 99 })],
      parents: [-1],
      orders: [1, 0],
    }),
    model([mesh({ part: 0 })], { offscreens: [offscreen()], parents: [-1], orders: [0, 1] }),
    model([mesh({ part: 0 })], {
      offscreens: [offscreen({ opacity: NaN })],
      parents: [-1],
      orders: [1, 0],
    }),
    model([mesh({ part: 0 })], {
      offscreens: [offscreen({ masks: [99], inverted: true })],
      parents: [-1],
      orders: [1, 0],
    }),
    model([mesh({ part: 0 })], {
      offscreens: [offscreen(), offscreen()],
      parents: [-1],
      orders: [2, 0, 1],
    }),
  ];
  for (const candidate of broken) {
    assert.equal(sampleModelAlpha(candidate, 0.3, 0.4, [opaque]), null);
    assert.equal(hitTestModel(candidate, 0.3, 0.4, [opaque]), false);
  }
});
