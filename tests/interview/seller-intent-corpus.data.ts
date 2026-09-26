// Seller-intent phrase corpus (QA round V). Used offline by
// tests/interview/seller-intent.test.ts (the instant patterns) and live by
// tests/interview/seller-intent-live.ts (the supporting-model classifier).
// Sources: the review probes (scratchpad harvest/skeptic-stop), the live
// runs (Clearwater, Ridgeline, Beacon, Great Lakes, Northbeam) and ordinary
// answers from the seeded demo transcripts that borrow stop vocabulary.

/** The seller wants the questions to stop now. */
export const STOP_FIRM: string[] = [
  "Please stop asking me questions.",
  "Stop.",
  "No more questions.",
  "No more questions for today please.",
  "Please stop with the questions, I've had enough.",
  "Enough questions — I'm done.",
  "I don't want to answer any more questions.",
  "I'm done answering questions today.",
  "Seriously, stop asking me things.",
];

/** The seller wants to wrap up or continue another time. */
export const STOP_SOFT: string[] = [
  "can we end it here",
  "let's end it here",
  "Can we end it now?",
  "I'd like to end it here",
  "I think that's enough for one day",
  "I'll stop here",
  "I'm going to stop here",
  "I'm going to stop now",
  "sorry have to run",
  "No more today please",
  "I'll finish this tomorrow",
  "I can't do any more today",
  "I'm exhausted, can we do this another time?",
  "Can we pick this up tomorrow?",
  "I have to run, let's continue later",
  "That's all for today",
  "Let's stop here for now.",
  "I really have to go.",
  "That's everything from me.",
  "Sorry — gotta run.",
  "I'm out of time.",
  "Can we wrap up?",
  "Can we wrap this up here? I have a pharmacy to run.",
  "I need to head out, sorry.",
  "Let's call it a day.",
  "Sorry, I have to go to a meeting.",
  "Gotta go pick up my daughter.",
  "I need to jump on another call.",
  "Ok that's it for me today.",
  "Let's leave it there for today.",
  "I'm going to have to cut this short.",
  "Can we do the rest another day?",
  "Talk soon.",
  "My brain is fried. Can we pick this up another day?",
  "My head's spinning — can I come back to this after the weekend?",
  "Could we do the rest on Monday?",
  "Honestly I'm wiped — can we continue Thursday?",
  "I have a patient in five minutes so I'll need to leave it there.",
];

/** Stops the instant patterns must catch (no waiting for the classifier). */
export const STOP_PATTERN_MUST: string[] = [...STOP_FIRM, ...STOP_SOFT.filter((s) => !/wiped|patient in five|fried/.test(s))];

