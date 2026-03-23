import { MissingInfoCard } from "../MissingInfoCard";

export default function MissingInfoCardExample() {
  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <MissingInfoCard
        field="Annual Revenue Breakdown"
        description="We need detailed revenue information by product line for the past 3 years. This helps buyers understand your revenue streams."
        status="review_needed"
        onAuthorizeSkip={() => console.log("Skip authorized")}
        onRetry={() => console.log("Retry requested")}
      />
      <MissingInfoCard
        field="Customer Retention Rate"
        description="Please provide customer retention metrics to demonstrate business stability."
        status="ai_attempting"
      />
    </div>
  );
}
