/**
 * Wording about Cimple's own process that must never reach a buyer — used by
 * the DD reveal pass's validation (dd-enrichment.ts) and the figure notes'
 * guards (figures/guards.ts). Kept in its own module so the guards don't load
 * the reveal pass.
 */
export const INTERNAL_WORDING =
  /\b(?:confirmed facts?|per (?:the )?(?:broker|facts|knowledge base|analysis|interview)|knowledge base|teaser|dd context|clarifying questions?|internal (?:note|review)|broker[- ]only|crm|the seller (?:said|told us|claimed|stated)|initially estimated|previously (?:stated|estimated))\b/i;
