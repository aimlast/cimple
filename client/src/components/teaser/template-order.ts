/** The built-in teaser templates in the order the picker shows them (named for who they're for). */
import { TEASER_TEMPLATES } from "@shared/teaser-templates";
import type { TeaserTemplateKey } from "@shared/teaser";

export { TEASER_TEMPLATES };
export const TEASER_TEMPLATE_KEYS_ORDER: readonly TeaserTemplateKey[] = ["listing", "one_page", "two_page", "investor"];

/** The template's display name ("One-page teaser"; a saved one's own name when given). */
export function templateDisplayName(key: string | null | undefined, savedName?: string | null): string {
  if (key && key in TEASER_TEMPLATES) return TEASER_TEMPLATES[key as TeaserTemplateKey].name;
  return savedName || "Your template";
}

/** Pages the template aims for (the fit indicator's target). */
export function templateTargetPages(key: string | null | undefined, basedOn?: string | null): number {
  const k = key && key in TEASER_TEMPLATES ? key : basedOn && basedOn in TEASER_TEMPLATES ? basedOn : "one_page";
  return TEASER_TEMPLATES[k as TeaserTemplateKey].targetPages;
}
