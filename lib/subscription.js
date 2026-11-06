import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { HttpError } from "./store.js";

export const DEFAULT_SUBSCRIPTION_MODEL = "openai-codex/gpt-6-sol";
const PROVIDER = "openai-codex";
const LOGIN =
  "Configure your provider credentials in omp, then check the connection again.";
const MAX_BYTES = 8 * 1024 * 1024;
export function subscriptionProvider(model) {
  if (typeof model !== "string" || model.length > 120 || !/^(openai-codex|anthropic|google-gemini-cli|groq)\/[A-Za-z0-9_-][A-Za-z0-9._/-]*$/.test(model) || model.split("/").some(part => part === ".." || part === "."))
    throw failure("Choose an exact supported omp provider/model ID.", 400);
  return model.split("/")[0];
}

function failure(
  message = "The omp connection request failed. Check your connection and provider credentials, then try again.",
  status = 502,
) {
  return new HttpError(status, message);
}

function cancelled() {
  return failure("The request was cancelled.", 499);
}

export function safeEnvironment(source) {
  const result = {};
  // Keep login-store location selectors, never API keys, model overrides, or endpoints.
  for (const key of [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "PI_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ])
    if (source[key]) result[key] = source[key];
  result.NO_COLOR = "1";
  result.TERM = "dumb";
  return result;
}

export async function executable(env) {
  const home = env.HOME || homedir();
  const candidates = env.GHST_OMP_PATH
    ? [env.GHST_OMP_PATH]
    : [
        ...(env.PATH || "")
          .split(delimiter)
          .filter(isAbsolute)
          .map((directory) => join(directory, "omp")),
        join(home, "Library/Application Support/Tern/omp/bin/omp"),
        join(home, ".local/bin/omp"),
        join(home, ".bun/bin/omp"),
        "/opt/homebrew/bin/omp",
        "/usr/local/bin/omp",
      ];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

function parseJSON(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw failure(
      "omp returned an invalid JSON response. Update omp and try again.",
    );
  }
}

export class Subscription {
  constructor({
    spawnProcess = spawn,
    resolveExecutable = executable,
    env = process.env,
    statusTimeoutMs = 10000,
    cacheTtlMs = 30000,
    now = Date.now,
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.resolveExecutable = resolveExecutable;
    this.env = { ...env };
    this.statusTimeoutMs = statusTimeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.active = new Set();
    this.cached = null;
    this.pending = null;
    this.closed = false;
  }

  async *run(
    path,
    args,
    { cwd, input = "", signal, timeoutMs, limit = MAX_BYTES },
  ) {
    if (this.closed || signal?.aborted) throw cancelled();
    let child;
    try {
      child = this.spawnProcess(path, args, {
        cwd,
        env: safeEnvironment(this.env),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      throw failure();
    }
    let error;
    let exitError;
    let ended = false;
    let killTimer;
    const kill = (kind) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {
        try {
          child.kill(kind);
        } catch {}
      }
    };
    const stop = (reason) => {
      if (ended || error) return;
      error = reason;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
    };
    const completion = new Promise((resolve) => {
      child.once("error", () => {
        error ||= failure();
      });
      child.once("close", (code, termination) => {
        ended = true;
        if (code !== 0 || termination) exitError = failure();
        resolve();
      });
    });
    const abort = () => stop(cancelled());
    this.active.add(abort);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          failure(
            "The omp connection request timed out. Check your connection and try again.",
            504,
          ),
        ),
      timeoutMs,
    );
    child.stderr.resume();
    child.stdin.on("error", () => stop(failure()));
    child.stdin.end(input);
    if (signal?.aborted || this.closed) abort();
    let bytes = 0;
    try {
      for await (const chunk of child.stdout) {
        if (error) throw error;
        bytes += Buffer.byteLength(chunk);
        if (bytes > limit)
          throw failure("omp returned too much connection data.");
        yield chunk;
      }
      await completion;
      if (error || exitError) throw error || exitError;
    } catch (cause) {
      throw cause instanceof HttpError ? cause : error || failure();
    } finally {
      if (!ended) {
        stop(cancelled());
        child.stdout.resume();
      }
      await completion;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      this.active.delete(abort);
    }
  }

  async metadata(refresh = false, provider = PROVIDER) {
    provider = ({ chatgpt: PROVIDER, claude: "anthropic", gemini: "google-gemini-cli" })[provider] || provider;
    if (![PROVIDER, "anthropic", "google-gemini-cli", "groq"].includes(provider)) provider = PROVIDER;
    if (this.closed) throw cancelled();
    if (this.pending) { await this.pending; return this.metadata(refresh, provider); }
    if (
      !refresh &&
      this.cached &&
      this.cached.provider === provider &&
      this.now() - this.cached.at < this.cacheTtlMs
    )
      return this.cached.value;
    this.pending = (async () => {
      let directory;
      let installed = false;
      try {
        const path = await this.resolveExecutable(this.env);
        if (!path)
          return {
            installed,
            connected: false,
            models: [],
            error: "omp is not installed. Install omp, then " + LOGIN,
          };
        installed = true;
        directory = await mkdtemp(join(tmpdir(), "ghst-omp-check-"));
        const collect = async (args) => {
          const chunks = [];
          for await (const chunk of this.run(path, args, {
            cwd: directory,
            timeoutMs: this.statusTimeoutMs,
            limit: 1024 * 1024,
          }))
            chunks.push(Buffer.from(chunk));
          return parseJSON(Buffer.concat(chunks).toString("utf8"));
        };
        const catalog = await collect([
          "models",
          provider,
          "--json",
          "--no-extensions",
        ]);
        const accounts = await collect([
          "usage",
          "accounts",
          "--provider",
          provider,
          "--json",
          "--no-extensions",
        ]);
        if (!Array.isArray(catalog.models) || !Array.isArray(accounts.accounts))
          throw failure();
        const models = catalog.models
          .filter(
            (row) =>
              row &&
              row.provider === provider &&
              row.kind === "chat" &&
              typeof row.id === "string" &&
              /^[A-Za-z0-9._:/-]+$/.test(row.id),
          )
          .map((row) => `${provider}/${row.id}`);
        // This command lists OAuth accounts only. Retain presence, not their identities.
        let connected = accounts.accounts.some(
          (row) =>
            row?.provider === provider &&
            typeof row.identityKey === "string" &&
            row.identityKey.length > 0,
        );
        if (provider === "groq") {
          let bytes = 0;
          for await (const chunk of this.run(path, ["token", "groq"], { cwd: directory, timeoutMs: this.statusTimeoutMs, limit: 16384 })) bytes += Buffer.byteLength(chunk);
          connected = bytes > 0;
        }
        return {
          installed,
          connected,
          models,
          path,
          ...(!connected
            ? { error: `No ${provider} account is configured. Configure its credentials in omp, then check again.` }
            : {}),
        };
      } catch (error) {
        return {
          installed,
          connected: false,
          models: [],
          error:
            error instanceof HttpError
              ? error.message
              : "Could not inspect the omp subscription connection. " + LOGIN,
        };
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    })();
    try {
      const value = await this.pending;
      this.cached = { at: this.now(), provider, value };
      return value;
    } finally {
      this.pending = null;
    }
  }

  async status({ refresh = false, model = DEFAULT_SUBSCRIPTION_MODEL } = {}) {
    subscriptionProvider(model);
    const metadata = await this.metadata(refresh, subscriptionProvider(model));
    const available = metadata.models.includes(model);
    return {
      installed: metadata.installed,
      connected: metadata.connected && available,
      model,
      ...(metadata.error
        ? { error: metadata.error }
        : !available
          ? {
              error:
                `The selected subscription model is not available in omp. Choose an exact model listed by \`omp models ${subscriptionProvider(model)}\`.`,
            }
          : {}),
    };
  }

  close() {
    this.closed = true;
    this.cached = null;
    for (const abort of this.active) abort();
  }
}
