import type { ContextChunk } from "@sdd/contracts";
import { describe, expect, it } from "vitest";
import { Bm25, addTerms } from "../src/retrieval/bm25";
import {
  DEFAULT_BUDGET_TOKENS,
  TRUNCATION_MARKER,
  assembleBundle,
  chunkTokens,
  estimateTokens,
  sectionTokens,
  truncateText,
} from "../src/retrieval/budget";
import { RRF_K, reciprocalRankFusion } from "../src/retrieval/fusion";
import { LexicalIndex, MODULE_BOOST } from "../src/retrieval/lexical";
import { excerptMindmap } from "../src/retrieval/mindmapExcerpt";
import { stem, terms, tokenize } from "../src/retrieval/text";
import type { ChunkRecord } from "../src/types";

describe("text analysis", () => {
  it("splits identifiers, camelCase, acronyms, snake_case and paths into words", () => {
    expect(tokenize("InvoiceService.createInvoice_v2")).toEqual(["invoice", "service", "create", "invoice", "v2"]);
    expect(tokenize("HTTPServer parseURL")).toEqual(["http", "server", "parse", "url"]);
    expect(tokenize("modules/billing/payments.ts")).toEqual(["modules", "billing", "payments", "ts"]);
    expect(tokenize("a b !! 7")).toEqual([]); // single characters are dropped
  });

  it("stems plurals and verb forms so related words meet", () => {
    expect(stem("refunding")).toBe(stem("refund"));
    expect(stem("refunds")).toBe(stem("refund"));
    expect(stem("charging")).toBe(stem("charge"));
    expect(stem("payments")).toBe(stem("payment"));
    expect(stem("invoices")).toBe(stem("invoice"));
    expect(stem("queries")).toBe(stem("query"));
    expect(stem("class")).toBe("class"); // does not eat the double s
    expect(stem("is")).toBe("is");
  });

  it("drops stop words and keeps duplicates (term frequency matters)", () => {
    expect(terms("Add support for refunding the payments and the payments")).toEqual(["refund", "payment", "payment"]);
  });
});

describe("Bm25", () => {
  const doc = (item: string, words: string[]) => {
    const termWeights = new Map<string, number>();
    addTerms(termWeights, words, 1);
    return { item, termWeights };
  };

  it("ranks by relevance and ignores documents sharing no term", () => {
    const index = new Bm25([
      doc("billing", ["invoice", "payment", "refund"]),
      doc("auth", ["token", "session"]),
      doc("both", ["invoice", "token"]),
    ]);
    expect(index.search(["refund", "payment"]).map((r) => r.item)).toEqual(["billing"]);
    expect(
      index
        .search(["invoice"])
        .map((r) => r.item)
        .sort(),
    ).toEqual(["billing", "both"]); // the auth-only document is not returned
    expect(index.search(["nothing"])).toEqual([]);
  });

  it("weights rare terms above common ones", () => {
    const index = new Bm25([doc("a", ["common", "rare"]), doc("b", ["common"]), doc("c", ["common"]), doc("d", ["common"])]);
    expect(index.search(["common", "rare"])[0].item).toBe("a");
  });

  it("rewards a higher term count, with diminishing returns and length normalisation", () => {
    const index = new Bm25([
      doc("once", ["x", "y", "z"]),
      doc("thrice", ["x", "x", "x"]),
      doc("long", ["x", ...Array.from({ length: 30 }, (_, i) => `w${i}`)]),
    ]);
    const order = index.search(["x"]).map((r) => r.item);
    expect(order[0]).toBe("thrice");
    expect(order.indexOf("once")).toBeLessThan(order.indexOf("long")); // the same single match counts for less in a long document
  });

  it("is deterministic and breaks ties by insertion order", () => {
    const index = new Bm25([doc("first", ["t"]), doc("second", ["t"])]);
    expect(index.search(["t"]).map((r) => r.item)).toEqual(["first", "second"]);
    expect(index.search(["t", "t", "t"]).map((r) => r.item)).toEqual(["first", "second"]); // repeated query terms count once
  });

  it("handles an empty index and a limit", () => {
    expect(new Bm25<string>([]).search(["x"])).toEqual([]);
    expect(new Bm25([doc("a", ["x"]), doc("b", ["x"])]).search(["x"], 1)).toHaveLength(1);
  });
});

