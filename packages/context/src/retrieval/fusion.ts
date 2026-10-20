/** Standard constant for reciprocal rank fusion: damps the advantage of the very top ranks. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: merges several ranked lists into one. An item's score is the sum of 1 / (k + rank) over the lists
 * it appears in, so an item both methods like beats an item only one of them loves, and no list's raw scores need to be comparable.
 * Ties are broken by the order in which items first appear (earlier list, earlier rank).
 */
export function reciprocalRankFusion<T>(
  lists: T[][],
  keyOf: (item: T) => string,
  k = RRF_K,
): { item: T; key: string; score: number; ranks: (number | null)[] }[] {
  const merged = new Map<string, { item: T; key: string; score: number; ranks: (number | null)[]; order: number }>();
  let order = 0;
  lists.forEach((list, listIndex) => {
    list.forEach((item, rank) => {
      const key = keyOf(item);
      let entry = merged.get(key);
      if (!entry) {
        entry = { item, key, score: 0, ranks: lists.map(() => null), order: order++ };
        merged.set(key, entry);
      }
      entry.score += 1 / (k + rank + 1);
      entry.ranks[listIndex] = rank;
    });
  });
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ item, key, score, ranks }) => ({ item, key, score, ranks }));
}
