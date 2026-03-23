import { ProgressTracker } from "../ProgressTracker";

export default function ProgressTrackerExample() {
  const steps = [
    { id: "1", title: "Business Type Selection", status: "completed" as const },
    { id: "2", title: "Initial Questionnaire", status: "completed" as const },
    { id: "3", title: "AI Interview", status: "current" as const },
    { id: "4", title: "Document Upload", status: "pending" as const },
    { id: "5", title: "Review & Approval", status: "pending" as const },
  ];

  return (
    <div className="p-6 max-w-md">
      <ProgressTracker steps={steps} />
    </div>
  );
}
