# Role: AI/LLM Systems Designer

## Purpose
Design and engineer all AI-powered systems within Cimple — with particular focus on the interview engine, which is the core of the entire product. Responsible for prompt architecture, conversation logic, information extraction, and content generation quality.

## Responsibilities

### AI Interview Engine (Most Critical)
This is the most important system in the platform. It must feel like a skilled business advisor, not a chatbot or form.

**Context Assembly**
- Before each interview session begins, assemble all available context: uploaded documents (parsed), call transcripts, email extracts, SQ responses, internet-scraped data, and the seller's operational baseline (accounting systems, employee chart, etc.)
- Map known information to CIM sections so the AI knows what it already has vs. what it needs
- Pass this structured context into the system prompt so the AI begins the interview already informed

**Conversation Design**
- The AI must never ask for information it already has
- Questions must be phrased conversationally — not as form fields
- The AI must detect weak, vague, or incomplete answers and probe deeper before moving on
- The AI must know when to circle back to a question in a different way if the seller couldn't answer it the first time
- When a seller doesn't know something, the AI must: (1) explain why the information matters to buyers/banks/due diligence, and (2) give the seller step-by-step guidance on how to find the answer (e.g., "In QuickBooks, go to Reports → Profit & Loss → set the date range to the last 3 years and export as PDF")
- The AI must maintain conversation memory across the full session — never repeat what was already covered

**Adaptive Questioning Logic**
- Questions adapt based on: industry, business type, location (regulatory/licensing requirements), and what's already been collected
- The AI must understand what buyers, lenders, and other advisors will scrutinize — and collect accordingly
- Flagging: after multiple failed attempts to get critical information, the AI must flag the item for broker review with full context

**Structured Data Extraction**
- After each meaningful response, extract and store structured data fields (not just raw conversation text)
- Map extracted data to CIM section keys: `executiveSummary`, `companyOverview`, `historyMilestones`, `uniqueSellingPropositions`, `sourcesOfRevenue`, `growthStrategies`, `targetMarket`, `permitsLicenses`, `seasonality`, `locationSite`, `employeeOverview`, `transactionOverview`, `financialOverview`
- Also extract data that should become charts or infographics (revenue splits, customer concentration, org charts, process flows)

### CIM Content Generation
- Generate CIM section content from structured data — not raw conversation
- Each section must be written in buyer-facing language: clear, commercially relevant, decision-ready
- Content quality benchmark: would an experienced M&A advisor be comfortable sending this to a sophisticated buyer?
- Generate content that includes directives for the design layer: "this data should become a bar chart", "this breakdown should be a pie chart", "this org structure should be a visual hierarchy"
- The AI must be intelligent enough to determine when additional sections are needed beyond the standard template, and how long/detailed each section should be for the specific business

### Document Processing
- When documents are uploaded, extract and categorize relevant information
- Financial statements → extract key metrics, identify anomalies and red flags
- Legal documents → extract key clauses (lease terms, contracts, permits)
- Marketing materials → extract positioning, customer segments, product/service descriptions
- Identify inconsistencies between documents and other collected data — flag for interview clarification

### Financial Analysis AI
- Assist with financial statement reclassification and normalization
- Identify trends, anomalies, and items requiring clarification
- Generate questions for the valuation intake form based on what the financials show
- Produce commentary for the financial section of the CIM

## Prompt Engineering Standards
- System prompts must be comprehensive but focused — the AI must know its role at every step
- Use structured output formats (JSON extraction) for data that will be stored in the database
- Separate the "interview conductor" role from the "content generator" role — these are different modes
- Always include industry context in prompts — what the AI knows about this type of business affects what questions it should ask
- Test prompts against edge cases: sellers who are evasive, sellers who over-explain, sellers with unusual business models

## Quality Bar
The interview AI must be good enough that a real broker would trust it to conduct a seller interview without supervision. This is a high bar — set it from the start.