/** Business answers that borrow stop vocabulary — never a stop. */
export const BUSINESS: string[] = [
  "Most residential installs take two days. If the unit arrives late we can finish the install next week, and the customer rarely minds. We run four crews and each has a lead tech.",
  "What I do know is that the lifetime value is strong, and a lot of them come back later or refer someone.",
  "I'm leaving the business once the transition is done, but I'll stay on clinically.",
  "The HVAC rebate alone is almost enough — that's enough to cover payroll for two months.",
  "In the summer we're done installing by 3pm most days.",
  "The landlord said they have to get back to us on the renewal terms.",
  "We keep a hard stop on credit at 60 days for every commercial account.",
  "Customers talk later about it on Google, which is where most reviews come from.",
  "Patients often continue later with maintenance visits once the acute phase is over.",
  "Can we continue with the lease next? I have the Hillhurst lease paperwork in front of me right now.",
  "Each visit, we end the session with a home exercise program and book the next one.",
  "The 401 bus used to stop here, so a lot of walk-ins came from the stop.",
  "We can take a break in January when it's slow.",
  "I have to go to the supplier every Monday to pick up stock, which takes most of the morning, and then I'm back in the shop by noon.",
  "Customers pick it up later in the week, usually Thursday.",
  "We usually wrap it up by 5 on Fridays.",
  "Our techs are done by 7pm most nights.",
  "We should stop taking walk-ins after 6, honestly.",
  "I need to leave the business in good shape for whoever takes over.",
  "Customers stop asking for discounts once they see the warranty.",
  "The bank had no more questions about the line of credit.",
  "Let's finish the install next week is what I told the customer.",
  "I'll talk to Rob tomorrow about the tooling list and get you the count.",
  "We stop at the bank on Fridays to drop the deposit.",
  "I'll finish the reconciliation tomorrow and upload it.",
  "We can continue the contract next year if they renew.",
  "No more today, we sold out by noon — that happens most Saturdays.",
  "The crew calls it a day around four in the winter.",
  "We end every job with a walkthrough and a signed completion form.",
  "The press line stops for maintenance every second Sunday.",
  "When a customer says stop, we pause the subscription, no fee.",
  "Drivers have to leave the yard by 5am to make the Toronto window.",
  "We had to cut the evening shift short last year when orders dropped.",
  "That's it for the equipment — everything else is leased.",
  "I'm done with the old POS system; we moved to Square in 2023.",
  "We're out of room in the warehouse, which is why we lease the second unit.",
  "The pharmacist on nights has to go home by 11 because of the union agreement.",
  "Our trucks come back later in the afternoon, usually after 3.",
  "Clients can pause their plan and pick it up again later.",
  "I told Dana she can take the rest of the week off after inventory.",
  "The previous owner wanted to stop the catering side, but I kept it.",
  "The collections agency will stop calling once the balance is settled.",
  "We don't do weekend work anymore, the guys wanted that.",
  "Honestly, I'd rather keep going with the same suppliers after the sale.",
  "Most patients finish their treatment plan in six to eight visits.",
  "I have to run the numbers with my accountant, but it's roughly $2.1M.",
  "The seasonal crew is done for the year by mid-November.",
  "That's enough about the trucks — they're all in the fleet list.",
  "We wind down the landscaping side in November and switch to snow.",
  "I have to be honest, the margins dropped when the resin price spiked.",
];

/** Ordinary answers with no intent at all. */
export const NEUTRAL: string[] = [
  "About 2.1 million last year, and we're tracking a bit ahead this year.",
  "Mostly word of mouth and the two family-practice groups nearby.",
  "Leah just got the raise in October after Bowmont tried to poach her.",
  "The lease runs to 2031 with a five-year renewal option.",
  "We have 14 full-time and 6 part-time.",
  "Rob keeps the tooling list, he can send it over.",
  "Not sure — my accountant would know.",
  "Yes, the corporation holds the lease.",
  "The top three customers are about 41% of sales.",
  "We opened the second location in 2021.",
];

export interface CorrectionCase {
  message: string;
  facts: Array<{ key: string; value: string }>;
  fieldHint: string;
  newValue: RegExp;
}
/** The seller replaces a value — the new value must stand. */
export const CORRECTIONS: CorrectionCase[] = [
  { message: "Scratch that — the lease is 12 years, not 10.", facts: [{ key: "leaseTerm", value: "10-year lease from 2021" }], fieldHint: "leaseTerm", newValue: /12/ },
  { message: "Sorry, I misspoke, we have 14 employees not 12.", facts: [{ key: "employeeCount", value: "12 full-time employees" }], fieldHint: "employeeCount", newValue: /14/ },
  { message: "Ignore what I said, revenue was 2.4M last year.", facts: [{ key: "annualRevenue", value: "$2.1M (FY2025)" }], fieldHint: "annualRevenue", newValue: /2\.4/ },
  { message: "I take that back — it's closer to 40.", facts: [{ key: "activeAccounts", value: "about 30 active commercial accounts" }], fieldHint: "activeAccounts", newValue: /40/ },
  { message: "No no, sorry — I misspoke. You're right, it's 9 trucks, the document is correct.", facts: [{ key: "partTimeCount", value: "13 seasonal (Apr-Nov) plus 6 on-call" }], fieldHint: "", newValue: /9/ },
  { message: "Wait, I misspoke — we don't run 40 trucks. We have two box trucks that do local milk-runs; they're leased and the drivers are on our payroll.", facts: [{ key: "deliveryOperation", value: "Company runs about 40 trucks for deliveries" }], fieldHint: "deliveryOperation", newValue: /two box trucks|2 box trucks/i },
  { message: "Make that $4,800 a month, not $4,500 — the rent went up in January.", facts: [{ key: "monthlyRent", value: "$4,500/month" }], fieldHint: "monthlyRent", newValue: /4,?800/ },
  { message: "Actually it's Priya, not Leah, who runs the pelvic health program.", facts: [{ key: "keyEmployees", value: "Leah runs the pelvic health program" }], fieldHint: "keyEmployees", newValue: /Priya/ },
];

