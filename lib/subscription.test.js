import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { access } from "node:fs/promises";
import { Subscription, DEFAULT_SUBSCRIPTION_MODEL, subscriptionProvider } from "./subscription.js";

const model = DEFAULT_SUBSCRIPTION_MODEL;
const id = model.split("/")[1];

function harness(
  t,
  {
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
            } else assert.fail(`Unexpected metadata command: ${args[0]}`);
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
    statusTimeoutMs: 1000,
    ...options,
  });
  t.after(() => {
    subscription.close();
    assert.deepEqual(failures, []);
  });
  return { subscription, calls };
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
      subscription.status({ model: invalid }),
      httpStatus(400),
    );
    assert.equal(calls.length, 0);
  });
}

test("unavailable exact IDs stay disconnected instead of fuzzy matching", async (t) => {
  const { subscription, calls } = harness(t);
  const result = await subscription.status({ model: "openai-codex/gpt" });
  assert.equal(result.connected, false);
  assert.match(result.error, /exact model/);
  assert.equal(calls.length, 2);
});

for (const [provider, selected] of [
  ["anthropic", "anthropic/claude-sonnet-4-5"],
  ["google-gemini-cli", "google-gemini-cli/gemini-2.5-pro"],
]) {
  test(`${provider} metadata uses its own catalog and account`, async (t) => {
    const { subscription, calls } = harness(t, {
      catalog: (call) => call.finish(JSON.stringify({
        models: [{ provider, kind: "chat", id: selected.slice(provider.length + 1) }],
      })),
      accounts: (call) => call.finish(JSON.stringify({
        accounts: [{ provider, identityKey: "private-identity" }],
      })),
    });
    assert.equal(subscriptionProvider(selected), provider);
    assert.deepEqual(await subscription.status({ model: selected }), {
      installed: true, connected: true, model: selected,
    });
    assert.equal(calls[0].args[1], provider);
    assert.equal(calls[1].args[3], provider);
    assert.equal(calls.every((call) => call.input === ""), true);
  });
}

test("metadata subprocesses exclude API credentials and model overrides", async (t) => {
  const { subscription, calls } = harness(t, {
    options: { env: {
      HOME: "/home/test", PATH: "/bin",
      PI_CODING_AGENT_DIR: "/existing/login-store",
      OPENAI_API_KEY: "secret", OPENAI_BASE_URL: "https://wrong.invalid",
      OPENAI_CODEX_OAUTH_TOKEN: "secret", PI_SMOL_MODEL: "openai/other",
      PI_CONFIG_FILES: "/unsafe", NODE_OPTIONS: "--require /unsafe",
    } },
  });
  await subscription.status();
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(call.options.env.PI_CODING_AGENT_DIR, "/existing/login-store");
    for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_CODEX_OAUTH_TOKEN", "PI_SMOL_MODEL", "PI_CONFIG_FILES", "NODE_OPTIONS"])
      assert.equal(call.options.env[key], undefined);
  }
});

async function consumeRun(subscription, signal) {
  for await (const _chunk of subscription.run("/installed/omp", ["models"], {
    cwd: "/isolated", signal, timeoutMs: 1000,
  })) {}
}

test("abort cancels a running metadata subprocess", async (t) => {
  const controller = new AbortController();
  const { subscription, calls } = harness(t, { catalog: () => controller.abort() });
  await assert.rejects(consumeRun(subscription, controller.signal), httpStatus(499));
  assert.deepEqual(calls[0].killed, ["SIGTERM"]);
});

test("already aborted metadata requests do not launch a subprocess", async (t) => {
  const { subscription, calls } = harness(t);
  await assert.rejects(consumeRun(subscription, AbortSignal.abort()), httpStatus(499));
  assert.equal(calls.length, 0);
});

test("consumer return terminates a metadata subprocess", async (t) => {
  const { subscription, calls } = harness(t, {
    catalog: (call) => call.child.stdout.write("partial metadata"),
  });
  for await (const chunk of subscription.run("/installed/omp", ["models"], {
    cwd: "/isolated", timeoutMs: 1000,
  })) {
    assert.equal(chunk.toString(), "partial metadata");
    break;
  }
  assert.deepEqual(calls[0].killed, ["SIGTERM"]);
});

test("close cancels active metadata subprocesses and prohibits future launches", async (t) => {
  let subscription;
  const fixture = harness(t, { catalog: () => subscription.close() });
  subscription = fixture.subscription;
  await assert.rejects(consumeRun(subscription), httpStatus(499));
  await assert.rejects(subscription.status(), httpStatus(499));
  assert.equal(fixture.calls.length, 1);
});

test("cancellation escalates when a metadata subprocess ignores SIGTERM", async (t) => {
  const controller = new AbortController();
  const { subscription, calls } = harness(t, {
    catalog: (call) => {
      call.child.kill = (signal) => {
        call.killed.push(signal);
        if (signal === "SIGKILL") call.finish("", null, signal);
        return true;
      };
      controller.abort();
    },
  });
  await assert.rejects(consumeRun(subscription, controller.signal), httpStatus(499));
  assert.deepEqual(calls[0].killed, ["SIGTERM", "SIGKILL"]);
});
