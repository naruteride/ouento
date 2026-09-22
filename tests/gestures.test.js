import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/character/gestures.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  target: 'es2022',
  logLevel: 'silent',
});
const { gestureName, sampleGesture, parameterOffset } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);
const names = ['none', 'nod', 'tilt', 'smallBounce', 'lookAway'];
const rest = { angleX: 0, angleY: 0, angleZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0, tracking: 1 };

test('every allowed gesture has a distinct small head/upper-body pose and no translation', () => {
  const expectedAxes = {
    none: [],
    nod: ['angleY'],
    tilt: ['angleZ', 'bodyZ'],
    smallBounce: ['angleY', 'bodyY'],
    lookAway: ['angleX', 'bodyX'],
  };
  for (const name of names) {
    assert.equal(gestureName(name), name);
    const pose = sampleGesture(name, 0.22, 1);
    assert.deepEqual(Object.keys(pose), Object.keys(rest));
    assert.deepEqual(
      Object.keys(pose).filter((axis) => axis !== 'tracking' && pose[axis] !== 0),
      expectedAxes[name],
    );
    for (let age = 0; age <= 2; age += 1 / 120) {
      const sample = sampleGesture(name, age, 1);
      for (const [axis, value] of Object.entries(sample))
        assert.ok(axis === 'tracking' ? value >= 0.35 && value <= 1 : Math.abs(value) <= 0.3);
    }
  }
});

test('gestures are one shot with smooth start, end and full tracking recovery', () => {
  for (const [name, duration] of [
    ['nod', 1.2],
    ['tilt', 1.4],
    ['smallBounce', 1.3],
    ['lookAway', 1.6],
  ]) {
    for (const age of [-1, 0, duration, duration + 0.1, duration * 2, 100])
      assert.deepEqual(sampleGesture(name, age, 1), rest);
    for (const age of [0.0001, duration - 0.0001]) {
      const nearEnd = sampleGesture(name, age, 1);
      for (const axis of Object.keys(rest)) assert.ok(Math.abs(nearEnd[axis] - rest[axis]) < 1e-7);
    }
    assert.ok(sampleGesture(name, duration / 2, 1).tracking < 0.36);
  }
});

test('explicit gesture strength scales pose and tracking independently of emotion', () => {
  for (const name of names) {
    const high = sampleGesture(name, 0.22, 0.8);
    const low = sampleGesture(name, 0.22, 0.2);
    for (const axis of Object.keys(rest)) {
      const base = rest[axis];
      assert.ok(Math.abs(high[axis] - base - 4 * (low[axis] - base)) < 1e-12);
    }
    assert.deepEqual(sampleGesture(name, 0.22, 0), rest);
    assert.deepEqual(sampleGesture(name, 0.22, 5), sampleGesture(name, 0.22, 1));
  }
});

test('unknown gestures and nonfinite motion input never generate offsets', () => {
  for (const value of ['dance', 'constructor', '__proto__', {}, null, 12])
    assert.equal(gestureName(value), 'none');
  for (const name of names)
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.deepEqual(sampleGesture(name, value, 1), rest);
      assert.deepEqual(sampleGesture(name, 0.22, value), rest);
    }
});

test('model offsets honor asymmetric actual defaults, missing axes and finite bounds', () => {
  const parameter = { minimum: -2, maximum: 10, default: 2 };
  assert.equal(parameterOffset(parameter, 0.25), 2);
  assert.equal(parameterOffset(parameter, -0.25), -1);
  assert.equal(parameterOffset(parameter, 99), 8);
  assert.equal(parameterOffset(parameter, -99), -4);
  assert.equal(parameterOffset(undefined, 0.2), 0);
  assert.equal(parameterOffset({ minimum: 1, maximum: 1, default: 1 }, 0.2), 0);
  assert.equal(parameterOffset({ minimum: 2, maximum: 1, default: 1 }, 0.2), 0);
  assert.equal(parameterOffset(parameter, NaN), 0);
});
