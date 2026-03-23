import { CIMCard } from "../CIMCard";

export default function CIMCardExample() {
  return (
    <div className="p-6 grid gap-4 max-w-4xl">
      <CIMCard
        id="1"
        businessName="Sunset Bistro & Grill"
        industry="Restaurant - Fast Casual"
        status="in_progress"
        progress={65}
        lastUpdated="2 hours ago"
      />
      <CIMCard
        id="2"
        businessName="TechFlow Solutions Inc"
        industry="Software & Technology"
        status="review"
        progress={95}
        lastUpdated="1 day ago"
      />
      <CIMCard
        id="3"
        businessName="Green Valley Manufacturing"
        industry="Manufacturing"
        status="completed"
        progress={100}
        lastUpdated="3 days ago"
      />
    </div>
  );
}
