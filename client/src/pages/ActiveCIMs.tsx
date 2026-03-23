import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Search, Plus, UserPlus, FileEdit, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Deal } from "@shared/schema";

const PHASE_LABELS = {
  phase1_info_collection: "Phase 1: Info Collection",
  phase2_platform_intake: "Phase 2: Platform Intake",
  phase3_content_creation: "Phase 3: Content Creation",
  phase4_design_finalization: "Phase 4: Design & Final",
};

function getPhaseProgress(deal: Deal): number {
  switch (deal.phase) {
    case "phase1_info_collection": return 15;
    case "phase2_platform_intake": return 40;
    case "phase3_content_creation": return 70;
    case "phase4_design_finalization": return 90;
    default: return 0;
  }
}

export default function ActiveCIMs() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Active Deals</h1>
        <p className="text-muted-foreground mt-2">Manage your business deals and CIM creation</p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <p>Deals list would be rendered here</p>
        </CardContent>
      </Card>
    </div>
  );
}
