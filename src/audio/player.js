/** Playback, analysis and pause all use the same Web Audio clock. */
export class SpeechPlayer {
  constructor(renderer, onState = () => {}) {
    this.renderer = renderer;
    this.onState = onState;
    this.generation = 0;
    this.context = null;
    this.session = null;
    this.frame = 0;
    this.disposed = false;
    this.pausePending = null;
    this.contextChanged = () => {
      const session = this.session;
      if (!session) return;
      const running = this.context.state === 'running';
      if (!running) this.renderer.cancelSpeech();
      this.onState({ speaking: running, paused: !running, utteranceId: session.id });
    };
  }

  async prepare() {
    if (this.disposed) throw new Error('음성 재생기가 닫혔습니다.');
    if (this.pausePending) await this.pausePending;
    if (this.disposed) throw new Error('음성 재생기가 닫혔습니다.');
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 48000 });
      this.context.addEventListener('statechange', this.contextChanged);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  async play(reply, { muted = false, validate } = {}) {
    if (this.disposed) return false;
    // A late rejected event must not stop a newer utterance already playing.
    const arrivalGeneration = this.generation;
    if (validate) {
      try {
        if (!(await validate())) return false;
      } catch (error) {
        if (this.disposed || arrivalGeneration !== this.generation) return false;
        throw error;
      }
      if (this.disposed || arrivalGeneration !== this.generation) return false;
    }
    this.cancel();
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation;
    try {
      await this.prepare();
      if (!current()) return false;
      const bytes = Uint8Array.from(atob(reply.audioBase64), (character) =>
        character.charCodeAt(0),
      );
      let buffer = await this.context.decodeAudioData(bytes.buffer);
      if (!current()) return false;
      if (buffer.sampleRate !== 48000) {
        const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * 48000), 48000);
        const source = offline.createBufferSource();
        try {
          source.buffer = buffer;
          source.connect(offline.destination);
          source.start();
          buffer = await offline.startRendering();
        } finally {
          source.disconnect();
        }
        if (!current()) return false;
      }
      // IPC cancellation may have happened while the audio was decoded or resampled.
      if (validate && !(await validate())) return false;
      if (!current()) return false;

      const mono = new Float32Array(buffer.length);
      for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex++) {
        const channel = buffer.getChannelData(channelIndex);
        for (let index = 0; index < mono.length; index++)
          mono[index] += channel[index] / buffer.numberOfChannels;
      }
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      const session = {
        id: reply.utteranceId,
        generation,
        source,
        gain,
        mono,
        validate,
        sampleRate: buffer.sampleRate,
        previous: 0,
        started: this.context.currentTime,
      };
      this.session = session;
      source.buffer = buffer;
      gain.gain.value = muted ? 0 : 1;
      source.connect(gain);
      gain.connect(this.context.destination);
      source.onended = () => {
        if (this.session === session) this.cancel();
      };
      source.start(session.started);
      this.onState({ speaking: this.context.state === 'running', utteranceId: session.id });
      const tick = () => {
        if (!current() || this.session !== session) return;
        if (this.context.state === 'running') {
          const position = Math.min(
            mono.length,
            Math.max(
              0,
              Math.floor((this.context.currentTime - session.started) * session.sampleRate),
            ),
          );
          // A throttled/hidden WebView must not feed seconds of old speech into the current mouth.
          const start = Math.max(session.previous, position - Math.ceil(session.sampleRate * 0.1));
          const chunk = mono.subarray(start, position);
          if (chunk.length) {
            let energy = 0;
            for (const sample of chunk) energy += sample * sample;
            const rms = Math.sqrt(energy / chunk.length);
            this.renderer.setMouth(rms < 0.008 ? 0 : Math.min(1, rms * 6), true);
            this.renderer.pushAudio(chunk, chunk.length / session.sampleRate);
          }
          session.previous = position;
        } else {
          this.renderer.setMouth(0, false);
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
      return true;
    } catch (error) {
      const stale = !current();
      if (this.session?.generation === generation) this.cancel();
      if (stale) return false;
      throw error;
    }
  }

  async pause() {
    const context = this.context;
    if (!context || !this.session) return;
    this.renderer.cancelSpeech();
    const pending = context.suspend();
    this.pausePending = pending;
    try {
      await pending;
    } finally {
      if (this.pausePending === pending) this.pausePending = null;
    }
  }

  async resume() {
    const session = this.session;
    if (!session || this.disposed) return false;
    if (this.pausePending) await this.pausePending;
    if (this.session !== session || this.disposed) return false;
    if (session.validate && !(await session.validate())) {
      if (this.session === session) this.cancel();
      return false;
    }
    if (this.session !== session || this.disposed) return false;
    await this.context.resume();
    return this.session === session && !this.disposed;
  }

  setMuted(muted) {
    if (this.session) this.session.gain.gain.value = muted ? 0 : 1;
  }

  cancel() {
    this.generation++;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const session = this.session;
    this.session = null;
    if (session) {
      session.source.onended = null;
      try {
        session.source.stop();
      } catch {
        /* It may have ended already. */
      }
      session.source.disconnect();
      session.gain.disconnect();
      session.source.buffer = null;
    }
    this.renderer.cancelSpeech();
    this.onState({ speaking: false });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (this.context) {
      this.context.removeEventListener('statechange', this.contextChanged);
      if (this.context.state !== 'closed') await this.context.close();
    }
  }
}

