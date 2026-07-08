/**
 * Support — help for brokers.
 *
 * Honest by design: the FAQ below describes how the product actually works
 * today, and the contact card opens a real email. (The previous version had
 * placeholder guides, fake video tutorials with made-up durations, a contact
 * form with no submit handler, and FAQ answers describing features that
 * don't exist.)
 */
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Mail, LifeBuoy } from "lucide-react";

const SUPPORT_EMAIL = "aim.kitabi@gmail.com";

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "How do I create a new deal?",
    a: "Go to Deals and click \"New Deal\". Enter the business name and industry — that's enough to start. The deal opens on its Overview page, where you can work through the phases: seller invite, AI interview, content generation, and design.",
  },
  {
    q: "How does the seller get involved?",
    a: "From the deal's Overview, use \"Invite Seller\" to generate a secure intake link and send it to your seller. They complete a short intake, upload documents against an industry-specific checklist, and have a conversation with the AI advisor — no account or password needed on their side.",
  },
  {
    q: "What does the AI interview cover?",
    a: "The interview adapts to the business. It identifies the industry early and loads industry-specific question areas (for example: lease terms and liquor licensing for restaurants, bonding and backlog for construction). It never re-asks anything the seller already provided in the intake or documents, and sellers can leave and come back anytime — progress saves automatically.",
  },
  {
    q: "How do I generate the CIM?",
    a: "Once enough information is collected, open the deal and use \"Generate CIM\" in Phase 3. The design agent plans the document and builds each section with charts, tables, and timelines suited to the content. Review and edit sections in the CIM Designer, where you can also generate the Blind (redacted) version.",
  },
  {
    q: "How do buyers see the CIM?",
    a: "Add a buyer on the deal's Buyers tab to create a secure, watermarked view link. Links are email-specific, expire after 30 days unless extended, and can require an NDA signature before any content is shown. Buyer activity (views, time, sections read) appears in Analytics.",
  },
  {
    q: "What's the difference between the Normal and Blind CIM?",
    a: "The Blind version replaces identifying details (business name, people, locations) with placeholders while preserving the financial story — it's what early-stage buyers see. Buyers you move to LOI level see the full Normal version. You control each buyer's access level from the deal's Buyers tab.",
  },
  {
    q: "Can I export the CIM as a PDF?",
    a: "Not yet — CIMs are shared through secure view links, which keeps analytics working and lets you revoke access at any time. A print-friendly view is available from the browser, and export options are on the roadmap.",
  },
  {
    q: "Which integrations work today?",
    a: "Pipedrive CRM sync is live (buyer decisions update your pipeline automatically). Gmail, Outlook, HubSpot, Salesforce, and call-recording tools are on the roadmap — the Integrations page shows current status honestly.",
  },
];

export default function Support() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <LifeBuoy className="h-5 w-5 text-teal" />
          Support
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Answers to common questions, and a direct line when you need one.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Frequently asked questions</CardTitle>
          <CardDescription>How Cimple works today.</CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="w-full">
            {FAQ.map((item, i) => (
              <AccordionItem key={i} value={`faq-${i}`}>
                <AccordionTrigger className="text-sm text-left">{item.q}</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground leading-relaxed">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Contact support
          </CardTitle>
          <CardDescription>
            Questions, problems, or feedback — email us and we'll get back to you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => {
              window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Cimple support request")}`;
            }}
            data-testid="button-email-support"
          >
            <Mail className="h-4 w-4 mr-2" />
            Email {SUPPORT_EMAIL}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
