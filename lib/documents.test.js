import { answerMessages } from "./openai.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, HttpError } from "./store.js";
import { Documents } from "./documents.js";
import { startServer } from "../server.js";

async function workspace(t, sessions = ["alpha", "beta"]) {
  const directory = await mkdtemp(join(tmpdir(), "ghst-documents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init();
  await store.update((state) => {
    state.sessions.unshift(
      ...sessions.map((id) => ({
        id,
        title: id[0].toUpperCase() + id.slice(1),
        createdAt: "2026-01-01T00:00:00.000Z",
        transcript: [],
        messages: [],
      })),
    );
  });
  return store;
}

async function skillUpload(store, name, text) {
  const path = join(store.uploadDirectory, `${randomUUID()}.md`);
  await writeFile(path, text);
  return { path, originalname: name, size: Buffer.byteLength(text) };
}

async function pdfUpload(store, name, pages) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(store.uploadDirectory, `${randomUUID()}.pdf`);
  await writeFile(path, pdf);
  return { path, originalname: name, size: Buffer.byteLength(pdf) };
}

async function addSkill(documents, sessionId, name, text) {
  return documents.add([await skillUpload(documents.store, name, text)], sessionId);
}

function session(id) {
  return {
    id,
    title: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    transcript: [],
    messages: [],
  };
}

async function seedReference(store, metadata, document) {
  const suffix = metadata.type === "pdf" ? "pdf" : "md";
  await writeFile(join(store.documentDirectory, `${metadata.id}.json`), JSON.stringify(document));
  await writeFile(join(store.documentDirectory, `${metadata.id}.${suffix}`), "fixture");
}

test("each session stores only its own references and skills", async (t) => {
  const store = await workspace(t);
  const documents = await new Documents(store).init();

  await addSkill(documents, "alpha", "alpha.md", "Alpha-only instructions");
  await addSkill(documents, "beta", "beta.md", "Beta-only instructions");
  const alphaDocuments = documents.forSession("alpha");
  alphaDocuments.set("alpha-pdf", {
    id: "alpha-pdf",
    name: "Alpha.pdf",
    sessionId: "alpha",
    type: "pdf",
    pages: [{ page: 1, text: "The quokka evidence belongs to Alpha." }],
  });

  assert.deepEqual(
    store.state.documents.map((document) => [document.sessionId, document.name]),
    [
      ["alpha", "alpha.md"],
      ["beta", "beta.md"],
    ],
  );
  assert.deepEqual(
    documents.skills("alpha").map((skill) => skill.text),
    ["Alpha-only instructions"],
  );
  assert.deepEqual(
    documents.skills("beta").map((skill) => skill.text),
    ["Beta-only instructions"],
  );
  assert.ok(alphaDocuments instanceof Map);
  assert.equal(documents.forSession("alpha"), alphaDocuments);
  assert.equal(alphaDocuments.get("alpha-pdf").pages[0].text, "The quokka evidence belongs to Alpha.");
  assert.equal(documents.forSession("beta").has("alpha-pdf"), false);
  assert.notEqual(alphaDocuments, documents.forSession("beta"));
  assert.throws(() => documents.forSession("missing"), HttpError);
  assert.throws(() => documents.skills("missing"), HttpError);
});

test("uploaded multipage PDFs preserve complete text, ownership and private storage across restart and removal", async t => {
  const store = await workspace(t);
  const documents = await new Documents(store).init();
  const pages = ["Opening evidence.", "Methods and analysis.", "Final-page conclusion sentinel."];
  const upload = await pdfUpload(store, "Thesis.pdf", pages);
  const original = await readFile(upload.path);
  const [metadata] = await documents.add([upload], "alpha");
  const [skill] = await addSkill(documents, "alpha", "guide.md", "Use verified page citations.");
  assert.equal(metadata.pages, 3);
  const document = documents.forSession("alpha").get(metadata.id);
  assert.deepEqual(document.pages, pages.map((text, index) => ({ page: index + 1, text })));
  assert.equal(document.sessionId, "alpha");
  assert.deepEqual(documents.skills("alpha").map(item => item.id), [skill.id]);
  assert.equal(documents.forSession("beta").size, 0);
  for (const path of documents.pathsFor(metadata))
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(documents.path(metadata.id, "pdf")), original);
  const restoredStore = await new Store(store.directory).init();
  const restored = await new Documents(restoredStore).init();
  assert.deepEqual(restored.forSession("alpha").get(metadata.id), document);
  assert.deepEqual(restored.skills("alpha"), documents.skills("alpha"));
  assert.equal(restored.forSession("beta").size, 0);
  await assert.rejects(restored.remove(metadata.id, "beta"), error => error.status === 404);
  assert.deepEqual(await readFile(restored.path(metadata.id, "pdf")), original);
  await restored.remove(metadata.id, "alpha");
  assert.equal(restored.forSession("alpha").has(metadata.id), false);
  assert.deepEqual(restored.skills("alpha").map(item => item.id), [skill.id]);
  for (const path of restored.pathsFor(metadata))
    await assert.rejects(readFile(path), { code: "ENOENT" });
  const afterRemoval = await new Documents(await new Store(store.directory).init()).init();
  assert.equal(afterRemoval.forSession("alpha").has(metadata.id), false);
  assert.deepEqual(afterRemoval.skills("alpha").map(item => item.id), [skill.id]);
});

