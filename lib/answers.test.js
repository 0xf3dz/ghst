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

function api({ text = "API answer [1]", finish = "stop", error, refusal = false } = {}) {
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
              yield { choices: [{ delta: { [refusal ? "refusal" : "content"]: text } }] };
              if (finish) yield { choices: [{ delta: {}, finish_reason: finish }] };
            })();
          },
        },
      },
    },
  };
}

const toolEvents = [
  { type: "tool_execution_start", toolCallId: "call-one", toolName: "read", args: { path: "references/reference.txt" } },
  { type: "tool_execution_end", toolCallId: "call-one", toolName: "read", result: { content: [{ type: "text", text: "Page 3\nThesis evidence supports the research conclusion." }] }, isError: false },
];

function runtime(answer = async function* () {
  for (const event of toolEvents) yield { type: "agent", event };
  yield { type: "delta", text: "Agent answer (Reference.pdf, p. 3)" };
}) {
  return { answer, command() {}, close() {} };
}

function failingRuntime(error, events = []) {
  return runtime(async function* () {
    yield* events;
    throw error;
  });
}

function generation(overrides = {}) {
  const transport = api();
  let clients = 0;
  const options = {
    settings: { ...DEFAULT_SETTINGS, answerProvider: "chatgpt", answerModel: "gpt-4o-mini" },
    messages: [
      { role: "system", content: "Use references." },
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Current question and references" },
    ],
    agentRuntime: runtime(),
    sessionId: "session",
    question: "Current question",
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

for (const answerProvider of ["chatgpt", "claude", "gemini", "groq"]) {
  test(`${answerProvider} forwards persistent runtime events and the complete request unchanged`, async () => {
    const emitted = [...toolEvents.map((event) => ({ type: "agent", event })), { type: "delta", text: "Agent answer" }];
    let received;
    const fixture = generation({
      settings: { ...DEFAULT_SETTINGS, answerProvider },
      agentRuntime: runtime(async function* (request) { received = request; yield* emitted; }),
    });
    const actual = await collect(fixture.options);
    assert.deepEqual(actual, emitted);
    for (let index = 0; index < emitted.length; index++) assert.equal(actual[index], emitted[index]);
    for (const key of ["sessionId", "settings", "messages", "question", "signal"])
      assert.equal(received[key], fixture.options[key]);
    assert.deepEqual(Object.keys(received).sort(), ["messages", "question", "sessionId", "settings", "signal"]);
    assert.equal(fixture.clients(), 0);
  });
}

for (const agentRuntime of [undefined, {}]) {
  test("omp generation requires an agent runtime instead of silently selecting another provider", async () => {
    const fixture = generation({ agentRuntime });
    await assert.rejects(collect(fixture.options), (error) => error.status === 503 && /agent runtime/i.test(error.message));
    assert.equal(fixture.clients(), 0);
  });
}

for (const failure of [
  ...[401, 429, 502, 503, 504].map((status) => new HttpError(status, "Agent request failed")),
  new HttpError(499, "Cancelled"),
  Object.assign(new Error("Cancelled"), { name: "AbortError" }),
  Object.assign(new Error("Cancelled"), { name: "APIUserAbortError" }),
  Object.assign(new Error("Disk full"), { code: "ENOSPC", syscall: "write" }),
  new HttpError(500, "Local persistence failed"),
]) {
  test(`${failure.name} ${failure.status || failure.code || failure.message} never retries persistent actions through an API or local fallback`, async (t) => {
    t.mock.method(globalThis, "fetch", () => assert.fail("No local fallback request is allowed"));
    const partial = [{ type: "agent", event: toolEvents[0] }, { type: "delta", text: "Partial" }];
    for (const answerModel of ["gpt-4o-mini", "ollama:local-model"]) {
      const fixture = generation({
        settings: { ...DEFAULT_SETTINGS, answerProvider: "chatgpt", answerModel },
        agentRuntime: failingRuntime(failure, partial),
      });
      const received = [];
      await assert.rejects(async () => {
        for await (const event of answerEvents(fixture.options)) received.push(event);
      }, (error) => error === failure);
      assert.deepEqual(received, partial);
      assert.equal(fixture.clients(), 0);
      assert.equal(fixture.transport.requests.length, 0);
    }
  });
}

test("an already-cancelled request never starts any provider", async () => {
  const fixture = generation({
    signal: AbortSignal.abort(),
    agentRuntime: runtime(() => assert.fail("Agent must not run")),
  });
  await assert.rejects(collect(fixture.options), (error) => error.status === 499);
  assert.equal(fixture.clients(), 0);
});

test("cancelling after an agent event closes its iterator without replaying actions", async () => {
  const controller = new AbortController();
  let closed = false;
  const fixture = generation({
    signal: controller.signal,
    agentRuntime: runtime(async function* () {
      try {
        yield { type: "agent", event: toolEvents[0] };
        yield { type: "delta", text: "Do not forward after cancellation" };
      } finally { closed = true; }
    }),
  });
  const received = [];
  await assert.rejects(async () => {
    for await (const event of answerEvents(fixture.options)) {
      received.push(event);
      controller.abort();
    }
  }, (error) => error.status === 499);
  assert.equal(received.length, 1);
  assert.equal(closed, true);
  assert.equal(fixture.clients(), 0);
});

test("response-write failures close the persistent iterator without starting another provider", async () => {
  let closed = false;
  const fixture = generation({ agentRuntime: runtime(async function* () {
    try { yield { type: "delta", text: "Partial" }; }
    finally { closed = true; }
  }) });
  const failure = new Error("Response closed");
  await assert.rejects(async () => {
    for await (const _event of answerEvents(fixture.options)) throw failure;
  }, (error) => error === failure);
  assert.equal(closed, true);
  assert.equal(fixture.clients(), 0);
});

test("direct API mode keeps its model, context, refusal text, and length-limit notice", async () => {
  const transport = api({ finish: "length", refusal: true });
  const fixture = generation({
    settings: { ...DEFAULT_SETTINGS, answerProvider: "openai" },
    agentRuntime: runtime(() => assert.fail("Agent must not run")),
    client: transport.client,
  });
  const events = await collect(fixture.options);
  assert.ok(events.every((event) => event.type === "delta"));
  assert.equal(events[0].text, "API answer [1]");
  assert.match(events[1].text, /model reached its response limit/);
  const [{ body, options }] = transport.requests;
  assert.equal(body.model, DEFAULT_SETTINGS.answerModel);
  assert.equal(body.messages, fixture.options.messages);
  assert.equal(body.stream, true);
  assert.equal(body.max_completion_tokens, 4000);
  assert.equal(options.signal, fixture.options.signal);
  assert.equal(fixture.clients(), 0);
});

for (const [options, expected] of [
  [{ finish: null }, /stream ended unexpectedly/],
  [{ text: " " }, /no answer text/],
]) {
  test(`direct API rejects ${expected.source}`, async () => {
    const transport = api(options);
    const fixture = generation({
      settings: { ...DEFAULT_SETTINGS, answerProvider: "openai" },
      createClient: () => transport.client,
    });
    await assert.rejects(collect(fixture.options), expected);
    assert.equal(transport.requests.length, 1);
  });
}

test("direct API reports a missing key without attempting an agent", async () => {
  const fixture = generation({
    settings: { ...DEFAULT_SETTINGS, answerProvider: "openai" },
    createClient: () => clientFor({ key: () => "" }),
    agentRuntime: runtime(() => assert.fail("Agent must not run")),
  });
  await assert.rejects(collect(fixture.options), /Add an OpenAI API key in Settings/);
});

for (const answerProvider of ["ollama", "custom"]) {
  test(`direct ${answerProvider} keeps its configured HTTP transport and context`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      requests.push({ url, options });
      return answerProvider === "ollama"
        ? new Response(JSON.stringify({ message: { role: "assistant", content: "Local answer" }, done: true }) + "\n")
        : Response.json({ choices: [{ message: { content: "Local answer" }, finish_reason: "stop" }] });
    });
    const fixture = generation({
      settings: {
        ...DEFAULT_SETTINGS, answerProvider, answerModel: "local-model",
        ollamaUrl: "http://127.0.0.1:11434",
        customCurl: `curl https://service.example/chat -d '{"model":{{model}},"messages":{{messages}}}'`,
      },
      agentRuntime: runtime(() => assert.fail("Agent must not run")),
    });
    assert.deepEqual(await collect(fixture.options), [{ type: "delta", text: "Local answer" }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, answerProvider === "ollama" ? "http://127.0.0.1:11434/api/chat" : "https://service.example/chat");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.model, "local-model");
    assert.deepEqual(body.messages, fixture.options.messages);
    assert.equal(fixture.clients(), 0);
  });
}

