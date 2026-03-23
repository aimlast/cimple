import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Download, Eye } from "lucide-react";

export default function Templates() {
  const templates = [
    {
      id: "1",
      name: "Restaurant & Food Service",
      description: "Comprehensive template for restaurant businesses including menu analysis, location details, and customer demographics",
      industries: ["Restaurant", "Fast Casual", "Fine Dining"],
      sections: 12,
    },
    {
      id: "2",
      name: "Technology & Software",
      description: "Specialized template for tech companies with focus on IP, development process, and technical architecture",
      industries: ["SaaS", "Software", "IT Services"],
      sections: 15,
    },
    {
      id: "3",
      name: "Manufacturing",
      description: "Manufacturing-focused template covering production capacity, supply chain, and equipment details",
      industries: ["Manufacturing", "Production", "Industrial"],
      sections: 14,
    },
    {
      id: "4",
      name: "Professional Services",
      description: "Template for service-based businesses focusing on client relationships and recurring revenue",
      industries: ["Consulting", "Legal", "Accounting"],
      sections: 10,
    },
    {
      id: "5",
      name: "Retail & E-commerce",
      description: "Retail template with inventory management, sales channels, and customer acquisition focus",
      industries: ["Retail", "E-commerce", "Online Store"],
      sections: 13,
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Industry Templates</h1>
        <p className="text-sm text-muted-foreground mt-1">
          AI-powered templates tailored for different business types
        </p>
      </div>

      <div className="grid gap-4">
        {templates.map((template) => (
          <Card key={template.id} className="hover-elevate">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="flex gap-3 flex-1">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <FileText className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                      {template.description}
                    </p>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2 flex-wrap">
                {template.industries.map((industry) => (
                  <Badge key={industry} variant="secondary">
                    {industry}
                  </Badge>
                ))}
              </div>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <span className="text-sm text-muted-foreground">
                  {template.sections} sections
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" data-testid={`button-preview-${template.id}`}>
                    <Eye className="h-4 w-4 mr-2" />
                    Preview
                  </Button>
                  <Button variant="ghost" size="sm" data-testid={`button-download-${template.id}`}>
                    <Download className="h-4 w-4 mr-2" />
                    Export
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
