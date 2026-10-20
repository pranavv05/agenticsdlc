/** Words that carry no meaning for matching code to a task description. */
const STOP_WORDS = new Set(
  "a an and are as at be by can do for from has have how if in is it its of on or so such that the their then there these this to was we when which who will with would should must need needs able also all any each new add use using user users system support feature allow".split(
    " ",
  ),
);

/** Splits identifiers and prose into lowercase word pieces: "InvoiceService.createInvoice_v2" -> invoice, service, create, invoice, v2. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** A light suffix stripper, applied to both the index and the query so "refunding", "refunds" and "refund" meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ied")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1); // charge / charging both become "charg"
  return w;
}

/** Searchable terms of a text: tokenised, stop words removed, stemmed. Order and duplicates are kept (term frequency matters). */
export function terms(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOP_WORDS.has(t))
    .map(stem);
}