function recordingCancelled() {
  const error = new Error('녹음이 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}

/** A single microphone session; late permission, stop and Blob callbacks cannot revive it. */
export class VoiceRecorder {
  constructor(onVoiceStart = () => {}) {
    this.onVoiceStart = onVoiceStart;
    this.generation = 0;
    this.state = 'idle';
    this.stream = null;
    this.recorder = null;
    this.session = null;
    this.startPromise = null;
    this.disposed = false;
  }

  start() {
    if (this.disposed) return Promise.reject(new Error('녹음기가 닫혔습니다.'));
    if (this.state === 'starting') return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new Error('이미 녹음 중입니다.'));
    const generation = ++this.generation;
    this.state = 'starting';
    this.startPromise = this.startSession(generation);
    return this.startPromise;
  }

  async startSession(generation) {
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('이 WebView에서 마이크 입력을 사용할 수 없습니다.');
      }
      await this.onVoiceStart();
      if (generation !== this.generation || this.disposed) return false;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (generation !== this.generation || this.disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const session = {
        generation,
        stream,
        recorder,
        chunks: [],
        timer: null,
        result: null,
        resolve: null,
        reject: null,
        finished: false,
      };
      this.session = session;
      this.stream = stream;
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (this.session === session && generation === this.generation && event.data.size)
          session.chunks.push(event.data);
      };
      recorder.onstop = () => this.finishSession(session);
      recorder.onerror = (event) =>
        this.failSession(session, event.error ?? new Error('마이크 녹음에 실패했습니다.'));
      recorder.start(250);
      this.state = 'recording';
      session.timer = setTimeout(() => {
        if (this.session !== session || generation !== this.generation) return;
        this.stop()
          .then((result) => {
            if (generation === this.generation && !this.disposed) return this.onLimit?.(result);
          })
          .catch((error) => {
            if (error.name !== 'AbortError') this.onError?.(error);
          });
      }, 60000);
      return true;
    } catch (error) {
      if (stream && this.session?.stream !== stream)
        stream.getTracks().forEach((track) => track.stop());
      if (generation !== this.generation || this.disposed) return false;
      if (generation === this.generation) {
        if (this.session) this.releaseSession(this.session);
        this.state = 'idle';
      }
      throw error;
    } finally {
      if (generation === this.generation) this.startPromise = null;
    }
  }

  stop() {
    const session = this.session;
    if (!session || !['recording', 'stopping'].includes(this.state))
      return Promise.reject(new Error('녹음 중이 아닙니다.'));
    if (session.result) return session.result;
    clearTimeout(session.timer);
    session.result = new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
    });
    this.state = 'stopping';
    try {
      // If a browser stopped the recorder, its final data/stop event is already queued.
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    } catch (error) {
      this.failSession(session, error);
    }
    return session.result;
  }

  async finishSession(session) {
    if (session.finished) return;
    session.finished = true;
    const blob = new Blob(session.chunks, { type: session.recorder.mimeType });
    const mimeType = session.recorder.mimeType;
    this.releaseSession(session);
    if (!session.result) {
      session.chunks = [];
      if (session.generation === this.generation && !this.disposed)
        this.onError?.(new Error('마이크 연결이 종료되어 녹음을 중단했습니다.'));
      return;
    }
    try {
      const bytes = await blob.arrayBuffer();
      if (session.generation !== this.generation || this.disposed) throw recordingCancelled();
      session.resolve?.({ audio: Array.from(new Uint8Array(bytes)), mimeType });
    } catch (error) {
      session.reject?.(error);
      if (!session.reject && error.name !== 'AbortError') this.onError?.(error);
    } finally {
      session.chunks = [];
    }
  }

  failSession(session, error) {
    if (session.finished) return;
    session.finished = true;
    this.releaseSession(session);
    session.chunks = [];
    if (session.reject) session.reject(error);
    else this.onError?.(error);
  }

  releaseSession(session) {
    clearTimeout(session.timer);
    session.recorder.ondataavailable = null;
    session.recorder.onstop = null;
    session.recorder.onerror = null;
    if (session.recorder.state !== 'inactive') {
      try {
        session.recorder.stop();
      } catch {
        /* Tracks below are still stopped. */
      }
    }
    session.stream.getTracks().forEach((track) => track.stop());
    if (this.session === session) {
      this.session = null;
      this.stream = null;
      this.recorder = null;
      this.state = 'idle';
    }
  }

  cancel() {
    this.generation++;
    const session = this.session;
    if (session) {
      session.finished = true;
      this.releaseSession(session);
      session.chunks = [];
      session.reject?.(recordingCancelled());
    }
    this.startPromise = null;
    this.state = 'idle';
  }

  dispose() {
    this.disposed = true;
    this.cancel();
  }
}
