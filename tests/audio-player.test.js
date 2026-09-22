import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlayer, VoiceRecorder } from '../src/audio/player.js';

const originals = new Map(
  [
    'AudioContext',
    'OfflineAudioContext',
    'MediaRecorder',
    'navigator',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
const install = (key, value) =>
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
after(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};
let contexts, animationFrames, nextFrame, streams;
const buffer = () => ({
  sampleRate: 48000,
  duration: 1,
  length: 48000,
  numberOfChannels: 1,
  getChannelData: () => new Float32Array(48000).fill(0.1),
});
class Node {
  constructor() {
    this.connections = 0;
    this.disconnections = 0;
  }
  connect() {
    this.connections++;
  }
  disconnect() {
    this.disconnections++;
  }
}
class Source extends Node {
  start(time) {
    this.started = time;
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.();
  }
}
class AudioContextFake {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.sources = [];
    this.gains = [];
    this.listeners = new Set();
    this.decodes = [];
    contexts.push(this);
  }
  addEventListener(_name, listener) {
    this.listeners.add(listener);
  }
  removeEventListener(_name, listener) {
    this.listeners.delete(listener);
  }
  changed(state) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async resume() {
    this.changed('running');
  }
  async suspend() {
    this.changed('suspended');
  }
  async close() {
    this.changed('closed');
    this.closed = true;
  }
  decodeAudioData() {
    return this.decodes.length ? this.decodes.shift() : Promise.resolve(buffer());
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  createGain() {
    const gain = new Node();
    gain.gain = { value: 1 };
    this.gains.push(gain);
    return gain;
  }
}
class RecorderFake {
  static fail = false;
  static isTypeSupported() {
    return true;
  }
  constructor(stream, options) {
    if (RecorderFake.fail) throw new Error('codec unavailable');
    this.stream = stream;
    this.mimeType = options?.mimeType || 'audio/webm';
    this.state = 'inactive';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      this.onstop?.();
    });
  }
}
function stream() {
  const track = {
    stops: 0,
    stop() {
      this.stops++;
    },
  };
  const value = { track, getTracks: () => [track] };
  streams.push(value);
  return value;
}
function renderer() {
  return {
    resets: 0,
    mouths: [],
    chunks: [],
    cancelSpeech() {
      this.resets++;
    },
    setMouth(open, speaking) {
      this.mouths.push({ open, speaking });
    },
    pushAudio(samples, dt) {
      this.chunks.push({ length: samples.length, dt });
    },
  };
}
function frame(context, time) {
  context.currentTime = time;
  const frames = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of frames) callback(time * 1000);
}
const reply = (id) => ({ utteranceId: id, audioBase64: 'AQID' });
beforeEach(() => {
  contexts = [];
  animationFrames = new Map();
  nextFrame = 0;
  streams = [];
  RecorderFake.fail = false;
  install('AudioContext', AudioContextFake);
  install('requestAnimationFrame', (callback) => {
    const id = ++nextFrame;
    animationFrames.set(id, callback);
    return id;
  });
  install('cancelAnimationFrame', (id) => animationFrames.delete(id));
  install('MediaRecorder', RecorderFake);
  install('navigator', { mediaDevices: { getUserMedia: async () => stream() } });
});

test('speech cancellation discards a late decode without allocating playback nodes', async () => {
  const player = new SpeechPlayer(renderer());
  await player.prepare();
  const decoding = deferred();
  contexts[0].decodes.push(decoding.promise);
  const playing = player.play(reply('old'));
  await flush();
  player.cancel();
  decoding.resolve(buffer());
  assert.equal(await playing, false);
  assert.equal(contexts[0].sources.length, 0);
  assert.equal(animationFrames.size, 0);
  await player.dispose();
});

