import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Autocomplete } from "@/components/ui/autocomplete";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type Field = {
  id: string;
  label: string;
  type: string;
  placeholder?: string;
  options?: string[];
  datalist?: string[];
  conditional?: (answers: Record<string, string>) => boolean;
};

type Question = {
  id: number;
  title: string;
  conditional?: (answers: Record<string, string>) => boolean;
  fields: Field[];
};

const questions: Question[] = [
  {
    id: 1,
    title: "Business Location & Years in Operation",
    fields: [
      { 
        id: "country", 
        label: "Country", 
        type: "text", 
        placeholder: "Canada",
        datalist: [
          "Canada",
          "United States",
          "United Kingdom",
          "Australia",
          "New Zealand",
          "Ireland",
          "Germany",
          "France",
          "Italy",
          "Spain",
          "Netherlands",
          "Belgium",
          "Switzerland",
          "Austria",
          "Sweden",
          "Norway",
          "Denmark",
          "Finland",
          "Poland",
          "Portugal",
          "Greece",
          "Czech Republic",
          "Hungary",
          "Romania",
          "Mexico",
          "Brazil",
          "Argentina",
          "Chile",
          "Colombia",
          "Peru",
          "Japan",
          "China",
          "South Korea",
          "Singapore",
          "Hong Kong",
          "Taiwan",
          "India",
          "Malaysia",
          "Thailand",
          "Indonesia",
          "Philippines",
          "Vietnam",
          "South Africa",
          "Egypt",
          "Nigeria",
          "Kenya",
          "Israel",
          "Saudi Arabia",
          "United Arab Emirates"
        ]
      },
      { 
        id: "state-province", 
        label: "State/Province/Region", 
        type: "text", 
        placeholder: "Ontario",
        datalist: [
          // Canadian Provinces
          "Alberta", "British Columbia", "Manitoba", "New Brunswick", "Newfoundland and Labrador",
          "Northwest Territories", "Nova Scotia", "Nunavut", "Ontario", "Prince Edward Island",
          "Quebec", "Saskatchewan", "Yukon",
          // US States (common ones)
          "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
          "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
          "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
          "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
          "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
          "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
          "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
          "Wisconsin", "Wyoming",
          // UK
          "England", "Scotland", "Wales", "Northern Ireland",
          // Australia
          "New South Wales", "Victoria", "Queensland", "South Australia", "Western Australia", "Tasmania"
        ]
      },
      { 
        id: "city", 
        label: "City", 
        type: "text", 
        placeholder: "Toronto",
        datalist: [
          // Canada
          "Toronto", "Montreal", "Vancouver", "Calgary", "Edmonton", "Ottawa", "Mississauga", "Winnipeg",
          "Quebec City", "Hamilton", "Brampton", "Surrey", "Kitchener", "Laval", "Halifax", "London",
          "Victoria", "Markham", "St. Catharines", "Niagara Falls", "Vaughan", "Gatineau", "Windsor",
          "Saskatoon", "Longueuil", "Burnaby", "Regina", "Richmond", "Richmond Hill", "Oakville",
          "Burlington", "Barrie", "Oshawa", "Sherbrooke", "Saguenay", "Lévis", "Kelowna", "Abbotsford",
          // USA
          "New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia", "San Antonio",
          "San Diego", "Dallas", "San Jose", "Austin", "Jacksonville", "Fort Worth", "Columbus",
          "Charlotte", "San Francisco", "Indianapolis", "Seattle", "Denver", "Washington", "Boston",
          "El Paso", "Nashville", "Detroit", "Oklahoma City", "Portland", "Las Vegas", "Memphis",
          "Louisville", "Baltimore", "Milwaukee", "Albuquerque", "Tucson", "Fresno", "Mesa", "Sacramento",
          "Atlanta", "Kansas City", "Colorado Springs", "Raleigh", "Miami", "Long Beach", "Virginia Beach",
          "Omaha", "Oakland", "Minneapolis", "Tulsa", "Tampa", "Arlington", "New Orleans"
        ]
      },
      { id: "years-in-operation", label: "Years in Operation", type: "number", placeholder: "5" },
    ],
  },
  {
    id: 2,
    title: "Business Structure",
    fields: [
      { id: "incorporated", label: "Is the business incorporated?", type: "select", options: ["Yes", "No"] },
    ],
  },
  {
    id: 3,
    title: "Incorporation Details (Canada)",
    conditional: (answers: Record<string, string>) => 
      answers["incorporated"] === "Yes" && answers["country"]?.toLowerCase().includes("canada"),
    fields: [
      { 
        id: "incorporation-type", 
        label: "Corporation Type", 
        type: "select", 
        options: [
          "Federal Corporation",
          "Provincial Corporation - Alberta",
          "Provincial Corporation - British Columbia", 
          "Provincial Corporation - Manitoba",
          "Provincial Corporation - New Brunswick",
          "Provincial Corporation - Newfoundland and Labrador",
          "Provincial Corporation - Northwest Territories",
          "Provincial Corporation - Nova Scotia",
          "Provincial Corporation - Nunavut",
          "Provincial Corporation - Ontario",
          "Provincial Corporation - Prince Edward Island",
          "Provincial Corporation - Quebec",
          "Provincial Corporation - Saskatchewan",
          "Provincial Corporation - Yukon"
        ]
      },
    ],
  },
  {
    id: 4,
    title: "Incorporation Details (USA)",
    conditional: (answers: Record<string, string>) => 
      answers["incorporated"] === "Yes" && 
      (answers["country"]?.toLowerCase().includes("usa") || 
       answers["country"]?.toLowerCase().includes("united states") ||
       answers["country"]?.toLowerCase().includes("america")),
    fields: [
      { 
        id: "incorporation-type", 
        label: "Corporation Type", 
        type: "select", 
        options: [
          "C Corporation",
          "S Corporation",
          "LLC (Limited Liability Company)",
          "Benefit Corporation (B-Corp)",
          "Professional Corporation (PC)",
          "Nonprofit Corporation"
        ]
      },
    ],
  },
  {
    id: 5,
    title: "Business Structure (Unincorporated)",
    conditional: (answers: Record<string, string>) => answers["incorporated"] === "No",
    fields: [
      { 
        id: "business-structure", 
        label: "Business Structure", 
        type: "select", 
        options: [
          "Sole Proprietorship",
          "Partnership - General Partnership",
          "Partnership - Limited Partnership",
          "Partnership - Limited Liability Partnership (LLP)",
          "Other (please specify)"
        ]
      },
    ],
  },
  {
    id: 6,
    title: "Other Business Structure",
    conditional: (answers: Record<string, string>) => 
      answers["business-structure"] === "Other (please specify)",
    fields: [
      { 
        id: "business-structure-other", 
        label: "Please describe your business structure", 
        type: "textarea", 
        placeholder: "Describe your business legal structure..." 
      },
    ],
  },
  {
    id: 7,
    title: "Employees & Operations",
    fields: [
      { id: "full-time-employees", label: "Full-time Employees", type: "number", placeholder: "10" },
      { id: "part-time-employees", label: "Part-time Employees", type: "number", placeholder: "5" },
      { id: "contractors", label: "Contractors/Seasonal", type: "number", placeholder: "2" },
    ],
  },
  {
    id: 8,
    title: "Real Estate",
    fields: [
      { id: "real-estate-type", label: "Is your business location owned or leased?", type: "select", options: ["Owned", "Leased"] },
      { 
        id: "property-for-sale", 
        label: "Is the property included in the sale?", 
        type: "select", 
        options: ["Yes", "No"],
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Owned"
      },
      { 
        id: "property-size", 
        label: "Property Size (sq ft)", 
        type: "text", 
        placeholder: "5,000 sq ft",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Owned"
      },
      { 
        id: "property-value", 
        label: "Assessed/Market Value", 
        type: "text", 
        placeholder: "$500,000",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Owned"
      },
      { 
        id: "property-taxes", 
        label: "Annual Property Taxes", 
        type: "text", 
        placeholder: "$8,000",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Owned"
      },
      { 
        id: "property-zoning", 
        label: "Zoning", 
        type: "text", 
        placeholder: "Commercial",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Owned"
      },
      { 
        id: "monthly-rent", 
        label: "Monthly Base Rent", 
        type: "text", 
        placeholder: "$3,500",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Leased"
      },
      { 
        id: "tmi-amount", 
        label: "TMI Amount (Taxes, Maintenance, Insurance)", 
        type: "text", 
        placeholder: "$800",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Leased"
      },
      { 
        id: "lease-term", 
        label: "Current Lease Term (years)", 
        type: "number", 
        placeholder: "5",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Leased"
      },
      { 
        id: "lease-end-date", 
        label: "When does current lease end?", 
        type: "text", 
        placeholder: "December 2026",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Leased"
      },
      { 
        id: "renewal-terms", 
        label: "Renewal Terms", 
        type: "text", 
        placeholder: "2 x 5 year options",
        conditional: (answers: Record<string, string>) => answers["real-estate-type"] === "Leased"
      },
    ],
  },
];

