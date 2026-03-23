import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BookOpen, Video, MessageCircle, Mail } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export default function Support() {
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Support</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Get help with the CIM platform
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              Onboarding Guides
            </CardTitle>
            <CardDescription>
              Step-by-step guides to get started
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button variant="outline" className="w-full justify-start" data-testid="button-guide-getting-started">
              <BookOpen className="h-4 w-4 mr-2" />
              Getting Started with CIMs
            </Button>
            <Button variant="outline" className="w-full justify-start" data-testid="button-guide-invite-sellers">
              <BookOpen className="h-4 w-4 mr-2" />
              Inviting Sellers
            </Button>
            <Button variant="outline" className="w-full justify-start" data-testid="button-guide-branding">
              <BookOpen className="h-4 w-4 mr-2" />
              Customizing Your Branding
            </Button>
            <Button variant="outline" className="w-full justify-start" data-testid="button-guide-sharing">
              <BookOpen className="h-4 w-4 mr-2" />
              Sharing CIMs with Buyers
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Video className="h-5 w-5" />
              Video Tutorials
            </CardTitle>
            <CardDescription>
              Watch video walk-throughs
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button variant="outline" className="w-full justify-start" data-testid="button-video-overview">
              <Video className="h-4 w-4 mr-2" />
              Platform Overview (5:30)
            </Button>
            <Button variant="outline" className="w-full justify-start" data-testid="button-video-ai-interview">
              <Video className="h-4 w-4 mr-2" />
              AI Interview Process (3:45)
            </Button>
            <Button variant="outline" className="w-full justify-start" data-testid="button-video-analytics">
              <Video className="h-4 w-4 mr-2" />
              Understanding Analytics (4:20)
            </Button>
            <Button variant="outline" className="w-full justify-start" data-testid="button-video-best-practices">
              <Video className="h-4 w-4 mr-2" />
              Best Practices (6:15)
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Frequently Asked Questions</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="item-1">
              <AccordionTrigger>How do I invite a seller to complete a CIM?</AccordionTrigger>
              <AccordionContent>
                In the Active CIMs page, click "Create New CIM" and select "Invite Seller". 
                The system will generate a unique, secure link that you can copy and send to the seller. 
                They'll be guided through the entire process by our AI assistant.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="item-2">
              <AccordionTrigger>What happens if a seller skips questions?</AccordionTrigger>
              <AccordionContent>
                Our AI will first explain why the information is important and ask again. 
                If the seller still chooses to skip, you'll receive a notification and the question 
                will be flagged for your review before the CIM is finalized.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="item-3">
              <AccordionTrigger>How do I track buyer engagement?</AccordionTrigger>
              <AccordionContent>
                When you share a CIM with buyers, they receive a unique view link. 
                All engagement metrics (time spent, sections viewed, etc.) are tracked automatically 
                and visible in the Analytics page.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="item-4">
              <AccordionTrigger>Can I customize the CIM branding?</AccordionTrigger>
              <AccordionContent>
                Yes! Go to Settings to upload your logo, set brand colors, choose fonts, and configure 
                headers/footers. These settings will be applied to all CIMs you create or export.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="item-5">
              <AccordionTrigger>How do I export a CIM as PDF?</AccordionTrigger>
              <AccordionContent>
                Once a CIM is complete and approved, you can export it from the CIM review page. 
                Choose from available design templates, and the PDF will be generated with your branding applied.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            Contact Support
          </CardTitle>
          <CardDescription>
            Can't find what you're looking for? Send us a message
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="support-subject">Subject</Label>
              <Input
                id="support-subject"
                placeholder="Brief description of your issue"
                data-testid="input-support-subject"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="support-message">Message</Label>
              <Textarea
                id="support-message"
                placeholder="Describe your issue in detail..."
                rows={5}
                data-testid="textarea-support-message"
              />
            </div>
            <Button type="submit" data-testid="button-submit-support">
              <Mail className="h-4 w-4 mr-2" />
              Send Message
            </Button>
          </form>
          <p className="text-xs text-muted-foreground mt-4">
            We typically respond within 24 hours during business days
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
