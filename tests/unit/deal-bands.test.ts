/**
 * shared/deal-bands.ts — the ONE size ladder for anything read before the
 * NDA (the teaser and the outreach drafts): every boundary, rounded
 * figures, the "same in the teaser" rule, and the outreach summary using it.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/deal-bands.test.ts
 */
import assert from "node:assert/strict";
import {
  customerRange,
  headcountRange,
  indexedTrend,
  marginRange,
  moneyIn,
  moneyRange,
  moneyRounded,
  parseMoney,
  recurringRange,
  revenueTrendWords,
  sameDisplayed,
  yearsRange,
} from "../../shared/deal-bands";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

check("the range ladder at every boundary", () => {
  const cases: Array<[number, string]> = [
    [1, "under $250K"],
    [249_999, "under $250K"],
    [250_000, "$250K–$500K"],
    [499_999, "$250K–$500K"],
    [500_000, "$500K–$750K"],
    [750_000, "$750K–$1M"],
    [999_999, "$750K–$1M"],
    [1_000_000, "$1M–$2M"],
    [1_999_999, "$1M–$2M"],
    [2_000_000, "$2M–$3M"],
    [9_999_999, "$9M–$10M"],
    [10_000_000, "$10M–$12.5M"],
    [12_500_000, "$12.5M–$15M"],
    [18_200_000, "$17.5M–$20M"],
    [22_500_000, "$22.5M–$25M"],
    [24_999_999, "$22.5M–$25M"],
    [25_000_000, "$25M–$30M"],
    [31_020_000, "$30M–$35M"],
    [49_999_999, "$45M–$50M"],
    [50_000_000, "$50M–$60M"],
    [99_999_999, "$90M–$100M"],
    [100_000_000, "$100M+"],
    [742_000_000, "$100M+"],
  ];
  for (const [n, want] of cases) assert.equal(moneyRange(n), want, String(n));
  assert.equal(moneyRange(0), "");
});

check("rounded figures: $10K under $1M, one decimal from $1M, nearest $1M from $100M", () => {
  assert.equal(moneyRounded(480_400), "$480K");
  assert.equal(moneyRounded(484_999), "$480K");
  assert.equal(moneyRounded(485_000), "$490K");
  assert.equal(moneyRounded(996_000), "$1M");
  assert.equal(moneyRounded(1_000_000), "$1M");
  assert.equal(moneyRounded(1_312_000), "$1.3M");
  assert.equal(moneyRounded(4_800_000), "$4.8M");
  assert.equal(moneyRounded(18_420_000), "$18.4M");
  assert.equal(moneyRounded(142_400_000), "$142M");
  assert.equal(moneyIn("rounded", 1_312_000), "$1.3M");
  assert.equal(moneyIn("ranges", 1_312_000), "$1M–$2M");
});

check("parseMoney reads the ways money is written", () => {
  assert.equal(parseMoney("$31,020,000"), 31_020_000);
  assert.equal(parseMoney("$3.9 million (normalized)"), 3_900_000);
  assert.equal(parseMoney("$480K"), 480_000);
  assert.equal(parseMoney("1.3M"), 1_300_000);
  assert.equal(parseMoney(2_500_000), 2_500_000);
  assert.equal(parseMoney("not disclosed"), null);
  assert.equal(parseMoney(-5), null);
});

check("sameDisplayed: same range → true; across a boundary → false; unreadable → false; rounded mode rounds", () => {
  assert.equal(sameDisplayed("$18,200,000", "$19.1M", "ranges"), true);
  assert.equal(sameDisplayed("$17,400,000", "$17,600,000", "ranges"), false);
  assert.equal(sameDisplayed("$18,200,000", "about eighteen million", "ranges"), false);
  assert.equal(sameDisplayed("$18,200,000", "$18,240,000", "rounded"), true);
  assert.equal(sameDisplayed("$18,200,000", "$18,300,000", "rounded"), false);
});

check("years, margins, customers, recurring, headcount are ranges", () => {
  assert.equal(yearsRange(34), "30+ years");
  assert.equal(yearsRange(20), "20+ years");
  assert.equal(yearsRange(4), null);
  assert.equal(yearsRange(null), null);
  assert.equal(marginRange(12.6), "10–15%");
  assert.equal(marginRange(31), "30%+");
  assert.equal(customerRange(22), "Largest customer 20–30%");
  assert.equal(customerRange(8), "No customer above 10%");
  assert.equal(recurringRange(45), "40–60% recurring");
  assert.equal(headcountRange(148), "100–249");
  assert.equal(headcountRange(0), null);
});

check("revenue trend in words, indexed trend from 3+ years only", () => {
  assert.equal(revenueTrendWords({ "2022": 100, "2023": 110, "2024": 125 }), "Up 2 years running");
  assert.equal(revenueTrendWords({ "2023": 110, "2024": 125 }), "Up last year");
  assert.equal(revenueTrendWords({ "2023": 110, "2024": 111 }), "Steady");
  assert.equal(revenueTrendWords({ "2023": 110, "2024": 90 }), "Down last year");
  assert.equal(revenueTrendWords({ "2024": 90 }), null);
  assert.equal(indexedTrend({ "2023": 1, "2024": 2 }), null);
  assert.deepEqual(indexedTrend({ "2022": 26_000_000, "2023": 28_600_000, "2024": 31_020_000 }), [
    { year: "2022", index: 100 },
    { year: "2023", index: 110 },
    { year: "2024", index: 119 },
  ]);
});

async function main() {
  // The outreach summary uses the same ladder (never two ranges for one deal).
  const { blindDealSummary, moneyBand } = await import("../../server/buyers/blind-deal-summary");
  check("blindDealSummary uses the shared ladder", () => {
    const s = blindDealSummary({ industry: "Trucking", blindCodename: "Project Coastline", extractedInfo: { annualRevenue: "$31,020,000", sde: "$1,312,000", yearsOperating: "34 years", locationSite: "Surrey, British Columbia" } } as never);
    assert.equal(s.revenueBand, moneyRange(31_020_000));
    assert.equal(s.sdeBand, "$1M–$2M");
    assert.equal(s.tenure, "30+ years established");
    assert.equal(s.region, "British Columbia");
    assert.equal(moneyBand("$480,000"), "under $250K".replace("under $250K", moneyRange(480_000)));
  });
  console.log(`\n${passed} checks passed`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
