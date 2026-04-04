import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building,
  FileText,
  Clock,
  Lock,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Download,
  Eye,
  HelpCircle
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Deal, BuyerAccess } from "@shared/schema";

interface ViewData {
  access: BuyerAccess;
  deal: Deal;
}

const CIM_SECTIONS = [
  { key: "executiveSummary", title: "Executive Summary" },
  { key: "companyOverview", title: "Company Overview" },
  { key: "historyMilestones", title: "History & Milestones" },
  { key: "uniqueSellingPropositions", title: "Unique Selling Propositions" },
  { key: "sourcesOfRevenue", title: "Sources of Revenue" },
  { key: "growthStrategies", title: "Growth Strategies" },
  { key: "targetMarket", title: "Target Market" },
  { key: "permitsLicenses", title: "Permits & Licenses" },
  { key: "seasonality", title: "Seasonality" },
  { key: "locationSite", title: "Location & Site" },
  { key: "employeeOverview", title: "Employee Overview" },
  { key: "transactionOverview", title: "Transaction Overview" },
  { key: "financialOverview", title: "Financial Overview" },
];

function Watermark({ email }: { email: string }) {
  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden opacity-5">
      <div className="absolute inset-0 flex flex-wrap items-center justify-center gap-24 -rotate-45">
        {Array.from({ length: 20 }).map((_, i) => (
          <span key={i} className="text-2xl font-bold text-foreground whitespace-nowrap">
            {email}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function BuyerViewRoom() {
  const { token } = useParams<{ token: string }>();
  const [activeSection, setActiveSection] = useState<string>("executiveSummary");
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);
  const [timeOnPage, setTimeOnPage] = useState(0);
  const startTimeRef = useRef<number>(Date.now());
  const sectionStartRef = useRef<number>(Date.now());
  const activeSectionRef = useRef<string>(activeSection);
  const hasTrackedInitialView = useRef(false);

  const { data, isLoading, error } = useQuery<ViewData>({
    queryKey: ["/api/view", token],
    enabled: !!token,
    queryFn: async () => {
      const res = await fetch(`/api/view/${token}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Access denied");
      }
      return res.json();
    },
  });

  const dealId = data?.deal?.id;
  const { data: faqs = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "faq"],
    enabled: !!dealId,
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/faq`);
      if (!res.ok) return [];
      return res.json();
    },
  });

  useEffect(() => {
    if (!token || hasTrackedInitialView.current) return;
    hasTrackedInitialView.current = true;

    fetch(`/api/buyer-access/${token}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "view" }),
    }).catch(console.error);

    fetch(`/api/buyer-access/${token}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "page_view", sectionKey: "executiveSummary" }),
    }).catch(console.error);
  }, [token]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeOnPage(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!token) return;

    const trackTimeInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - sectionStartRef.current) / 1000);
      if (elapsed >= 30) {
        fetch(`/api/buyer-access/${token}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            eventType: "time_on_page",
            sectionKey: activeSectionRef.current,
            timeSpentSeconds: 30
          }),
        }).catch(console.error);
        sectionStartRef.current = Date.now();
      }
    }, 30000);

    return () => clearInterval(trackTimeInterval);
  }, [token]);

  const handleSectionChange = (sectionKey: string) => {
    if (!token || sectionKey === activeSection) return;
    
    const elapsed = Math.floor((Date.now() - sectionStartRef.current) / 1000);
    if (elapsed > 0) {
      fetch(`/api/buyer-access/${token}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          eventType: "time_on_page",
          sectionKey: activeSectionRef.current,
          timeSpentSeconds: elapsed
        }),
      }).catch(console.error);
    }
    
    sectionStartRef.current = Date.now();
    activeSectionRef.current = sectionKey;
    setActiveSection(sectionKey);
    
    fetch(`/api/buyer-access/${token}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "page_view", sectionKey }),
    }).catch(console.error);
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-[600px] w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-3">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive/60" />
          <h2 className="text-lg font-semibold">Access denied</h2>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "This link is invalid or has expired."}
          </p>
          <p className="text-xs text-muted-foreground/60">Contact your broker for a new access link.</p>
        </div>
      </div>
    );
  }

  const { access, deal } = data;
  const cimContent = deal.cimContent as Record<string, string> | null;

  const availableSections = CIM_SECTIONS.filter(s => cimContent?.[s.key]);

  return (
    <div className="min-h-screen bg-background">
      {access.watermarkEnabled && <Watermark email={access.buyerEmail} />}

      <header className="border-b border-border sticky top-0 bg-background/95 backdrop-blur-sm z-40">
        <div className="max-w-6xl mx-auto px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-amber flex items-center justify-center">
              <Building className="h-4 w-4 text-amber-foreground" />
            </div>
            <div>
              <h1 className="font-semibold text-sm leading-tight">{deal.businessName}</h1>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Confidential Information Memorandum
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-[10px] text-muted-foreground">Viewing as</p>
              <p className="text-xs font-medium">{access.buyerEmail}</p>
            </div>
            <span className="flex items-center gap-1 text-xs text-muted-foreground border border-border rounded-full px-2.5 py-1">
              <Clock className="h-3 w-3" />
              {formatTime(timeOnPage)}
            </span>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-3">
            <Card className="sticky top-24">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Contents
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[400px]">
                  <div className="p-2 space-y-1">
                    {availableSections.map((section, idx) => (
                      <button
                        key={section.key}
                        onClick={() => handleSectionChange(section.key)}
                        className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 ${
                          activeSection === section.key
                            ? "bg-amber/10 text-amber font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-accent"
                        }`}
                        data-testid={`nav-section-${section.key}`}
                      >
                        <span className="text-xs opacity-60">{idx + 1}.</span>
                        {section.title}
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="mt-4">
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Access Level</span>
                  <Badge variant="outline" className="capitalize">{access.accessLevel}</Badge>
                </div>
                <Separator />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Downloads</span>
                  {access.canDownload ? (
                    <Badge variant="default">Allowed</Badge>
                  ) : (
                    <Badge variant="secondary" className="flex items-center gap-1">
                      <Lock className="h-3 w-3" />
                      Restricted
                    </Badge>
                  )}
                </div>
                <Separator />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">NDA Status</span>
                  {access.ndaSigned ? (
                    <Badge variant="default">Signed</Badge>
                  ) : (
                    <Badge variant="outline">Pending</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="col-span-9">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-xl">
                      {availableSections.find(s => s.key === activeSection)?.title || "Section"}
                    </CardTitle>
                    <CardDescription>
                      {deal.industry} • {deal.businessName}
                    </CardDescription>
                  </div>
                  {access.canDownload && (
                    <Button variant="outline" size="sm" data-testid="button-download-section">
                      <Download className="h-4 w-4 mr-2" />
                      Download
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div 
                  className="prose prose-sm max-w-none dark:prose-invert"
                  data-testid={`content-${activeSection}`}
                >
                  {cimContent?.[activeSection] ? (
                    <div dangerouslySetInnerHTML={{ 
                      __html: cimContent[activeSection].replace(/\n/g, "<br />") 
                    }} />
                  ) : (
                    <p className="text-muted-foreground italic">
                      This section is not yet available.
                    </p>
                  )}
                </div>

                <div className="flex justify-between items-center mt-8 pt-6 border-t">
                  {availableSections.findIndex(s => s.key === activeSection) > 0 && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        const idx = availableSections.findIndex(s => s.key === activeSection);
                        if (idx > 0) handleSectionChange(availableSections[idx - 1].key);
                      }}
                      data-testid="button-prev-section"
                    >
                      Previous Section
                    </Button>
                  )}
                  <div className="flex-1" />
                  {availableSections.findIndex(s => s.key === activeSection) < availableSections.length - 1 && (
                    <Button
                      onClick={() => {
                        const idx = availableSections.findIndex(s => s.key === activeSection);
                        if (idx < availableSections.length - 1) handleSectionChange(availableSections[idx + 1].key);
                      }}
                      className="bg-amber text-amber-foreground hover:bg-amber/90 gap-1.5"
                      data-testid="button-next-section"
                    >
                      Next Section
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {faqs.length > 0 && (
        <div className="max-w-6xl mx-auto px-6 mt-8">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <HelpCircle className="h-5 w-5" />
                Frequently Asked Questions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {faqs.map((faq: any) => (
                <div key={faq.id} className="border rounded-lg">
                  <button
                    className="w-full text-left px-4 py-3 flex items-center justify-between gap-2"
                    onClick={() => setExpandedFaq(expandedFaq === faq.id ? null : faq.id)}
                    data-testid={`faq-toggle-${faq.id}`}
                  >
                    <span className="font-medium text-sm">{faq.question}</span>
                    <ChevronDown className={`h-4 w-4 transition-transform flex-shrink-0 ${expandedFaq === faq.id ? 'rotate-180' : ''}`} />
                  </button>
                  {expandedFaq === faq.id && (
                    <div className="px-4 pb-3 text-sm text-muted-foreground">
                      {faq.answer}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      <footer className="border-t mt-12 py-6">
        <div className="max-w-6xl mx-auto px-6 text-center text-sm text-muted-foreground">
          <p>
            This document is confidential and intended solely for the named recipient.
          </p>
          <p className="mt-1">
            Unauthorized distribution or reproduction is strictly prohibited.
          </p>
        </div>
      </footer>
    </div>
  );
}
