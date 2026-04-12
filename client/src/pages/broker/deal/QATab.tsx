/**
 * QATab — Buyer Q&A management + FAQ.
 */
import { useQuery } from "@tanstack/react-query";
import { useDeal } from "@/contexts/DealContext";
import { BuyerQAPanel } from "@/components/deal/BuyerQAPanel";

export function QATab() {
  const { dealId } = useDeal();

  const { data: faqs = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "faq"],
    enabled: !!dealId,
  });

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <BuyerQAPanel dealId={dealId} />

      {faqs.length > 0 && (
        <div className="pt-4 border-t border-border space-y-2">
          <h3 className="text-sm font-semibold">FAQ</h3>
          {faqs.map((faq: any) => (
            <div
              key={faq.id}
              className="p-3 rounded-lg bg-card border border-border"
            >
              <p className="text-sm font-medium">{faq.question}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {faq.answer}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
