/**
 * Addback Verification Engine
 *
 * AI-powered system that matches addbacks to actual transactions in GL,
 * QuickBooks exports, or bank statements. Provides transaction-level
 * corroboration for every addback in the normalization schedule.
 *
 * Two workflows:
 *  A) Addbacks already provided — verify against uploaded transaction data
 *  B) Addbacks identified from scratch — discover addbacks from raw transactions
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ timeout: 600_000 });

// ── Types ──

export interface ParsedTransaction {
  date: string;
  description: string;
  amount: number;
  account: string;
  category: string;
  source: "gl" | "bank" | "quickbooks";
  rawLine: string;
}

export interface MatchedTransaction {
  date: string;
  description: string;
  amount: number;
  account: string;
  source: "gl" | "bank" | "quickbooks";
  documentId: string;
  confidence: number; // 0–1
}

export interface MatchResult {
  addbackId: string;
  verificationStatus: "matched" | "no_match" | "partial_match";
  matchedTransactions: MatchedTransaction[];
  totalMatchedAmount: number;
  aiNotes: string;
}

export interface IdentifiedAddback {
  id: string;
  label: string;
  description: string;
  category: "owner_comp" | "discretionary" | "one_time" | "non_recurring" | "non_cash" | "related_party" | "other";
  annualAmount: number;
  yearAmounts: Record<string, number>;
  matchedTransactions: MatchedTransaction[];
  aiNotes: string;
}

export interface SellerQuestion {
  id: string;
  question: string;
  context: string;
  relatedAddbackId: string | null;
  relatedTransactions: Array<{ date: string; description: string; amount: number }>;
  answer: string | null;
  status: "pending" | "answered" | "skipped";
}

// ── 1. Parse transaction data ──

export async function parseTransactionData(
  text: string,
  sourceType: "gl" | "bank" | "quickbooks",
  documentId: string,
): Promise<ParsedTransaction[]> {
  // Truncate very large texts to stay within context limits
  const truncated = text.length > 80000 ? text.slice(0, 80000) + "\n[TRUNCATED]" : text;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: `You are a financial data extraction specialist. Parse the provided ${sourceType === "gl" ? "General Ledger export" : sourceType === "bank" ? "bank statement" : "QuickBooks report"} into structured transaction data.

Extract every transaction with:
- date: ISO date string (YYYY-MM-DD)
- description: the transaction description/memo
- amount: the dollar amount (positive for debits/expenses, negative for credits/income)
- account: the GL account name or category
- category: best-fit category (payroll, rent, utilities, insurance, professional_fees, owner_draw, travel, meals, vehicle, supplies, depreciation, interest, taxes, revenue, other)
- rawLine: the original line from the source

Return ONLY a valid JSON array. No markdown, no explanation. If you cannot parse the data, return an empty array [].`,
    messages: [
      {
        role: "user",
        content: `Parse these transactions:\n\n${truncated}`,
      },
    ],
  });

  const content = (response.content[0] as { type: string; text: string }).text;

  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t: any) => ({
      date: t.date || "",
      description: t.description || "",
      amount: Number(t.amount) || 0,
      account: t.account || "",
      category: t.category || "other",
      source: sourceType,
      rawLine: t.rawLine || "",
    }));
  } catch {
    console.error("Failed to parse transaction data from AI response");
    return [];
  }
}

// ── 2. Match addbacks to transactions ──

export async function matchAddbacksToTransactions(
  addbacks: Array<{
    id: string;
    label: string;
    description: string;
    category: string;
    annualAmount: number;
    yearAmounts: Record<string, number>;
  }>,
  transactions: ParsedTransaction[],
  industry: string,
  documentId: string,
): Promise<MatchResult[]> {
  if (addbacks.length === 0 || transactions.length === 0) {
    return addbacks.map((a) => ({
      addbackId: a.id,
      verificationStatus: "no_match" as const,
      matchedTransactions: [],
      totalMatchedAmount: 0,
      aiNotes: "No transaction data available for matching.",
    }));
  }

  // Build a concise transaction summary (limit to prevent token overflow)
  const txSummary = transactions
    .slice(0, 2000)
    .map((t, i) => `[${i}] ${t.date} | ${t.description} | $${t.amount.toFixed(2)} | ${t.account} | ${t.source}`)
    .join("\n");

  const addbackSummary = addbacks
    .map((a) => {
      const yearStr = Object.entries(a.yearAmounts || {})
        .map(([y, amt]) => `${y}: $${amt.toFixed(2)}`)
        .join(", ");
      return `- ID: ${a.id} | "${a.label}" (${a.category}) | Annual: $${a.annualAmount.toFixed(2)} | ${yearStr}\n  Description: ${a.description}`;
    })
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: `You are an M&A financial analyst specializing in SDE/EBITDA normalization for ${industry} businesses. Your job is to match claimed addbacks to actual transactions in the financial records.

Rules for matching:
- An addback for "Owner salary" should match transactions like "Salary - J. Smith", "Owner Draw", "Management Compensation", etc.
- Fuzzy matching is essential — addback labels rarely match transaction descriptions exactly
- Group related transactions (e.g., monthly salary payments should be summed to match annual addback)
- A match is "matched" if total matched transactions are within 15% of the claimed addback amount
- A match is "partial_match" if some supporting transactions exist but amounts differ significantly
- A match is "no_match" if no plausible transactions can be found
- Assign confidence 0.0–1.0 per matched transaction

Return ONLY a valid JSON array of results, one per addback. Each result:
{
  "addbackId": "...",
  "verificationStatus": "matched" | "partial_match" | "no_match",
  "matchedTransactionIndices": [array of transaction indices from the list],
  "totalMatchedAmount": number,
  "aiNotes": "explanation of the match logic"
}`,
    messages: [
      {
        role: "user",
        content: `ADDBACKS TO VERIFY:\n${addbackSummary}\n\nTRANSACTION DATA:\n${txSummary}`,
      },
    ],
  });

  const content = (response.content[0] as { type: string; text: string }).text;

  try {
    const results = JSON.parse(content);
    if (!Array.isArray(results)) return [];

    return results.map((r: any) => ({
      addbackId: r.addbackId,
      verificationStatus: r.verificationStatus || "no_match",
      matchedTransactions: (r.matchedTransactionIndices || [])
        .filter((idx: number) => idx >= 0 && idx < transactions.length)
        .map((idx: number) => {
          const t = transactions[idx];
          return {
            date: t.date,
            description: t.description,
            amount: t.amount,
            account: t.account,
            source: t.source,
            documentId,
            confidence: r.confidence ?? 0.7,
          };
        }),
      totalMatchedAmount: r.totalMatchedAmount || 0,
      aiNotes: r.aiNotes || "",
    }));
  } catch {
    console.error("Failed to parse match results from AI response");
    return addbacks.map((a) => ({
      addbackId: a.id,
      verificationStatus: "no_match" as const,
      matchedTransactions: [],
      totalMatchedAmount: 0,
      aiNotes: "AI matching failed — manual review required.",
    }));
  }
}

// ── 3. Identify addbacks from scratch (Workflow B) ──

export async function identifyAddbacksFromTransactions(
  transactions: ParsedTransaction[],
  industry: string,
  dealContext: {
    businessName: string;
    askingPrice?: string;
    ownerNames?: string[];
  },
): Promise<IdentifiedAddback[]> {
  if (transactions.length === 0) return [];

  const txSummary = transactions
    .slice(0, 2000)
    .map((t, i) => `[${i}] ${t.date} | ${t.description} | $${t.amount.toFixed(2)} | ${t.account} | ${t.category} | ${t.source}`)
    .join("\n");

  const ownerContext = dealContext.ownerNames?.length
    ? `Known owner names: ${dealContext.ownerNames.join(", ")}`
    : "Owner names not confirmed — look for patterns suggesting owner compensation.";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: `You are an M&A financial analyst performing SDE/EBITDA normalization for a ${industry} business called "${dealContext.businessName}".

Analyze the transaction data and identify potential addbacks. Look for:
1. Owner compensation — salary, draws, bonuses, benefits paid to owners
2. Related-party transactions — payments to family members, owner-controlled entities
3. One-time expenses — lawsuit settlements, relocation costs, unusual write-offs
4. Non-recurring items — startup costs, one-time marketing campaigns, special projects
5. Discretionary spending — excessive travel, entertainment, vehicles, personal expenses run through the business
6. Non-cash charges — depreciation, amortization beyond standard
7. Above-market rent to related parties

${ownerContext}

Group related transactions (e.g., 12 monthly salary payments = one addback).
Calculate annual amounts by summing the relevant transactions.

Return ONLY a valid JSON array. Each item:
{
  "id": "ab_1" (sequential),
  "label": "descriptive name",
  "description": "explanation of why this is an addback",
  "category": "owner_comp" | "discretionary" | "one_time" | "non_recurring" | "non_cash" | "related_party" | "other",
  "annualAmount": number,
  "yearAmounts": { "2023": number, "2024": number },
  "matchedTransactionIndices": [indices],
  "aiNotes": "reasoning"
}`,
    messages: [
      {
        role: "user",
        content: `Identify addbacks from these transactions:\n\n${txSummary}`,
      },
    ],
  });

  const content = (response.content[0] as { type: string; text: string }).text;

  try {
    const results = JSON.parse(content);
    if (!Array.isArray(results)) return [];

    return results.map((r: any) => ({
      id: r.id || `ab_${Math.random().toString(36).slice(2, 8)}`,
      label: r.label || "Unknown addback",
      description: r.description || "",
      category: r.category || "other",
      annualAmount: Number(r.annualAmount) || 0,
      yearAmounts: r.yearAmounts || {},
      matchedTransactions: (r.matchedTransactionIndices || [])
        .filter((idx: number) => idx >= 0 && idx < transactions.length)
        .map((idx: number) => {
          const t = transactions[idx];
          return {
            date: t.date,
            description: t.description,
            amount: t.amount,
            account: t.account,
            source: t.source,
            documentId: "",
            confidence: 0.8,
          };
        }),
      aiNotes: r.aiNotes || "",
    }));
  } catch {
    console.error("Failed to parse identified addbacks from AI response");
    return [];
  }
}

// ── 4. Generate seller questions ──

export async function generateSellerQuestions(
  addbacks: Array<{
    id: string;
    label: string;
    description: string;
    category: string;
    annualAmount: number;
    verificationStatus?: string;
    matchedTransactions?: MatchedTransaction[];
    aiNotes?: string;
  }>,
  transactions: ParsedTransaction[],
  gaps: string[],
): Promise<SellerQuestion[]> {
  const unmatchedAddbacks = addbacks.filter(
    (a) => a.verificationStatus === "no_match" || a.verificationStatus === "partial_match",
  );

  if (unmatchedAddbacks.length === 0 && gaps.length === 0) return [];

  const addbackContext = unmatchedAddbacks
    .map((a) => {
      const txStr = (a.matchedTransactions || [])
        .slice(0, 5)
        .map((t) => `  ${t.date} | ${t.description} | $${t.amount}`)
        .join("\n");
      return `- "${a.label}" ($${a.annualAmount}) [${a.verificationStatus}]\n  AI notes: ${a.aiNotes || "none"}\n  Closest matches:\n${txStr || "  (none found)"}`;
    })
    .join("\n\n");

  const ambiguousTx = transactions
    .filter((t) => {
      const desc = t.description.toLowerCase();
      return (
        desc.includes("owner") ||
        desc.includes("personal") ||
        desc.includes("related") ||
        desc.includes("consulting") ||
        desc.includes("management fee") ||
        t.category === "other"
      );
    })
    .slice(0, 20)
    .map((t) => `${t.date} | ${t.description} | $${t.amount} | ${t.account}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    system: `You are a financial analyst asking a business seller targeted questions to verify addbacks for an SDE/EBITDA normalization. Ask clear, specific questions — not generic ones. Reference actual transaction amounts and descriptions from their records so they know exactly what you are asking about.

Return ONLY a valid JSON array. Each item:
{
  "id": "q_1",
  "question": "the question to ask the seller",
  "context": "why you are asking (internal note, not shown to seller)",
  "relatedAddbackId": "addback ID or null",
  "relatedTransactions": [{ "date": "...", "description": "...", "amount": number }],
  "answer": null,
  "status": "pending"
}`,
    messages: [
      {
        role: "user",
        content: `Generate verification questions for the seller.

UNVERIFIED ADDBACKS:
${addbackContext || "(none)"}

AMBIGUOUS TRANSACTIONS:
${ambiguousTx || "(none)"}

ADDITIONAL GAPS:
${gaps.length > 0 ? gaps.join("\n") : "(none)"}`,
      },
    ],
  });

  const content = (response.content[0] as { type: string; text: string }).text;

  try {
    const results = JSON.parse(content);
    if (!Array.isArray(results)) return [];
    return results.map((q: any) => ({
      id: q.id || `q_${Math.random().toString(36).slice(2, 8)}`,
      question: q.question || "",
      context: q.context || "",
      relatedAddbackId: q.relatedAddbackId || null,
      relatedTransactions: (q.relatedTransactions || []).map((t: any) => ({
        date: t.date || "",
        description: t.description || "",
        amount: Number(t.amount) || 0,
      })),
      answer: null,
      status: "pending" as const,
    }));
  } catch {
    console.error("Failed to parse seller questions from AI response");
    return [];
  }
}
