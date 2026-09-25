const ENTER_MS = 200;
const EXIT_MS = 400;
const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });

export function speechBubbleDuration(text) {
  const length = [...segmenter.segment(text.trim().replace(/\s+/gu, ' '))].length;
  return Math.max(9000, 2000 + length * 100);
}

export const speechBubbleStyles = `
  .speech-bubble {
    box-sizing:border-box; width:max-content; max-width:300px;
    border:1px solid #d6cedfa6; border-radius:16px; padding:10px 14px;
    background:rgba(255,253,244,.82); color:#302b40;
    font:13px/1.5 system-ui; box-shadow:0 3px 10px #3b2d5214;
    opacity:0; transform:translateY(8px);
    transition:opacity ${EXIT_MS}ms ease-in, transform ${EXIT_MS}ms ease-in;
    white-space:pre-wrap; overflow-wrap:anywhere;
  }
  .speech-bubble[data-state="visible"] {
    opacity:1; transform:translateY(0);
    transition-duration:${ENTER_MS}ms; transition-timing-function:ease-out;
  }
  @media (prefers-reduced-motion:reduce) {
    .speech-bubble { transform:none; transition-property:opacity; }
  }
`;

/** Keeps delayed expiry/exit callbacks from dismissing a newer caption. */
export class SpeechBubble {
  constructor(element, timers = { setTimeout, clearTimeout }, onChange = null) {
    this.element = element;
    this.timers = timers;
    this.generation = 0;
    this.onChange = onChange;
    this.element.style.display = 'none';
    this.element.dataset.state = 'hidden';
  }

  clearTimers() {
    const { clearTimeout } = this.timers;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.exitTimer);
    this.expiryTimer = this.exitTimer = undefined;
  }

  show(text, hold = false) {
    this.clearTimers();
    this.generation++;
    const hidden = this.element.dataset.state === 'hidden';
    this.element.textContent = text;
    this.element.style.display = 'block';
    if (hidden) {
      this.element.dataset.state = 'entering';
      // Commit the transparent, lowered starting position before transitioning.
      void this.element.offsetHeight;
    }
    // Repeated playback notifications do not restart an entrance. Replacing a
    // fading caption reverses smoothly from its current opacity and position.
    this.element.dataset.state = 'visible';
    if (!hold) this.scheduleDismissal();
    this.notify();
  }

  scheduleDismissal() {
    if (this.element.dataset.state !== 'visible') return;
    const { setTimeout, clearTimeout } = this.timers;
    clearTimeout(this.expiryTimer);
    const generation = ++this.generation;
    this.expiryTimer = setTimeout(() => {
      if (generation === this.generation) this.hide();
    }, speechBubbleDuration(this.element.textContent));
  }

  hide(immediate = false) {
    if (!immediate && this.element.dataset.state !== 'visible') return;
    this.clearTimers();
    const generation = ++this.generation;
    const finish = () => {
      if (generation !== this.generation) return;
      this.element.dataset.state = 'hidden';
      this.element.style.display = 'none';
      this.element.textContent = '';
      this.notify();
    };
    if (immediate) finish();
    else {
      const { setTimeout } = this.timers;
      this.element.dataset.state = 'hiding';
      this.notify();
      this.exitTimer = setTimeout(finish, EXIT_MS);
    }
  }

  notify() {
    this.onChange?.({ state: this.element.dataset.state, text: this.element.textContent });
  }
}