test('late utterance validation cannot resume cancelled speech', async () => {
  const player = new SpeechPlayer(renderer());
  const validation = deferred();
  const playing = player.play(reply('old'), { validate: () => validation.promise });
  await flush();
  player.cancel();
  validation.resolve(true);
  assert.equal(await playing, false);
  assert.equal(contexts.length, 0);
  assert.equal(await player.play(reply('denied'), { validate: async () => false }), false);
  await player.dispose();
});

test('a rejected late audio event cannot stop the utterance currently playing', async () => {
  const player = new SpeechPlayer(renderer());
  await player.play(reply('current'));
  assert.equal(await player.play(reply('cancelled'), { validate: async () => false }), false);
  assert.equal(player.session.id, 'current');
  assert.notEqual(contexts[0].sources[0].stopped, true);
  await player.dispose();
});

for (const sampleRate of [48000, 44100]) {
  test(`native denial after ${sampleRate} Hz decoding/resampling prevents audio allocation`, async () => {
    const face = renderer();
    const player = new SpeechPlayer(face);
    await player.prepare();
    const decoding = deferred();
    const validation = deferred();
    let validations = 0;
    let offlineSource;
    if (sampleRate !== 48000) {
      install(
        'OfflineAudioContext',
        class {
          constructor() {
            this.destination = {};
          }
          createBufferSource() {
            offlineSource = new Source();
            return offlineSource;
          }
          async startRendering() {
            return buffer();
          }
        },
      );
    }
    contexts[0].decodes.push(decoding.promise);
    const playing = player.play(reply('native-denied'), {
      validate: () => (++validations === 1 ? Promise.resolve(true) : validation.promise),
    });
    await flush();
    assert.equal(validations, 1);
    decoding.resolve({ ...buffer(), sampleRate, length: sampleRate });
    await flush();
    assert.equal(validations, 2, 'the native check must run after decoding/resampling');
    const generation = player.generation;
    validation.resolve(false);
    assert.equal(await playing, false);
    assert.equal(player.generation, generation, 'denial works without a local cancel event');
    assert.equal(player.session, null);
    assert.equal(contexts[0].sources.length, 0);
    assert.equal(contexts[0].gains.length, 0);
    assert.equal(animationFrames.size, 0);
    assert.equal(face.chunks.length, 0);
    if (offlineSource) assert.equal(offlineSource.disconnections, 1);
    await player.dispose();
  });
}

test('an old post-decode native denial leaves newer speech playing', async () => {
  const player = new SpeechPlayer(renderer());
  const validation = deferred();
  let validations = 0;
  const old = player.play(reply('old-denied'), {
    validate: () => (++validations === 1 ? Promise.resolve(true) : validation.promise),
  });
  await flush();
  assert.equal(validations, 2);
  assert.equal(await player.play(reply('new-valid')), true);
  validation.resolve(false);
  assert.equal(await old, false);
  assert.equal(player.session.id, 'new-valid');
  assert.equal(contexts[0].sources.length, 1);
  assert.notEqual(contexts[0].sources[0].stopped, true);
  await player.dispose();
});

test('a newer speech owns playback even if the old decode completes last', async () => {
  const player = new SpeechPlayer(renderer());
  await player.prepare();
  const decoding = deferred();
  contexts[0].decodes.push(decoding.promise);
  const old = player.play(reply('old'));
  await flush();
  assert.equal(await player.play(reply('new')), true);
  decoding.resolve(buffer());
  assert.equal(await old, false);
  assert.equal(player.session.id, 'new');
  assert.equal(contexts[0].sources.length, 1);
  await player.dispose();
});

