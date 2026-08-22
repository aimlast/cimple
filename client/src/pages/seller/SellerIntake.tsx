/**
 * SellerIntake — Multi-step onboarding for sellers invited by their broker.
 *
 * Route: /seller/:token (rendered inside SellerLayout)
 *
 * Steps: welcome → business-basics → systems → employees → interview → complete
 *
 * The interview step embeds AIConversationInterface inline. Sellers can
 * also resume the interview fullscreen at /seller/:token/interview.
 *
 * `?edit=1` is an explicit edit intent: it opens the wizard at Business
 * Basics even when intake + interview are already complete (which would
 * otherwise redirect to the progress page), and saving returns the seller
 * to progress instead of pushing them back into the conversation.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MessageCircle,
  Upload,
  ArrowRight,
  ArrowLeft,
  Building2,
  Users,
  Settings,
  CheckCircle2,
  FileText,
  Loader2,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AIConversationInterface } from "@/components/AIConversationInterface";
import { SellerOnboarding } from "@/components/seller/SellerOnboarding";

type Section = "welcome" | "business-basics" | "systems" | "employees" | "interview" | "complete";

interface SystemInfo {
  accounting: string;
  crm: string;
  pos: string;
  erp: string;
  other: string[];
}

interface Employee {
  name: string;
  role: string;
  yearsWithCompany: string;
  keyPerson: boolean;
}

interface BusinessBasics {
  yearsInBusiness: string;
  numberOfLocations: string;
  ownershipStructure: string;
  reasonForSelling: string;
  transitionAvailability: string;
}

const EMPTY_BASICS: BusinessBasics = {
  yearsInBusiness: "",
  numberOfLocations: "1",
  ownershipStructure: "",
  reasonForSelling: "",
  transitionAvailability: "",
};

const EMPTY_SYSTEMS: SystemInfo = {
  accounting: "",
  crm: "",
  pos: "",
  erp: "",
  other: [],
};

const EMPTY_EMPLOYEE: Employee = { name: "", role: "", yearsWithCompany: "", keyPerson: false };

const str = (v: unknown, fallback = ""): string =>
  v === null || v === undefined ? fallback : String(v);

/** Seed the intake form from whatever the deal already holds so a returning
 *  seller never sees blank fields (and never PATCHes blanks over real data). */
function seedBasics(raw: unknown): BusinessBasics | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  return {
    yearsInBusiness: str(q.yearsInBusiness),
    numberOfLocations: str(q.numberOfLocations, "1"),
    ownershipStructure: str(q.ownershipStructure),
    reasonForSelling: str(q.reasonForSelling),
    transitionAvailability: str(q.transitionAvailability),
  };
}

function seedSystems(raw: unknown): SystemInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    accounting: str(s.accounting),
    crm: str(s.crm),
    pos: str(s.pos),
    erp: str(s.erp),
    other: Array.isArray(s.other) ? s.other.map((o) => str(o)).filter(Boolean) : [],
  };
}

function seedEmployees(raw: unknown): Employee[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      const emp = e as Record<string, unknown>;
      return {
        name: str(emp.name),
        role: str(emp.role),
        yearsWithCompany: str(emp.yearsWithCompany),
        keyPerson: emp.keyPerson === true,
      };
    });
  return list.length > 0 ? list : null;
}

interface SellerProgressSummary {
  currentStep: "intake" | "interview" | "documents" | "review";
  documents: { requiredTotal: number; requiredUploaded: number; percentage: number };
}

