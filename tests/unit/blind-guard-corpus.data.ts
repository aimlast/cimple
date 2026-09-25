/**
 * The Blind-CIM guard's regression corpus (shared/blind-guard.ts): realistic
 * deal facts across industries, what must always be caught in each, and what
 * must never become an identifier. Used by blind-guard-corpus.test.ts and
 * by term-diff scripts comparing guard versions.
 */
export type Deal = { businessName: string; blindCodename?: string; extractedInfo: Record<string, unknown> };

export const staffDeal: Deal = {
  businessName: "Grand River Plumbing & Heating Ltd.",
  extractedInfo: {
    employees: "Staff: Carlos Reyes (12), Ana Torres (4), Sam Kim (2)",
    hygienistDetails: "Hygienists: Priya (7), Thomas (3), Marcus (4)",
    officeManager: "Office Manager: Amy Evans (12)",
    keyEmployees: "Chris Jones: 6 yrs; Ana Torres: 4\nMaria Teller (bookkeeper)\nCarlos (12)",
    teamRoles:
      "Patient Care Coordinator, Lawn Care Technician, Body Shop Manager, Social Media Manager, Fleet Maintenance Supervisor, " +
      "Accounts Payable Specialist, Business Development Manager, Quality Control Manager, Human Resources Coordinator, " +
      "Customer Success Lead, Night Shift Supervisor",
    staffNotes: "Emma Winter (dispatcher, 5 years), Jack Frost (installer), Tom Barber, Ann Painter (office)",
    city: "KITCHENER",
  },
};

export interface CorpusDeal extends Deal {
  /** Must be caught in a blind text. */
  mustCatch: string[];
  /** Must never be a term (roles, everyday phrases). */
  neverTerms?: string[];
}