async function serverFixture(t, { agentRuntime = runtime(), transport = api(), key = "saved-test-key" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ghst-agent-answers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init();
  const reference = {
    id: "reference", name: "Reference.pdf", type: "pdf",
    pages: [{ page: 3, text: "Thesis evidence supports the research conclusion." }],
  };
  await writeFile(join(store.documentDirectory, "reference.json"), JSON.stringify(reference));
  await writeFile(join(store.documentDirectory, "reference.pdf"), "reference fixture");
  await store.update((state) => {
    state.apiKey = key;
    state.settings.answerProvider = "chatgpt";
    state.settings.answerModel = "gpt-4o-mini";
    state.documents.push({ id: reference.id, sessionId: "session", name: reference.name, type: reference.type });
    state.sessions.unshift({
      id: "session", title: "Defense", createdAt: "2026-01-01T00:00:00Z",
      transcript: [{ id: "transcript", time: "12:00", text: "Meeting context" }],
      messages: [
        { id: "old-user", role: "user", text: "Earlier question" },
        { id: "old-answer", role: "assistant", text: "Earlier answer" },
      ],
    });
    state.sessions.push({
      id: "other-session", title: "Private meeting", createdAt: "2026-01-01T00:00:00Z",
      transcript: [{ id: "private-transcript", time: "12:00", text: "Other session private transcript" }],
      messages: [{ id: "private-message", role: "user", text: "Other session private question" }],
    });
  });
  let clients = 0;
  const { server, url } = await startServer({
    port: 0, store, agentRuntime,
    subscription: { async status() { return { connected: true }; }, close() {} },
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
  const request = (body = {}, options = {}, sessionId = "session") => fetch(`${url}/api/sessions/${sessionId}/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "What thesis evidence supports the research conclusion?",
      requestId: "request-one", answerProvider: "chatgpt", ...body,
    }),
    ...options,
  });
  const events = async (body, sessionId) => {
    const response = await request(body, {}, sessionId);
    assert.equal(response.status, 200);
    return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  };
  return { store, transport, request, events, url, clients: () => clients };
}

test("HTTP forwards tool events, persists them with one answer, and keeps current-session context isolated", async (t) => {
  const requests = [];
  const fixture = await serverFixture(t, {
    agentRuntime: runtime(async function* (request) {
      requests.push(request);
      for (const event of toolEvents) yield { type: "agent", event };
      yield { type: "delta", text: "Agent answer (Reference.pdf, p. 3)" };
    }),
  });
  const events = await fixture.events();
  assert.deepEqual(events.map((event) => event.type), ["agent", "agent", "delta", "done"]);
  assert.deepEqual(events.filter((event) => event.type === "agent").map((event) => event.event), toolEvents);
  const saved = fixture.store.session("session").messages;
  assert.equal(saved.length, 4);
  assert.equal(saved[2].pending, undefined);
  assert.equal(saved[3].text, "Agent answer (Reference.pdf, p. 3)");
  assert.equal(saved[3].sources, undefined);
  assert.deepEqual(saved[3].agentEvents, toolEvents);
  assert.deepEqual(events.at(-1).message.agentEvents, toolEvents);
  assert.equal(requests[0].sessionId, "session");
  assert.equal(requests[0].question, "What thesis evidence supports the research conclusion?");
  assert.equal(requests[0].settings.answerProvider, "chatgpt");
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.deepEqual(requests[0].messages.slice(1, 3), [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
  ]);
  assert.match(requests[0].messages.at(-1).content, /Meeting context/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /Thesis evidence supports|referencePassages|Other session private/);
  assert.equal(fixture.store.session("other-session").messages.length, 1);
  assert.deepEqual((await fixture.events()).map((event) => event.type), ["done"]);
  assert.equal(requests.length, 1);
  const hidden = await fixture.request({ question: "Explain this meeting", requestId: "request-two" }, {}, "other-session");
  assert.equal(hidden.status, 404);
  assert.equal(requests.length, 1);
  assert.equal(fixture.store.session("other-session").messages.length, 1);
  assert.equal(fixture.store.session("session").messages.length, 4);
  assert.equal(fixture.clients(), 0);
});

test("consecutive transcript answers reuse the single persistent conversation", async t => {
  const requests = [];
  const fixture = await serverFixture(t, {
    agentRuntime: runtime(async function* (request) {
      requests.push(request);
      yield { type: "delta", text: `Answer for ${request.question}` };
    }),
  });
  const post = (path, body) => fetch(`${fixture.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const [index, question] of ["First spoken question", "Second spoken question"].entries()) {
    const response = await post("/api/sessions/session/transcript", { text: question, requestId: `transcript-${index}` });
    assert.equal(response.status, 201);
    const events = await fixture.events({ question: (await response.json()).text, requestId: `spoken-${index}` });
    assert.equal(events.at(-1).type, "done");
    assert.ok(events.every(event => event.type !== "interaction"));
  }
  assert.deepEqual(requests.map(request => request.sessionId), ["session", "session"]);
  assert.match(JSON.stringify(requests[1].messages), /First spoken question/);
  assert.match(JSON.stringify(requests[1].messages), /Answer for First spoken question/);
  assert.match(requests[1].messages.at(-1).content, /Second spoken question/);
  assert.equal(fixture.store.session("session").transcript.length, 3);
  assert.equal(fixture.store.session("session").messages.length, 6);
  assert.equal(fixture.clients(), 0);
});

test("HTTP exposes only the first saved conversation and rejects session management without changing saved data", async t => {
  const fixture = await serverFixture(t, {
    agentRuntime: runtime(() => assert.fail("Session management must not prompt a model")),
  });
  const before = structuredClone(fixture.store.state);
  const response = await fetch(`${fixture.url}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.sessions.map(session => session.id), ["session"]);
  assert.deepEqual(state.documents.map(document => document.id), ["reference"]);
  assert.equal(state.sessions[0].title, "Defense");
  assert.equal(state.sessions[0].transcript[0].text, "Meeting context");
  for (const [method, path] of [
    ["POST", "/api/sessions"],
    ["PATCH", "/api/sessions/session"],
    ["DELETE", "/api/sessions/session"],
    ["PATCH", "/api/sessions/other-session"],
    ["DELETE", "/api/sessions/other-session"],
    ["POST", "/api/sessions/other-session/transcript"],
    ["POST", "/api/sessions/other-session/agent/command"],
    ["POST", "/api/sessions/other-session/documents"],
    ["DELETE", "/api/sessions/other-session/documents/reference"],
    ["GET", "/api/sessions/other-session/export"],
  ]) {
    const result = await fetch(`${fixture.url}${path}`, {
      method,
      ...(method === "POST" || method === "PATCH" ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Changed", text: "Hidden transcript", command: "cancel" }),
      } : {}),
    });
    assert.equal(result.status, 404, `${method} ${path}`);
  }
  assert.deepEqual(fixture.store.state, before);
  const restored = await new Store(fixture.store.directory).init();
  assert.deepEqual(restored.state, before);
  assert.deepEqual(restored.publicState().sessions.map(session => session.id), ["session"]);
  const exported = await fetch(`${fixture.url}/api/sessions/session/export`);
  assert.equal(exported.status, 200);
  const markdown = await exported.text();
  assert.match(markdown, /Meeting context|Earlier answer/);
  assert.doesNotMatch(markdown, /Other session private/);
  assert.equal(fixture.clients(), 0);
});

test("the exposed conversation retains reference upload, answer and removal URLs", async t => {
  const fixture = await serverFixture(t);
  const form = new FormData();
  form.append("files", new Blob(["Cite supplied evidence clearly."], { type: "text/markdown" }), "evidence.md");
  const uploaded = await fetch(`${fixture.url}/api/sessions/session/documents`, { method: "POST", body: form });
  assert.equal(uploaded.status, 201);
  const { documents: [reference] } = await uploaded.json();
  assert.equal(reference.sessionId, "session");
  assert.equal(reference.name, "evidence.md");
  const state = await (await fetch(`${fixture.url}/api/state`)).json();
  assert.deepEqual(state.documents.map(document => document.id), ["reference", reference.id]);
  const events = await fixture.events();
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.some((event) => event.type === "sources"), false);
  const removed = await fetch(`${fixture.url}/api/sessions/session/documents/${reference.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(fixture.store.state.documents.map(document => document.id), ["reference"]);
  const restored = await new Store(fixture.store.directory).init();
  assert.deepEqual(restored.session("session"), fixture.store.session("session"));
  assert.equal(restored.session("other-session").messages.length, 1);
});

for (const answerProvider of ["openai", "ollama", "custom"]) {
  test(`${answerProvider} cannot answer from an attached PDF without an omp agent`, async t => {
    const fixture = await serverFixture(t, { agentRuntime: runtime(() => assert.fail("Agent must not run")) });
    await fixture.store.update(state => { state.settings.answerProvider = answerProvider; });
    const response = await fixture.request({ answerProvider, requestId: `direct-${answerProvider}` });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /PDF references require an omp answer connection/);
    assert.equal(fixture.store.session("session").messages.length, 2);
    assert.equal(fixture.clients(), 0);
  });
}

test("HTTP persistent failure preserves a retryable user message without API or local replay", async (t) => {
  const fixture = await serverFixture(t, {
    agentRuntime: failingRuntime(new HttpError(429, "Agent quota reached"), [{ type: "agent", event: toolEvents[0] }, { type: "delta", text: "Partial" }]),
  });
  const events = await fixture.events();
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).error, /Agent quota reached/);
  assert.ok(!events.some((event) => ["reset", "fallback", "done"].includes(event.type)));
  const messages = fixture.store.session("session").messages;
  assert.equal(messages.length, 3);
  assert.equal(messages.at(-1).pending, true);
  assert.equal(fixture.clients(), 0);
});

for (const failAt of [1, 2]) {
  test(`local persistence failure at write ${failAt} never starts another provider`, async (t) => {
    const fixture = await serverFixture(t);
    const update = fixture.store.update.bind(fixture.store);
    let writes = 0;
    fixture.store.update = (change) => {
      if (++writes === failAt) return Promise.reject(new Error("Disk full"));
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

test("provider queue mismatch rejects before agent or API generation", async (t) => {
  const fixture = await serverFixture(t, { agentRuntime: runtime(() => assert.fail("Agent must not run")) });
  const response = await fixture.request({ answerProvider: "openai" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /connection changed/);
  assert.equal(fixture.clients(), 0);
});

test("local response limit does not activate another provider", async (t) => {
  const fixture = await serverFixture(t, { agentRuntime: runtime(async function* () { yield { type: "delta", text: "x".repeat(64001) }; }) });
  const events = await fixture.events();
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).error, /local response limit/);
  assert.equal(fixture.clients(), 0);
});

test("HTTP client disconnect cancels the persistent agent without billing another provider", { timeout: 5000 }, async (t) => {
  const finished = Promise.withResolvers();
  const fixture = await serverFixture(t, {
    agentRuntime: runtime(async function* ({ signal }) {
      try {
        yield { type: "delta", text: "Partial" };
        if (!signal.aborted)
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw new HttpError(499, "Agent request cancelled");
      } finally { finished.resolve(); }
    }),
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
