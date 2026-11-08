import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Store } from "./store.js";
import { startServer } from "../server.js";

async function streamFixture(t, { transcribeProvider = "openai", key = "test-key" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ghst-stream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init();
  await store.update((state) => {
    state.apiKey = key;
    state.settings.transcribeProvider = transcribeProvider;
    state.settings.transcribeModel = "gpt-live-transcribe";
    state.settings.language = "en";
  });
  const record = { sessions: [], appended: [], commits: [], closed: 0 };
  const { server, url } = await startServer({
    port: 0,
    store,
    agentRuntime: { answer() {}, command() {}, close() {} },
    subscription: { async status() { return { connected: true }; }, close() {} },
    createRealtime(options) {
      record.sessions.push(options);
      return {
        ready: Promise.resolve(),
        append(bytes) {
          record.appended.push(Buffer.from(bytes));
        },
        commit(seq) {
          record.commits.push(seq);
        },
        close() {
          record.closed++;
        },
      };
    },
  });
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.terminate();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const connect = (options = {}) => {
    const client = new WebSocket(url.replace("http", "ws") + "/api/transcribe/stream", options);
    clients.add(client);
    return client;
  };
  return { store, record, connect };
}

function nextMessage(client) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      client.off("error", onError);
      resolve(JSON.parse(data.toString()));
    };
    const onError = (error) => {
      client.off("message", onMessage);
      reject(error);
    };
    client.once("message", onMessage);
    client.once("error", onError);
  });
}

function rejection(client) {
  return new Promise((resolve) => {
    client.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    client.once("error", () => {});
  });
}

test("a local speech stream forwards PCM, commits, and transcript events", async (t) => {
  const { record, connect } = await streamFixture(t);
  const client = connect();
  assert.deepEqual(await nextMessage(client), { type: "ready" });
  const [options] = record.sessions;
  assert.equal(options.apiKey, "test-key");
  assert.equal(options.model, "gpt-live-transcribe");
  assert.equal(options.language, "en");

  client.send(Buffer.from([9, 8, 7]));
  client.send(JSON.stringify({ type: "commit", seq: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(record.appended, [Buffer.from([9, 8, 7])]);
  assert.deepEqual(record.commits, [2]);

  const completed = nextMessage(client);
  options.onCompleted({ seq: 2, transcript: "Question about the third chapter." });
  assert.deepEqual(await completed, {
    type: "completed",
    seq: 2,
    transcript: "Question about the third chapter.",
  });
  const delta = nextMessage(client);
  options.onDelta({ seq: 2, delta: "Question about" });
  assert.deepEqual(await delta, { type: "delta", seq: 2, delta: "Question about" });

  client.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(record.closed, 1);
});

test("a local transcription provider refuses the speech stream", async (t) => {
  const { connect } = await streamFixture(t, { transcribeProvider: "local" });
  const message = await nextMessage(connect());
  assert.equal(message.type, "error");
  assert.match(message.message, /OpenAI transcription/);
});

test("a missing API key refuses the speech stream", async (t) => {
  const { connect } = await streamFixture(t, { key: "" });
  const message = await nextMessage(connect());
  assert.equal(message.type, "error");
  assert.match(message.message, /API key/);
});

test("a fourth speech stream is refused", async (t) => {
  const { connect } = await streamFixture(t);
  for (const client of [connect(), connect(), connect()])
    assert.deepEqual(await nextMessage(client), { type: "ready" });
  const message = await nextMessage(connect());
  assert.equal(message.type, "error");
  assert.match(message.message, /already open/);
});

test("a non-local Host header refuses the speech stream", async (t) => {
  const { connect } = await streamFixture(t);
  const { status } = await rejection(connect({ headers: { host: "remote.example" } }));
  assert.equal(status, 403);
});
