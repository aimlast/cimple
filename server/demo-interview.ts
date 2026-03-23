interface DemoQuestion {
  id: string;
  fields: string[];
  response: string;
  extractInfo: (userMessage: string) => Record<string, string | undefined>;
}

const demoQuestions: DemoQuestion[] = [
  {
    id: "products-services",
    fields: ["keyProducts"],
    response: "Got it. Now list ALL of your day-to-day responsibilities in the business — everything you personally handle.",
    extractInfo: (msg) => {
      return { keyProducts: msg.substring(0, 300) };
    },
  },

  {
    id: "owner-role",
    fields: ["ownerInvolvement"],
    response: "Thanks. How many employees do you have? Break it down by full-time, part-time, and contractors.",
    extractInfo: (msg) => {
      return { ownerInvolvement: msg.substring(0, 300) };
    },
  },

  {
    id: "employee-count",
    fields: ["employees"],
    response: "Noted. What does each key employee do? List their roles and main responsibilities.",
    extractInfo: (msg) => {
      const empMatch = msg.match(/(\d+)\s*(?:employee|people|staff|team|person|worker|full|part|total)/i);
      if (empMatch) return { employees: empMatch[1] };
      const numMatch = msg.match(/(\d+)/);
      if (numMatch) return { employees: numMatch[1] };
      return { employees: msg.substring(0, 80) };
    },
  },

  {
    id: "employee-roles",
    fields: ["employeeStructure"],
    response: "Perfect. Describe your typical customer — age range, location, are they consumers or businesses, and how do they usually find you?",
    extractInfo: (msg) => {
      return { employeeStructure: msg.substring(0, 300), keyEmployees: msg.substring(0, 200) };
    },
  },

  {
    id: "customer-profile",
    fields: ["targetMarket"],
    response: "Got it. What percentage of revenue comes from repeat customers vs. new ones? Is any single customer more than 10% of your revenue?",
    extractInfo: (msg) => {
      return { targetMarket: msg.substring(0, 200), customerDemographics: msg.substring(0, 200) };
    },
  },

  {
    id: "customer-concentration",
    fields: ["customerConcentration"],
    response: "Thanks. What specifically do you offer that your direct competitors don't? I need concrete differentiators, not just 'better service.'",
    extractInfo: (msg) => {
      return { customerConcentration: msg.substring(0, 200), customerBase: msg.substring(0, 150) };
    },
  },

  {
    id: "differentiators",
    fields: ["competitiveAdvantage"],
    response: "That's useful. List your main suppliers or vendors — who are they, how long have you worked with each, and are there backup options?",
    extractInfo: (msg) => {
      return { competitiveAdvantage: msg.substring(0, 250), uniqueSellingProposition: msg.substring(0, 200) };
    },
  },

  {
    id: "suppliers",
    fields: ["suppliers"],
    response: "Noted. Do you lease or own your space? If leasing, what's the monthly rent and when does the lease expire?",
    extractInfo: (msg) => {
      return { suppliers: msg.substring(0, 250), supplyChain: msg.substring(0, 150) };
    },
  },

  {
    id: "lease-property",
    fields: ["leaseDetails"],
    response: "Got it. List the major equipment and physical assets that would be included in the sale.",
    extractInfo: (msg) => {
      return { leaseDetails: msg.substring(0, 200), propertyInfo: msg.substring(0, 150) };
    },
  },

  {
    id: "equipment-assets",
    fields: ["assets"],
    response: "Thanks. What software, systems, or technology does the business run on? POS, CRM, accounting software, booking systems, etc.",
    extractInfo: (msg) => {
      return { assets: msg.substring(0, 250), assetsIncluded: msg.substring(0, 200) };
    },
  },

  {
    id: "technology",
    fields: ["technologySystems"],
    response: "Noted. List all licenses, permits, and certifications required to operate the business.",
    extractInfo: (msg) => {
      return { technologySystems: msg.substring(0, 200) };
    },
  },

  {
    id: "licenses",
    fields: ["permitsLicenses"],
    response: "Got it. Does the business have busy and slow periods? Which months are your peak season and which are slowest?",
    extractInfo: (msg) => {
      return { permitsLicenses: msg.substring(0, 200), complianceRequirements: msg.substring(0, 150) };
    },
  },

  {
    id: "seasonality",
    fields: ["seasonality"],
    response: "Thanks. What are the top 2-3 specific things a new owner could do to grow revenue?",
    extractInfo: (msg) => {
      return { seasonality: msg.substring(0, 200), peakPeriods: msg.substring(0, 100) };
    },
  },

  {
    id: "growth",
    fields: ["growthOpportunities"],
    response: "Those are solid opportunities. Last question — why are you selling the business?",
    extractInfo: (msg) => {
      return { growthOpportunities: msg.substring(0, 250), expansionPlans: msg.substring(0, 150) };
    },
  },

  {
    id: "reason-for-sale",
    fields: ["reasonForSale"],
    response: "Thanks for sharing that. I've got everything I need — you've given me a really complete picture of the business.\n\nYour broker will use all of this to put together a professional document for buyers. You're all set!",
    extractInfo: (msg) => {
      return { reasonForSale: msg.substring(0, 200) };
    },
  },
];

export function getDemoResponse(messages: any[], extractedInfo: any) {
  const lastUserMessage = messages[messages.length - 1]?.content || "";

  console.log("[Demo] Processing message:", lastUserMessage.substring(0, 80));
  console.log("[Demo] Current extracted info keys:", Object.keys(extractedInfo));

  for (const question of demoQuestions) {
    const alreadyCaptured = question.fields.every(field => extractedInfo[field]);
    if (alreadyCaptured) {
      continue;
    }

    console.log("[Demo] Next question to fill:", question.id);

    const extracted = question.extractInfo(lastUserMessage);
    const cleanExtracted: Record<string, string> = {};
    Object.entries(extracted).forEach(([key, value]) => {
      if (value !== undefined) {
        cleanExtracted[key] = value;
      }
    });

    console.log("[Demo] Extracted fields:", Object.keys(cleanExtracted));

    const isLastQuestion = question.id === "reason-for-sale";

    return {
      message: question.response,
      extractedInfo: { ...extractedInfo, ...cleanExtracted },
      ...(isLastQuestion ? { shouldFinish: true } : {}),
    };
  }

  console.log("[Demo] All questions answered");
  return {
    message: "Thanks — I've collected all the information I need. Your broker will take it from here!",
    extractedInfo: extractedInfo,
    shouldFinish: true,
  };
}
