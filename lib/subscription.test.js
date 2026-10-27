import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Subscription, DEFAULT_SUBSCRIPTION_MODEL } from "./subscription.js";

const model = DEFAULT_SUBSCRIPTION_MODEL;
const id = model.split("/")[1];
const messages = [
  { role: "system", content: "Use supplied evidence. Cite [1]." },
  { role: "user", content: "Earlier question" },
  { role: "assistant", content: "Earlier answer" },
  {
    role: "user",
    content:
      'Context: {"sourceNumber":1,"text":"Evidence"}\nCurrent question: explain',
  },
];
const assistant = (content = "Evidence [1].", changes = {}) => ({
  role: "assistant",
  provider: "openai-codex",
  model: id,
  content: [{ type: "text", text: content }],
  stopReason: "stop",
  ...changes,
});
const events = (text = "Evidence [1].") => [
  { type: "session", version: 3 },
  { type: "agent_start" },
  { type: "message_start", message: assistant("") },
  {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: {
      type: "thinking_delta",
      delta: "private reasoning",
    },
  },
  {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: text },
  },
  { type: "message_end", message: assistant(text) },
  {
    type: "agent_end",
    messages: [assistant(text)],
    isTerminal: true,
    yielded: true,
  },
];
const encode = (items) =>
  items.map((item) => JSON.stringify(item) + "\n").join("");

function harness(
  t,
  {
    answer = (call) => call.finish(encode(events())),
    catalog,
    accounts,
    options = {},
  } = {},
) {
  const calls = [];
  let failures = [];
  const spawnProcess = (path, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = "";
    let closed = false;
    const call = {
      path,
      args,
      options: spawnOptions,
      child,
      killed: [],
      finish(output = "", code = 0, termination = null) {
        if (closed) return;
        closed = true;
        child.stdout.end(output);
        child.stderr.end();
        queueMicrotask(() => child.emit("close", code, termination));
      },
      get input() {
        return input;
      },
    };
    child.kill = (signal) => {
      call.killed.push(signal);
      call.finish("", null, signal);
      return true;
    };
    child.stdin = new Writable({
      write(chunk, _, callback) {
        input += chunk.toString();
        callback();
      },
      final(callback) {
        callback();
        queueMicrotask(async () => {
          try {
            if (args[0] === "models") {
              if (catalog) await catalog(call);
              else
                call.finish(
                  JSON.stringify({
                    models: [{ provider: "openai-codex", kind: "chat", id }],
                  }),
                );
            } else if (args[0] === "usage") {
              if (accounts) await accounts(call);
              else
                call.finish(
                  JSON.stringify({
                    accounts: [
                      {
                        provider: "openai-codex",
                        identityKey: "private-identity",
                      },
                    ],
                  }),
                );
            } else await answer(call);
          } catch (error) {
            failures.push(error);
            call.finish("", 1);
          }
        });
      },
    });
    calls.push(call);
    return child;
  };
  const subscription = new Subscription({
    spawnProcess,
    resolveExecutable: async () => "/installed/omp",
    timeoutMs: 1000,
    statusTimeoutMs: 1000,
    ...options,
  });
  t.after(() => {
    subscription.close();
    assert.deepEqual(failures, []);
  });
  return { subscription, calls };
}

async function collect(subscription, options = {}) {
  const deltas = [];
  for await (const delta of subscription.answer({
    messages,
    model,
    ...options,
  }))
    deltas.push(delta);
  return deltas;
}

function httpStatus(status) {
  return (error) => error.status === status;
}

test("safe OAuth metadata is cached, coalesced, model-specific, and never returns identities", async (t) => {
  let time = 1000;
  const { subscription, calls } = harness(t, {
    options: { now: () => time, cacheTtlMs: 30 },
  });
  const results = await Promise.all([
    subscription.status(),
    subscription.status(),
  ]);
  assert.deepEqual(results, [
    { installed: true, connected: true, model },
    { installed: true, connected: true, model },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    "models",
    "openai-codex",
    "--json",
    "--no-extensions",
  ]);
  assert.deepEqual(calls[1].args, [
    "usage",
    "accounts",
    "--provider",
    "openai-codex",
    "--json",
    "--no-extensions",
  ]);
  for (let index = 0; index < 50; index++) {
    const result = await subscription.status({
      model: `openai-codex/missing-${index}`,
    });
    assert.equal(result.connected, false);
  }
  assert.equal(calls.length, 2);
  await subscription.status({ refresh: true });
  assert.equal(calls.length, 4);
  time += 31;
  await subscription.status();
  assert.equal(calls.length, 6);
  for (const call of calls) await assert.rejects(access(call.options.cwd));
});