test("a reference cannot be removed through another session", async (t) => {
  const store = await workspace(t);
  const documents = await new Documents(store).init();
  const [alphaReference] = await addSkill(documents, "alpha", "alpha.md", "Alpha");
  await addSkill(documents, "beta", "beta.md", "Beta");

  await assert.rejects(
    documents.remove(alphaReference.id, "beta"),
    (error) => error instanceof HttpError && error.status === 404,
  );
  assert.equal(store.state.documents.length, 2);
  assert.equal(documents.skills("alpha").length, 1);
  assert.equal(await readFile(documents.path(alphaReference.id, "md"), "utf8"), "Alpha");

  await documents.remove(alphaReference.id, "alpha");
  assert.deepEqual(
    store.state.documents.map((document) => document.name),
    ["beta.md"],
  );
  assert.equal(documents.skills("alpha").length, 0);
  assert.equal(documents.skills("beta").length, 1);
  for (const path of documents.pathsFor(alphaReference))
    await assert.rejects(readFile(path), { code: "ENOENT" });
  const restored = await new Documents(await new Store(store.directory).init()).init();
  assert.equal(restored.forSession("alpha").size, 0);
  assert.deepEqual(restored.skills("beta").map(skill => skill.text), ["Beta"]);
});

test("startup preserves all saved conversations, references and runtime history while exposing only the first", async (t) => {
  const store = await workspace(t);
  const documents = await new Documents(store).init();
  const [alphaReference] = await addSkill(documents, "alpha", "alpha.md", "Alpha");
  const [betaReference] = await addSkill(documents, "beta", "beta.md", "Beta");
  await store.update(state => {
    state.sessions[0].transcript.push({ id: "spoken", time: "12:00", text: "Saved speech" });
    state.sessions[0].messages.push({ id: "answer", role: "assistant", text: "Saved answer" });
    state.sessions[1].messages.push({ id: "private", role: "user", text: "Hidden history" });
  });
  for (const id of ["alpha", "beta"]) {
    const history = join(store.directory, "agents", id, "history");
    await mkdir(history, { recursive: true });
    await writeFile(join(history, "saved.jsonl"), `${id} native history`);
  }
  const before = structuredClone(store.state);
  const restored = await new Store(store.directory).init();
  const restoredDocuments = await new Documents(restored).init();
  assert.deepEqual(restored.state, before);
  assert.deepEqual(JSON.parse(await readFile(restored.path, "utf8")), before);
  assert.deepEqual(restored.publicState().sessions.map(item => item.id), ["alpha"]);
  assert.deepEqual(restored.publicState().documents.map(item => item.id), [alphaReference.id]);
  assert.deepEqual(restored.publicState().sessions[0].transcript, before.sessions[0].transcript);
  assert.deepEqual(restored.publicState().sessions[0].messages, before.sessions[0].messages);
  assert.equal(restoredDocuments.skills("beta")[0].text, "Beta");
  for (const reference of [alphaReference, betaReference]) {
    const saved = JSON.parse(await readFile(join(store.documentDirectory, `${reference.id}.json`), "utf8"));
    assert.equal(saved.sessionId, reference.sessionId);
    assert.equal(await readFile(join(store.documentDirectory, `${reference.id}.md`), "utf8"), reference.sessionId === "alpha" ? "Alpha" : "Beta");
  }
  for (const id of ["alpha", "beta"])
    assert.equal(await readFile(join(store.directory, "agents", id, "history", "saved.jsonl"), "utf8"), `${id} native history`);
});

