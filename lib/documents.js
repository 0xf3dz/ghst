import { readFile, rename, chmod, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJSON, HttpError } from "./store.js";

export const MAX_SKILL_CHARACTERS = 32000;
export const MAX_TOTAL_SKILL_CHARACTERS = 64000;
const MAX_PDF_CHARACTERS = 50000000;
const MAX_PDF_PAGES = 10000;

function safeName(name) {
  return (
    basename(name.replaceAll("\\", "/"))
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 240) || "Reference"
  );
}

async function parsePDF(file, id, name) {
  const data = new Uint8Array(await readFile(file.path));
  if (!Buffer.from(data.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) {
    throw new HttpError(400, `${name}: this file is not a PDF.`);
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data,
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    stopAtErrors: true,
  });
  let pdf;
  try {
    pdf = await loading.promise;
    if (pdf.numPages > MAX_PDF_PAGES)
      throw new HttpError(
        413,
        `${name}: the PDF exceeds the ${MAX_PDF_PAGES}-page limit. Split it into smaller files.`,
      );
    const pages = [];
    let characters = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (typeof item.str === "string")
          text += item.str + (item.hasEOL ? "\n" : " ");
      }
      text = text.replace(/\u0000/g, "").trim();
      characters += text.length;
      if (characters > MAX_PDF_CHARACTERS)
        throw new HttpError(
          413,
          `${name}: extracted text exceeds 50 million characters. Split it into smaller files.`,
        );
      pages.push({ page: number, text });
      page.cleanup();
    }
    if (!pages.some((page) => /[\p{L}\p{N}]/u.test(page.text))) {
      throw new HttpError(
        422,
        `${name}: no readable text was found. This may be a scanned PDF. Run OCR locally, then upload the searchable PDF.`,
      );
    }
    return { id, name, type: "pdf", pages, characters };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.name === "PasswordException")
      throw new HttpError(
        422,
        `${name}: the PDF is password protected. Upload an unlocked copy.`,
      );
    throw new HttpError(
      422,
      `${name}: PDF text extraction failed. Export a valid searchable PDF and try again.`,
    );
  } finally {
    await loading.destroy().catch(() => {});
  }
}

async function parseSkill(file, id, name) {
  if (file.size > MAX_SKILL_CHARACTERS * 4)
    throw new HttpError(
      413,
      `${name}: Markdown skills must contain no more than ${MAX_SKILL_CHARACTERS} characters.`,
    );
  const bytes = await readFile(file.path);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(422, `${name}: save the Markdown file as UTF-8 text.`);
  }
  if (text.includes("\u0000") || !text.trim())
    throw new HttpError(
      422,
      `${name}: the Markdown file is empty or contains binary data.`,
    );
  if (text.length > MAX_SKILL_CHARACTERS)
    throw new HttpError(
      413,
      `${name}: Markdown skills must contain no more than ${MAX_SKILL_CHARACTERS} characters.`,
    );
  return { id, name, type: "skill", pages: [], text, characters: text.length };
}

export class Documents {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
    this.pending = Promise.resolve();
  }

  path(id, suffix) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
      throw new Error("Invalid document ID");
    return join(this.store.documentDirectory, `${id}.${suffix}`);
  }

  forSession(sessionId) {
    this.store.session(sessionId);
    if (!this.sessions.has(sessionId))
      this.sessions.set(sessionId, new Map());
    return this.sessions.get(sessionId);
  }

  skills(sessionId) {
    const skills = [];
    for (const document of this.forSession(sessionId).values())
      if (document.type === "skill") skills.push(document);
    return skills;
  }

  async init() {
    const ids = new Set();
    for (const metadata of this.store.state.documents) {
      try {
        this.store.session(metadata.sessionId);
        if (ids.has(metadata.id)) throw new Error("Duplicate document ID");
        ids.add(metadata.id);
        const document = JSON.parse(
          await readFile(this.path(metadata.id, "json"), "utf8"),
        );
        if (
          document.id !== metadata.id ||
          document.type !== metadata.type ||
          !Array.isArray(document.pages) ||
          !["pdf", "skill"].includes(document.type)
        )
          throw new Error("Invalid document");
        if (document.type === "skill" && typeof document.text !== "string")
          throw new Error("Invalid skill");
        await chmod(this.path(metadata.id, "json"), 0o600);
        await chmod(
          this.path(metadata.id, document.type === "pdf" ? "pdf" : "md"),
          0o600,
        );
        document.sessionId = metadata.sessionId;
        this.forSession(metadata.sessionId).set(document.id, document);
      } catch {
        throw new Error(
          "Cannot read a saved reference. Restore the documents directory from a backup, or choose a new THESIS_DATA_DIR.",
        );
      }
    }
    return this;
  }

  exclusive(operation) {
    const pending = this.pending.then(operation);
    this.pending = pending.catch(() => {});
    return pending;
  }

  add(files, sessionId) {
    return this.exclusive(async () => {
      const documents = this.forSession(sessionId);
      if (!files.length)
        throw new HttpError(400, "Select one or more PDF or Markdown files.");
      if (documents.size + files.length > 250)
        throw new HttpError(
          413,
          "Each session supports up to 250 documents. Remove a document before adding another.",
        );
      const parsed = [];
      let skillCharacters = this.skills(sessionId)
        .reduce((sum, item) => sum + item.characters, 0);
      for (const file of files) {
        const id = randomUUID();
        const name = safeName(file.originalname);
        const document =
          extname(name).toLowerCase() === ".pdf"
            ? await parsePDF(file, id, name)
            : await parseSkill(file, id, name);
        document.sessionId = sessionId;
        if (document.type === "skill") skillCharacters += document.characters;
        if (skillCharacters > MAX_TOTAL_SKILL_CHARACTERS)
          throw new HttpError(
            413,
            "All Markdown skills together must contain no more than 64000 characters. Their full text is applied to each answer.",
          );
        parsed.push({ file, document });
      }
      const metadata = parsed.map(({ document }) => ({
        id: document.id,
        sessionId,
        name: document.name,
        type: document.type,
        pages: document.pages.length,
        characters: document.characters,
      }));
      const written = [];
      try {
        for (const { file, document } of parsed) {
          const original = this.path(
            document.id,
            document.type === "pdf" ? "pdf" : "md",
          );
          written.push(original, this.path(document.id, "json"));
          await chmod(file.path, 0o600);
          await rename(file.path, original);
          await atomicJSON(this.path(document.id, "json"), document);
        }
        await this.store.update((state) => {
          this.store.session(sessionId, state);
          state.documents.push(...metadata);
        });
      } catch (error) {
        await Promise.all(
          written.map((path) => rm(path, { force: true }).catch(() => {})),
        );
        throw error;
      }
      for (const { document } of parsed) documents.set(document.id, document);
      return metadata;
    });
  }

  remove(id, sessionId) {
    return this.exclusive(async () => {
      const documents = this.forSession(sessionId);
      const metadata = this.store.state.documents.find(
        (document) => document.id === id && document.sessionId === sessionId,
      );
      if (!metadata) throw new HttpError(404, "Document not found in this session.");
      const paths = this.pathsFor(metadata);
      await this.store.update((state) => {
        this.store.session(sessionId, state);
        state.documents = state.documents.filter(
          (document) => document.id !== id || document.sessionId !== sessionId,
        );
      });
      documents.delete(id);
      await Promise.all(paths.map((path) => rm(path, { force: true })));
    });
  }

  pathsFor(metadata) {
    return [
      this.path(metadata.id, "json"),
      this.path(metadata.id, metadata.type === "pdf" ? "pdf" : "md"),
    ];
  }
}