test("installation alone or another provider's account never counts as connected", async (t) => {
  const { subscription, calls } = harness(t, {
    accounts: (call) =>
      call.finish(
        JSON.stringify({
          accounts: [{ provider: "openai", identityKey: "not-oauth" }],
        }),
      ),
  });
  assert.equal((await subscription.status()).connected, false);
  await assert.rejects(collect(subscription), httpStatus(503));
  assert.equal(calls.length, 2);
});

test("missing executable reports not installed without spawning", async (t) => {
  const { subscription, calls } = harness(t, {
    options: { resolveExecutable: async () => null },
  });
  const result = await subscription.status();
  assert.equal(result.installed, false);
  assert.equal(result.connected, false);
  assert.match(result.error, /Install omp/);
  assert.equal(calls.length, 0);
});

test("metadata errors are sanitized and cached without exposing CLI stderr", async (t) => {
  const { subscription, calls } = harness(t, {
    catalog: (call) => {
      call.child.stderr.write(
        "secret-token /private/account/path user@example.test",
      );
      call.finish("secret stdout", 1);
    },
  });
  const result = await subscription.status();
  assert.equal(result.installed, true);
  assert.equal(result.connected, false);
  assert.doesNotMatch(result.error, /secret|private|example/);
  await subscription.status();
  assert.equal(calls.length, 1);
});

test("metadata timeout terminates the process and remains disconnected", async (t) => {
  const { subscription, calls } = harness(t, {
    catalog: () => {},
    options: { statusTimeoutMs: 20 },
  });
  const result = await subscription.status();
  assert.equal(result.connected, false);
  assert.match(result.error, /timed out/);
  assert.deepEqual(calls[0].killed, ["SIGTERM"]);
});

test("real subprocess inputs isolate tools, context, roles, credentials and preserve citations/history", async (t) => {
  let root;
  const { subscription, calls } = harness(t, {
    options: {
      env: {
        HOME: "/home/test",
        PATH: "/bin",
        OPENAI_API_KEY: "secret",
        OPENAI_BASE_URL: "https://wrong.invalid",
        OPENAI_CODEX_OAUTH_TOKEN: "secret",
        PI_SMOL_MODEL: "openai/other",
        PI_CONFIG_FILES: "/unsafe",
        NODE_OPTIONS: "--require /unsafe",
        PI_CODING_AGENT_DIR: "/existing/login-store",
      },
    },
    answer: async (call) => {
      assert.equal(call.options.shell, false);
      assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
      assert.deepEqual(await readdir(call.options.cwd), []);
      assert.notEqual(call.options.cwd, process.cwd());
      assert.equal(
        call.options.env.PI_CODING_AGENT_DIR,
        "/existing/login-store",
      );
      for (const key of [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_CODEX_OAUTH_TOKEN",
        "PI_SMOL_MODEL",
        "PI_CONFIG_FILES",
        "NODE_OPTIONS",
      ])
        assert.equal(call.options.env[key], undefined);
      for (const flag of [
        "--no-tools",
        "--no-lsp",
        "--no-pty",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--no-session",
        "--no-title",
        "--no-prewalk",
      ])
        assert.ok(call.args.includes(flag));
      const value = (flag) => call.args[call.args.indexOf(flag) + 1];
      assert.equal(value("--model"), model);
      assert.equal(value("--models"), model);
      assert.equal(value("--provider"), "openai-codex");
      assert.equal(value("--max-time"), "120s");
      assert.equal(value("--thinking"), "medium");
      assert.equal(value("--system-prompt"), messages[0].content + "\n");
      assert.equal(value("--append-system-prompt"), "");
      assert.deepEqual(
        JSON.parse(call.input.slice(call.input.indexOf("\n") + 1)),
        messages.slice(1),
      );
      const config = JSON.parse(await readFile(value("--config"), "utf8"));
      root = dirname(value("--config"));
      assert.equal(config.advisor.enabled, false);
      assert.equal(config.retry.enabled, false);
      assert.equal(config.retry.modelFallback, false);
      assert.equal(config.retry.usageAwareFallback, false);
      assert.equal(config.contextPromotion.enabled, false);
      assert.equal(config.memory.backend, "off");
      assert.equal(config.autolearn.enabled, false);
      assert.equal(config.providers.cacheWarming, "off");
      assert.equal(config.features.unexpectedStopDetection, "off");
      assert.deepEqual(config.workspace.additionalDirectories, []);
      assert.deepEqual(config.enabledModels, [model]);
      assert.ok(
        Object.values(config.modelRoles).every((value) => value === model),
      );
      const bytes = Buffer.from(encode(events("Café [1].")));
      const split = bytes.indexOf(Buffer.from("é")) + 1;
      call.child.stdout.write(bytes.subarray(0, split));
      call.finish(bytes.subarray(split));
    },
  });
  assert.deepEqual(await collect(subscription), ["Café [1]."]);
  assert.equal(calls.length, 3);
  await assert.rejects(access(root));
});

