import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
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
  Loader2
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AIConversationInterface } from "@/components/AIConversationInterface";

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

export default function SellerInviteIntake() {
  const [, params] = useRoute("/invite/:token");
  const [, setLocation] = useLocation();
  const [currentSection, setCurrentSection] = useState<Section>("welcome");
  const { toast } = useToast();

  const [businessBasics, setBusinessBasics] = useState({
    yearsInBusiness: "",
    numberOfLocations: "1",
    ownershipStructure: "",
    reasonForSelling: "",
    transitionAvailability: "",
  });

  const [systems, setSystems] = useState<SystemInfo>({
    accounting: "",
    crm: "",
    pos: "",
    erp: "",
    other: [],
  });

  const [employees, setEmployees] = useState<Employee[]>([
    { name: "", role: "", yearsWithCompany: "", keyPerson: false }
  ]);

  const [otherSystem, setOtherSystem] = useState("");

  const { data: inviteData, isLoading: isLoadingInvite, error: inviteError } = useQuery<{
    invite: any;
    deal: any;
  }>({
    queryKey: ["/api/invites", params?.token],
    enabled: !!params?.token,
  });

  const saveQuestionnaireMutation = useMutation({
    mutationFn: async (data: { questionnaireData: any; operationalSystems: any; employeeChart: any }) => {
      if (!inviteData?.deal?.id) throw new Error("No deal found");
      return apiRequest("PATCH", `/api/deals/${inviteData.deal.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invites", params?.token] });
      toast({
        title: "Information Saved",
        description: "Your business details have been saved successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to save your information. Please try again.",
        variant: "destructive",
      });
    },
  });

  const sections: { id: Section; label: string; icon: any }[] = [
    { id: "welcome", label: "Welcome", icon: MessageCircle },
    { id: "business-basics", label: "Business Basics", icon: Building2 },
    { id: "systems", label: "Systems Used", icon: Settings },
    { id: "employees", label: "Key People", icon: Users },
    { id: "interview", label: "AI Interview", icon: MessageCircle },
    { id: "complete", label: "Complete", icon: CheckCircle2 },
  ];

  const currentIndex = sections.findIndex(s => s.id === currentSection);
  const progress = ((currentIndex) / (sections.length - 1)) * 100;

  const goNext = async () => {
    if (currentSection === "employees") {
      await saveQuestionnaireMutation.mutateAsync({
        questionnaireData: businessBasics,
        operationalSystems: systems,
        employeeChart: employees.filter(e => e.name.trim() !== ""),
      });
    }
    const nextIndex = currentIndex + 1;
    if (nextIndex < sections.length) {
      setCurrentSection(sections[nextIndex].id);
    }
  };

  const goBack = () => {
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      setCurrentSection(sections[prevIndex].id);
    }
  };

  const addEmployee = () => {
    setEmployees([...employees, { name: "", role: "", yearsWithCompany: "", keyPerson: false }]);
  };

  const updateEmployee = (index: number, field: keyof Employee, value: any) => {
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
      setSystems({ ...systems, other: [...systems.other, otherSystem.trim()] });
      setOtherSystem("");
    }
  };

  if (isLoadingInvite) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!params?.token || inviteError || !inviteData) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center">
            <h2 className="text-xl font-semibold mb-2">Invalid Invite Link</h2>
            <p className="text-muted-foreground">
              This invite link is not valid or has expired.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {currentSection !== "welcome" && currentSection !== "complete" && (
        <div className="border-b bg-card/50 px-4 py-3">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">
                {inviteData.deal?.businessName} - CIM Intake
              </span>
              <Badge variant="secondary">{Math.round(progress)}% Complete</Badge>
            </div>
            <Progress value={progress} className="h-2" />
            <div className="flex justify-between mt-2">
              {sections.slice(1, -1).map((section, idx) => (
                <div 
                  key={section.id}
                  className={`text-xs ${currentIndex > idx + 1 ? 'text-primary' : 'text-muted-foreground'}`}
                >
                  {section.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-3xl">
          {currentSection === "welcome" && (
            <Card>
              <CardContent className="p-8 space-y-6">
                <div className="text-center space-y-3">
                  <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                    <MessageCircle className="h-8 w-8 text-primary" />
                  </div>
                  <h1 className="text-3xl font-bold">Welcome to Your CIM Intake</h1>
                  <p className="text-muted-foreground text-lg">
                    You've been invited to provide information about{" "}
                    <span className="font-medium text-foreground">{inviteData.deal?.businessName}</span>.
                  </p>
                </div>

                <div className="bg-muted/50 rounded-lg p-6 space-y-4">
                  <h3 className="font-semibold">The process includes:</h3>
                  <div className="grid gap-3">
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Building2 className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium">Business Basics</div>
                        <div className="text-sm text-muted-foreground">Basic information about your business</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Settings className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium">Systems & Tools</div>
                        <div className="text-sm text-muted-foreground">What software and systems your business uses</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <Users className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium">Key People</div>
                        <div className="text-sm text-muted-foreground">Information about key employees</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <MessageCircle className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium">AI-Guided Interview</div>
                        <div className="text-sm text-muted-foreground">Answer questions in a natural conversation</div>
                      </div>
                    </div>
                  </div>
                </div>

                <Button 
                  className="w-full" 
                  size="lg"
                  onClick={goNext}
                  data-testid="button-start-intake"
                >
                  Get Started
                  <ArrowRight className="h-4 w-4 ml-2" />
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
                      onChange={(e) => setBusinessBasics({ ...businessBasics, yearsInBusiness: e.target.value })}
                      data-testid="input-years-in-business"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="numberOfLocations">Number of Locations</Label>
                    <Input
                      id="numberOfLocations"
                      placeholder="e.g., 1"
                      value={businessBasics.numberOfLocations}
                      onChange={(e) => setBusinessBasics({ ...businessBasics, numberOfLocations: e.target.value })}
                      data-testid="input-locations"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ownershipStructure">Ownership Structure</Label>
                  <Input
                    id="ownershipStructure"
                    placeholder="e.g., Sole proprietorship, LLC, Corporation"
                    value={businessBasics.ownershipStructure}
                    onChange={(e) => setBusinessBasics({ ...businessBasics, ownershipStructure: e.target.value })}
                    data-testid="input-ownership"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reasonForSelling">Reason for Selling</Label>
                  <Textarea
                    id="reasonForSelling"
                    placeholder="Why are you looking to sell your business?"
                    value={businessBasics.reasonForSelling}
                    onChange={(e) => setBusinessBasics({ ...businessBasics, reasonForSelling: e.target.value })}
                    data-testid="input-reason-selling"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="transitionAvailability">Transition Availability</Label>
                  <Textarea
                    id="transitionAvailability"
                    placeholder="How long are you willing to stay on to help transition the business?"
                    value={businessBasics.transitionAvailability}
                    onChange={(e) => setBusinessBasics({ ...businessBasics, transitionAvailability: e.target.value })}
                    data-testid="input-transition"
                  />
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={goBack} data-testid="button-back">
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button className="flex-1" onClick={goNext} data-testid="button-next">
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
                      onChange={(e) => setSystems({ ...systems, accounting: e.target.value })}
                      data-testid="input-accounting"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="crm">CRM System</Label>
                    <Input
                      id="crm"
                      placeholder="e.g., Salesforce, HubSpot, None"
                      value={systems.crm}
                      onChange={(e) => setSystems({ ...systems, crm: e.target.value })}
                      data-testid="input-crm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pos">Point of Sale (POS)</Label>
                    <Input
                      id="pos"
                      placeholder="e.g., Square, Toast, Clover"
                      value={systems.pos}
                      onChange={(e) => setSystems({ ...systems, pos: e.target.value })}
                      data-testid="input-pos"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="erp">ERP / Inventory System</Label>
                    <Input
                      id="erp"
                      placeholder="e.g., NetSuite, SAP, None"
                      value={systems.erp}
                      onChange={(e) => setSystems({ ...systems, erp: e.target.value })}
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
                    <Button variant="outline" onClick={addOtherSystem} data-testid="button-add-system">
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
                          onClick={() => setSystems({ ...systems, other: systems.other.filter((_, i) => i !== idx) })}
                        >
                          {sys} ×
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={goBack} data-testid="button-back">
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button className="flex-1" onClick={goNext} data-testid="button-next">
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
                  List key employees and their roles (these are important for buyers)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  {employees.map((employee, idx) => (
                    <div key={idx} className="p-4 border rounded-lg space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">Employee {idx + 1}</span>
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
                            onChange={(e) => updateEmployee(idx, "name", e.target.value)}
                            data-testid={`input-employee-name-${idx}`}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Role</Label>
                          <Input
                            placeholder="e.g., Operations Manager"
                            value={employee.role}
                            onChange={(e) => updateEmployee(idx, "role", e.target.value)}
                            data-testid={`input-employee-role-${idx}`}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Years with Company</Label>
                          <Input
                            placeholder="e.g., 5"
                            value={employee.yearsWithCompany}
                            onChange={(e) => updateEmployee(idx, "yearsWithCompany", e.target.value)}
                            data-testid={`input-employee-years-${idx}`}
                          />
                        </div>
                        <div className="flex items-center space-x-2 pt-6">
                          <Checkbox
                            id={`keyPerson-${idx}`}
                            checked={employee.keyPerson}
                            onCheckedChange={(checked) => updateEmployee(idx, "keyPerson", checked)}
                            data-testid={`checkbox-key-person-${idx}`}
                          />
                          <Label htmlFor={`keyPerson-${idx}`} className="text-sm">
                            Key person (critical to operations)
                          </Label>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <Button variant="outline" onClick={addEmployee} className="w-full" data-testid="button-add-employee">
                  <Users className="h-4 w-4 mr-2" />
                  Add Another Employee
                </Button>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={goBack} data-testid="button-back">
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back
                  </Button>
                  <Button 
                    className="flex-1" 
                    onClick={goNext}
                    disabled={saveQuestionnaireMutation.isPending}
                    data-testid="button-next"
                  >
                    {saveQuestionnaireMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        Continue to Interview
                        <ArrowRight className="h-4 w-4 ml-2" />
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {currentSection === "interview" && inviteData?.deal && (
            <Card className="h-[calc(100vh-200px)]">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2">
                  <MessageCircle className="h-5 w-5" />
                  AI-Guided Interview
                </CardTitle>
                <CardDescription>
                  Answer questions naturally - our AI will guide you through each topic
                </CardDescription>
              </CardHeader>
              <CardContent className="h-[calc(100%-80px)]">
                <AIConversationInterface
                  dealId={inviteData.deal.id}
                  businessName={inviteData.deal.businessName}
                  industry={inviteData.deal.industry}
                  existingInfo={inviteData.deal.extractedInfo}
                  onComplete={() => setCurrentSection("complete")}
                  onInfoUpdate={() => {
                    queryClient.invalidateQueries({ queryKey: ["/api/invites", params?.token] });
                  }}
                />
              </CardContent>
            </Card>
          )}

          {currentSection === "complete" && (
            <Card>
              <CardContent className="p-8 text-center space-y-6">
                <div className="h-20 w-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
                </div>
                <div className="space-y-2">
                  <h1 className="text-3xl font-bold">Thank You!</h1>
                  <p className="text-muted-foreground text-lg">
                    Your information has been submitted successfully.
                  </p>
                </div>

                <div className="bg-muted/50 rounded-lg p-6 text-left space-y-3">
                  <h3 className="font-semibold">What happens next?</h3>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                      <span>Your broker will review the information you provided</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                      <span>They may reach out for any clarifications needed</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
                      <span>Your CIM will be drafted and shared with you for approval</span>
                    </li>
                  </ul>
                </div>

                <p className="text-sm text-muted-foreground">
                  You can close this window. Your broker will contact you with next steps.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
