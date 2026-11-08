import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeTranscription } from "./realtime.js";

class FakeSocket {
  static instances = [];
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function session(options = {}) {
  FakeSocket.instances = [];
  const events = { deltas: [], completed: [], failures: [] };
  const connection = new RealtimeTranscription({
    apiKey: "test-key",
    language: "en",
    onDelta: (delta) => events.deltas.push(delta),
    onCompleted: (done) => events.completed.push(done),
    onFailure: (message) => events.failures.push(message),
    WebSocketImpl: FakeSocket,
    ...options,
  });
  connection.socket.open();
  connection.socket.receive({ type: "session.updated" });
  return { connection, socket: connection.socket, events };
}

test("the session update streams 24 kHz PCM and carries the model, language, and key", async () => {
  const { connection, socket } = session({ model: "gpt-transcribe" });
  await connection.ready;
  assert.equal(socket.options.headers.Authorization, "Bearer test-key");
  const [update] = socket.sent;
  assert.deepEqual(update, {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-transcribe", language: "en" },
          turn_detection: null,
        },
      },
    },
  });
});

test("audio frames become base64 append messages and commits keep their sequence", async () => {
  const { connection, socket, events } = session();
  await connection.ready;
  connection.append(new Uint8Array([1, 2, 3]));
  connection.commit(4);
  assert.deepEqual(socket.sent.slice(1), [
    { type: "input_audio_buffer.append", audio: "AQID" },
    { type: "input_audio_buffer.commit" },
  ]);
  socket.receive({ type: "input_audio_buffer.committed", item_id: "item-1" });
  socket.receive({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-1",
    delta: "Hello",
  });
  socket.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-1",
    transcript: "  Hello there.  ",
  });
  assert.deepEqual(events.deltas, [{ seq: 4, delta: "Hello" }]);
  assert.deepEqual(events.completed, [{ seq: 4, transcript: "Hello there." }]);
});

test("a completion without a commit mapping reports a null sequence", async () => {
  const { socket, events } = session();
  socket.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "unknown",
    transcript: "Unmapped speech",
  });
  assert.deepEqual(events.completed, [{ seq: null, transcript: "Unmapped speech" }]);
});

test("upstream failures reach the caller and keep the reason", async () => {
  const { connection, socket, events } = session();
  await connection.ready;
  socket.receive({ type: "error", error: { message: "Invalid audio format." } });
  socket.receive({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "item-2",
    error: { message: "Silence." },
  });
  assert.deepEqual(events.failures, [
    "Transcription failed: Invalid audio format.",
    "Transcription failed: Silence.",
  ]);
});

test("audio sent before the upstream socket opens is queued and flushed in order", () => {
  FakeSocket.instances = [];
  const connection = new RealtimeTranscription({ apiKey: "key", WebSocketImpl: FakeSocket });
  const socket = connection.socket;
  connection.append(new Uint8Array([5]));
  connection.commit(1);
  assert.deepEqual(socket.sent, []);
  socket.open();
  assert.deepEqual(
    socket.sent.map((message) => message.type),
    ["session.update", "input_audio_buffer.append", "input_audio_buffer.commit"],
  );
});

test("an unsupported model fails before any socket opens", () => {
  FakeSocket.instances = [];
  assert.throws(
    () => new RealtimeTranscription({ apiKey: "key", model: "gpt-4o-transcribe", WebSocketImpl: FakeSocket }),
    (error) => error.status === 400,
  );
  assert.equal(FakeSocket.instances.length, 0);
});

test("a deliberate close does not report a stream failure", async () => {
  const { connection, socket, events } = session();
  await connection.ready;
  connection.close();
  assert.equal(socket.closed, true);
  assert.deepEqual(events.failures, []);
});

test("an unexpected close after setup reports a stream failure", async () => {
  const { connection, socket, events } = session();
  await connection.ready;
  socket.closed = true;
  socket.onclose();
  assert.deepEqual(events.failures, ["The speech stream closed. Start listening to reconnect."]);
});