for (const invalid of [
  "openai/gpt-6-sol",
  "gpt-6-sol",
  "openai-codex/gpt-6-sol:high",
  "openai-codex/a,b",
  "openai-codex/../x",
  "openai-codex/" + "a".repeat(120),
]) {
  test(`provider/model boundary rejects ${invalid.slice(0, 50)} before spawning`, async (t) => {
    const { subscription, calls } = harness(t);
    await assert.rejects(
      collect(subscription, { model: invalid }),
      httpStatus(400),
    );
    await assert.rejects(
      subscription.status({ model: invalid }),
      httpStatus(400),
    );
    assert.equal(calls.length, 0);
  });
}

test("unavailable exact IDs are rejected instead of fuzzy matching", async (t) => {
  const { subscription, calls } = harness(t);
  await assert.rejects(
    collect(subscription, { model: "openai-codex/gpt" }),
    httpStatus(400),
  );
  assert.equal(calls.length, 2);
});

const brokenStreams = {
  "non JSON output": () => "not-json\n",
  "truncated final frame": () => encode(events()).trimEnd(),
  "missing terminal event": () => encode(events().slice(0, -1)),
  "missing completed message": () =>
    encode(events().filter((event) => event.type !== "message_end")),
  "wrong provider": () =>
    encode(
      events().map((event) =>
        event.type === "message_start"
          ? { ...event, message: assistant("", { provider: "openai" }) }
          : event,
      ),
    ),
  "wrong model": () =>
    encode(
      events().map((event) =>
        event.type === "message_start"
          ? { ...event, message: assistant("", { model: "different" }) }
          : event,
      ),
    ),
  "model fallback": () =>
    encode([{ type: "retry_fallback_applied" }, ...events()]),
  "tool execution": () =>
    encode([{ type: "tool_execution_start" }, ...events()]),
  "tool call delta": () =>
    encode([
      ...events().slice(0, 3),
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start" },
      },
    ]),
  "provider error": () =>
    encode(
      events().map((event) =>
        event.type === "message_end"
          ? {
              ...event,
              message: assistant("", {
                stopReason: "error",
                errorMessage: "secret token",
              }),
            }
          : event,
      ),
    ),
  "truncated answer": () =>
    encode(
      events().map((event) =>
        event.type === "message_end"
          ? { ...event, message: assistant("", { stopReason: "length" }) }
          : event,
      ),
    ),
  "stream mismatch": () =>
    encode(
      events().map((event) =>
        event.type === "message_end"
          ? { ...event, message: assistant("different") }
          : event,
      ),
    ),
  "malformed delta": () =>
    encode(
      events().map((event) =>
        event.assistantMessageEvent?.type === "text_delta"
          ? {
              ...event,
              assistantMessageEvent: { type: "text_delta", delta: 42 },
            }
          : event,
      ),
    ),
  "out of order delta": () => encode([events()[4], ...events()]),
  "empty answer": () => encode(events("")),
  "oversized frame": () => "x".repeat(2 * 1024 * 1024 + 1),
};
for (const [name, output] of Object.entries(brokenStreams)) {
  test(`protocol rejects ${name}`, async (t) => {
    const { subscription } = harness(t, {
      answer: (call) => call.finish(output()),
    });
    await assert.rejects(
      collect(subscription),
      (error) =>
        error.status === 502 && !error.message.includes("secret token"),
    );
  });
}

