import { call, on } from './bridge/api.js';
import { speechBubbleStyles } from './ui/speech-bubble.js';
import { BubbleSurface } from './ui/bubble-surface.js';

document.documentElement.style.cssText = 'background:transparent;overflow:hidden;';
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden;';
const style = document.createElement('style');
style.textContent = `${speechBubbleStyles}
  #bubble { position:absolute; left:12px; top:12px; display:none; overflow:auto; }
`;
document.head.append(style);
const surface = new BubbleSurface(document.querySelector('#bubble'), (size) =>
  call('layout_speech_bubble', size),
);
let unsubscribe;
async function start() {
  unsubscribe = await on('speech-bubble-state', (state) => {
    surface.update(state).catch((error) => console.warn('말풍선 배치 실패:', error));
  });
  await surface.update(await call('speech_bubble_ready'));
}
start().catch((error) => console.warn('말풍선 준비 실패:', error));
window.addEventListener('beforeunload', () => {
  surface.dispose();
  unsubscribe?.();
});
