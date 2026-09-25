import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechBubble, speechBubbleDuration } from '../src/ui/speech-bubble.js';

function fixture() {
  const element = { style: {}, dataset: {}, textContent: '', offsetHeight: 60 };
  let id = 0;
  const scheduled = new Map();
  const timers = {
    setTimeout(fn, delay) {
      assert.equal(this, undefined, 'browser timers must not receive the injected object as this');
      scheduled.set(++id, { fn, delay });
      return id;
    },
    clearTimeout(timer) {
      assert.equal(this, undefined, 'browser timers must not receive the injected object as this');
      scheduled.delete(timer);
    },
  };
  const bubble = new SpeechBubble(element, timers);
  const fireNext = () => {
    assert.equal(scheduled.size, 1);
    const [key, timer] = [...scheduled][0];
    scheduled.delete(key);
    timer.fn();
    return timer.delay;
  };
  return { bubble, element, scheduled, fireNext };
}

test('longer captions have more reading time without counting emoji components separately', () => {
  assert.equal(speechBubbleDuration('안녕!'), 9000);
  assert.equal(speechBubbleDuration('가'.repeat(100)), 12000);
  assert.equal(speechBubbleDuration('가'.repeat(300)), 32000);
  assert.equal(speechBubbleDuration('👨‍👩‍👧‍👦'.repeat(100)), 12000);
  assert.equal(speechBubbleDuration('   안녕!\n\n'), 9000);
});

test('expiry leaves the caption rendered for its exit, then removes it and its text', () => {
  const f = fixture();
  f.bubble.show('가'.repeat(100));
  assert.equal(f.fireNext(), 12000);
  assert.equal(f.element.dataset.state, 'hiding');
  assert.equal(f.element.style.display, 'block');
  assert.equal(f.fireNext(), 400);
  assert.equal(f.element.style.display, 'none');
  assert.equal(f.element.textContent, '');
});

test('queued expiry and exit callbacks cannot remove a newer caption', () => {
  const f = fixture();
  f.bubble.show('이전 대사');
  const expiry = [...f.scheduled.values()][0].fn;
  f.bubble.show('새 대사');
  expiry();
  assert.equal(f.element.dataset.state, 'visible');
  f.bubble.hide();
  const exit = [...f.scheduled.values()][0].fn;
  f.bubble.show('퇴장 중 도착한 대사', true);
  exit();
  assert.equal(f.element.textContent, '퇴장 중 도착한 대사');
  assert.equal(f.element.dataset.state, 'visible');
  assert.equal(f.scheduled.size, 0);
});

test('playback holds the caption and release gives the full reading time', () => {
  const f = fixture();
  const text = '말'.repeat(200);
  f.bubble.show(text);
  f.bubble.show(text, true);
  f.bubble.show(text, true);
  assert.equal(f.scheduled.size, 0);
  f.bubble.scheduleDismissal();
  assert.equal(f.fireNext(), 22000);
  f.bubble.hide(true);
  assert.equal(f.element.dataset.state, 'hidden');
  assert.equal(f.scheduled.size, 0);
});

test('repeated hide does not extend an exit and immediate removal cannot resurrect it', () => {
  const f = fixture();
  f.bubble.show('취소할 대사');
  f.bubble.hide();
  const exit = [...f.scheduled.values()][0];
  f.bubble.hide();
  assert.equal([...f.scheduled.values()][0], exit);
  f.bubble.hide(true);
  exit.fn();
  f.bubble.scheduleDismissal();
  assert.equal(f.element.style.display, 'none');
  assert.equal(f.scheduled.size, 0);
});