describe("reciprocalRankFusion", () => {
  it("scores items by the sum of 1 / (k + rank) over the lists they appear in", () => {
    const merged = reciprocalRankFusion(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      (x) => x,
    );
    const byKey = Object.fromEntries(merged.map((m) => [m.key, m.score]));
    expect(byKey.a).toBeCloseTo(1 / (RRF_K + 1));
    expect(byKey.b).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    expect(byKey.c).toBeCloseTo(1 / (RRF_K + 2));
  });

  it("puts an item both lists like above one only a single list loves", () => {
    const merged = reciprocalRankFusion(
      [
        ["top-of-one", "shared"],
        ["shared", "top-of-two"],
      ],
      (x) => x,
    );
    expect(merged[0].item).toBe("shared");
  });

  it("de-duplicates, reports the rank in each list, and keeps the earlier list's item", () => {
    const merged = reciprocalRankFusion(
      [
        [{ id: "x", from: 1 }],
        [
          { id: "x", from: 2 },
          { id: "y", from: 2 },
        ],
      ],
      (o) => o.id,
    );
    expect(merged.map((m) => m.key)).toEqual(["x", "y"]);
    expect(merged[0].item.from).toBe(1);
    expect(merged[0].ranks).toEqual([0, 0]);
    expect(merged[1].ranks).toEqual([null, 1]);
  });

  it("breaks ties by first appearance and copes with empty lists", () => {
    expect(reciprocalRankFusion([["a"], ["b"]], (x) => x).map((m) => m.item)).toEqual(["a", "b"]);
    expect(reciprocalRankFusion([[], []], (x: string) => x)).toEqual([]);
    expect(reciprocalRankFusion([], (x: string) => x)).toEqual([]);
  });
});

