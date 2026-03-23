import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageCircle, BookOpen, HelpCircle } from "lucide-react";

export default function Support() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Support & Help</h1>
        <p className="text-muted-foreground mt-2">Get help with CIMPLE</p>
      </div>
      <div className="grid gap-6 grid-cols-1 md:grid-cols-3">
        <Card className="cursor-pointer hover:shadow-lg transition">
          <CardHeader>
            <BookOpen className="h-8 w-8 text-primary mb-2" />
            <CardTitle>Documentation</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Read guides and tutorials</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-lg transition">
          <CardHeader>
            <MessageCircle className="h-8 w-8 text-primary mb-2" />
            <CardTitle>Contact Support</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Chat with our support team</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-lg transition">
          <CardHeader>
            <HelpCircle className="h-8 w-8 text-primary mb-2" />
            <CardTitle>FAQ</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Common questions answered</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