test('resampling cancelled mid-render is disposed without starting output', async () => {
  const rendering = deferred();
  let offlineSource;
  install(
    'OfflineAudioContext',
    class {
      constructor() {
        this.destination = {};
      }
      createBufferSource() {
        offlineSource = new Source();
        return offlineSource;
      }
      startRendering() {
        return rendering.promise;
      }
    },
  );
  const player = new SpeechPlayer(renderer());
  await player.prepare();
  contexts[0].decodes.push(Promise.resolve({ ...buffer(), sampleRate: 44100, length: 44100 }));
  const playing = player.play(reply('a'));
  await flush();
  player.cancel();
  rendering.resolve(buffer());
  assert.equal(await playing, false);
  assert.equal(offlineSource.disconnections, 1);
  assert.equal(contexts[0].sources.length, 0);
  await player.dispose();
});

test('cancel, natural end and replacement disconnect source and gain nodes', async () => {
  const player = new SpeechPlayer(renderer());
  await player.play(reply('a'));
  const context = contexts[0];
  player.cancel();
  assert.equal(context.sources[0].stopped, true);
  assert.equal(context.sources[0].disconnections, 1);
  assert.equal(context.gains[0].disconnections, 1);
  assert.equal(context.sources[0].buffer, null);
  await player.play(reply('b'));
  await player.play(reply('c'));
  assert.equal(context.gains[1].disconnections, 1);
  context.sources[2].end();
  assert.equal(context.gains[2].disconnections, 1);
  assert.equal(player.session, null);
  await player.dispose();
  assert.equal(context.closed, true);
  assert.equal(context.listeners.size, 0);
});

test('pause closes the mouth and resumes from the frozen audio clock', async () => {
  const face = renderer();
  const player = new SpeechPlayer(face);
  let validations = 0;
  await player.play(reply('a'), {
    validate: async () => {
      validations++;
      return true;
    },
  });
  const context = contexts[0];
  frame(context, 0.02);
  assert.equal(face.chunks.at(-1).length, 960);
  await player.pause();
  const count = face.chunks.length;
  frame(context, 0.02);
  assert.equal(face.chunks.length, count);
  assert.deepEqual(face.mouths.at(-1), { open: 0, speaking: false });
  assert.equal(await player.resume(), true);
  frame(context, 0.04);
  assert.equal(face.chunks.at(-1).length, 960);
  assert.equal(validations, 3);
  frame(context, 0.9);
  assert.equal(face.chunks.at(-1).length, 4800);
  player.setMuted(true);
  assert.equal(context.gains[0].gain.value, 0);
  await player.dispose();
});

test('silent PCM closes the mouth without interrupting the playback clock', async () => {
  const face = renderer();
  const player = new SpeechPlayer(face);
  await player.prepare();
  contexts[0].decodes.push(
    Promise.resolve({ ...buffer(), getChannelData: () => new Float32Array(48000) }),
  );
  await player.play(reply('silence'));
  frame(contexts[0], 0.02);
  assert.deepEqual(face.mouths.at(-1), { open: 0, speaking: true });
  assert.equal(face.chunks.at(-1).length, 960);
  assert.notEqual(contexts[0].sources[0].stopped, true);
  assert.equal(player.session.previous, 960);
  await player.dispose();
});

test('dispose during pending context resume cannot revive playback', async () => {
  const player = new SpeechPlayer(renderer());
  await player.prepare();
  const resume = deferred();
  contexts[0].state = 'suspended';
  contexts[0].resume = () => resume.promise;
  const playing = player.play(reply('a'));
  await flush();
  await player.dispose();
  resume.reject(new Error('closed while resuming'));
  assert.equal(await playing, false);
  assert.equal(contexts[0].sources.length, 0);
});

test('new playback waits for an in-flight pause before resuming its audio clock', async () => {
  const player = new SpeechPlayer(renderer());
  await player.play(reply('old'));
  const context = contexts[0];
  const suspending = deferred();
  context.suspend = async () => {
    await suspending.promise;
    context.changed('suspended');
  };
  const pausing = player.pause();
  const playing = player.play(reply('new'));
  await flush();
  assert.equal(context.sources.length, 1);
  suspending.resolve();
  await pausing;
  assert.equal(await playing, true);
  assert.equal(context.state, 'running');
  assert.equal(player.session.id, 'new');
  await player.dispose();
});