test("nonzero process exit rejects even a successful terminal stream", async (t) => {
  const { subscription } = harness(t, {
    answer: (call) => {
      call.child.stderr.write("private credential error");
      call.finish(encode(events()), 1);
    },
  });
  await assert.rejects(
    collect(subscription),
    (error) => error.status === 502 && !error.message.includes("credential"),
  );
});

test("answer timeout kills subprocess and deletes isolated working directory", async (t) => {
  const { subscription, calls } = harness(t, {
    answer: () => {},
    options: { timeoutMs: 20 },
  });
  await assert.rejects(collect(subscription), httpStatus(504));
  assert.deepEqual(calls.at(-1).killed, ["SIGTERM"]);
  await assert.rejects(access(calls.at(-1).options.cwd));
});

test("abort cancels a running answer, not its provider selection", async (t) => {
  const controller = new AbortController();
  const { subscription, calls } = harness(t, {
    answer: () => controller.abort(),
  });
  await assert.rejects(
    collect(subscription, { signal: controller.signal }),
    httpStatus(499),
  );
  assert.deepEqual(calls.at(-1).killed, ["SIGTERM"]);
  await assert.rejects(access(calls.at(-1).options.cwd));
});

test("already aborted requests do not launch an answer", async (t) => {
  const { subscription, calls } = harness(t);
  await assert.rejects(
    collect(subscription, { signal: AbortSignal.abort() }),
    httpStatus(499),
  );
  assert.equal(calls.length, 0);
});

test("consumer return terminates the child and cleans up", async (t) => {
  const { subscription, calls } = harness(t, {
    answer: (call) => call.child.stdout.write(encode(events().slice(0, 5))),
  });
  for await (const delta of subscription.answer({ messages, model })) {
    assert.equal(delta, "Evidence [1].");
    break;
  }
  assert.deepEqual(calls.at(-1).killed, ["SIGTERM"]);
  await assert.rejects(access(calls.at(-1).options.cwd));
});

test("close cancels active subprocesses and prohibits future launches", async (t) => {
  let subscription;
  const result = harness(t, { answer: () => subscription.close() });
  subscription = result.subscription;
  await assert.rejects(collect(subscription), httpStatus(499));
  await assert.rejects(subscription.status(), httpStatus(499));
  assert.equal(result.calls.length, 3);
});

for (const [raw, status, expected] of [
  ["429 quota exceeded secret-token /private/path", 429, /quota.*reset/],
  [
    "401 authentication expired secret-token /private/path",
    401,
    /omp login openai-codex/,
  ],
  ["upstream timeout secret-token /private/path", 504, /timed out/],
]) {
  test(`provider error maps to actionable ${status} without leaking diagnostics`, async (t) => {
    const { subscription } = harness(t, {
      answer: (call) =>
        call.finish(
          encode([
            ...events().slice(0, 3),
            {
              type: "message_update",
              assistantMessageEvent: {
                type: "error",
                error: assistant("", {
                  stopReason: "error",
                  errorMessage: raw,
                }),
              },
            },
          ]),
        ),
    });
    await assert.rejects(collect(subscription), (error) => {
      assert.equal(error.status, status);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /secret-token|private\/path/);
      return true;
    });
  });
}

test("cancellation escalates when the child ignores SIGTERM", async (t) => {
  const controller = new AbortController();
  const { subscription, calls } = harness(t, {
    answer: (call) => {
      call.child.kill = (signal) => {
        call.killed.push(signal);
        if (signal === "SIGKILL") call.finish("", null, signal);
        return true;
      };
      controller.abort();
    },
  });
  await assert.rejects(
    collect(subscription, { signal: controller.signal }),
    httpStatus(499),
  );
  assert.deepEqual(calls.at(-1).killed, ["SIGTERM", "SIGKILL"]);
});
