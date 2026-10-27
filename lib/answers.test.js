import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { answerEvents } from "./answers.js";
import { clientFor } from "./openai.js";
import { DEFAULT_SETTINGS, HttpError, Store } from "./store.js";
import { startServer } from "../server.js";

function api({ text = "API answer [1]", finish = "stop", error } = {}) {
  const requests = [];
  return {
    requests,
    client: {
      chat: {
        completions: {
          async create(body, options) {
            requests.push({ body, options });
            if (error) throw error;
            return (async function* () {
              yield { choices: [{ delta: { content: text } }] };
              if (finish)
                yield { choices: [{ delta: {}, finish_reason: finish }] };
            })();
          },
        },
      },
    },
  };
}

function failingSubscription(error, partial = "") {
  return {
    async *answer() {
      if (partial) yield partial;
      throw error;
    },
    close() {},
  };
}

function generation(overrides = {}) {
  const transport = api();
  let clients = 0;
  const options = {
    settings: { ...DEFAULT_SETTINGS, answerModel: "gpt-4o-mini" },
    messages: [
      { role: "system", content: "Use references." },
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Current question and references" },
    ],
    subscription: failingSubscription(new HttpError(429, "Subscription quota")),
    signal: new AbortController().signal,
    createClient() {
      clients++;
      return transport.client;
    },
    ...overrides,
  };
  return { options, transport, clients: () => clients };
}

async function collect(options) {
  const events = [];
  for await (const event of answerEvents(options)) events.push(event);
  return events;
}

test("successful subscription answers never construct an API client", async () => {
  const fixture = generation({
    subscription: {
      async *answer() {
        yield "Subscription ";
        yield "answer";
      },
    },
  });
  assert.deepEqual(await collect(fixture.options), [
    { type: "delta", text: "Subscription " },
    { type: "delta", text: "answer" },
  ]);
  assert.equal(fixture.clients(), 0);
});

for (const [status, reason] of [
  [401, "Subscription login expired"],
  [429, "Subscription quota reached"],
  [503, "Subscription disconnected or unavailable"],
  [502, "Subscription generation failed"],
  [504, "Subscription timed out"],
]) {
  test(`${reason} falls back with the saved model and unchanged context`, async () => {
    const fixture = generation({
      subscription: failingSubscription(new HttpError(status, reason)),
    });
    assert.deepEqual(await collect(fixture.options), [
      { type: "fallback", provider: "openai", reason },
      { type: "delta", text: "API answer [1]" },
    ]);
    assert.equal(fixture.clients(), 1);
    const [{ body, options }] = fixture.transport.requests;
    assert.equal(body.messages, fixture.options.messages);
    assert.equal(body.model, "gpt-4o-mini");
    assert.equal(body.stream, true);
    assert.equal(body.max_completion_tokens, 4000);
    assert.equal(options.signal, fixture.options.signal);
  });
}

test("partial subscription text is reset before fallback deltas", async () => {
  const reason = "Subscription quota reached";
  const fixture = generation({
    subscription: failingSubscription(new HttpError(429, reason), "Discard me"),
  });
  const events = await collect(fixture.options);
  assert.deepEqual(events, [
    { type: "delta", text: "Discard me" },
    { type: "reset", reason },
    { type: "fallback", provider: "openai", reason },
    { type: "delta", text: "API answer [1]" },
  ]);
  let displayed = "";
  for (const event of events) {
    if (event.type === "reset") displayed = "";
    if (event.type === "delta") displayed += event.text;
  }
  assert.equal(displayed, "API answer [1]");
});

test("empty subscription answers also fall back", async () => {
  const fixture = generation({ subscription: { async *answer() {} } });
  const events = await collect(fixture.options);
  assert.equal(events[0].type, "fallback");
  assert.equal(fixture.transport.requests.length, 1);
});

test("missing fallback key reports the Settings action without an API request", async () => {
  const fixture = generation({ createClient: () => clientFor({ key: () => "" }) });
  await assert.rejects(collect(fixture.options), /Add an OpenAI API key in Settings/);
  assert.equal(fixture.transport.requests.length, 0);
});

test("fallback failure propagates once without retrying either provider", async () => {
  const failure = new HttpError(429, "API quota reached");
  const transport = api({ error: failure });
  const fixture = generation({ createClient: () => transport.client });
  await assert.rejects(collect(fixture.options), (error) => error === failure);
  assert.equal(transport.requests.length, 1);
});