export default function CIMQuestionnaire() {
  const [, setLocation] = useLocation();
  const cimId = localStorage.getItem("currentCimId") || "";
  
  const [currentStep, setCurrentStep] = useState(() => {
    if (!cimId) return 0;
    const savedStep = localStorage.getItem(`cim_${cimId}_questionnaireStep`);
    return savedStep ? parseInt(savedStep) : 0;
  });
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    if (!cimId) return {};
    const saved = localStorage.getItem(`cim_${cimId}_questionnaireAnswers`);
    return saved ? JSON.parse(saved) : {};
  });
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  // Save currentStep to CIM-specific localStorage whenever it changes
  useEffect(() => {
    if (cimId) {
      localStorage.setItem(`cim_${cimId}_questionnaireStep`, currentStep.toString());
    }
  }, [currentStep, cimId]);

  // Filter questions based on conditional logic
  const visibleQuestions = questions.filter(q => !q.conditional || q.conditional(answers));
  const currentQuestion = visibleQuestions[currentStep];
  const progress = ((currentStep + 1) / visibleQuestions.length) * 100;

  const handleNext = async () => {
    if (currentStep < visibleQuestions.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      // Save questionnaire data to CIM
      setIsSaving(true);
      try {
        const cimId = localStorage.getItem("currentCimId");
        if (cimId) {
          await apiRequest("PATCH", `/api/cims/${cimId}`, {
            questionnaireData: answers,
            status: "in_progress",
          });
          
          // Invalidate cache so updated CIM appears on dashboard
          await queryClient.invalidateQueries({ queryKey: ["/api/cims"] });
        }
        console.log("Questionnaire complete:", answers);
        
        // Clear CIM-specific saved data now that questionnaire is complete
        if (cimId) {
          localStorage.removeItem(`cim_${cimId}_questionnaireAnswers`);
          localStorage.removeItem(`cim_${cimId}_questionnaireStep`);
        }
        
        setLocation("/broker/cim/new-documents");
      } catch (error: any) {
        console.error("Failed to save questionnaire:", error);
        toast({
          title: "Error",
          description: "Failed to save questionnaire data. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsSaving(false);
      }
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    } else {
      setLocation("/broker/new-cim");
    }
  };

  const updateAnswer = (fieldId: string, value: string) => {
    const updatedAnswers = { ...answers, [fieldId]: value };
    setAnswers(updatedAnswers);
    // Save to CIM-specific localStorage immediately
    if (cimId) {
      localStorage.setItem(`cim_${cimId}_questionnaireAnswers`, JSON.stringify(updatedAnswers));
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Preliminary Questions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Step {currentStep + 1} of {visibleQuestions.length}: {currentQuestion.title}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Progress</span>
          <span className="font-medium">{Math.round(progress)}%</span>
        </div>
        <Progress value={progress} />
      </div>

      <Card>
        <CardContent className="p-6 space-y-6">
          {currentQuestion.fields
            .filter(field => !field.conditional || field.conditional(answers))
            .map((field) => (
            <div key={field.id} className="space-y-6">
              <Label htmlFor={field.id}>{field.label}</Label>
              {field.type === "select" ? (
                <Select value={answers[field.id] || ""} onValueChange={(value) => updateAnswer(field.id, value)}>
                  <SelectTrigger id={field.id} data-testid={`select-${field.id}`}>
                    <SelectValue placeholder="Select an option" />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options?.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === "textarea" ? (
                <Textarea
                  id={field.id}
                  placeholder={field.placeholder}
                  value={answers[field.id] || ""}
                  onChange={(e) => updateAnswer(field.id, e.target.value)}
                  rows={4}
                  data-testid={`input-${field.id}`}
                />
              ) : field.datalist ? (
                <Autocomplete
                  id={field.id}
                  value={answers[field.id] || ""}
                  onChange={(value) => updateAnswer(field.id, value)}
                  suggestions={field.datalist}
                  placeholder={field.placeholder}
                  type={field.type}
                  data-testid={`input-${field.id}`}
                />
              ) : (
                <Input
                  id={field.id}
                  type={field.type}
                  placeholder={field.placeholder}
                  value={answers[field.id] || ""}
                  onChange={(e) => updateAnswer(field.id, e.target.value)}
                  data-testid={`input-${field.id}`}
                />
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={handleBack} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <Button onClick={handleNext} disabled={isSaving} data-testid="button-next">
          {isSaving ? "Saving..." : (currentStep < visibleQuestions.length - 1 ? "Next" : "Continue to Documents")}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
