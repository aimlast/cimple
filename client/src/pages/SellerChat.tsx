import { AIConversationInterface } from "@/components/AIConversationInterface";
import { Card } from "@/components/ui/card";
import { Lightbulb } from "lucide-react";

export default function SellerChat() {
  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col">
        <AIConversationInterface />
      </div>
      
      <div className="w-80 border-l p-6 space-y-4 overflow-y-auto">
        <h3 className="font-semibold">Information Gathered</h3>
        
        <Card className="p-4 space-y-2">
          <p className="text-sm font-medium">Business Type</p>
          <p className="text-sm text-muted-foreground">Restaurant - Fast Casual</p>
        </Card>

        <Card className="p-4 space-y-2">
          <p className="text-sm font-medium">Annual Revenue</p>
          <p className="text-sm text-muted-foreground">$2.5M - $5M</p>
        </Card>

        <Card className="p-4 space-y-2">
          <p className="text-sm font-medium">Years in Operation</p>
          <p className="text-sm text-muted-foreground">8 years</p>
        </Card>

        <div className="pt-4">
          <div className="flex gap-2 mb-2">
            <Lightbulb className="h-4 w-4 text-primary" />
            <h4 className="text-sm font-semibold">Tip</h4>
          </div>
          <p className="text-xs text-muted-foreground">
            Be specific with your answers. The more detail you provide, the better your CIM will be.
          </p>
        </div>
      </div>
    </div>
  );
}
