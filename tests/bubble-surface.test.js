import test from 'node:test';
import assert from 'node:assert/strict';
import { BubbleSurface } from '../src/ui/bubble-surface.js';

function fixture() {
  const layouts = [];
  const reads = { width: 0, height: 0 };
  const size = { width: 246, height: 76 };
  const element = {
    style: {},
    dataset: {},
    textContent: '',
    get offsetWidth() {
      reads.width++;
      return size.width;
    },
    get offsetHeight() {
      reads.height++;
      return size.height;
    },
    getBoundingClientRect() {
      throw new Error('An animated transform must not determine the native window size.');
    },
  };
  const surface = new BubbleSurface(
    element,
    (value) => new Promise((resolve) => layouts.push({ value: { ...value }, resolve })),
  );
  return { surface, element, layouts, reads, size };
}

const visible = (revision, text = '합성 말풍선', limits = {}) => ({
  revision,
  layoutRevision: 0,
  state: 'visible',
  text,
  maxWidth: 300,
  maxHeight: 700,
  ...limits,
});

test('surface measures offset dimensions and waits for native layout before entering', async () => {
  const f = fixture();
  assert.equal(f.element.style.display, 'none');
  const pending = f.surface.update(visible(1, '측정할 대사', { maxWidth: 260, maxHeight: 480 }));
  assert.equal(f.element.dataset.state, 'entering');
  assert.equal(f.element.textContent, '측정할 대사');
  assert.equal(f.element.style.maxWidth, '260px');
  assert.equal(f.element.style.maxHeight, '480px');
  assert.deepEqual(f.layouts[0].value, { revision: 1, layoutRevision: 0, width: 246, height: 76 });
  assert.equal(f.reads.width, 1);
  assert.ok(f.reads.height >= 1);
  f.layouts[0].resolve();
  await pending;
  assert.equal(f.element.dataset.state, 'visible');
  assert.equal(f.element.style.display, 'block');
});

test('a previous layout cannot complete a newer caption entrance in either response order', async () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const f = fixture();
    const pending = [
      f.surface.update(visible(10, '이전 대사')),
      f.surface.update(visible(11, '현재 대사')),
    ];
    f.layouts[order[0]].resolve();
    await pending[order[0]];
    assert.equal(f.element.textContent, '현재 대사');
    assert.equal(f.element.dataset.state, order[0] === 0 ? 'entering' : 'visible');
    f.layouts[order[1]].resolve();
    await pending[order[1]];
    assert.equal(f.element.textContent, '현재 대사');
    assert.equal(f.element.dataset.state, 'visible');
  }
});

test('hidden and hiding states invalidate pending layouts without reappearing', async () => {
  for (const state of ['hidden', 'hiding']) {
    const f = fixture();
    const pending = f.surface.update(visible(20));
    await f.surface.update({ revision: 21, layoutRevision: 0, state, text: '' });
    assert.equal(f.layouts.length, 1, 'hiding must not issue its own layout or TTL');
    f.layouts[0].resolve();
    await pending;
    assert.equal(f.element.dataset.state, state);
    assert.equal(f.element.style.display, state === 'hidden' ? 'none' : 'block');
    if (state === 'hidden') assert.equal(f.element.textContent, '');
    await f.surface.update({ revision: 22, layoutRevision: 0, state: 'hidden', text: '' });
    assert.equal(f.element.style.display, 'none');
    assert.equal(f.element.textContent, '');
  }
});

test('disposal suppresses delayed layout completion and all later updates', async () => {
  const f = fixture();
  const pending = f.surface.update(visible(30));
  f.surface.dispose();
  f.layouts[0].resolve();
  await pending;
  await f.surface.update(visible(31, '종료 뒤 도착한 대사'));
  assert.equal(f.element.style.display, 'none');
  assert.equal(f.element.textContent, '');
  assert.equal(f.layouts.length, 1);
});

test('older visible and hiding revisions cannot overwrite or dismiss the current caption', async () => {
  const f = fixture();
  const pending = f.surface.update(visible(40, '현재 대사'));
  f.layouts[0].resolve();
  await pending;
  for (const state of ['visible', 'hiding', 'hidden'])
    await f.surface.update({ ...visible(39, '오래된 대사'), state });
  assert.equal(f.element.dataset.state, 'visible');
  assert.equal(f.element.textContent, '현재 대사');
  assert.equal(f.layouts.length, 1);
  await f.surface.update({ revision: 41, layoutRevision: 0, state: 'hidden', text: '' });
  await f.surface.update(visible(40, '늦게 도착한 현재 대사'));
  assert.equal(f.element.style.display, 'none');
  assert.equal(f.element.textContent, '');
});

test('the same revision remeasures changed monitor limits and ignores an older size response', async () => {
  const f = fixture();
  const initial = f.surface.update(visible(50));
  f.size.width = 180;
  f.size.height = 132;
  const resized = f.surface.update(
    visible(50, '합성 말풍선', { layoutRevision: 1, maxWidth: 180, maxHeight: 240 }),
  );
  assert.equal(f.element.style.maxWidth, '180px');
  assert.equal(f.element.style.maxHeight, '240px');
  assert.deepEqual(
    f.layouts.map((layout) => layout.value),
    [
      { revision: 50, layoutRevision: 0, width: 246, height: 76 },
      { revision: 50, layoutRevision: 1, width: 180, height: 132 },
    ],
  );
  f.layouts[0].resolve();
  await initial;
  assert.equal(f.element.dataset.state, 'entering');
  f.layouts[1].resolve();
  await resized;
  assert.equal(f.element.dataset.state, 'visible');
  assert.equal(f.element.style.maxWidth, '180px');
});

test('hiding an already hidden surface does not revive it or start a layout', async () => {
  const f = fixture();
  await f.surface.update({ revision: 1, layoutRevision: 0, state: 'hiding', text: '이전 대사' });
  assert.equal(f.element.dataset.state, 'hidden');
  assert.equal(f.element.style.display, 'none');
  assert.equal(f.layouts.length, 0);
});

test('a delayed ready snapshot cannot restore older limits for the same caption', async () => {
  const f = fixture();
  const current = f.surface.update(
    visible(60, '현재 화면', { layoutRevision: 2, maxWidth: 220, maxHeight: 320 }),
  );
  f.layouts[0].resolve();
  await current;
  await f.surface.update(visible(60, '현재 화면', { layoutRevision: 1, maxWidth: 300 }));
  assert.equal(f.layouts.length, 1);
  assert.equal(f.element.style.maxWidth, '220px');
  assert.equal(f.element.style.maxHeight, '320px');
  assert.equal(f.element.dataset.state, 'visible');
});
