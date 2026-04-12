/**
 * FinancialsTab — Full financial analysis center.
 */
import { useDeal } from "@/contexts/DealContext";
import { FinancialAnalysisCenter } from "@/components/financial/FinancialAnalysisCenter";

export function FinancialsTab() {
  const { dealId } = useDeal();

  return (
    <div className="px-6 py-6">
      <FinancialAnalysisCenter dealId={dealId} />
    </div>
  );
}