test("an empty store initializes one conversation and reuses it on restart", async t => {
  const store = await workspace(t, []);
  const first = structuredClone(store.publicState().sessions[0]);
  assert.equal(store.state.sessions.length, 1);
  assert.ok(first.id);
  assert.deepEqual(first.transcript, []);
  assert.deepEqual(first.messages, []);
  const restored = await new Store(store.directory).init();
  assert.deepEqual(restored.publicState().sessions, [first]);
  assert.equal(restored.state.sessions.length, 1);
});

test("legacy global references move to their own session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ghst-documents-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      version: 1,
      settings: {},
      apiKey: "",
      sessions: [
        {
          ...session("existing"),
          transcript: [{ id: "entry", time: "12:00", text: "Existing transcript" }],
          messages: [{ id: "message", role: "user", text: "Existing question" }],
        },
      ],
      documents: [
        {
          id: "legacy-reference",
          name: "Legacy.pdf",
          type: "pdf",
          pages: 1,
          characters: 15,
        },
        {
          id: "orphan-reference",
          sessionId: "deleted-session",
          name: "Orphan.pdf",
          type: "pdf",
          pages: 1,
          characters: 15,
        },
      ],
    }),
  );
  const store = await new Store(directory).init();
  const prompt = answerMessages({ settings: store.state.settings, session: store.session("existing"), question: "New question", skills: [] });
  assert.equal(JSON.stringify(prompt).includes("Existing question"), false);
  await seedReference(store, {
    id: "legacy-reference",
    type: "pdf",
    name: "Legacy.pdf",
  }, {
    id: "legacy-reference",
    type: "pdf",
    name: "Legacy.pdf",
    pages: [{ page: 1, text: "Legacy evidence" }],
    characters: 15,
  });
  await seedReference(store, {
    id: "orphan-reference",
    type: "pdf",
    name: "Orphan.pdf",
  }, {
    id: "orphan-reference",
    type: "pdf",
    name: "Orphan.pdf",
    pages: [{ page: 1, text: "Orphan evidence" }],
    characters: 15,
  });
  const documents = await new Documents(store).init();

  const migrated = store.state.sessions.find(
    (item) => item.title === "Previous context library",
  );
  assert.ok(migrated);
  assert.deepEqual(
    store.state.documents.map((document) => document.sessionId),
    [migrated.id, migrated.id],
  );
  assert.deepEqual(store.session("existing").messages, [
    { id: "message", role: "user", text: "Existing question" },
  ]);
  assert.equal(documents.forSession(migrated.id).get("legacy-reference").pages[0].text, "Legacy evidence");
  assert.equal(documents.forSession(migrated.id).get("orphan-reference").pages[0].text, "Orphan evidence");
  assert.ok([...documents.forSession(migrated.id).values()].every(document => document.sessionId === migrated.id));
  assert.equal(documents.forSession("existing").size, 0);
  assert.deepEqual(store.publicState().sessions.map(item => item.id), ["existing"]);
  assert.deepEqual(store.publicState().documents, []);
  const restored = await new Store(directory).init();
  assert.deepEqual(restored.state, store.state);
});

