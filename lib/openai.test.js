import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWav } from "./openai.js";

function pcmWav({
  channels = 1,
  bits = 16,
  sampleRate = 16000,
  frames = 800,
} = {}) {
  const alignment = (channels * bits) / 8;
  const dataLength = frames * alignment;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * alignment, 28);
  buffer.writeUInt16LE(alignment, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

async function wavFile(t, buffer) {
  const directory = await mkdtemp(join(tmpdir(), "thesis-wav-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "recording.wav");
  await writeFile(path, buffer);
  return path;
}

test("a recording chunk with no WAV header is rejected", async (t) => {
  const path = await wavFile(t, pcmWav().subarray(44));
  await assert.rejects(validateWav(path), (error) => error.status === 422);
});

test("a truncated WAV is rejected even when its RIFF size is adjusted", async (t) => {
  const partial = Buffer.from(pcmWav().subarray(0, 100));
  partial.writeUInt32LE(partial.length - 8, 4);
  const path = await wavFile(t, partial);
  await assert.rejects(validateWav(path), (error) => error.status === 422);
});

test("a WAV with an incomplete declared RIFF payload is rejected", async (t) => {
  const path = await wavFile(t, pcmWav().subarray(0, 100));
  await assert.rejects(validateWav(path), (error) => error.status === 422);
});

test("inconsistent PCM frame alignment is rejected", async (t) => {
  const buffer = pcmWav({ channels: 2 });
  buffer.writeUInt16LE(2, 32);
  const path = await wavFile(t, buffer);
  await assert.rejects(validateWav(path), (error) => error.status === 422);
});

test("audio duration beyond 120 seconds is rejected", async (t) => {
  const path = await wavFile(
    t,
    pcmWav({ sampleRate: 8000, frames: 8000 * 121 }),
  );
  await assert.rejects(validateWav(path), (error) => error.status === 413);
});
