import { Card, CardContent } from "@/components/ui/card";
import { MessageSquare } from "lucide-react";

export default function SellerChat() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-md">
        <CardContent className="pt-6 text-center space-y-4">
          <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground" />
          <div>
            <h3 className="font-semibold text-lg">Interview Access</h3>
            <p className="text-muted-foreground text-sm mt-2">
              To start or continue your interview, please use the invite link provided by your broker.
              The interview will guide you through a conversation to collect the information needed for your business profile.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