export default function SellerIntake() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const isEditIntent = new URLSearchParams(search).get("edit") === "1";
  const [currentSection, setCurrentSection] = useState<Section>("welcome");
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const { toast } = useToast();

  const [businessBasics, setBusinessBasics] = useState<BusinessBasics>(EMPTY_BASICS);

  const [systems, setSystems] = useState<SystemInfo>(EMPTY_SYSTEMS);

  const [employees, setEmployees] = useState<Employee[]>([{ ...EMPTY_EMPLOYEE }]);

  const [otherSystem, setOtherSystem] = useState("");

  const {
    data: inviteData,
    isLoading: isLoadingInvite,
    error: inviteError,
  } = useQuery<{
    invite: any;
    deal: any;
  }>({
    queryKey: ["/api/invites", token],
    enabled: !!token,
  });

  // Document/step status — only needed once the conversation is done, to
  // route the seller onward (documents vs progress) instead of a dead end.
  const { data: progressData } = useQuery<SellerProgressSummary>({
    queryKey: [`/api/seller/${token}/progress`],
    enabled: !!token && currentSection === "complete",
  });

  // Seed the form from the invite payload exactly once per page load, and
  // resume at the right step. The invite email links to /seller/:token, so
  // every return visit lands here — without this a seller saw blank fields
  // and clicking through overwrote their saved answers with empty values.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !inviteData?.deal) return;
    seededRef.current = true;
    const deal = inviteData.deal;

    const basics = seedBasics(deal.questionnaireData);
    const sys = seedSystems(deal.operationalSystems);
    const emps = seedEmployees(deal.employeeChart);
    if (basics) setBusinessBasics(basics);
    if (sys) setSystems(sys);
    if (emps) setEmployees(emps);

    const intakeDone = !!basics;
    if (isEditIntent) {
      // Explicit edit intent (progress page's "Edit business details") —
      // open the wizard on the first editable step regardless of status.
      setCurrentSection("business-basics");
    } else if (intakeDone && deal.interviewCompleted) {
      // Intake and conversation both done — the progress page is the right
      // home (it routes to documents / review and lets them revisit the chat).
      setLocation(`/seller/${token}/progress`);
    } else if (intakeDone) {
      setCurrentSection("interview");
    }
  }, [inviteData, token, setLocation, isEditIntent]);

  // In edit mode a seller who already finished the conversation should land
  // back on progress after saving, not on "Start Business Overview".
  const returnToProgressAfterSave = isEditIntent && !!inviteData?.deal?.interviewCompleted;

  const saveQuestionnaireMutation = useMutation({
    mutationFn: async (data: {
      questionnaireData: any;
      operationalSystems: any;
      employeeChart: any;
    }) => {
      if (!inviteData?.deal?.id) throw new Error("No deal found");
      // The invite token authenticates the seller — the deal PATCH endpoint
      // only accepts intake fields from a token that maps to this deal.
      const res = await fetch(`/api/deals/${inviteData.deal.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Seller-Token": token || "",
        },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to save your information (${res.status})`);
      }
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invites", token] });
      queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] });
      toast({
        title: "Information Saved",
        description: "Your business details have been saved successfully.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't save your information",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const sections: { id: Section; label: string; icon: any }[] = [
    { id: "welcome", label: "Welcome", icon: MessageCircle },
    { id: "business-basics", label: "Business Basics", icon: Building2 },
    { id: "systems", label: "Systems Used", icon: Settings },
    { id: "employees", label: "Key People", icon: Users },
    { id: "interview", label: "Business Overview", icon: MessageCircle },
    { id: "complete", label: "Complete", icon: CheckCircle2 },
  ];

  const currentIndex = sections.findIndex((s) => s.id === currentSection);
  const progress = (currentIndex / (sections.length - 1)) * 100;

  const goNext = async () => {
    if (currentSection === "employees") {
      try {
        await saveQuestionnaireMutation.mutateAsync({
          questionnaireData: businessBasics,
          operationalSystems: systems,
          employeeChart: employees.filter((e) => e.name.trim() !== ""),
        });
      } catch {
        // onError already surfaced the server message — stay on this step
        // so nothing is lost and the seller can retry.
        return;
      }
      if (returnToProgressAfterSave) {
        setLocation(`/seller/${token}/progress`);
        return;
      }
    }
    const nextIndex = currentIndex + 1;
    if (nextIndex < sections.length) {
      setCurrentSection(sections[nextIndex].id);
    }
  };

  const goBack = () => {
    if (isEditIntent && currentSection === "business-basics") {
      // Edit mode entered from progress — "Back" on the first step returns
      // there rather than to the welcome screen.
      setLocation(`/seller/${token}/progress`);
      return;
    }
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      setCurrentSection(sections[prevIndex].id);
    }
  };

  const addEmployee = () => {
    setEmployees([...employees, { ...EMPTY_EMPLOYEE }]);
  };

  const updateEmployee = (
    index: number,
    field: keyof Employee,
    value: any,
  ) => {
    const updated = [...employees];
    updated[index] = { ...updated[index], [field]: value };
    setEmployees(updated);
  };

  const removeEmployee = (index: number) => {
    if (employees.length > 1) {
      setEmployees(employees.filter((_, i) => i !== index));
    }
  };

  const addOtherSystem = () => {
    if (otherSystem.trim()) {
      setSystems({
        ...systems,
        other: [...systems.other, otherSystem.trim()],
      });
      setOtherSystem("");
    }
  };

  if (isLoadingInvite) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  if (!token || inviteError || !inviteData) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="max-w-sm w-full text-center space-y-3">
          <h2 className="text-lg font-semibold">Invalid invite link</h2>
          <p className="text-sm text-muted-foreground">
            This invite link is not valid or has expired. Contact your broker
            for a new link.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-45px)] bg-background flex flex-col">
      {/* Progress header */}
      {currentSection !== "welcome" && currentSection !== "complete" && (
        <div className="border-b border-border bg-card px-5 py-3 sticky top-0 z-10">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium">
                {inviteData.deal?.businessName}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(progress)}%
              </span>
            </div>
            <Progress value={progress} className="h-1" />
            <div className="flex justify-between mt-2">
              {sections.slice(1, -1).map((section, idx) => (
                <span
                  key={section.id}
                  className={`text-[10px] font-medium ${
                    currentIndex > idx + 1
                      ? "text-teal"
                      : currentIndex === idx + 1
                        ? "text-foreground"
                        : "text-muted-foreground/50"
                  }`}
                >
                  {section.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-3xl">
          {currentSection === "welcome" && (
            <Card className="max-w-lg mx-auto">
              <CardContent className="p-8 space-y-7">
                <div className="text-center space-y-3">
                  <div className="h-12 w-12 rounded-xl bg-teal flex items-center justify-center mx-auto">
                    <MessageCircle className="h-5 w-5 text-teal-foreground" />
                  </div>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    Welcome
                  </h1>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    You've been invited to share information about{" "}
                    <span className="font-medium text-foreground">
                      {inviteData.deal?.businessName}
                    </span>{" "}
                    to help create a professional CIM.
                  </p>
                </div>

                <div className="rounded-lg border border-border divide-y divide-border">
                  {[
                    {
                      icon: Building2,
                      title: "Business Basics",
                      desc: "Ownership, location, and fundamentals",
                    },
                    {
                      icon: Settings,
                      title: "Systems & Tools",
                      desc: "Software and systems you use",
                    },
                    {
                      icon: Users,
                      title: "Key People",
                      desc: "Key employees and their roles",
                    },
                    {
                      icon: MessageCircle,
                      title: "Business Overview",
                      desc: "Tell us about your business in your own words",
                    },
                  ].map(({ icon: Icon, title, desc }) => (
                    <div
                      key={title}
                      className="flex items-center gap-3 px-4 py-3"
                    >
                      <div className="h-7 w-7 rounded-md bg-teal/10 flex items-center justify-center shrink-0">
                        <Icon className="h-3.5 w-3.5 text-teal" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{title}</p>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <Button
                  className="w-full bg-teal text-teal-foreground hover:bg-teal/90 gap-2"
                  onClick={goNext}
                  data-testid="button-start-intake"
                >
                  Get Started
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          )}

          {currentSection === "business-basics" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  Business Basics
                </CardTitle>
                <CardDescription>
                  Help us understand the fundamentals of your business
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="yearsInBusiness">Years in Business</Label>
                    <Input
                      id="yearsInBusiness"
                      placeholder="e.g., 15"
                      value={businessBasics.yearsInBusiness}
                      onChange={(e) =>
                        setBusinessBasics({
                          ...businessBasics,
                          yearsInBusiness: e.target.value,
                        })
                      }
                      data-testid="input-years-in-business"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="numberOfLocations">
                      Number of Locations
                    </Label>
                    <Input
                      id="numberOfLocations"
                      placeholder="e.g., 1"
                      value={businessBasics.numberOfLocations}
                      onChange={(e) =>
                        setBusinessBasics({
                          ...businessBasics,
                          numberOfLocations: e.target.value,
                        })
                      }
                      data-testid="input-locations"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ownershipStructure">
                    Ownership Structure
                  </Label>
                  <Input
                    id="ownershipStructure"
                    placeholder="e.g., Sole proprietorship, LLC, Corporation"
                    value={businessBasics.ownershipStructure}
                    onChange={(e) =>
                      setBusinessBasics({
                        ...businessBasics,
                        ownershipStructure: e.target.value,
                      })
                    }
                    data-testid="input-ownership"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reasonForSelling">Reason for Selling</Label>
                  <Textarea
                    id="reasonForSelling"
                    placeholder="Why are you looking to sell your business?"
                    value={businessBasics.reasonForSelling}
                    onChange={(e) =>
                      setBusinessBasics({
                        ...businessBasics,
                        reasonForSelling: e.target.value,
                      })
                    }
                    data-testid="input-reason-selling"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="transitionAvailability">
                    Transition Availability
                  </Label>
                  <Textarea
                    id="transitionAvailability"
                    placeholder="How long are you willing to stay on to help transition the business?"
                    value={businessBasics.transitionAvailability}
                    onChange={(e) =>
                      setBusinessBasics({
                        ...businessBasics,
                        transitionAvailability: e.target.value,
                      })
                    }
                    data-testid="input-transition"
                  />
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={goBack}
                    data-testid="button-back"
                  >
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button
                    className="flex-1 bg-teal text-teal-foreground hover:bg-teal/90"
                    onClick={goNext}
                    data-testid="button-next"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {currentSection === "systems" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  Systems & Tools
                </CardTitle>
                <CardDescription>
                  What software and systems does your business use?
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="accounting">Accounting Software</Label>
                    <Input
                      id="accounting"
                      placeholder="e.g., QuickBooks, Xero, FreshBooks"
                      value={systems.accounting}
                      onChange={(e) =>
                        setSystems({ ...systems, accounting: e.target.value })
                      }
                      data-testid="input-accounting"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="crm">CRM System</Label>
                    <Input
                      id="crm"
                      placeholder="e.g., Salesforce, HubSpot, None"
                      value={systems.crm}
                      onChange={(e) =>
                        setSystems({ ...systems, crm: e.target.value })
                      }
                      data-testid="input-crm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pos">Point of Sale (POS)</Label>
                    <Input
                      id="pos"
                      placeholder="e.g., Square, Toast, Clover"
                      value={systems.pos}
                      onChange={(e) =>
                        setSystems({ ...systems, pos: e.target.value })
                      }
                      data-testid="input-pos"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="erp">ERP / Inventory System</Label>
                    <Input
                      id="erp"
                      placeholder="e.g., NetSuite, SAP, None"
                      value={systems.erp}
                      onChange={(e) =>
                        setSystems({ ...systems, erp: e.target.value })
                      }
                      data-testid="input-erp"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <Label>Other Important Systems</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add another system..."
                      value={otherSystem}
                      onChange={(e) => setOtherSystem(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addOtherSystem()}
                      data-testid="input-other-system"
                    />
                    <Button
                      variant="outline"
                      onClick={addOtherSystem}
                      data-testid="button-add-system"
                    >
                      Add
                    </Button>
                  </div>
                  {systems.other.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {systems.other.map((sys, idx) => (
                        <Badge
                          key={idx}
                          variant="secondary"
                          className="cursor-pointer"
                          onClick={() =>
                            setSystems({
                              ...systems,
                              other: systems.other.filter((_, i) => i !== idx),
                            })
                          }
                        >
                          {sys} ×
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={goBack}
                    data-testid="button-back"
                  >
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button
                    className="flex-1 bg-teal text-teal-foreground hover:bg-teal/90"
                    onClick={goNext}
                    data-testid="button-next"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {currentSection === "employees" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Key People
                </CardTitle>
                <CardDescription>
                  List key employees and their roles (these are important for
                  buyers)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  {employees.map((employee, idx) => (
                    <div key={idx} className="p-4 border rounded-lg space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          Employee {idx + 1}
                        </span>
                        {employees.length > 1 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeEmployee(idx)}
                            data-testid={`button-remove-employee-${idx}`}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Name / Title</Label>
                          <Input
                            placeholder="e.g., John Smith"
                            value={employee.name}
                            onChange={(e) =>
                              updateEmployee(idx, "name", e.target.value)
                            }
                            data-testid={`input-employee-name-${idx}`}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Role</Label>
                          <Input
                            placeholder="e.g., Operations Manager"
                            value={employee.role}
                            onChange={(e) =>
                              updateEmployee(idx, "role", e.target.value)
                            }
                            data-testid={`input-employee-role-${idx}`}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Years with Company</Label>
                          <Input
                            placeholder="e.g., 5"
                            value={employee.yearsWithCompany}
                            onChange={(e) =>
                              updateEmployee(
                                idx,
                                "yearsWithCompany",
                                e.target.value,
                              )
                            }
                            data-testid={`input-employee-years-${idx}`}
                          />
                        </div>
                        <div className="flex items-center space-x-2 pt-6">
                          <Checkbox
                            id={`keyPerson-${idx}`}
                            checked={employee.keyPerson}
                            onCheckedChange={(checked) =>
                              updateEmployee(idx, "keyPerson", checked)
                            }
                            data-testid={`checkbox-key-person-${idx}`}
                          />
                          <Label
                            htmlFor={`keyPerson-${idx}`}
                            className="text-sm"
                          >
                            Key person (critical to operations)
                          </Label>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <Button
                  variant="outline"
                  onClick={addEmployee}
                  className="w-full"
                  data-testid="button-add-employee"
                >
                  <Users className="h-4 w-4 mr-2" />
                  Add Another Employee
                </Button>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={goBack}
                    data-testid="button-back"
                  >
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button
                    className="flex-1 bg-teal text-teal-foreground hover:bg-teal/90"
                    onClick={goNext}
                    disabled={saveQuestionnaireMutation.isPending}
                    data-testid="button-next"
                  >
                    {saveQuestionnaireMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : returnToProgressAfterSave ? (
                      <>
                        Save changes
                        <ArrowRight className="h-4 w-4 ml-2" />
                      </>
                    ) : (
                      <>
                        Start Business Overview
                        <ArrowRight className="h-4 w-4 ml-2" />
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {currentSection === "interview" && inviteData?.deal && (
            <>
              {/* Show onboarding overlay on first visit to the conversation step */}
              {!inviteData.invite.onboardingCompleted && !onboardingDismissed && (
                <SellerOnboarding
                  token={token!}
                  onComplete={() => setOnboardingDismissed(true)}
                />
              )}
              <Card className="h-[calc(100vh-200px)]">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2">
                    <MessageCircle className="h-5 w-5" />
                    Business Overview
                  </CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-x-2">
                    <span>
                      Tell us about your business naturally — our AI advisor will
                      guide the conversation
                    </span>
                    <button
                      type="button"
                      onClick={() => setCurrentSection("business-basics")}
                      className="text-xs text-teal hover:underline"
                      data-testid="button-edit-business-info"
                    >
                      Edit your business details
                    </button>
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-[calc(100%-80px)]">
                  {/* The invite token authenticates every interview call
                      (start / stream / history / end) — without it a real
                      seller gets 401 on the core step. */}
                  <AIConversationInterface
                    dealId={String(inviteData.deal.id)}
                    businessName={inviteData.deal.businessName}
                    sellerToken={token!}
                    onComplete={async () => {
                      await Promise.all([
                        queryClient.invalidateQueries({ queryKey: ["/api/invites", token] }),
                        queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] }),
                      ]);
                      setCurrentSection("complete");
                    }}
                  />
                </CardContent>
              </Card>
            </>
          )}

          {currentSection === "complete" && (() => {
            const docs = progressData?.documents;
            const docsOutstanding =
              !!docs && docs.requiredTotal > 0 && docs.requiredUploaded < docs.requiredTotal;
            const remaining = docs ? docs.requiredTotal - docs.requiredUploaded : 0;
            return (
              <Card className="max-w-md mx-auto">
                <CardContent className="p-8 text-center space-y-6">
                  <div className="h-12 w-12 rounded-full bg-success/15 flex items-center justify-center mx-auto">
                    <CheckCircle2 className="h-6 w-6 text-success" />
                  </div>
                  <div className="space-y-2">
                    <h1 className="text-xl font-semibold">
                      {docsOutstanding ? "Overview complete" : "All done!"}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {docsOutstanding
                        ? `Your conversation has been saved. One more step — your broker still needs ${remaining} ${remaining === 1 ? "document" : "documents"} from you.`
                        : "Your information has been submitted successfully."}
                    </p>
                  </div>

                  <div className="rounded-lg border border-border divide-y divide-border text-left">
                    {(docsOutstanding
                      ? [
                          "Upload the documents on your checklist",
                          "Your broker will review everything you provided",
                          "Your CIM will be drafted and shared with you for approval",
                        ]
                      : [
                          "Your broker will review the information you provided",
                          "They may reach out for any clarifications",
                          "Your CIM will be drafted and shared with you for approval",
                        ]
                    ).map((item, idx) => (
                      <div
                        key={item}
                        className="flex items-start gap-3 px-4 py-3"
                      >
                        {docsOutstanding && idx === 0 ? (
                          <Upload className="h-4 w-4 text-teal mt-0.5 shrink-0" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
                        )}
                        <span className="text-sm text-muted-foreground">
                          {item}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    {docsOutstanding ? (
                      <>
                        <Button
                          className="w-full bg-teal text-teal-foreground hover:bg-teal/90 gap-2"
                          onClick={() => setLocation(`/seller/${token}/documents`)}
                          data-testid="button-go-documents"
                        >
                          <Upload className="h-4 w-4" />
                          Upload your documents
                        </Button>
                        <Button
                          variant="ghost"
                          className="w-full"
                          onClick={() => setLocation(`/seller/${token}/progress`)}
                          data-testid="button-go-progress"
                        >
                          View your progress
                          <ArrowRight className="h-4 w-4 ml-2" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        className="w-full bg-teal text-teal-foreground hover:bg-teal/90 gap-2"
                        onClick={() => setLocation(`/seller/${token}/progress`)}
                        data-testid="button-go-progress"
                      >
                        <FileText className="h-4 w-4" />
                        View your progress
                      </Button>
                    )}
                  </div>

                  {!docsOutstanding && (
                    <p className="text-xs text-muted-foreground/60">
                      You can close this window. Your broker will be in touch.
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