describe("assembleBundle (token budget)", () => {
  const chunk = (n: number, size = 400): ContextChunk => ({
    repoId: "r",
    filePath: `src/file${n}.ts`,
    symbolName: `fn${n}`,
    chunkType: "function",
    code: "x".repeat(size),
    startLine: 1,
    endLine: 10,
    score: 1 - n / 100,
    via: "similarity",
  });
  const section = (n: number, size = 2000) => ({ repoId: "r", path: `mod${n}/CLAUDE.md.generated.md`, content: "d".repeat(size) });
  const parts = (chunks: number, sections = 3) => ({
    mode: "hybrid" as const,
    chunks: Array.from({ length: chunks }, (_, i) => chunk(i)),
    sections: Array.from({ length: sections }, (_, i) => section(i)),
    mindmap: "m".repeat(3000),
  });

  it("returns everything untouched when it fits", () => {
    const bundle = assembleBundle({ ...parts(2, 1), mindmap: "small map" }, 100_000);
    expect(bundle.truncated).toBe(false);
    expect(bundle.chunks).toHaveLength(2);
    expect(bundle.relevantClaudeMdSections).toHaveLength(1);
    expect(bundle.relevantMindmapExcerpt).toBe("small map");
    expect(bundle.mode).toBe("hybrid");
  });

  it("never exceeds the budget, for any budget (property check)", () => {
    for (const budget of [1, 2, 10, 50, 99, 150, 200, 333, 500, 1000, 2500, 5000, 12_000, 100_000]) {
      for (const p of [parts(0, 0), parts(1, 1), parts(30, 5), { ...parts(5, 2), chunks: [chunk(0, 100_000), chunk(1, 10)] }]) {
        const bundle = assembleBundle(p, budget);
        expect(bundle.tokenEstimate, `budget ${budget}`).toBeLessThanOrEqual(budget);
        const recomputed =
          bundle.chunks.reduce((n, c) => n + chunkTokens(c), 0) +
          bundle.relevantClaudeMdSections.reduce((n, s) => n + sectionTokens(s), 0) +
          estimateTokens(bundle.relevantMindmapExcerpt.length);
        expect(bundle.tokenEstimate).toBe(recomputed);
      }
    }
  });

  it("keeps the best-ranked chunks: a smaller budget returns a prefix of what a larger budget returns", () => {
    const full = assembleBundle(parts(40), 1_000_000).chunks.map((c) => c.filePath);
    for (const budget of [300, 800, 2000, 6000]) {
      const got = assembleBundle(parts(40), budget).chunks.map((c) => c.filePath);
      expect(got, `budget ${budget}`).toEqual(full.slice(0, got.length));
    }
  });

  it("flags truncation and marks cut text", () => {
    const small = assembleBundle(parts(20), 1500);
    expect(small.truncated).toBe(true);
    expect(small.chunks.length).toBeLessThan(20);
    const cutText = [
      ...small.chunks.map((c) => c.code),
      ...small.relevantClaudeMdSections.map((s) => s.content),
      small.relevantMindmapExcerpt,
    ];
    expect(cutText.some((t) => t.endsWith(TRUNCATION_MARKER))).toBe(true);
  });

  it("cuts a chunk that does not fit when enough room is left, drops it when not, and stops there", () => {
    const big = { ...chunk(0, 8000), score: 0.9 };
    const bundle = assembleBundle({ mode: "claude-md", chunks: [big, chunk(1), chunk(2)], sections: [], mindmap: "" }, 1000);
    expect(bundle.chunks).toHaveLength(1);
    expect(bundle.chunks[0].code.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(bundle.chunks[0].code.length).toBeLessThan(8000);

    const tight = assembleBundle(
      { mode: "claude-md", chunks: [chunk(0, 400), chunk(1, 40_000), chunk(2, 10)], sections: [], mindmap: "" },
      130,
    );
    expect(tight.chunks.map((c) => c.filePath)).toEqual(["src/file0.ts"]); // chunk 1 does not fit and chunk 2 must not jump the queue
  });

  it("caps documentation at 30% and the mind map at 10% so code keeps most of the room", () => {
    const bundle = assembleBundle(parts(30, 10), 10_000);
    const docs = bundle.relevantClaudeMdSections.reduce((n, s) => n + sectionTokens(s), 0);
    expect(docs).toBeLessThanOrEqual(3000);
    expect(estimateTokens(bundle.relevantMindmapExcerpt.length)).toBeLessThanOrEqual(1000);
    expect(bundle.chunks.length).toBeGreaterThan(5);
  });

  it("keeps sections most relevant first and drops the later ones", () => {
    const bundle = assembleBundle(
      { mode: "claude-md", chunks: [], sections: [section(0, 3000), section(1, 3000), section(2, 3000)], mindmap: "" },
      2000,
    );
    expect(bundle.relevantClaudeMdSections.map((s) => s.path)[0]).toBe("mod0/CLAUDE.md.generated.md");
    expect(bundle.truncated).toBe(true);
  });

  it("handles empty parts and rejects a bad budget", () => {
    expect(assembleBundle({ mode: null, chunks: [], sections: [], mindmap: "" }, 100)).toEqual({
      mode: null,
      chunks: [],
      relevantClaudeMdSections: [],
      relevantMindmapExcerpt: "",
      tokenEstimate: 0,
      truncated: false,
    });
    for (const bad of [0, -5, 1.5, NaN]) expect(() => assembleBundle(parts(1), bad)).toThrow(RangeError);
    expect(DEFAULT_BUDGET_TOKENS).toBe(12_000);
  });

  it("truncateText counts the marker and leaves short text alone", () => {
    expect(truncateText("short", 10)).toEqual({ text: "short", truncated: false });
    const cut = truncateText("x".repeat(1000), 50);
    expect(cut.truncated).toBe(true);
    expect(estimateTokens(cut.text.length)).toBeLessThanOrEqual(50);
    expect(cut.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(truncateText("x".repeat(1000), 2).text).toBe(""); // not even room for the marker
  });
});

describe("LexicalIndex", () => {
  const chunk = (filePath: string, symbolName: string, code: string): ChunkRecord => ({
    repoId: "r",
    filePath,
    symbolName,
    chunkType: "function",
    code,
    startLine: 1,
    endLine: 5,
  });
  const chunks = [
    chunk(
      "modules/billing/payments.ts",
      "refundPayment",
      "if (amountCents > invoice.paidCents) throw new Error('Cannot refund more than was paid');",
    ),
    chunk("modules/billing/invoice.ts", "createInvoice", "return { id: `inv_${Date.now()}`, customerId, items, paidCents: 0 };"),
    chunk(
      "modules/auth/tokens.ts",
      "issueToken",
      "const expires = Date.now() + ttlSeconds * 1000; return Buffer.from(userId).toString('base64');",
    ),
    chunk("modules/auth/session.ts", "createSession", "const token = issueToken(userId); sessions.set(token, userId);"),
  ];

  it("ranks the chunk that matches the words of the task first", () => {
    const index = new LexicalIndex(chunks);
    expect(index.search("refund part of a payment", 4)[0].chunk.symbolName).toBe("refundPayment");
    expect(index.search("create an invoice for a customer", 4)[0].chunk.symbolName).toBe("createInvoice");
    expect(index.search("issue a token for a user", 4)[0].chunk.symbolName).toBe("issueToken");
  });

  it("counts a match in the symbol name or path above a match in the body", () => {
    const index = new LexicalIndex([
      chunk("src/a.ts", "other", "function other() { /* mentions widget once */ }"),
      chunk("src/widget.ts", "widget", "function widget() {}"),
    ]);
    expect(index.search("widget", 2)[0].chunk.filePath).toBe("src/widget.ts");
  });

  it("returns nothing for a task with no usable words or no match, and respects the limit", () => {
    const index = new LexicalIndex(chunks);
    expect(index.search("the and of to", 5)).toEqual([]);
    expect(index.search("zzzxqy", 5)).toEqual([]);
    expect(index.search("invoice token session payment", 2)).toHaveLength(2);
    expect(new LexicalIndex([]).search("invoice", 5)).toEqual([]);
  });

  it("is deterministic", () => {
    const a = new LexicalIndex(chunks).search("invoice payment token", 4).map((h) => h.chunk.filePath);
    const b = new LexicalIndex([...chunks]).search("invoice payment token", 4).map((h) => h.chunk.filePath);
    expect(a).toEqual(b);
  });

  describe("module docs steer the search", () => {
    const docs = new Map([
      ["modules/billing", "Billing handles invoices, card charges and refunds for customers."],
      ["modules/auth", "Auth issues tokens and sessions for logged in users."],
    ]);

    it("ranks modules by how well their CLAUDE.md matches, best normalised to 1", () => {
      const index = new LexicalIndex(chunks, docs);
      const hits = index.relevantModules("refund a card charge", 3);
      expect(hits[0]).toEqual({ dir: "modules/billing", relevance: 1 });
      expect(hits.every((h) => h.relevance > 0 && h.relevance <= 1)).toBe(true);
      expect(new LexicalIndex(chunks).relevantModules("refund")).toEqual([]);
    });

    it("boosts chunks of a matching module by up to MODULE_BOOST", () => {
      const task = "session token";
      const plain = new LexicalIndex(chunks).search(task, 4);
      const boosted = new LexicalIndex(chunks, docs).search(task, 4);
      const scoreOf = (hits: typeof plain, file: string) => hits.find((h) => h.chunk.filePath === file)!.score;
      const ratio = scoreOf(boosted, "modules/auth/tokens.ts") / scoreOf(plain, "modules/auth/tokens.ts");
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThanOrEqual(1 + MODULE_BOOST + 1e-9);
    });

    it("can lift a weaker chunk in the right module above a stronger one in the wrong module", () => {
      const tied = [
        chunk("modules/billing/a.ts", "handle", "export function handle() { return 'ledger entry'; }"),
        chunk("modules/auth/b.ts", "handle", "export function handle() { return 'ledger entry'; }"),
      ];
      const steer = new Map([
        ["modules/billing", "Everything about the ledger and entries lives here."],
        ["modules/auth", "Login only."],
      ]);
      expect(new LexicalIndex(tied, steer).search("ledger entry", 2)[0].chunk.filePath).toBe("modules/billing/a.ts");
    });
  });
});

describe("excerptMindmap", () => {
  const map = [
    "# repo — module structure",
    "",
    "```mermaid",
    "flowchart LR",
    '  A["modules/auth"]',
    '  B["modules/billing"]',
    '  C["modules/reports"]',
    '  D["modules/search"]',
    "  B -->|imports| A",
    "  C --> D",
    "```",
    "",
    "Billing depends on auth. Reports use search.",
  ].join("\n");

  it("keeps the touched modules, their edges and the neighbours those edges reach", () => {
    const out = excerptMindmap(map, ["modules/billing"]);
    expect(out).toContain('B["modules/billing"]');
    expect(out).toContain("B -->|imports| A");
    expect(out).toContain('A["modules/auth"]'); // neighbour across a kept edge stays declared
    expect(out).not.toContain("modules/reports");
    expect(out).not.toContain("C --> D");
    expect(out).toContain("flowchart LR");
    expect(out).toContain("(excerpt)");
    expect(out).toContain("Billing depends on auth.");
  });

  it("matches a module by its last path segment too", () => {
    expect(excerptMindmap(map, ["billing"])).toContain("B -->|imports| A");
  });

  it("falls back to the whole map when nothing matches or nothing is touched", () => {
    expect(excerptMindmap(map, ["modules/unknown"])).toBe(map);
    expect(excerptMindmap(map, [])).toBe(map);
    expect(excerptMindmap("no diagram here", ["x"])).toBe("no diagram here");
    expect(excerptMindmap("y".repeat(5000), ["x"])).toHaveLength(1500);
  });

  it("handles node definitions written inline in edges", () => {
    const inline = ["```mermaid", "flowchart LR", '  X["svc/a"] --> Y["svc/b"]', '  P["svc/p"] --> Q["svc/q"]', "```"].join("\n");
    const out = excerptMindmap(inline, ["svc/a"]);
    expect(out).toContain('X["svc/a"] --> Y["svc/b"]');
    expect(out).not.toContain("svc/p");
  });
});
