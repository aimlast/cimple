/**
 * Sample teasers for the template picker's live thumbnails (pure). Generic
 * placeholder words and round numbers only — never a deal's information.
 * One sample block per template slot, so a thumbnail shows the template's
 * real shape and length.
 */
import { TEASER_TEMPLATES, type TeaserTemplateDef } from "@shared/teaser-templates";
import { isBuiltInTeaserTemplate } from "@shared/teaser";
import type { BuyerSection } from "@shared/cim-buyer-view";
import type { TeaserHeaderView } from "./TeaserHeader";

export const SAMPLE_HEADER: TeaserHeaderView = {
  label: "CONFIDENTIAL OPPORTUNITY",
  codename: "Project Example",
  tagline: "An established regional business with loyal, recurring customers",
  chips: ["Industry", "Province", "Established 20+ years"],
};

const P = "A well-run business with a long record, a steady customer base and a team that runs the day-to-day work. It is ready for a new owner to grow.";

function sampleData(slot: string, layoutType: string): Record<string, unknown> {
  switch (slot) {
    case "key_numbers":
      return { columns: 4, metrics: [{ label: "Revenue", value: "$5M–$7.5M" }, { label: "SDE", value: "$1M–$1.5M" }, { label: "Asking price", value: "$4.5M" }, { label: "Employees", value: "25–49" }] };
    case "listing_facts":
      return {
        columns: 3,
        metrics: [
          { label: "Asking price", value: "$1.2M" }, { label: "Cash flow (SDE)", value: "$410K" }, { label: "Gross revenue", value: "$2.1M" },
          { label: "FF&E", value: "Included" }, { label: "Employees", value: "10–24" }, { label: "Established", value: "20+ years" },
          { label: "Financing", value: "Vendor financing available" }, { label: "Support & training", value: "Owner handover" }, { label: "Reason for selling", value: "Retirement" },
        ],
      };
    case "overview":
    case "management":
      return { body: P };
    case "highlights":
      return { style: "list", columns: 1, items: [1, 2, 3, 4, 5].map((i) => ({ title: `Highlight ${i}`, description: "A short line on why it matters to a buyer." })) };
    case "growth":
      return { style: "list", columns: 1, items: [1, 2, 3].map((i) => ({ title: `Opportunity ${i}`, description: "Room for a new owner to grow." })) };
    case "operations":
    case "financial_snapshot":
      return { stats: [{ label: "Team", value: "25–49" }, { label: "Locations", value: "2" }, { label: "Years", value: "20+" }, { label: "Recurring", value: "60–70%" }] };
    case "trend":
      return { indexed: true, data: [{ name: "2021", index: 100 }, { name: "2022", index: 108 }, { name: "2023", index: 117 }, { name: "2024", index: 126 }], series: [{ key: "index", label: "Revenue (first year = 100)" }] };
    case "opportunity":
    case "deal_structure":
      return {
        left: { title: "Who it suits", layoutType: "list", content: "A strategic buyer in the region\nAn owner-operator with sector experience" },
        right: { title: "Deal at a glance", layoutType: "metric", content: "Sale type: Share sale\nReason for sale: Retirement\nOwner transition: 6-month handover\nReal estate: Leased" },
      };
    case "next_step":
      return { ordered: true, items: [{ title: "Ask for the CIM from this page" }, { title: "Confirm your email and sign the NDA online" }, { title: "Your broker reviews your request" }] };
    case "confidentiality":
      return { body: "This summary doesn't name the business. Please don't contact the business, its staff, customers or suppliers." };
    default:
      return layoutType === "prose_highlight" ? { body: P } : { items: [{ title: "Your block" }] };
  }
}

/** A sample teaser drawn with a template's slots (built-in or saved). */
export function sampleTeaser(def: TeaserTemplateDef): { header: TeaserHeaderView; sections: BuyerSection[] } {
  const sections: BuyerSection[] = def.slots.map((s, i) => ({
    id: `sample-${def.key}-${s.slot}-${i}`,
    dealId: "sample",
    sectionKey: `s_sample_${i}`,
    sectionTitle: s.title,
    order: i,
    layoutType: s.layoutType,
    layoutData: sampleData(s.slot, s.layoutType),
    aiDraftContent: s.layoutType === "prose_highlight" ? String(sampleData(s.slot, s.layoutType).body ?? "") : null,
    brokerEditedContent: null,
    isVisible: true as const,
  }));
  return { header: SAMPLE_HEADER, sections };
}

export function sampleFor(key: string): { header: TeaserHeaderView; sections: BuyerSection[] } {
  return sampleTeaser(isBuiltInTeaserTemplate(key) ? TEASER_TEMPLATES[key] : TEASER_TEMPLATES.one_page);
}
