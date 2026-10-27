const STOP_WORDS = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our please should so that the their them then there these they this those to us was we were what when where which who why will with would you your thesis paper document reference explain tell main".split(
    " ",
  ),
);
const tokenize = (text) =>
  (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
    (token) => !STOP_WORDS.has(token),
  );

function passages(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const result = [];
  for (let start = 0; start < normalized.length; ) {
    let end = Math.min(start + 1600, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(" ", end);
      if (boundary > start + 1000) end = boundary;
    }
    result.push(normalized.slice(start, end));
    if (end === normalized.length) break;
    start = Math.max(start + 1, end - 220);
  }
  return result;
}

export class RetrievalIndex {
  constructor() {
    this.documents = new Map();
    this.chunks = new Map();
    this.postings = new Map();
    this.totalLength = 0;
  }

  add(document) {
    this.remove(document.id);
    this.documents.set(document.id, document);
    if (document.type !== "pdf") return;
    let sequence = 0;
    for (const page of document.pages) {
      for (const text of passages(page.text)) {
        const id = `${document.id}:${sequence++}`;
        const tokens = tokenize(text);
        const frequencies = new Map();
        for (const token of tokens)
          frequencies.set(token, (frequencies.get(token) || 0) + 1);
        const chunk = {
          documentId: document.id,
          name: document.name,
          page: page.page,
          text,
          length: tokens.length,
          frequencies,
        };
        this.chunks.set(id, chunk);
        this.totalLength += tokens.length;
        for (const [token, frequency] of frequencies) {
          if (!this.postings.has(token)) this.postings.set(token, new Map());
          this.postings.get(token).set(id, frequency);
        }
      }
    }
  }

  remove(documentId) {
    this.documents.delete(documentId);
    for (const [id, chunk] of this.chunks) {
      if (chunk.documentId !== documentId) continue;
      this.chunks.delete(id);
      this.totalLength -= chunk.length;
      for (const token of chunk.frequencies.keys()) {
        const posting = this.postings.get(token);
        posting.delete(id);
        if (!posting.size) this.postings.delete(token);
      }
    }
  }

  search(question, limit = 6, previousQuestion = "") {
    const followUp =
      tokenize(question).length < 5 ||
      /\b(it|that|this|those|they|further|more)\b/i.test(question);
    const query = `${question} ${followUp ? previousQuestion : ""}`;
    const overview =
      /\b(contribution|contributions|summary|summarize|overview|main|findings|conclude|conclusion|about)\b/i.test(
        query,
      );
    const limitations =
      /\b(limit|limits|limitation|limitations|weakness|weaknesses|future)\b/i.test(
        query,
      );
    const expansion = limitations
      ? "limitations discussion future work"
      : overview
        ? "abstract contribution contributions conclusion conclusions findings objectives"
        : "";
    const scores = new Map();
    const count = this.chunks.size;
    if (!count) return [];
    const average = this.totalLength / count || 1;
    for (const token of new Set(tokenize(`${query} ${expansion}`))) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      const inverse = Math.log(
        1 + (count - posting.size + 0.5) / (posting.size + 0.5),
      );
      for (const [id, frequency] of posting) {
        const chunk = this.chunks.get(id);
        const score =
          (inverse * (frequency * 2.2)) /
          (frequency + 1.2 * (0.25 + (0.75 * chunk.length) / average));
        scores.set(id, (scores.get(id) || 0) + score);
      }
    }
    if (overview || limitations || scores.size < 3) {
      const sectionPattern = limitations
        ? /\b(limitations|future work|discussion)\b/i
        : /\b(abstract|conclusions?|summary|contributions?)\b/i;
      const coverage = new Map();
      for (const [id, chunk] of this.chunks) {
        const match = sectionPattern.exec(chunk.text.slice(0, 700));
        if (
          !match ||
          /\b(contents|references|bibliography)\b/i.test(
            chunk.text.slice(0, 200),
          )
        )
          continue;
        const priority = (match.index < 160 ? 8 : 3) + (scores.get(id) || 0);
        const key = `${chunk.documentId}:${match[0].toLowerCase()}`;
        if (!coverage.has(key) || priority > coverage.get(key).priority)
          coverage.set(key, { id, priority });
      }
      for (const { id, priority } of coverage.values())
        scores.set(id, priority);
    }
    const selected = [];
    for (const [id] of [...scores].sort((a, b) => b[1] - a[1])) {
      const chunk = this.chunks.get(id);
      if (
        selected.some(
          (item) =>
            item.documentId === chunk.documentId &&
            item.page === chunk.page &&
            (item.text.includes(chunk.text.slice(0, 200)) ||
              chunk.text.includes(item.text.slice(0, 200))),
        )
      )
        continue;
      selected.push({
        documentId: chunk.documentId,
        name: chunk.name,
        page: chunk.page,
        text: chunk.text,
      });
      if (selected.length === limit) break;
    }
    return selected;
  }

  skills() {
    return [...this.documents.values()].filter((item) => item.type === "skill");
  }
}
