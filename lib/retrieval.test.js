import test from "node:test";
import assert from "node:assert/strict";
import { RetrievalIndex } from "./retrieval.js";

function document(id, pages) {
  return {
    id,
    name: `${id}.pdf`,
    type: "pdf",
    pages: pages.map(([page, text]) => ({ page, text })),
  };
}

test("retrieval reaches the end of long pages and preserves page attribution", () => {
  const index = new RetrievalIndex();
  const markers = Array.from(
    { length: 40 },
    (_, number) => `sentinel${number}`,
  );
  const text = markers
    .map((marker) => `${"coastal sediment ".repeat(35)}${marker}`)
    .join(" ");
  index.add(
    document("long-thesis", [
      [1, "Front matter."],
      [723, text],
      [724, "Final appendix."],
    ]),
  );
  for (const marker of markers) {
    const sources = index.search(marker);
    assert.ok(
      sources.some((source) => source.text.includes(marker)),
      marker,
    );
    for (const source of sources) {
      assert.equal(source.documentId, "long-thesis");
      assert.equal(source.name, "long-thesis.pdf");
      assert.equal(source.page, 723);
      assert.ok(source.text.length > 0 && source.text.length <= 1600);
      assert.ok(text.includes(source.text));
    }
  }
});

test("retrieval never merges passages across page boundaries", () => {
  const index = new RetrievalIndex();
  index.add(
    document("boundaries", [
      [7, "UpstreamMarker mangrove roots trap sediment."],
      [8, "DownstreamMarker waves remove sediment."],
    ]),
  );
  const sources = index.search("UpstreamMarker DownstreamMarker");
  assert.equal(sources.length, 2);
  assert.deepEqual(
    new Set(sources.map((source) => source.page)),
    new Set([7, 8]),
  );
  assert.ok(
    sources.every(
      (source) =>
        !(
          source.text.includes("UpstreamMarker") &&
          source.text.includes("DownstreamMarker")
        ),
    ),
  );
});

test("short follow-ups retain the preceding question subject", () => {
  const index = new RetrievalIndex();
  index.add(
    document("ecology", [
      [
        18,
        "Mangrove restoration reduces erosion because root networks retain sediment.",
      ],
      [19, "Coral spawning occurs during seasonal lunar cycles."],
    ]),
  );
  assert.deepEqual(index.search("Why?"), []);
  const sources = index.search(
    "Why?",
    6,
    "How does mangrove restoration reduce erosion?",
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].page, 18);
  assert.match(sources[0].text, /root networks/);
});

test("broad contribution questions cover abstract and conclusion evidence", () => {
  const index = new RetrievalIndex();
  index.add(
    document("coverage", [
      [1, "Table of contents: Abstract, Methods, Conclusion."],
      [
        2,
        "Abstract. A controlled estuary survey identifies improved sediment retention.",
      ],
      [15, "Methods. Sampling stations use calibrated sensors."],
      [
        80,
        "Conclusion. The measured intervention improves shoreline stability.",
      ],
    ]),
  );
  const sources = index.search("What is the main contribution?");
  assert.ok(sources.some((source) => source.page === 2));
  assert.ok(sources.some((source) => source.page === 80));
  assert.notEqual(sources[0].page, 1);
});

test("limitations questions prioritize limitations over introductory coverage", () => {
  const index = new RetrievalIndex();
  index.add(
    document("limitations", [
      [
        2,
        "Abstract. An estuary survey identifies improved sediment retention.",
      ],
      [
        76,
        "Limitations. The short observation period prevents conclusions about long-term changes.",
      ],
      [77, "Future work. Multi-year observations would improve confidence."],
    ]),
  );
  const sources = index.search("What are the limitations?");
  assert.ok([76, 77].includes(sources[0].page));
  assert.ok(sources.some((source) => source.page === 76));
  assert.ok(sources.some((source) => source.page === 77));
});

test("retrieval obeys its result limit and distinguishes documents", () => {
  const index = new RetrievalIndex();
  for (let number = 0; number < 12; number++)
    index.add(
      document(`reference-${number}`, [
        [number + 1, "Calibration measurement uncertainty."],
      ]),
    );
  assert.equal(index.search("calibration").length, 6);
  const sources = index.search("calibration", 3);
  assert.equal(sources.length, 3);
  assert.equal(new Set(sources.map((source) => source.documentId)).size, 3);
});

test("replacement and removal discard obsolete searchable text", () => {
  const index = new RetrievalIndex();
  index.add(
    document("revised", [[9, "ObsoleteMarker appears in the earlier draft."]]),
  );
  index.add(
    document("revised", [[10, "ReplacementMarker appears in the new draft."]]),
  );
  assert.deepEqual(index.search("ObsoleteMarker"), []);
  assert.equal(index.search("ReplacementMarker")[0].page, 10);
  index.remove("revised");
  index.remove("revised");
  assert.deepEqual(index.search("ReplacementMarker"), []);
});

test("Markdown skills remain instructions rather than cited PDF evidence", () => {
  const index = new RetrievalIndex();
  index.add({
    id: "skill",
    name: "skill.md",
    type: "skill",
    text: "InstructionMarker",
    pages: [],
  });
  assert.equal(index.skills()[0].text, "InstructionMarker");
  assert.deepEqual(index.search("InstructionMarker"), []);
});
