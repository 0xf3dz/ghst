"use strict";
const { spawn } = require('node:child_process');
const { buildZoomAudio } = require('./build-zoom-audio.cjs');
class ZoomAudio {
  constructor(send) { this.send = send; this.current = null; }
  async start() {
    if (process.platform !== 'darwin') throw new Error('Zoom-only capture requires macOS. Select a dedicated Zoom-only virtual audio input.');
    if (this.current) throw new Error('Zoom capture is already active. Stop capture first.');
    const binary = buildZoomAudio();
    const child = spawn(binary, [], { stdio: ['pipe','pipe','pipe'], shell: false });
    const state = { child, buffer: Buffer.alloc(0), ready: false, stopping: false, failed: false };
    this.current = state;
    child.stderr.resume();
    child.stdin.on('error', () => {});
    return new Promise((resolve, reject) => {
      const fail = (message) => {
        if (state.failed || state.stopping) return;
        state.failed = true;
        clearTimeout(state.timer);
        if (!state.ready) reject(new Error(message));
        else this.send('desktop:zoom-audio-error', message);
        this.stop();
      };
      state.reject = reject;
      state.timer = setTimeout(() => fail('Zoom supplied no audio. Join computer audio, play remote speech, and check Screen & System Audio Recording permission.'), 30000);
      child.once('error', () => fail('Could not launch the Zoom audio helper. Rebuild the app and try again.'));
      child.once('close', () => {
        state.closed = true;
        clearTimeout(state.timer);
        clearTimeout(state.killTimer);
        if (!state.stopping) fail('Zoom audio capture ended. Restart capture.');
        if (this.current === state) this.current = null;
      });
      child.stdout.on('data', (chunk) => {
        if (state.stopping) return;
        state.buffer = Buffer.concat([state.buffer, chunk]);
        while (state.buffer.length >= 4) {
          const length = state.buffer.readUInt32LE(0);
          if (length < 1 || length > 8193) { fail('Invalid Zoom audio packet. Restart capture.'); return; }
          if (state.buffer.length < length + 4) break;
          const type = state.buffer[4];
          const body = state.buffer.subarray(5, length + 4);
          state.buffer = state.buffer.subarray(length + 4);
          if (type === 3) { fail(body.toString('utf8').slice(0,4096)); return; }
          if (type === 1 && body.length === 8 && !state.ready) {
            const sampleRate = body.readDoubleLE();
            if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) { fail('Invalid Zoom audio rate.'); return; }
            state.ready = true;
            clearTimeout(state.timer);
            resolve({sampleRate});
          } else if (type === 2 && state.ready && body.length > 0 && body.length % 4 === 0) {
            const data = new Float32Array(body.length / 4);
            for (let i=0;i<data.length;i++) data[i] = body.readFloatLE(i*4);
            if (!data.every(Number.isFinite)) { fail('Invalid Zoom audio samples.'); return; }
            this.send('desktop:zoom-audio', data);
          } else { fail('Invalid Zoom audio sequence. Restart capture.'); return; }
        }
      });
    });
  }
  async stop() {
    const state = this.current;
    if (!state || state.stopping) return;
    state.stopping = true;
    clearTimeout(state.timer);
    if (!state.ready) state.reject?.(new Error('Zoom audio capture stopped.'));
    state.child.stdin.end();
    state.child.kill('SIGTERM');
    if (!state.closed) await new Promise(resolve => {
      state.child.once('close', resolve);
      state.killTimer = setTimeout(() => { state.child.kill('SIGKILL'); }, 1000);
    });
    clearTimeout(state.killTimer);
    if (this.current === state) this.current = null;
  }
}
module.exports = { ZoomAudio };