for (const answerProvider of ["chatgpt", "openai"]) {
  test(`${answerProvider} API streams still require a finish reason`, async () => {
    const transport = api({ finish: null });
    const fixture = generation({
      settings: { ...DEFAULT_SETTINGS, answerProvider },
      createClient: () => transport.client,
    });
    await assert.rejects(collect(fixture.options), /stream ended unexpectedly/);
    assert.equal(transport.requests.length, 1);
  });
}

test("direct API mode keeps its model, refusal text, and length-limit notice", async () => {
  const transport = api({ finish: "length" });
  const fixture = generation({
    settings: { ...DEFAULT_SETTINGS, answerProvider: "openai" },
    subscription: { answer: () => assert.fail("Subscription must not run") },
    createClient: () => transport.client,
  });
  const events = await collect(fixture.options);
  assert.ok(events.every((event) => event.type === "delta"));
  assert.equal(events[0].text, "API answer [1]");
  assert.match(events[1].text, /model reached its response limit/);
  assert.equal(transport.requests[0].body.model, DEFAULT_SETTINGS.answerModel);
});

for (const failure of [
  new HttpError(499, "Cancelled"),
  Object.assign(new Error("Cancelled"), { name: "AbortError" }),
  Object.assign(new Error("Cancelled"), { name: "APIUserAbortError" }),
  Object.assign(new Error("Disk full"), { code: "ENOSPC", syscall: "write" }),
  new HttpError(500, "Local persistence failed"),
]) {
  test(`${failure.name}: ${failure.message} does not activate fallback`, async () => {
    const fixture = generation({ subscription: failingSubscription(failure, "Partial") });
    await assert.rejects(collect(fixture.options), (error) => error === failure);
    assert.equal(fixture.clients(), 0);
    assert.equal(fixture.transport.requests.length, 0);
  });
}

test("an already-cancelled request never starts either provider", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = generation({
    signal: controller.signal,
    subscription: { answer: () => assert.fail("Subscription must not run") },
  });
  await assert.rejects(collect(fixture.options), (error) => error.status === 499);
  assert.equal(fixture.clients(), 0);
});

test("cancellation racing a subscription failure never constructs the API client", async () => {
  const controller = new AbortController();
  const fixture = generation({
    signal: controller.signal,
    subscription: {
      async *answer() {
        yield "Partial";
        controller.abort();
        throw new HttpError(503, "Disconnected");
      },
    },
  });
  await assert.rejects(collect(fixture.options), (error) => error.status === 499);
  assert.equal(fixture.clients(), 0);
});

for (const boundary of ["delta", "reset", "fallback"]) {
  test(`cancelling after the ${boundary} event cannot bill fallback`, async () => {
    const controller = new AbortController();
    const fixture = generation({
      signal: controller.signal,
      subscription: failingSubscription(new HttpError(429, "Quota"), "Partial"),
    });
    await assert.rejects(
      async () => {
        for await (const event of answerEvents(fixture.options)) {
          if (event.type === boundary) controller.abort();
        }
      },
      (error) => error.status === 499,
    );
    assert.equal(fixture.transport.requests.length, 0);
  });
}

test("response-write failures stay outside the provider fallback boundary", async () => {
  const fixture = generation({
    subscription: failingSubscription(new HttpError(429, "Quota"), "Partial"),
  });
  const failure = new Error("Response closed");
  await assert.rejects(async () => {
    for await (const _event of answerEvents(fixture.options)) throw failure;
  }, (error) => error === failure);
  assert.equal(fixture.clients(), 0);
});