export const corpus: CorpusDeal[] = [
  {
    businessName: "QA CIMGEN — Harbourline Dental",
    blindCodename: "Project Atlas",
    extractedInfo: {
      companyName: "Harbourline Dental Group",
      ownerName: "Dr. Patel",
      keyEmployees: "Dr. Anita Patel (principal dentist), Dr. Marcus Lee (associate dentist, 6 years), Sandra (office manager, since 2013)\nDr. A. Patel",
      officeManager: "Maria, 9 years tenure, runs day-to-day operations",
      hygienistDetails: "Two hygienists: Priya (7 years tenure), Sam (2 years tenure). Neither has indicated plans to leave.",
      staffBreakdown: "Registered Dental Hygienists: 2, Certified Dental Assistants: 3, Office Manager, Patient Care Coordinator",
      accountantContact: "Jennifer Walsh at Walsh & Associates CPA in Waterloo",
      leaseAddress: "Unit 4, 210 Fairway Road South, Kitchener, Ontario N2C 1X1",
      locations: "Kitchener, ON\nPlaza on Fairway Road",
      contactPhone: "519-555-0142",
      contactEmail: "anita@harbourlinedental.ca",
      website: "https://www.harbourlinedental.ca",
    },
    mustCatch: [
      "Harbourline Dental Group", "Harbourline's patients", "HARBOURLINE", "Dr. Anita Patel", "PATEL", "Marcus Lee", "Sandra", "Maria", "Priya", "Sam",
      "Jennifer Walsh", "Kitchener", "Fairway Rd", "N2C 1X1", "(519) 555-0142", "5195550142", "anita@harbourlinedental.ca",
      "harbourlinedental.ca",
    ],
    neverTerms: ["Patient Care", "Care", "Coordinator", "Dental Hygienists", "Hygienists", "Ontario", "Waterloo"],
  },
  {
    businessName: "Frostline HVAC Services Inc.",
    extractedInfo: {
      ownerName: "Gord Frost",
      managementTeam: [
        { name: "Gord Frost", title: "Owner / President" },
        { name: "Linda Frost", title: "Accounts Payable Specialist" },
        { name: "Dev Patel", title: "Service Manager" },
      ],
      employees: "Licensed Refrigeration Mechanics: 6\nApprentices (3)\nNight Shift Supervisor\nDispatch: Kayla Winter",
      businessAddress: "88 Speedvale Ave W, Guelph, ON N1H 1K2",
      seasonality: "Busiest in winter (furnace) and summer (AC); spring and fall are shoulder seasons.",
      successorPlan: "Rick Olsen (Service Manager) could step up; Training Program ongoing",
      familyInvolvement: "Wife Karen does the books; son Tyler (22) works summers",
      teamMembers: [{ name: "Office Manager", role: "vacant" }, { name: "Doug", role: "Lead Hand" }, { name: "TBD" }],
      website: "frostlinehvac.ca",
      socialMedia: "facebook.com/frostlinehvac, Instagram @frostline_hvac",
    },
    mustCatch: [
      "Frostline", "FROSTLINE HVAC", "Gord Frost", "Linda Frost", "Mr. Frost", "Dev Patel", "Kayla Winter", "Guelph", "Speedvale",
      "N1H 1K2", "Rick Olsen", "Karen", "Tyler", "Doug", "www.frostlinehvac.ca", "@frostline_hvac",
    ],
    neverTerms: ["Frost", "Winter", "Accounts Payable", "Payable", "Night Shift", "Shift", "Mechanics", "Apprentices", "Office Manager", "TBD", "Training Program"],
  },
  {
    businessName: "Nonna Lucia's Trattoria",
    extractedInfo: {
      ownerName: "Lucia Romano",
      keyEmployees: [
        "Head Chef: Giuseppe Bianchi (14 yrs)",
        "Sous Chef - Maria de la Cruz",
        "Front of House Manager: Chloé Tremblay",
        "Line Cooks (4), Dishwashers (2), Servers (9)",
      ],
      city: "Oakville",
      liquorLicence: "Full liquor licence, AGCO, patio endorsement",
      kitchenStaff: { "Pasta Station": 2, "Pizza Oven": 1, "Grill": 2 },
    },
    mustCatch: ["Nonna Lucia", "Lucia Romano", "Romano", "Giuseppe Bianchi", "Bianchi", "Maria de la Cruz", "Chloé Tremblay", "CHLOE TREMBLAY", "Oakville"],
    neverTerms: ["Line Cooks", "Dishwashers", "Servers", "Pasta Station", "Pizza Oven", "Grill", "Front", "House"],
  },
  {
    businessName: "Evergreen Lawn & Landscape Ltd",
    extractedInfo: {
      owners: "Brian and Kelly O'Neill (50/50)",
      employees: "Lawn Care Technicians (8 seasonal), Landscape Foreman, Snow Removal Crew (6), Office Admin: Tanya",
      staff: { "Mike Kowalczyk": "Crew lead, 9 years", "Irrigation Specialist": "1 FT" },
      city: "barrie",
      equipment: "3 Kubota zero-turns, 2 F-550 dump trucks",
    },
    mustCatch: ["Brian", "O'Neill", "Kelly O'Neill", "Tanya", "Mike Kowalczyk", "Kowalczyk", "BARRIE", "Barrie"],
    neverTerms: ["Lawn Care", "Care", "Technicians", "Snow Removal", "Removal", "Crew", "Irrigation", "Specialist"],
  },
  {
    businessName: "Maple Ridge Bakery",
    extractedInfo: {
      ownerName: "Bill Hartley",
      keyEmployees: "Baker: Rosa (since 2016); Cake Decorator (2); Counter Staff (5)",
      address: "1204 Queen Street East, Toronto, ON M4M 1K8",
      socialMedia: "Instagram @mapleridgebakes (4.1k followers); facebook.com/mapleridgebakery",
    },
    mustCatch: ["Maple Ridge Bakery", "Bill Hartley", "Hartley", "Rosa", "1204 Queen Street East", "M4M 1K8", "mapleridgebakes", "mapleridgebakery"],
    neverTerms: ["Baker", "Cake Decorator", "Counter Staff", "Bill"],
  },
  {
    businessName: "Precision Collision & Auto Body",
    extractedInfo: {
      ownerName: "Raj Sandhu",
      employees: "Body Shop Manager: Harpreet Gill; Painters (3); Estimator; Detailers x2; Parts Clerk",
      keyEmployees: "Quality Control Manager (vacant)\nSenior Painter Jose Alvarez — 15 years",
      teamStructure: "Owner-operated. General Manager Handles Insurance Relations, Oversees Scheduling, Parts Ordering",
      city: "Surrey",
      contactPhone: "+1 (604) 555-0199",
    },
    mustCatch: ["Raj Sandhu", "Sandhu", "Harpreet Gill", "Gill", "Jose Alvarez", "Alvarez", "Surrey", "604-555-0199", "6045550199"],
    neverTerms: ["Body Shop", "Shop", "Quality Control", "Control", "Painters", "Detailers", "Parts Clerk", "Scheduling", "Oversees Scheduling", "Insurance Relations", "Parts Ordering", "Ordering"],
  },
  {
    businessName: "Little Sprouts Early Learning Centre",
    extractedInfo: {
      ownerName: "Grace Park",
      staffBreakdown: "Registered Early Childhood Educators (RECE): 9; Early Childhood Assistants: 4; Cook: 1; Summer Students (3)",
      keyEmployees: "Supervisor - Joy Mensah (11 years); Assistant Supervisor: Olumide Adebayo",
      location: "Normal, Illinois",
    },
    mustCatch: ["Grace Park", "Joy Mensah", "Mensah", "Olumide Adebayo", "Adebayo", "Normal, Illinois", "in Normal"],
    neverTerms: ["Early Childhood", "Childhood", "Summer Students", "Summer", "Grace", "Joy", "Park", "Cook"],
  },
  {
    businessName: "Northbound Freight Logistics",
    extractedInfo: {
      ownerName: "Wendell Pryce",
      keyEmployees: "Dispatch Lead — Sunita Rao; Fleet Maintenance Supervisor (Darnell Ruiz); Drivers: 22 AZ, 4 DZ",
      employees: "Human Resources Coordinator (part-time), Customer Success Lead",
      headOffice: "Unit 12, 400 Industrial Pkwy, Olds, AB T4H 1P2",
    },
    mustCatch: ["Northbound", "Wendell Pryce", "Pryce", "Sunita Rao", "Darnell Ruiz", "Ruiz", "Olds", "T4H 1P2"],
    neverTerms: ["Fleet Maintenance", "Maintenance", "Human Resources", "Resources", "Customer Success", "Success", "Drivers"],
  },
  {
    businessName: "Salon Luxe",
    extractedInfo: {
      ownerName: "Valentina Moreau",
      staff: "Stylists (7), Colourists (2), Esthetician, Receptionist: Bree",
      keyEmployees: "Social Media Manager (contract) — Jade",
      city: "Reading",
    },
    mustCatch: ["Valentina Moreau", "Moreau", "Jade", "Bree", "Reading, PA"],
    neverTerms: ["Social Media", "Media", "Stylists", "Colourists", "Esthetician"],
  },
  {
    businessName: "Cedar Valley Veterinary Hospital",
    extractedInfo: {
      owners: [{ name: "Dr. Helen Frost", share: "60%" }, { name: "Dr. Omar Haddad", share: "40%" }],
      keyEmployees: "Practice Manager: Lisa Teller; RVTs (5); Kennel Attendants (3); Client Care Coordinator",
      address: "15 Mill Lane, Mobile, AL 36602",
    },
    mustCatch: ["Helen Frost", "Dr. Frost", "Omar Haddad", "Haddad", "Lisa Teller", "Ms. Teller", "Mobile, AL"],
    neverTerms: ["Frost", "Teller", "Client Care", "Care", "Kennel Attendants", "Mill"],
  },
];

// Blind copy a redactor would write: roles, seasons, industry words, province.
export const CLEAN_BLIND_COPY = [
  "Project Keystone is a well-established business in a mid-sized city in Ontario, Canada.",
  "The Patient Care Coordinator and Client Care Coordinator keep patient care consistent.",
  "Revenue dips in winter; frost dates drive the spring rush and summer is the busiest season.",
  "A normal schedule runs Monday to Friday; mobile service calls are booked by the Office Manager.",
  "Quality control, accounts payable, human resources and business development are handled in-house.",
  "The team includes Licensed Plumbers, Line Cooks, Stylists, Registered Early Childhood Educators and Summer Students.",
  "The Body Shop Manager, Fleet Maintenance Supervisor, Night Shift Supervisor and Customer Success Lead report to the Owner.",
  "Grace period on receivables is 30 days; the lawn care crew, the barber shop tenant and the bakery counter staff are seasonal.",
  "Every repair meets precision standards.",
  "Park access, reading programs and a joy to work with — the landlord is flexible. A barber, a painter and a teller work nearby.",
];
