import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, HttpError, boundedText, publicSession } from "./lib/store.js";
import { Documents } from "./lib/documents.js";
import { RetrievalIndex } from "./lib/retrieval.js";
import { Subscription } from "./lib/subscription.js";
import { answerClient, answerEvents } from "./lib/answers.js";
import {
  ANSWER_MODELS,
  answerMessages,
  clientFor,
  modelError,
  transcribe,
} from "./lib/openai.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res)).catch(next);
const sessionSize = (session) =>
  session.transcript.reduce((sum, entry) => sum + entry.text.length, 0) +
  session.messages.reduce((sum, message) => sum + message.text.length, 0);

function requestId(req) {
  const value = req.body?.requestId ?? req.get("Idempotency-Key");
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new HttpError(
      400,
      "The request ID must contain 1 to 128 letters, digits, underscores, or hyphens.",
    );
  return value;
}

function requireJSON(req, _res, next) {
  if (
    !req.is("application/json") ||
    !req.body ||
    Array.isArray(req.body) ||
    typeof req.body !== "object"
  )
    return next(
      new HttpError(
        400,
        "Send a JSON object with Content-Type: application/json.",
      ),
    );
  next();
}

function validateSubscriptionModel(model) {
  if (
    typeof model !== "string" ||
    model.length > 120 ||
    !/^openai-codex\/[A-Za-z0-9._-]+$/.test(model)
  )
    throw new HttpError(
      400,
      "Use an exact openai-codex model ID, up to 120 characters.",
    );
  return model;
}

function settingsUpdate(body) {
  const update = {};
  if (body.answerProvider !== undefined) {
    if (!["chatgpt", "openai"].includes(body.answerProvider))
      throw new HttpError(
        400,
        "The answer provider must be chatgpt or openai.",
      );
    update.answerProvider = body.answerProvider;
  }
  if (body.subscriptionModel !== undefined)
    update.subscriptionModel = validateSubscriptionModel(
      body.subscriptionModel,
    );
  if (body.answerModel !== undefined) {
    if (!ANSWER_MODELS.has(body.answerModel))
      throw new HttpError(
        400,
        `Supported answer models: ${[...ANSWER_MODELS].join(", ")}.`,
      );
    update.answerModel = body.answerModel;
  }
  if (body.transcribeModel !== undefined) {
    if (
      !["gpt-4o-transcribe", "gpt-4o-mini-transcribe"].includes(
        body.transcribeModel,
      )
    )
      throw new HttpError(
        400,
        "The transcription model must be gpt-4o-transcribe or gpt-4o-mini-transcribe.",
      );
    update.transcribeModel = body.transcribeModel;
  }
  if (body.language !== undefined) {
    if (
      typeof body.language !== "string" ||
      !/^([a-z]{2,3})?$/i.test(body.language)
    )
      throw new HttpError(
        400,
        "Use an ISO language code such as en or es, or leave the language empty.",
      );
    update.language = body.language.toLowerCase();
  }
  if (body.instructions !== undefined) {
    if (
      typeof body.instructions !== "string" ||
      body.instructions.length > 16000
    )
      throw new HttpError(
        400,
        "Instructions must contain no more than 16000 characters.",
      );
    update.instructions = body.instructions;
  }
  if (
    body.apiKey !== undefined &&
    (typeof body.apiKey !== "string" ||
      body.apiKey.trim().length > 512 ||
      /[\u0000-\u0020\u007f]/.test(body.apiKey.trim()))
  )
    throw new HttpError(
      400,
      "The API key must be a single value with no spaces, up to 512 characters.",
    );
  return update;
}

function safeMarkdown(value) {
  return value.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>#|])/g, "\\$1");
}

