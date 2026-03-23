import { ProgressTracker } from "../ProgressTracker";

export default function ProgressTrackerExample() {
  return (
    <div className="p-6 space-y-4">
      <ProgressTracker
        currentStep={2}
        steps={[
          { id: 1, label: "Company Info", status: "completed" },
          { id: 2, label: "Financial Data", status: "current" },
          { id: 3, label: "Operations", status: "pending" },
          { id: 4, label: "Review", status: "pending" },
        ]}
      />
    </div>
  );
}
