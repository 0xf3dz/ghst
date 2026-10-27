import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_SETTINGS = Object.freeze({
  answerProvider: "chatgpt",
  subscriptionModel: "openai-codex/gpt-6-sol",
  answerModel: "gpt-4.1",
  transcribeModel: "gpt-4o-transcribe",
  language: "",
  instructions: "",
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class Store {
  constructor(
    directory = process.env.THESIS_DATA_DIR ||
      join(homedir(), ".thesis-assistant"),
  ) {
    this.directory = directory;
    this.documentDirectory = join(directory, "documents");
    this.uploadDirectory = join(directory, "uploads");
    this.path = join(directory, "state.json");
    this.pending = Promise.resolve();
  }

  async init() {
    for (const directory of [
      this.directory,
      this.documentDirectory,
      this.uploadDirectory,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8"));
      if (
        this.state.version !== 1 ||
        !Array.isArray(this.state.documents) ||
        !Array.isArray(this.state.sessions) ||
        !this.state.settings
      ) {
        throw new Error("Invalid state");
      }
      this.state.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
      await chmod(this.path, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(
          "Cannot read saved application data. Restore the state.json file from a backup, or choose a new THESIS_DATA_DIR.",
        );
      this.state = {
        version: 1,
        settings: { ...DEFAULT_SETTINGS },
        apiKey: "",
        documents: [],
        sessions: [],
      };
      await atomicJSON(this.path, this.state);
    }
    return this;
  }

  update(change) {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.state);
      const result = await change(next);
      await atomicJSON(this.path, next);
      this.state = next;
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  key() {
    return process.env.OPENAI_API_KEY?.trim() || this.state.apiKey || "";
  }

  publicState() {
    return {
      configured: Boolean(this.key()),
      settings: Object.fromEntries(
        Object.keys(DEFAULT_SETTINGS).map((key) => [
          key,
          this.state.settings[key],
        ]),
      ),
      documents: this.state.documents,
      sessions: this.state.sessions.map(publicSession),
    };
  }

  session(id, state = this.state) {
    const session = state.sessions.find((item) => item.id === id);
    if (!session)
      throw new HttpError(
        404,
        "Session not found. Select or create a session.",
      );
    return session;
  }
}

export function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    transcript: session.transcript.map(({ id, text, time }) => ({
      id,
      text,
      time,
    })),
    messages: session.messages.map(({ id, role, text, sources }) => ({
      id,
      role,
      text,
      ...(sources ? { sources } : {}),
    })),
  };
}

export function boundedText(value, name, maximum, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(400, `${name} must be non-empty text.`);
  if (value.length > maximum)
    throw new HttpError(
      400,
      `${name} must contain no more than ${maximum} characters.`,
    );
  return value.trim();
}
