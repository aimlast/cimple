/**
 * Comparable Transactions (Comps) Module — Stub
 *
 * Placeholder for comparable transaction lookup. Currently returns a
 * skeleton structure suitable for manual entry by the broker.
 * Will eventually integrate with valuation APIs / comps databases.
 */

export interface CompTransaction {
  id: string;
  businessName: string;
  industry: string;
  subIndustry?: string;
  revenue: number;
  sde?: number;
  ebitda?: number;
  salePrice: number;
  revenueMultiple: number;
  sdeMultiple?: number;
  ebitdaMultiple?: number;
  saleDate?: string;
  location?: string;
  source: "manual" | "api" | "database";
  notes?: string;
}

export interface CompsResult {
  comparables: CompTransaction[];
  medianRevenueMultiple: number | null;
  medianSdeMultiple: number | null;
  medianEbitdaMultiple: number | null;
  impliedValuation: {
    byRevenue: number | null;
    bySde: number | null;
    byEbitda: number | null;
  };
  dataSource: string;
  generatedAt: string;
}

/**
 * Fetch comparable transactions for a business.
 *
 * Currently returns a placeholder — brokers can add manual entries via
 * the PATCH endpoint on the financial analysis.
 */
export async function getComparables(
  industry: string,
  revenue: number | null,
  sde: number | null,
): Promise<CompsResult> {
  // TODO: Integrate with BizBuySell, DealStats, or similar comps API
  return {
    comparables: [],
    medianRevenueMultiple: null,
    medianSdeMultiple: null,
    medianEbitdaMultiple: null,
    impliedValuation: {
      byRevenue: null,
      bySde: null,
      byEbitda: null,
    },
    dataSource: "manual",
    generatedAt: new Date().toISOString(),
  };
}