test("answers receive only the active session's context library", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ghst-documents-answer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory).init();
  const alpha = session("alpha");
  alpha.transcript = [{ id: "alpha-entry", time: "12:00", text: "Alpha transcript" }];
  alpha.messages = [{ id: "alpha-message", role: "user", text: "Alpha history" }];
  const beta = session("beta");
  beta.transcript = [{ id: "beta-entry", time: "12:00", text: "Beta transcript" }];
  beta.messages = [{ id: "beta-message", role: "user", text: "Beta history" }];
  await store.update((state) => {
    state.settings.answerProvider = "chatgpt";
    state.settings.subscriptionModel = "openai-codex/gpt-6-sol";
    state.sessions.unshift(alpha, beta);
    state.documents.push(
      {
        id: "alpha-pdf",
        sessionId: "alpha",
        name: "Alpha.pdf",
        type: "pdf",
        pages: 1,
        characters: 30,
      },
      {
        id: "beta-pdf",
        sessionId: "beta",
        name: "Beta.pdf",
        type: "pdf",
        pages: 1,
        characters: 30,
      },
      {
        id: "alpha-skill",
        sessionId: "alpha",
        name: "AlphaSkill.md",
        type: "skill",
        pages: 0,
        characters: 21,
      },
      {
        id: "beta-skill",
        sessionId: "beta",
        name: "BetaSkill.md",
        type: "skill",
        pages: 0,
        characters: 20,
      },
    );
  });
  await seedReference(store, { id: "alpha-pdf", type: "pdf", name: "Alpha.pdf" }, {
    id: "alpha-pdf",
    type: "pdf",
    name: "Alpha.pdf",
    pages: [{ page: 1, text: "Alpha quokka evidence" }],
    characters: 30,
  });
  await seedReference(store, { id: "beta-pdf", type: "pdf", name: "Beta.pdf" }, {
    id: "beta-pdf",
    type: "pdf",
    name: "Beta.pdf",
    pages: [{ page: 1, text: "Beta numbat evidence" }],
    characters: 30,
  });
  await seedReference(store, { id: "alpha-skill", type: "skill", name: "AlphaSkill.md" }, {
    id: "alpha-skill",
    type: "skill",
    name: "AlphaSkill.md",
    pages: [],
    text: "Alpha-only instructions",
    characters: 21,
  });
  await seedReference(store, { id: "beta-skill", type: "skill", name: "BetaSkill.md" }, {
    id: "beta-skill",
    type: "skill",
    name: "BetaSkill.md",
    pages: [],
    text: "Beta-only instructions",
    characters: 20,
  });

  const calls = [];
  const subscription = {
    async status() {
      return { connected: true, installed: true, model: "openai-codex/gpt-6-sol" };
    },
    async metadata() {
      return { models: ["openai-codex/gpt-6-sol"] };
    },
    close() {},
  };
  const agentRuntime = {
    async *answer({ messages }) { calls.push(messages); yield { type: "delta", text: "Isolated answer" }; },
    close() {},
  };
  const { server, url } = await startServer({ port: 0, store, subscription, agentRuntime });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const ask = async (sessionId, question) => {
    const response = await fetch(`${url}/api/sessions/${sessionId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        requestId: randomUUID(),
        answerProvider: "chatgpt",
      }),
    });
    assert.equal(response.status, 200);
    return (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };

  const alphaEvents = await ask("alpha", "What is the quokka evidence?");
  assert.deepEqual(alphaEvents.map((event) => event.type), ["delta", "done"]);
  const alphaContext = JSON.stringify(calls[0]);
  assert.match(alphaContext, /Alpha transcript/);
  assert.match(alphaContext, /Alpha history/);
  assert.match(alphaContext, /Alpha-only instructions/);
  assert.doesNotMatch(alphaContext, /Beta transcript/);
  assert.doesNotMatch(alphaContext, /Beta history/);
  assert.doesNotMatch(alphaContext, /Beta-only instructions/);
  assert.doesNotMatch(alphaContext, /Beta\.pdf/);
  assert.doesNotMatch(alphaContext, /Alpha quokka evidence|Beta numbat evidence/);

  const hidden = await fetch(`${url}/api/sessions/beta/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "What is the numbat evidence?", answerProvider: "chatgpt" }),
  });
  assert.equal(hidden.status, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(store.session("beta"), beta);
  const publicState = await (await fetch(`${url}/api/state`)).json();
  assert.deepEqual(publicState.sessions.map(item => item.id), ["alpha"]);
  assert.deepEqual(publicState.documents.map(item => item.id), ["alpha-pdf", "alpha-skill"]);
  for (const id of ["alpha", "beta"]) {
    const removed = await fetch(`${url}/api/sessions/${id}/documents/beta-pdf`, { method: "DELETE" });
    assert.equal(removed.status, 404);
  }
  assert.ok(store.state.documents.some(document => document.id === "beta-pdf"));
  assert.equal(await readFile(join(store.documentDirectory, "beta-pdf.pdf"), "utf8"), "fixture");
});
