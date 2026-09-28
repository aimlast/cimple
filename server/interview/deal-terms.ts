/**
 * deal-terms — a term of THIS sale versus a term an existing agreement sets.
 *
 * The non-compete the seller will sign with a buyer, the transition period,
 * seller financing, an earn-out: these are the deal's terms, set by the
 * seller and the broker and agreed with a buyer. A shareholders' agreement's
 * covenant, an employment contract's non-compete or a lease's renewal clause
 * is a different thing that happens to share the words. The seller saying
 * "I'd expect about five years post-sale" does not conflict with "the
 * shareholders' agreement has a two-year covenant for departing
 * shareholders" — and treating it as one made the interview ask the seller
 * to reconcile them ("…or is the two years what you'd actually sign?",
 * round A, Great Lakes).
 *
 * Only a document that sets the sale's terms (an LOI, a term sheet, an
 * offer, a purchase agreement) states the deal's term; the seller's own
 * earlier words about the sale still can conflict with what they say now.
 */

/**
 * Fact keys that name a term of the sale itself. Deliberately narrow: a
 * construction company's holdbacks receivable, escrow balances, training
 * programs or training costs are business facts that happen to share a
 * word with a sale term — their conflicts with the statements are real and
 * must still be raised (a bare "holdback…" / "escrow…" / "training…" key
 * used to switch the conflict check off for all of them).
 */
const DEAL_TERM_KEY_RE =
  /^(?:non[-_]?compet\w*|nonSolicit\w*|restrictiveCovenant\w*|transition(?:Period|Plan|Support|Time|Weeks|Months|Duration|Term|Assistance)\w*|(?:seller|owner|postSale|postClosing)?[tT]raining(?:Period|Support|Weeks|Days|Duration|Term|Commitment|Hours)\w*|consulting(?:Period|Agreement|Term)\w*|sellerFinanc\w*|vendorTakeBack\w*|vtb\w*|vendorFinanc\w*|earn[-_]?out\w*|(?:purchasePrice|sale|deal|transaction|closing)(?:Holdback|Escrow)\w*|holdback(?:Period|Percent\w*|Term|OnSale|FromPrice)\w*|escrow(?:Period|Percent\w*|Term|Holdback)\w*|(?:target)?closingDate\w*|dealStructure\w*|saleStructure\w*|transactionStructure\w*|(?:owner|seller)?[sS]tayOn\w*|postSale\w*|ownerTransition\w*|sellerTransition\w*)$/i;

/**
 * Words that name a term of the sale in a topic or a claim. "Stay on" only
 * with the owner as the one staying ("I'd stay on", "the owner will stay
 * on") — staff who "stay on through the winter" are not a sale term; a
 * holdback only when it is on the price or the sale.
 */
const DEAL_TERM_TOPIC_RE =
  /\bnon[- ]?compet\w*|\bnon[- ]?solicit\w*|\brestrictive covenant|\btransition (?:period|support|plan|time)|\btraining (?:period|support)|\b(?:i(?:['’]d|['’]ll|['’]m| would| will| can| could| am| plan to| want to| intend to)?|we(?:['’]d| would| will)|(?:the )?(?:owner|seller|vendor)s?(?: would| will| is| are)?)\s+(?:\w+\s+){0,3}?stay on\b|\bseller financ\w*|\bvendor take[- ]?back|\bvtb\b|\bearn[- ]?out|\bholdback (?:on|from|of) (?:the )?(?:purchase|sale|price|proceeds|closing)|\b(?:purchase[- ]price|sale|closing) (?:holdback|escrow)|\bpost[- ](?:sale|closing)\b/i;

/** A document that sets the terms of this sale — its terms ARE the deal's. */
const DEAL_DOCUMENT_RE =
  /\b(?:loi|letter of intent|term ?sheet|offer to purchase|offer letter|purchase (?:and sale )?agreement|apa|spa|share purchase|asset purchase|heads of terms|indication of interest|ioi|deal terms?|sale terms?)\b/i;

export function isDealTermKey(key: string | null | undefined): boolean {
  return !!key && DEAL_TERM_KEY_RE.test(key.trim());
}

export function isDealTermTopic(text: string | null | undefined): boolean {
  return !!text && DEAL_TERM_TOPIC_RE.test(text);
}

export function isDealDocument(name: string | null | undefined): boolean {
  return !!name && DEAL_DOCUMENT_RE.test(name);
}

/**
 * True when a document's value for a deal term is the document's own term
 * (an existing covenant), not the sale's — so the seller stating what they'd
 * accept in the sale is not a conflict with it. `docName` is the document's
 * name (null/undefined: a document of unknown name, never a deal document).
 */
export function documentTermNotDealTerm(args: { key?: string | null; topic?: string | null; docName?: string | null }): boolean {
  if (!isDealTermKey(args.key) && !isDealTermTopic(args.topic) && !isDealTermTopic(args.key?.replace(/([a-z])([A-Z])/g, "$1 $2"))) return false;
  return !isDealDocument(args.docName);
}