async function serverFixture(t, { subscription, transport = api(), key = "saved-test-key" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ghst-fallback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init();
  const reference = {
    id: "reference",
    name: "Reference.pdf",
    type: "pdf",
    pages: [{ page: 3, text: "Thesis evidence supports the research conclusion." }],
  };
  await writeFile(join(store.documentDirectory, "reference.json"), JSON.stringify(reference));
  await writeFile(join(store.documentDirectory, "reference.pdf"), "reference fixture");
  await store.update((state) => {
    state.apiKey = key;
    state.settings.answerModel = "gpt-4o-mini";
    state.documents.push({ id: reference.id, name: reference.name, type: reference.type });
    state.sessions.push({
      id: "session",
      title: "Defense",
      createdAt: "2026-01-01T00:00:00Z",
      transcript: [{ id: "transcript", time: "12:00", text: "Meeting context" }],
      messages: [
        { id: "old-user", role: "user", text: "Earlier question" },
        { id: "old-answer", role: "assistant", text: "Earlier answer" },
      ],
    });
  });
  let clients = 0;
  const { server, url } = await startServer({
    port: 0,
    store,
    subscription: subscription || failingSubscription(new HttpError(429, "Subscription quota"), "Discard this"),
    createClient(savedStore) {
      clients++;
      assert.equal(savedStore.state.apiKey, key);
      if (!key) return clientFor({ key: () => "" });
      return transport.client;
    },
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const request = (body = {}, options = {}) => fetch(`${url}/api/sessions/session/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "What thesis evidence supports the research conclusion?",
      requestId: "request-one",
      answerProvider: "chatgpt",
      ...body,
    }),
    ...options,
  });
  const events = async (body) => {
    const response = await request(body);
    assert.equal(response.status, 200);
    return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  };
  return { store, transport, request, events, clients: () => clients };
}

test("HTTP fallback replaces partial text and saves one answer with history and sources", async (t) => {
  const fixture = await serverFixture(t);
  const events = await fixture.events();
  assert.deepEqual(events.map((event) => event.type), ["sources", "delta", "reset", "fallback", "delta", "done"]);
  const sources = events[0].sources;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].page, 3);
  const saved = fixture.store.session("session").messages;
  assert.equal(saved.length, 4);
  assert.equal(saved[2].role, "user");
  assert.equal(saved[2].pending, undefined);
  assert.equal(saved[3].text, "API answer [1]");
  assert.deepEqual(saved[3].sources, sources);
  assert.equal(events.at(-1).message.text, "API answer [1]");
  const [{ body }] = fixture.transport.requests;
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages.slice(1, 3), [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
  ]);
  assert.match(body.messages.at(-1).content, /Meeting context/);
  assert.match(body.messages.at(-1).content, /Reference\.pdf/);
  assert.match(body.messages.at(-1).content, /sourceNumber/);
  assert.deepEqual((await fixture.events()).map((event) => event.type), ["sources", "done"]);
  assert.equal(fixture.store.session("session").messages.length, 4);
  assert.equal(fixture.transport.requests.length, 1);
});

test("HTTP missing fallback key leaves one retryable user message and no assistant", async (t) => {
  const fixture = await serverFixture(t, { key: "" });
  for (let attempt = 0; attempt < 2; attempt++) {
    const events = await fixture.events();
    assert.equal(events.at(-1).type, "error");
    assert.match(events.at(-1).error, /Add an OpenAI API key in Settings/);
    assert.ok(!events.some((event) => event.type === "fallback"));
  }
  const messages = fixture.store.session("session").messages;
  assert.equal(messages.length, 3);
  assert.equal(messages.at(-1).pending, true);
  assert.equal(fixture.transport.requests.length, 0);
});

for (const failAt of [1, 2]) {
  test(`local persistence failure at write ${failAt} never starts fallback`, async (t) => {
    const fixture = await serverFixture(t, {
      subscription: { async *answer() { yield "Subscription answer"; }, close() {} },
    });
    const update = fixture.store.update.bind(fixture.store);
    let writes = 0;
    fixture.store.update = (change) => {
      writes++;
      if (writes === failAt) return Promise.reject(new Error("Disk full"));
      return update(change);
    };
    const response = await fixture.request();
    if (failAt === 1) assert.equal(response.status, 500);
    else {
      const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events.at(-1).type, "error");
    }
    assert.equal(fixture.clients(), 0);
    assert.equal(fixture.store.session("session").messages.length, failAt === 1 ? 2 : 3);
  });
}

test("provider queue mismatch rejects before subscription or API generation", async (t) => {
  const fixture = await serverFixture(t, {
    subscription: { answer: () => assert.fail("Subscription must not run"), close() {} },
  });
  const response = await fixture.request({ answerProvider: "openai" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /connection changed/);
  assert.equal(fixture.clients(), 0);
});

test("local response limit does not activate fallback", async (t) => {
  const fixture = await serverFixture(t, {
    subscription: { async *answer() { yield "x".repeat(64001); }, close() {} },
  });
  const events = await fixture.events();
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).error, /local response limit/);
  assert.equal(fixture.clients(), 0);
});

test("HTTP client disconnect cancels subscription without billing fallback", { timeout: 5000 }, async (t) => {
  const finished = Promise.withResolvers();
  const fixture = await serverFixture(t, {
    subscription: {
      async *answer({ signal }) {
        try {
          yield "Partial";
          if (!signal.aborted)
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          throw new HttpError(503, "Subscription disconnected");
        } finally {
          finished.resolve();
        }
      },
      close() {},
    },
  });
  const controller = new AbortController();
  const response = await fixture.request({}, { signal: controller.signal });
  const reader = response.body.getReader();
  let received = "";
  while (!received.includes("Partial")) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += new TextDecoder().decode(value);
  }
  controller.abort();
  await finished.promise;
  await setImmediate();
  assert.equal(fixture.clients(), 0);
  assert.equal(fixture.store.session("session").messages.length, 3);
});