function exportSession(session) {
  const lines = [
    `# ${safeMarkdown(session.title)}`,
    "",
    `Created: ${session.createdAt}`,
    "",
    "## Transcript",
    "",
  ];
  if (!session.transcript.length) lines.push("No transcript entries.", "");
  for (const entry of session.transcript)
    lines.push(`### ${entry.time}`, "", entry.text, "");
  lines.push("## Questions and answers", "");
  if (!session.messages.length) lines.push("No questions or answers.", "");
  for (const message of session.messages) {
    lines.push(
      `### ${message.role === "user" ? "Question" : "Answer"}`,
      "",
      message.text,
      "",
    );
    if (message.sources?.length) {
      lines.push("Sources:", "");
      for (const source of message.sources)
        lines.push(
          `- ${safeMarkdown(source.name)}, p. ${source.page}`,
          `  ${source.text.replace(/\s+/g, " ")}`,
          "",
        );
    }
  }
  return lines.join("\n");
}

async function cleanupUpload(req) {
  const files = [
    ...(Array.isArray(req.files) ? req.files : []),
    ...(req.file ? [req.file] : []),
  ];
  await Promise.all(
    files.map((file) => rm(file.path, { force: true }).catch(() => {})),
  );
}

function sendEvent(res, event) {
  return new Promise((resolveEvent, reject) => {
    if (res.destroyed || res.writableEnded)
      return reject(new Error("Response closed"));
    res.write(`${JSON.stringify(event)}\n`, (error) =>
      error ? reject(error) : resolveEvent(),
    );
  });
}

