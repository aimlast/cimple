import { StatCard } from "../StatCard";
import { FileText, Clock, CheckCircle, TrendingUp } from "lucide-react";

export default function StatCardExample() {
  return (
    <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        title="Active CIMs"
        value={12}
        icon={FileText}
        trend={{ value: "3 new this week", positive: true }}
      />
      <StatCard
        title="Avg. Completion Time"
        value="4.5 days"
        icon={Clock}
        trend={{ value: "12% faster", positive: true }}
      />
      <StatCard
        title="Completed This Month"
        value={24}
        icon={CheckCircle}
        description="8 more than last month"
      />
      <StatCard
        title="Quality Score"
        value="94%"
        icon={TrendingUp}
        trend={{ value: "5% improvement", positive: true }}
      />
    </div>
  );
}
