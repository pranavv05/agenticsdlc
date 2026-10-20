const K1 = 1.2;
const B = 0.75;

export interface Bm25Document<T> {
  item: T;
  /** Weighted term counts: a term in a more important field is added with a larger weight. */
  termWeights: Map<string, number>;
}

/** Counts terms into `into`, each occurrence adding `weight`. */
export function addTerms(into: Map<string, number>, terms: string[], weight: number): void {
  for (const t of terms) into.set(t, (into.get(t) ?? 0) + weight);
}

/** BM25 over weighted term counts (a simple BM25F). Deterministic: ties are broken by insertion order. */
export class Bm25<T> {
  private readonly docs: Bm25Document<T>[];
  private readonly lengths: number[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(docs: Bm25Document<T>[]) {
    this.docs = docs;
    this.lengths = docs.map((d) => [...d.termWeights.values()].reduce((a, b) => a + b, 0));
    this.avgLength = this.lengths.length ? this.lengths.reduce((a, b) => a + b, 0) / this.lengths.length : 0;
    for (const d of docs) for (const term of d.termWeights.keys()) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
  }

  get size(): number {
    return this.docs.length;
  }

  private idf(term: string): number {
    const df = this.docFreq.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  /** Scores every document that shares at least one query term, best first. */
  search(queryTerms: string[], limit = Infinity): { item: T; score: number }[] {
    const unique = [...new Set(queryTerms)];
    const results: { item: T; score: number; order: number }[] = [];
    this.docs.forEach((doc, order) => {
      let score = 0;
      const norm = this.avgLength ? 1 - B + (B * this.lengths[order]) / this.avgLength : 1;
      for (const term of unique) {
        const tf = doc.termWeights.get(term);
        if (!tf) continue;
        score += (this.idf(term) * tf * (K1 + 1)) / (tf + K1 * norm);
      }
      if (score > 0) results.push({ item: doc.item, score, order });
    });
    results.sort((a, b) => b.score - a.score || a.order - b.order);
    return results.slice(0, limit).map(({ item, score }) => ({ item, score }));
  }
}