export async function startServer({
  port = process.env.PORT || 3210,
  store = new Store(),
  subscription = new Subscription(),
  createClient = clientFor,
} = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be an integer from 0 to 65535.");
  await store.init();
  const index = new RetrievalIndex();
  const documents = await new Documents(store, index).init();
  const answering = new Map();
  const transcriptions = new Set();
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const expected = new Set([
      `127.0.0.1:${req.socket.localPort}`,
      `localhost:${req.socket.localPort}`,
    ]);
    if (!expected.has(req.get("host")))
      return res
        .status(403)
        .json({ error: "This service accepts local requests only." });
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (origin && origin !== `http://${req.get("host")}`)
      return res
        .status(403)
        .json({ error: "Cross-origin requests are not allowed." });
    if (req.get("sec-fetch-site") === "cross-site")
      return res
        .status(403)
        .json({ error: "Cross-site requests are not allowed." });
    next();
  });
  app.use(express.json({ limit: "128kb", strict: true }));

  const disk = multer.diskStorage({
    destination: (_req, _file, callback) =>
      callback(null, store.uploadDirectory),
    filename: (_req, file, callback) =>
      callback(
        null,
        `${randomUUID()}${extname(file.originalname).toLowerCase()}`,
      ),
  });
  const referencesUpload = multer({
    storage: disk,
    limits: { fileSize: 100 * 1024 * 1024, files: 8, fields: 0, parts: 8 },
    fileFilter: (_req, file, callback) =>
      callback(
        [".pdf", ".md"].includes(extname(file.originalname).toLowerCase())
          ? null
          : new HttpError(
              400,
              "Upload only PDF (.pdf) or Markdown (.md) files.",
            ),
        true,
      ),
  }).array("files", 8);
  const audioUpload = multer({
    storage: disk,
    limits: { fileSize: 24 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    fileFilter: (_req, file, callback) =>
      callback(
        extname(file.originalname).toLowerCase() === ".wav"
          ? null
          : new HttpError(400, "Upload a complete WAV audio file."),
        true,
      ),
  }).single("audio");

  app.get(
    "/api/state",
    asyncRoute(async (_req, res) => {
      const state = store.publicState();
      res.json({
        ...state,
        subscription: await subscription.status({
          model: state.settings.subscriptionModel,
        }),
      });
    }),
  );
  app.get(
    "/api/subscription",
    asyncRoute(async (_req, res) => {
      res.json(
        await subscription.status({
          model: store.state.settings.subscriptionModel,
        }),
      );
    }),
  );
  app.post(
    "/api/subscription/check",
    requireJSON,
    asyncRoute(async (req, res) => {
      const model =
        req.body.subscriptionModel === undefined
          ? store.state.settings.subscriptionModel
          : validateSubscriptionModel(req.body.subscriptionModel);
      res.json(
        await subscription.status({
          refresh: true,
          model,
        }),
      );
    }),
  );
  app.post(
    "/api/settings",
    requireJSON,
    asyncRoute(async (req, res) => {
      const update = settingsUpdate(req.body);
      await store.update((state) => {
        Object.assign(state.settings, update);
        if (req.body.apiKey?.trim()) state.apiKey = req.body.apiKey.trim();
      });
      const state = store.publicState();
      res.json({ configured: state.configured, settings: state.settings });
    }),
  );
  app.delete(
    "/api/key",
    asyncRoute(async (_req, res) => {
      await store.update((state) => {
        state.apiKey = "";
      });
      res.json({ configured: Boolean(store.key()) });
    }),
  );
  app.post(
    "/api/documents",
    referencesUpload,
    asyncRoute(async (req, res) => {
      try {
        const added = await documents.add(req.files || []);
        res.status(201).json({ documents: added });
      } finally {
        await cleanupUpload(req);
      }
    }),
  );
  app.delete(
    "/api/documents/:id",
    asyncRoute(async (req, res) => {
      await documents.remove(req.params.id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/sessions",
    requireJSON,
    asyncRoute(async (req, res) => {
      const title =
        boundedText(req.body.title, "Title", 160, { optional: true }) ||
        "Research session";
      const operationId = requestId(req);
      const session = await store.update((state) => {
        if (operationId) {
          const existing = state.sessions.find(
            (item) => item.requestId === operationId,
          );
          if (existing) {
            if (existing.title !== title)
              throw new HttpError(
                409,
                "This request ID was already used with another session title.",
              );
            return existing;
          }
        }
        if (state.sessions.length >= 200)
          throw new HttpError(
            413,
            "The app supports up to 200 sessions. Export and remove an old session first.",
          );
        const created = {
          id: randomUUID(),
          title,
          createdAt: new Date().toISOString(),
          transcript: [],
          messages: [],
          ...(operationId ? { requestId: operationId } : {}),
        };
        state.sessions.unshift(created);
        return created;
      });
      res.status(201).json(publicSession(session));
    }),
  );
  app.delete(
    "/api/sessions/:id",
    asyncRoute(async (req, res) => {
      if (answering.has(req.params.id))
        throw new HttpError(
          409,
          "An answer is running for this session. Stop it or wait before deleting the session.",
        );
      await store.update((state) => {
        state.sessions = state.sessions.filter(
          (session) => session.id !== req.params.id,
        );
      });
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/sessions/:id/transcript",
    requireJSON,
    asyncRoute(async (req, res) => {
      const text = boundedText(req.body.text, "Transcript text", 32000);
      const operationId = requestId(req);
      const entry = await store.update((state) => {
        const session = store.session(req.params.id, state);
        if (operationId) {
          const existing = session.transcript.find(
            (item) => item.requestId === operationId,
          );
          if (existing) {
            if (existing.text !== text)
              throw new HttpError(
                409,
                "This request ID was already used with different transcript text.",
              );
            return existing;
          }
        }
        if (
          sessionSize(session) + text.length > 2000000 ||
          session.transcript.length >= 10000
        )
          throw new HttpError(
            413,
            "This session is full. Export it and create a new session.",
          );
        const item = {
          id: randomUUID(),
          text,
          time: new Date().toISOString(),
          ...(operationId ? { requestId: operationId } : {}),
        };
        session.transcript.push(item);
        return item;
      });
      res
        .status(201)
        .json({ id: entry.id, text: entry.text, time: entry.time });
    }),
  );
  app.get("/api/sessions/:id/export", (req, res, next) => {
    try {
      const session = store.session(req.params.id);
      res.set(
        "Content-Disposition",
        `attachment; filename="research-session-${session.id}.md"`,
      );
      res.type("text/markdown").send(exportSession(session));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/transcribe",
    (req, _res, next) => {
      try {
        req.openai = clientFor(store);
        if (transcriptions.size >= 3)
          throw new HttpError(
            429,
            "Three audio requests are already running. Wait before sending another.",
          );
        next();
      } catch (error) {
        next(error);
      }
    },
    audioUpload,
    asyncRoute(async (req, res) => {
      if (!req.file)
        throw new HttpError(400, "Attach a WAV file in the audio field.");
      if (transcriptions.size >= 3)
        throw new HttpError(
          429,
          "Three audio requests are already running. Wait before sending another.",
        );
      const controller = new AbortController();
      transcriptions.add(controller);
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        await chmod(req.file.path, 0o600);
        const text = await transcribe(
          req.openai,
          req.file.path,
          store.state.settings.language,
          controller.signal,
          store.state.settings.transcribeModel,
        );
        if (!res.destroyed) res.json({ text });
      } finally {
        transcriptions.delete(controller);
        await cleanupUpload(req);
      }
    }),
  );

  app.post(
    "/api/sessions/:id/answer",
    requireJSON,
    asyncRoute(async (req, res) => {
      const requestedProvider = req.body.answerProvider;
      if (
        requestedProvider !== undefined &&
        requestedProvider !== store.state.settings.answerProvider
      )
        throw new HttpError(
          409,
          "The answer connection changed. Send this question again with the selected connection.",
        );
      const question = boundedText(req.body.question, "Question", 12000);
      const operationId = requestId(req);
      const sessionId = req.params.id;
      const snapshot = store.session(sessionId);
      if (answering.has(sessionId))
        throw new HttpError(
          409,
          "An answer is already running for this session. Wait for it to finish.",
        );
      if (answering.size >= 3)
        throw new HttpError(
          429,
          "Three answers are already running. Wait before requesting another.",
        );
      if (
        snapshot.messages.length >= 2000 ||
        sessionSize(snapshot) + question.length + 64000 > 2000000
      )
        throw new HttpError(
          413,
          "This session is full. Export it and create a new session.",
        );
      if (operationId) {
        const previous = snapshot.messages.find(
          (message) =>
            message.role === "assistant" && message.requestId === operationId,
        );
        if (previous) {
          if (previous.question !== question)
            throw new HttpError(
              409,
              "This request ID was already used with another question.",
            );
          res.type("application/x-ndjson");
          await sendEvent(res, {
            type: "sources",
            sources: previous.sources || [],
          });
          const { id, role, text, sources } = previous;
          await sendEvent(res, {
            type: "done",
            message: { id, role, text, sources },
          });
          return res.end();
        }
      }
      const controller = new AbortController();
      answering.set(sessionId, controller);
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const previousQuestion =
          [...snapshot.messages]
            .reverse()
            .find((message) => message.role === "user" && !message.pending)
            ?.text || "";
        const sources = index.search(question, 6, previousQuestion);
        const settings = { ...store.state.settings };
        if (
          requestedProvider !== undefined &&
          requestedProvider !== settings.answerProvider
        )
          throw new HttpError(
            409,
            "The answer connection changed. Send this question again with the selected connection.",
          );
        let client;
        if (settings.answerProvider === "openai") {
          client = answerClient(settings, () => createClient(store));
        } else if (settings.answerProvider === "chatgpt") {
          validateSubscriptionModel(settings.subscriptionModel);
        } else {
          throw new HttpError(
            400,
            "Choose a supported answer provider in Settings.",
          );
        }
        const messages = answerMessages({
          settings,
          session: snapshot,
          question,
          sources,
          skills: index.skills(),
        });
        const userMessageId = await store.update((state) => {
          const session = store.session(sessionId, state);
          if (
            session.messages.length >= 2000 ||
            sessionSize(session) + question.length + 64000 > 2000000
          )
            throw new HttpError(
              413,
              "This session is full. Export it and create a new session.",
            );
          const previous = session.messages.at(-1);
          if (
            previous?.role === "user" &&
            previous.pending &&
            previous.text === question &&
            previous.requestId === operationId
          )
            return previous.id;
          if (
            operationId &&
            session.messages.some(
              (message) =>
                message.requestId === operationId && message.text !== question,
            )
          )
            throw new HttpError(
              409,
              "This request ID was already used with another question.",
            );
          const message = {
            id: randomUUID(),
            role: "user",
            text: question,
            pending: true,
            ...(operationId ? { requestId: operationId } : {}),
          };
          session.messages.push(message);
          return message.id;
        });
        res.set({
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        await sendEvent(res, { type: "sources", sources });
        let text = "";
        try {
          for await (const event of answerEvents({
            settings,
            messages,
            subscription,
            signal: controller.signal,
            createClient: () => createClient(store),
            client,
          })) {
            if (controller.signal.aborted)
              throw new HttpError(499, "The answer request was cancelled.");
            if (event.type === "reset") text = "";
            if (event.type === "delta") {
              text += event.text;
              if (text.length > 64000) {
                controller.abort();
                throw new HttpError(
                  502,
                  "The answer exceeded the local response limit. Ask a narrower question.",
                );
              }
            }
            await sendEvent(res, event);
          }
          if (controller.signal.aborted)
            throw new HttpError(499, "The answer request was cancelled.");
          const message = {
            id: randomUUID(),
            role: "assistant",
            text,
            sources,
          };
          await store.update((state) => {
            const session = store.session(sessionId, state);
            const userMessage = session.messages.find(
              (item) => item.id === userMessageId,
            );
            if (userMessage) delete userMessage.pending;
            session.messages.push({
              ...message,
              ...(operationId ? { requestId: operationId, question } : {}),
            });
          });
          await sendEvent(res, { type: "done", message });
        } catch (error) {
          const safe = modelError(error);
          if (!res.destroyed && !res.writableEnded)
            await sendEvent(res, { type: "error", error: safe.message });
        }
        if (!res.destroyed) res.end();
      } finally {
        answering.delete(sessionId);
      }
    }),
  );

  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use(
    express.static(join(ROOT, "public"), { dotfiles: "deny", etag: false }),
  );
  app.use((_req, res) =>
    res.status(404).json({ error: "Resource not found." }),
  );
  app.use((error, req, res, _next) => {
    void cleanupUpload(req);
    if (res.headersSent) {
      if (!res.destroyed && !res.writableEnded)
        res.end(
          `${JSON.stringify({ type: "error", error: "The request could not be completed." })}\n`,
        );
      return;
    }
    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "The upload is too large. PDF files support up to 100 MB; audio supports up to 24 MB."
          : "Invalid upload. Use the files field for up to eight references, or the audio field for one WAV file.";
      return res.status(413).json({ error: message });
    }
    if (error.type === "entity.too.large")
      return res
        .status(413)
        .json({ error: "The JSON request body exceeds 128 KB." });
    if (error.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ error: "The request contains invalid JSON." });
    const safe =
      error instanceof HttpError
        ? error
        : new HttpError(
            500,
            "The local request failed. Check available disk space and data-directory permissions, then try again.",
          );
    res.status(safe.status).json({ error: safe.message });
  });
  const server = createServer(app);
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 30000;
  server.on("close", () => {
    for (const controller of [...answering.values(), ...transcriptions])
      controller.abort();
    subscription.close();
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startServer()
    .then(({ server, url }) => {
      console.log(`Ghst is available at ${url}`);
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => {
          server.close();
          server.closeAllConnections();
        });
    })
    .catch(() => {
      console.error(
        "Could not start Ghst. Check the port, dependency installation, and saved-data directory.",
      );
      process.exitCode = 1;
    });
}