test('pending microphone permission is stopped if cancellation arrives first', async () => {
  const permission = deferred();
  navigator.mediaDevices.getUserMedia = () => permission.promise;
  const recorder = new VoiceRecorder();
  const starting = recorder.start();
  await flush();
  recorder.cancel();
  const late = stream();
  permission.resolve(late);
  assert.equal(await starting, false);
  assert.equal(late.track.stops, 1);
  assert.equal(recorder.stream, null);
  assert.equal(recorder.state, 'idle');
});

test('duplicate start shares permission and never creates a second microphone stream', async () => {
  const permission = deferred();
  let requests = 0;
  navigator.mediaDevices.getUserMedia = () => {
    requests++;
    return permission.promise;
  };
  const recorder = new VoiceRecorder();
  const first = recorder.start();
  const second = recorder.start();
  assert.equal(first, second);
  await flush();
  const microphone = stream();
  permission.resolve(microphone);
  assert.equal(await first, true);
  assert.equal(requests, 1);
  recorder.cancel();
  assert.equal(microphone.track.stops, 1);
});

test('recorder creation failure releases microphone tracks', async () => {
  RecorderFake.fail = true;
  const recorder = new VoiceRecorder();
  await assert.rejects(recorder.start(), /codec unavailable/);
  assert.equal(streams[0].track.stops, 1);
  assert.equal(recorder.stream, null);
  assert.equal(recorder.state, 'idle');
});

test('normal stop returns final bytes once and releases every microphone track', async () => {
  const recorder = new VoiceRecorder();
  await recorder.start();
  const first = recorder.stop();
  const second = recorder.stop();
  assert.equal(first, second);
  const result = await first;
  assert.deepEqual(result.audio, [1, 2, 3]);
  assert.equal(result.mimeType, 'audio/webm;codecs=opus');
  assert.equal(streams[0].track.stops, 1);
  assert.equal(recorder.state, 'idle');
  assert.equal(recorder.stream, null);
});

test('cancel while final stop events are pending rejects instead of sending old audio', async () => {
  const recorder = new VoiceRecorder();
  await recorder.start();
  const stopping = recorder.stop();
  const rejection = assert.rejects(stopping, { name: 'AbortError' });
  recorder.cancel();
  await rejection;
  await flush();
  assert.equal(recorder.stream, null);
  assert.equal(streams[0].track.stops, 1);
});

test('unexpected microphone termination reports an error without sending partial audio', async () => {
  const recorder = new VoiceRecorder();
  const errors = [];
  let submitted = 0;
  recorder.onError = (error) => errors.push(error.message);
  recorder.onLimit = () => submitted++;
  await recorder.start();
  recorder.recorder.stop();
  await flush();
  assert.equal(recorder.state, 'idle');
  assert.equal(streams[0].track.stops, 1);
  assert.equal(errors.length, 1);
  assert.equal(submitted, 0);
});

test('60 second stop emits one result and cancellation suppresses a late auto-stop', async (t) => {
  let timeout;
  const cleared = [];
  t.mock.method(globalThis, 'setTimeout', (callback, duration) => {
    assert.equal(duration, 60000);
    timeout = callback;
    return 71;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => cleared.push(id));
  const recorder = new VoiceRecorder();
  const completed = deferred();
  let emissions = 0;
  recorder.onLimit = (result) => {
    emissions++;
    completed.resolve(result);
  };
  await recorder.start();
  timeout();
  const result = await completed.promise;
  assert.deepEqual(result.audio, [1, 2, 3]);
  assert.equal(emissions, 1);
  assert.ok(cleared.includes(71));
  assert.equal(streams[0].track.stops, 1);
  await recorder.start();
  timeout();
  recorder.cancel();
  await flush();
  assert.equal(emissions, 1);
  assert.equal(streams[1].track.stops, 1);
});