export interface RetractionCase {
  message: string;
  facts: Array<{ key: string; value: string }>;
  fieldHint: string;
  /** Text that must survive when only part of the fact is withdrawn. */
  keeps?: RegExp;
}
/** The seller withdraws something, with no replacement. */
export const RETRACTIONS: RetractionCase[] = [
  {
    message: "Let me take those mold numbers back — I was guessing, and I don't want a guess ending up in the book. Rob keeps the tooling list; he can send it over.",
    facts: [{ key: "toolingOwnership", value: "15–18 molds owned outright; 240–250 customer-owned molds stored; racking for ~300" }],
    fieldHint: "toolingOwnership",
  },
  {
    message: "sorry, ignore what I said about 40 trucks, I was guessing — I don't know the count",
    facts: [{ key: "outboundLogistics", value: "Contract hauler Buckeye Freight handles dedicated outbound lanes (~40 trucks/year). Approximately 40 customer trucks per week come through dock for JIT pulls." }],
    fieldHint: "outboundLogistics",
    keeps: /Buckeye Freight/,
  },
  { message: "Honestly that was just a guess on the warranty claims — Denise has the real sheet.", facts: [{ key: "warrantyClaims", value: "About 2% of installs have a warranty claim" }], fieldHint: "warrantyClaims" },
  { message: "Forget what I said about the margins, I don't actually know them. My accountant does.", facts: [{ key: "grossMargin", value: "roughly 38% gross margin" }], fieldHint: "grossMargin" },
  { message: "I shouldn't have said that about the backlog, I'm not sure of the number. Ask Devin.", facts: [{ key: "backlog", value: "about $3M in signed backlog" }], fieldHint: "backlog" },
];

export interface PrivacyCase {
  message: string;
  facts: Array<{ key: string; value: string }>;
  /** A word that must not reach the facts. */
  sensitive: RegExp;
}
/** The seller asks that something stay out of the book. */
export const PRIVACY: PrivacyCase[] = [
  { message: "Honestly the real reason is my wife's cancer diagnosis, but keep that out of the book.", facts: [{ key: "reasonForSale", value: "Retirement after 30 years" }], sensitive: /cancer|diagnos/i },
  { message: "I had a heart attack in March. Leave that out please.", facts: [], sensitive: /heart attack/i },
  { message: "We're going through a divorce and that's part of why. Don't put that in the document.", facts: [{ key: "reasonForSale", value: "Retirement" }], sensitive: /divorce/i },
  { message: "There's a wrongful dismissal claim from a former tech, but that's between us for now.", facts: [], sensitive: /wrongful dismissal|dismissal/i },
  { message: "My son has an addiction problem and I need to be closer to home — off the record.", facts: [], sensitive: /addiction/i },
  { message: "Keep this private: I'm negotiating with a competitor on the side.", facts: [], sensitive: /competitor/i },
];

/** Context cases: the interviewer's previous message changes the reading. */
export const CONTEXT: Array<{ prevAi: string; message: string; stop: boolean }> = [
  { prevAi: "Before we wrap up, is there anything else you'd like to add?", message: "That covers it.", stop: true },
  { prevAi: "Before we wrap up, is there anything else you'd like to add?", message: "Nope, that's everything.", stop: true },
  { prevAi: "Anything else about the lease I should know?", message: "Nothing else on the lease, the landlord handles maintenance.", stop: false },
  { prevAi: "Is there anything else about your customers buyers should know?", message: "No, that's about it for customers.", stop: false },
];
