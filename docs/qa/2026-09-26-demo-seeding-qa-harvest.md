### maple-main-cafe
Headline revenue comes from a second-hand, broker-only CRM figure. Annual revenue shows "~$590K gross (described as 'a little under six hundred')", taken from the accountant's HST-inclusive number in the lead-referral CRM note. It has no alternates. The deal-list card shows Revenue $590K. The seller said about $520K for 2025 in the intro call, and the first-meeting CRM note records "Rosa: 2025 sales ~$520K (Daniel's ~$590K = prob. incl. HST)", but extraction put the seller's figure only under revenueByYear (2025: about $520,000). So the annualRevenue conflict never forms an alternate or discrepancy, and the seller's own number (higher authority) doesn't win. annualRevenue and the latest year of revenueByYear should be reconciled.

### maple-main-cafe
Source dates on the Information tab show one day early. Date-only meta dates are parsed as UTC midnight and displayed in local time (EDT). In the Sources panel: call 2026-09-09 shows "Sep 8", CRM lead 2026-09-03 shows "Sep 2", CRM meeting 2026-09-11 shows "Sep 10", website 2026-09-24 shows "Sep 23". This affects every broker in the Americas.

### maple-main-cafe
A value the call extraction worked out itself beats an explicit value from a document. leaseExpiry = "October 2029 (4 years remaining from October 2025 renewal)" is wrong: a 5-year term from 1 Oct 2025 ends 30 Sep 2030. It comes from the call, which only said "five years starting October 2025, four years left". The first-meeting CRM note's exact "30 Sep 2030" is kept only as an alternate. Similarly, leaseAddress "Wyndham Street (Guelph, Ontario - implied from context)" from the call beats the CRM's exact "118 Wyndham St N". Values the extractor inferred itself (it even labels this one "implied from context") should not outrank specific values from a lower-authority source.

### maple-main-cafe
The CIM quality score looks inflated for a deal this early. After one 15-minute intro call, two short CRM notes and a website page, with no financial statements and no interview, the deal scores "Solid · 82" with 4 of 6 critical sections covered. The Financial Summary is "partly covered" only by second-hand estimates. The founder may see this as over-crediting thin, unverified facts.

### maple-main-cafe
Minor inconsistency: the Information header says "50 facts from 6 sources" while the Sources panel says "8 sources". The header seems to count only sources that contributed facts. Also minor: email source rows show the from/to line but no date, unlike the call and CRM rows.

### maple-main-cafe [interview QA]
No interview at this stage, by design (phase1_new, interviewTurnsTarget 0).

What the screenshots show:
- **Overview:** Phase 1, 1 of 3 tasks done. "Invite Seller" is checked with "Invite emailed to rosa.delgado@…invalid — waiting on seller". NDA shows "Send for E-Signature" / "Mark as Signed", the questionnaire shows "Waiting on seller", and the valuation field is prefilled with $185,000.
- **Information:** "50 facts from 6 sources" and "Solid · 82". The seller card comes from the invite. The source filter chips read Calls 36, Emails 1, CRM 10, Website 2, Your edits 1. Both CRM notes carry the "Broker only" lock, and facts show their sources and alternates.
- **Information, Financial Summary:** shows the revenue problem described under product bugs.
- **Deal list:** a "Maple & Main Café" card: Phase 1 Broker Prep, "Your move: get the NDA signed", asking $185K, revenue $590K, SDE $90K, 7 documents, "22 hours ago".

### northbeam-landscaping
1. A year in a revenue-by-year map ignores source authority, so the first source processed wins. In server/documents/extractor.ts, mergeValue for revenueByYear never overwrites a year already on file. The broker-only CRM intake note (rank 2) was processed first and kept 2024 = "about $2.4M" against 3 financial-statement/T2 uploads, an email and the call (rank 5), all saying $2,104,800. Before I corrected it through the Information tab, the headline revenue series read "2024: about $2.4M · 2023: SDE ~$380K · 2022: SDE ~$329K".

### northbeam-landscaping
2. Extraction put SDE figures under revenue. The CRM status note's "SDE ~$410K / ~$380K / ~$329K" was extracted into revenueByYear. With bug 1, that turned SDE into the revenue for 2022 and 2023.

### northbeam-landscaping
3. Among equal-rank documents, the first one processed wins even when it covers an older year. The FY2022 statements and T2 were ingested first, so the headline facts showed FY2022 or FY2021 values: netIncome "$52,719 (2022), $80,181 (2021)", grossProfit, ebitda, inventory, totalCurrentAssets, totalLiabilities, accountsReceivable, insurance, and yearsOfData "2 years (2022 and 2021)". The FY2024 values ended up only as other values; the FY2024 statements got credit for just 1 fact. I corrected 8 of these by hand through the app. Extraction is also inconsistent across the statements: the FY2023 statements produced year-suffixed keys (netIncome2023…), but the FY2024 statements did not, so there are no …2024 balance-sheet facts.

### northbeam-landscaping
4. Placeholder values from the call beat precise documents. Calls rank above documents (5 vs 3), so the call extractor's non-answers replaced exact document values: leaseAddress "Hartwell, Barrie area (specific address not stated)" (the lease PDF has the full address), leaseRenewalOptions "Option to renew (terms not specified in call)", debtObligations "specific amounts not stated", accountant "Pam (surname not provided)". Extracted values that say "not stated / not specified" should never win over, or even compete with, a concrete value.

### northbeam-landscaping
5. The interview outline loses the industry playbook when the industry is generic. routes.ts:6300 (outlineView) calls ensureInterviewPlan(deal) without { subIndustry: deal.subIndustry }. For industry "Home Services" with sub-industry "Landscaping and snow & ice management", matchIndustrySection finds nothing, so the plan status is 'unavailable'. The Overview shows "Standard checklist — no industry playbook matched this business type yet", although playbook 1D LANDSCAPING AND SNOW MANAGEMENT exists and the keyword map covers landscap|snow. Only the interview path (session-manager) passes the sub-industry.

### northbeam-landscaping
6. Choosing another value for one year relabels the whole map as a broker edit. In useAlternate → setBrokerMapEntry (server/information/facts.ts), picking the value for one year (e.g. revenueByYear.2022) sets the whole revenueByYear source to broker ('Broker edit · Chose Document', rank 7). The other years get the same label, including the still-unresolved CRM value "about $2.4M" for 2024: it was shown as broker-confirmed until I also picked the 2024 value.

### northbeam-landscaping
7. Rejected values lose their source kind. After a broker picks another value, the displaced value is relabelled "Document · CRM note - intake call" and "Document · CRM note - status and pricing" instead of "CRM note · …". Other entries on the same fact still read "CRM note · …".

### northbeam-landscaping
8. Checklist auto-matching credits the wrong files. Commercial Lease Agreement was credited to the email thread "Email thread - yard lease renewal", not the lease PDF uploaded minutes later. Bank Statements (3 Months) was credited to "Financial statements FY2023 (compilation engagement)", but no bank statements exist. Both were fixed through the checklist PATCH.

### northbeam-landscaping
9. Source dates show one day early on the Information tab. sourceMeta dates are stored date-only (e.g. 2025-03-14) and displayed as Mar 13, 2025; likewise Jan 22 → Jan 21, Jan 14 → Jan 13, Feb 5 → Feb 4. The date-only string is parsed as UTC midnight and then shown in local time.

### northbeam-landscaping
10. The Information tab disagrees with itself on the source count: the header says "254 facts from 13 sources" while the Sources panel says "18 sources". The count by kind also differs: the CRM filter shows 3 but the API's counts say crm 4.

### northbeam-landscaping
11. The Overview's Phase 2 row "Seller onboarding" is struck through as done but still carries the orange "Waiting on seller" badge.

### northbeam-landscaping [interview QA]
No interview was run: the phase1_docs stage has none (interviewTurnsTarget 0), so there is no AI turn to review. Two things will matter when the interview starts later:
- revenueByYear has been corrected, but the broker-only CRM values "about $2.4M" and "SDE ~$…" are still stored as other values on it (flagged broker-only in the Information tab). The interview must not quote them.
- The FY2024 revenue conflict (CRM "about $2.4M" vs statements $2,104,800) exists only as another value. No discrepancy row exists yet because the discrepancy check was not run at this stage.

### clearwater-physio
The interview ends early on a false stop signal (most serious). In server/interview/turn-guard.ts, the STOP_PHRASES entry `(?:finish|continue|come back) (?:later|tomorrow|another time)` matches ordinary answers such as 'a lot of them come back later or refer someone'. That flagged stop #1 on seller turn 5, which made the AI offer to wrap up. On the next turn the end was allowed as the seller's choice (session-manager.ts ~l.984, sellerStopDetected: stopNow || priorStopCount > 0), even though that turn wasn't a stop. So the interview completed at 6 of the 10-turn minimum and set deals.interviewCompleted=true, which the app offers no way to reset. Clearwater deal ac6572af…, session 5bf14e18.

### clearwater-physio
The filler guard lets recap/praise openers through: (a) 'That's a realistic read — … helps.' is not covered by FILLER_OPENER_RE. (b) KEEP_OPENER_RE keeps any leading sentence containing 'your broker' or 'confirm', so 'That's exactly right — your broker will want…' and 'That's helpful — having Dana confirm…' survived (turns 11 and 12). (c) The closing message 'That makes complete sense, and it's exactly the kind of insight…' is not filtered.

### clearwater-physio
The interview re-asks things already in its sources. The Zoom transcript (video_call source) already covers College complaints (00:15:08), audits (00:14:49 and 00:15:08), and new-patient sources and referrals (00:13:12–00:13:36). The interview asked about all of them again: the session-2 opener, turn 7, and turns 1–2.

### clearwater-physio
The interview's priorities are wrong. In 12 turns it never raised the planted Seton profitability conflict (seller: breaks even; location P&L: -$23,751), the Hillhurst lease renewal, the former associate now competing nearby, or the FY2025 figures. It spent turns on cost per new patient, infection-control inspections and prepaid packages instead.

### clearwater-physio
The interview made up a year. The fact practitionerForwardIntentions records 'Leah retained after October 2024 Bowmont offer'. The seller said only 'October', and the sources say fall 2025 (raise effective Oct 2025). The grounding guard does not catch invented years.

### clearwater-physio
Headline financial figures come from the older year. After the FY2023 compiled statements (uploaded first) and then the FY2024 ones, annualRevenue stayed at FY2023 $3,082,400 and sde at $537,300. That sde is EBITDA plus owner salary from the FY2023 statement, not a normalized SDE. The FY2024 extraction wrote extra keys (sde2024, ebitda2024, sde2023) instead of updating the headline facts. The deals-list card showed Revenue $3.08M / SDE $537K (the true figures are $3.32M / $690K). I corrected them with broker edits on the Information tab.

### clearwater-physio
revenueByYear is garbage again: it has duplicate keys '2023' / 'FY23' / 'FY2023' and '2024' / 'FY24' / 'FY2024', and 'FY23': '$3,318,600 (less Seton decline)' puts the FY2024 value under FY23. CLAUDE.md says revenueByYear can no longer become garbage.

### clearwater-physio
Source dates show one day early. formatShortDate (client/src/components/information/source-kinds.tsx:62) runs `new Date('2026-02-10')` on date-only dates, which parses as UTC midnight, so in Eastern time it shows the day before. All 13 dated sources in the Sources panel are off by one day (Zoom 'Feb 9', CRM 'Dec 3, 2025', lease 'Apr 19, 2017').

### clearwater-physio
The readiness score fills up from documents alone. It was 'Buyer-ready 92' before any interview turn and is 'Buyer-ready 100 · Every section is well covered' now, while the same header says '36 still missing' and the key buyer issues were never asked about.

### clearwater-physio
The Information header says '219 facts from 17 sources', but the Sources panel on the same page says '18 sources'.

### clearwater-physio
On the Overview tab, the Seller onboarding step is struck through as done but still shows a 'Waiting on seller' badge.

### clearwater-physio
Minor: the minute book source contributes 0 facts, and the staff roster and Hillhurst lease 2 each (probably outranked by the Zoom call). The companyHistory fact says the company was 'Incorporated March 2009 by Dr. Amrit Sandhu and spouse Harjit', but the spouse is not a shareholder or director.

### clearwater-physio [interview QA]
I read all 13 AI messages (1 opening and 12 replies across 2 sessions, 12 seller turns in total) against the founder's rules.

**What worked**
- **No CRM or broker-only content leaked.** Nothing from the CRM notes reached the seller: not "two and a half, maybe more", not the Paul Hollis referral, not Greg Tallis, not "Get the number".
- **Openings were short.** The first message was 1–2 sentences. The session-2 opener was "Welcome back, Amrit" plus one question.
- **Turns 7–10 were model replies.** Each was a single question with no preamble.
- **The filler guard trimmed once.** On turn 5 it removed "That's helpful context." (seen in the server log).

**Problems, in order of seriousness**

1. **The interview ended early after 6 seller turns (the minimum is 10).**
   - Seller turn 5 was a normal answer that included "a lot of them come back later or refer someone". The stop-phrase pattern `(?:finish|continue|come back) (?:later|tomorrow|another time)` read that as a request to stop. The server logged "Seller stop signal #1".
   - The AI then offered to wrap up ("…or shall we wrap up for today?").
   - On seller turn 6 the seller kept talking about the business. The interview still ended: because an earlier stop had been counted, the turn-6 end was treated as the seller's choice and the 10-turn minimum was skipped.
   - I reproduced this offline: detectStopSignal returns true for seller turn 5.

2. **Recap and praise got through:**
   - Turn 3: "That's a realistic read — and the fact that Leah and Priya already receive direct referrals helps." The filler pattern doesn't cover this wording.
   - Turn 11: "That's exactly right — your broker will want Dana to pull those insurer agreements… buyers will want certainty…"
   - Turn 12: "That's helpful — having Dana confirm the ClinicNest ownership-transfer process… would give buyers confidence…"
   - Turns 11 and 12 were kept because the keep-list matches "your broker" and "confirm". So a praise sentence survives whenever it happens to contain one of those words.
   - Turn 6 closing: "That makes complete sense, and it's exactly the kind of insight that helps the right buyer…"

3. **It re-asked things already in the Zoom transcript, which the interview can see:**
   - College complaints: the session-2 opening question. The Zoom call at 00:15:08 already answered it (one complaint in 2023, dismissed).
   - Audits: turn 7 asked about WCB audits. Zoom 00:15:08 says "Insurer audits, the routine ones. We pass" and 00:14:49 says "never had an audit problem".
   - New-patient sources and referrals (turns 1 and 2): Zoom 00:13:12–00:13:36 already covers the 40/30/30 split and the family-practice groups that "send a lot to me by name".

4. **It chased the wrong topics.** All 12 turns went to:
   - reputation, acquisition channels, referral ties and team plans
   - cost per new patient
   - College complaints, WCB audit, infection-control inspection, prepaid packages
   - direct-billing transfer and ClinicNest records

   It never probed the planted Seton discrepancy: seller says "breaks even", the location P&L shows EBITDA of -$23,751. It also never asked about the Hillhurst lease renewal (window Aug 31 – Nov 30, 2026), Ethan Marsh competing 3 km from Seton, or the FY2025 estimate. These are the most important buyer issues, and they are all in the documents or the Zoom call.

5. **It made up a year.** The fact practitionerForwardIntentions says "Leah retained after October 2024 Bowmont offer". The seller only said "in October". The sources say fall 2025, and the raise was October 2025.

6. **One "why we ask" didn't match its question.** Turn 11 asked how patient records transfer in ClinicNest, but its explanation was about the direct-billing revenue gap.

7. **Turn 4 was low-value.** It asked for cost per new patient, and the answer was saved as a fact from a stated rough guess ($60–75, marked approximate).

**Problem with my test seller, not the product**
Even though I told the persona not to invent anything, it made up details beyond the bible:
- In session 1: names (Dr. Patel, Dr. Kowalski, the Bhatia family) and RMT names beyond Aimee.
- In session 2 (after I tightened the prompt), and now saved as interview facts:
  - wcbAuditHistory: a 2019 WCB audit with a $400–500 refund. This contradicts "never had an audit problem".
  - preSoldPackageLiability: $8–12k of unused Pilates class-pack credit.
  - infectionControlCompliance: inspection dates.

They are in the transcript and the facts. You may want to delete those three facts on the Information tab (the delete can be undone).

### ridgeline-metal
**Same-rank facts: the last document to finish ingesting wins, regardless of fiscal year.** annualRevenue became $8,420,000 (FY2022, from the 2022 T2) while FY2024's $9,815,000 sat as an alternate. grossProfit ended up as the FY2022 value, and netIncome as "$779,090 (2023), $601,910 (2022)". Relevant code: server/interview/info-merger.ts mergeExtractedData, via documents/ingest.ts. I corrected these with broker 'use this value' edits.

### ridgeline-metal
**Per-year map merge ignores source rank.** revenueByYear.2024 kept the AR aging's "~$10.1M (trailing 12 months to May 31, 2025)" (a document, rank 3). Email (rank 4) and call (rank 5) sources both said $9,815,000, but those stayed alternates. revenueByYear.2025 was held by a CRM note (rank 2) over the call's value (rank 5). The map also had duplicate keys ("FY2022/FY2023/FY2024" alongside "2022/2023/2024"). I fixed this with a broker edit.

### ridgeline-metal
**The financial analysis adds the $60K Class D dividend back as owner compensation.** Owner comp comes out as $180K + $60K + $28K = $268K, and Adj. SDE $1,777,000 includes the dividend. Dividends come out of after-tax income and should not be added back; the interview prompts already state this rule. As a result, the planted owner-add-back discrepancy is framed as "$260K vs $268K, likely rounding/timing" instead of salary vs dividend. The normalization notes also compute the replacement-GM net as $268K − $165K. Relevant code: server/financial/analyzer.ts.

### ridgeline-metal
**The discrepancy engine flags identical values.** "2022 bad debt expense" was $22,000 vs $22,000 (created by the financial analysis, later superseded). coldbrookReceivableAmount is $38,700 vs $38,700 and is still OPEN. employeeCount ("42" vs "more than 40 / ~40") is noise, and its document_value text names "CRM notes and site visit", so a broker-only source is named in a discrepancy that could be routed to the seller. larkspurMSAChangeOfControl is "no MSA uploaded to verify", which is a missing document, not a disagreement between sources.

### ridgeline-metal
**Interview tasks are re-created every turn with no deduplication.** 28 task rows exist for 4 distinct follow-ups. Relevant code: server/interview/session-manager.ts ~l.1268, the `for (const task of aiResponse.newTasks) storage.createTask(...)` loop.

### ridgeline-metal
**Tone guard misses commentary sentences.** stripFillerPreamble / the tone rule does not catch recap, praise or grading sentences such as "That's smart planning — …", "Good — …", "That's the right approach — …". They appear on about 12 of 21 turns; the Interview QA notes quote each one.

### ridgeline-metal
**Source dates on the Information tab show one day early.** The Teams call dated 2025-06-11 shows "Jun 10, 2025"; the phone call dated 06-05 shows "Jun 4"; the WIP report dated 05-31 shows "May 30"; the CRM note dated 06-12 shows "Jun 11". This is probably a date-only sourceMeta string parsed as UTC and then shown in local time (client/src/components/information/source-kinds.tsx formatShortDate or the SourcesPanel meta date).

### ridgeline-metal
**Extraction glitch in businessDescription.** The FY2024 compiled-statements extraction produced "serving the oil & gas, ebitda agricultural and commercial construction sectors". The stray word 'ebitda' is not in the extracted text; it came from the model. It is still visible on the Information tab because my attempt to fix it was blocked (see unfinished).

### ridgeline-metal
**Broker-private notes swallow material business facts.** The notes include the Class D $60K dividend declaration, personal guarantees on the term loan, and the related-party lease. These are kept out of CIM, financial and buyer consumers, even though the dividend is exactly the fact the add-back discrepancy needs. The list has 43 entries, with the health note appearing 4 times, and it takes up the whole top of the Interview tab.

### ridgeline-metal
**Overview status contradictions.** The Phase 2 'Seller onboarding' row is marked done (struck through) but still shows a 'Waiting on seller' badge. The Overview offers 'Ready to build the CIM / Continue to Content Creation' while 2 critical discrepancies are open, and it doesn't surface them at all; only the Financials banner does.

### ridgeline-metal
**Information-tab per-source fact counts look wrong.** Minute book extract (15 extracted keys) and the Equipment list (8 keys) show 0 facts. The 2022 T2 shows 74 facts while the 2024 T2 shows 8. This follows from bug 1 (whichever same-rank source is merged last wins).

### ridgeline-metal
Demo-content artifact (not a product bug): the extractor recorded "Sample document labeled as fictional business for demonstration purposes" as a broker-private note, from the FICTIONAL marker in the FY2024 statement PDF.

### ridgeline-metal [interview QA]
21 seller turns, about 22 minutes, Opus at 22–77 s per turn; latency grew as the session got longer. The AI never quoted or named a CRM note. The health disclosure was handled correctly: "that stays with your broker only". The health detail went to _brokerPrivateNotes and appears in no business field; reasonForSale is still "retirement / grandkids".

Problems against the founder's rules:

1. **The reply-is-the-question tone rule was broken on most turns.** The replies open with recap, praise or grading that stripFillerPreamble did not catch:
   - AI[3]: "That's something a buyer's lawyer will definitely want nailed down early — knowing whether…"
   - AI[4]: "Good to get that clarified on the MSA — no consent clause simplifies things."
   - AI[7]: "That $400K over three years … lines up with what I'd expect — and having the beam line, new plasma, and cranes all in good shape gives a buyer confidence…"
   - AI[8]: "A 3-6 month scramble on estimating directly impacts the bid pipeline, which is why a retention plan…"
   - AI[11]: "A stable EMR near 1.0 with no lost-time since 2021 is exactly what they want to see in a fab shop."
   - AI[12]: "That's smart planning — … a real asset."
   - AI[13]: "That's the right approach — … exactly what buyers will want to hear."
   - AI[14]: "That makes sense — for sub work … it's not a gap in your current operation."
   - AI[16]: "Good — a clean Phase I and no legacy contamination issues removes a major due diligence risk for buyers."
   - AI[17]: a two-sentence commentary ("That's a realistic read — …").
   - AI[18]: "A smart buyer will prioritize that conversation…"
   - AI[19]: "Good — CWB transfer … is standard."
   - The closing AI[21] also praises: "it's clear you've built something solid".
   - The filler is full sentences of commentary, not only one-word openers.

2. **It re-asked a known fact.** At AI[12] it asked the seller again to "just confirm" the Larkspur MSA has no consent clause. He had answered that clearly at SELLER[4], and the answer had been captured (larkspurMSA_COC was updated).

3. **It never probed the two planted financial conflicts.**
   - At AI[3] it said "your documents show the backlog at $4.2M, which includes the Westlock terminal that's still awaiting PO". The $4.2M is Gord's own claim from the call and video transcripts; the WIP report says $3.1M signed. The AI misattributed the figure to documents and never reconciled $4.2M vs $3.1M.
   - It never asked about owner compensation or add-backs ($260K claimed vs $180K T4 + $60K dividend).
   - It asked no financial questions at all. The "financial-core checkpoint by ~turn 8" did not happen, probably because every financial field was already filled from documents.
   - The doc-conflict reconcile guard did not fire for either conflict.

4. **Opening turn.** AI[0] has no welcome or orientation. It jumps straight to a mid-priority permits question ("One area I'd like to fill in: beyond the CWB Division 2 and COR certifications…"), not a critical section.

5. **Small misattributions.** Statements Luis made on the Teams call are presented to Gord as "you mentioned" (the 110-ton brake at AI[6], Walt and Henry retiring at AI[16]).

6. **Tasks are duplicated every turn.** The same 4 follow-ups were re-created on almost every turn: 28 task rows for 4 distinct tasks. "Get Larkspur MSA change-of-control clause language" stayed even after the seller corrected himself and said there is no such clause.

7. **It ended at turn 21.** Governance said all critical sections were covered. Reasonable given how much was on file, but ownership, transition, deal structure and financials were never discussed with the seller.

Persona caveats (the fault is in my driver, not the product):
- Before I tightened the prompt, Sonnet-as-Gord invented an MSA change-of-control clause at SELLER[2]. I had him correct himself at SELLER[4]; the correction was captured, but the discrepancy engine then raised larkspurMSAChangeOfControl.
- He also invented a few minor names: "Northland Steel", "Castleford", "Jeff"/"Kyle", and an "Environment Canada emissions filing".
- I restarted the driver once, after turn 3; the session resumed cleanly.

### harborview-it
Dates on the Information tab show one day early for sourceMeta dates given without a time. The Google Meet with meta.date '2025-05-06' shows 'May 5, 2025', and the CRM note dated '2025-06-03' shows 'Jun 2, 2025'. The date is read as UTC midnight and then shown in local time (EDT). Brokers west of UTC will see every dated source a day off.

### harborview-it
Information tab source counts disagree on the same screen: the header says '331 facts from 19 sources' and the Sources panel says '20 sources'. The panel appears to count the questionnaire entry and the header does not. Per-source counts also look off: the Google Meet card says '4 facts' but the Video calls chip and the API count say 3.

### harborview-it
Overview Phase 2: the 'Seller onboarding' task is struck through as done (sqCompleted=true) but still carries an orange 'Waiting on seller' badge. The two contradict each other.

### harborview-it
The industry fact is replaced by the T2's NAICS text ('541513 - Computer facilities management services (managed IT services)') instead of the broker's own 'IT / Managed Services'. The broker-entered industry is not recorded as a broker fact, the way the asking price is, so a document outranks it on the Information tab. Minor, but it looks odd to a broker.

### harborview-it [interview QA]
Not run. The interview needs demo_key set first; otherwise an interview completing after the 10-turn minimum would feed the industry-wide interview insights on a non-demo deal. No AI turns to review yet.

### lakeshore-home-comfort
BLOCKER: Full CIM generation always fails with 'CIM generation failed while planning the document' on a rich deal. In server/cim/layout-engine.ts generateManifest, max_tokens is 4000. A read-only probe showed stop_reason=max_tokens with 4000 output tokens and an empty tool input, on both the first try and the retry. A 20-section plan needs about 3,700 tokens, so most deals with 300 facts will hit the limit. The real stop reason is never logged. 'Regenerate all' on this deal will fail the same way. I worked around it with a temporary 13-section house-outline template, since deleted.

### lakeshore-home-comfort
Multi-year document ingestion: whichever fiscal year is uploaded first keeps the unsuffixed headline facts. Here the FY2022 T2 and statements set accountsReceivable $412K, grossProfit, netIncome, costOfSales, interestExpense, deferredIncome, workingCapital and fleetSize. FY2023 and FY2024 income-statement lines were never stored as facts (only revenueByYear survives as a map). As a result the first CIM invented FY2023/24 numbers: gross profit $2,976K vs $3,018K, net income $417,930 vs $482,930 and $484,190 vs $563,190, EBITDA $870K vs $917K, interest $86K vs $38–41K. I fixed this with broker fact edits.

### lakeshore-home-comfort
The fleetSize fact was extracted as a dollar value ('Motor vehicles valued at $1,318,000 gross…' from the T2) instead of the vehicle count on the fleet list.

### lakeshore-home-comfort
Resolving a financial-analysis discrepancy writes no fact when the field is a descriptive label, and none of the 5 were written: 'Owner's claimed SDE vs calculated SDE', 'Comfort Club active member count', 'Lease expiry and renewal options', 'Fleet size - service vans vs total vehicles', 'Total employee headcount'. discrepancyFactTarget returns null. The sde fact stayed at '~$1.5M', and buildLayoutParams only overlays resolvedValue under the label key, so generation still sees the old values.

### lakeshore-home-comfort
Financial-analysis discrepancies: 'Total employee headcount' says the document value is '36 total employees including owner', but the roster excludes the owner. The planted licensed-technician conflict (24 vs 22) was found neither by the analysis nor by run-discrepancy-check. The discrepancy texts cite 'per broker note' / 'per broker recast' (CRM content), which would reach the seller if the broker routed one to 'ask the seller'.

### lakeshore-home-comfort
Blind redaction of org_chart sections always fails when the AI uses first names as node ids ('dave', 'kevin', 'steve' in id/reportsTo). The guard reports 'still named Steve, Dave, Kevin' and the section is held back from blind buyers. Also, an org chart level with 5 or more nodes is wider than the paper and nodes are clipped: the 5th node rendered at x=1034 in a 764px row inside a ~620px page.

### lakeshore-home-comfort
The AI filled the cover's preparedBy with the seller's accountant ('Bellamy & Rao LLP, Chartered Professional Accountants'). The redactor kept it in the blind cover, and CoverPage shows it under 'Prepared by' whenever the brokerage has no firm name. That is both identifying and wrong.

### lakeshore-home-comfort
Donut chart with unit '$' puts the unit after the number ('3,520,000 $', '7,412,000 $').

### lakeshore-home-comfort
Information tab shows source dates one day early: date-only meta is parsed as UTC midnight and displayed in local time (video call 2025-04-22 shows 'Apr 21, 2025'; CRM 04-09 shows 'Apr 8').

### lakeshore-home-comfort
Interview: the filler/recap guard misses 'That's a clear picture —', 'That's important context —', 'Good to know…' and 'That's exactly what buyers want to see'. It also created a follow-up task for a document already on file, and repeated the seller's figures (3,100 members, 26 trucks) against documents on file. Details are in interviewQa.

### lakeshore-home-comfort
Minor: the blind cover location reads 'Major Metropolitan Area, Ontario' and the blind map note says 'Greater Toronto Area' for a Hamilton business, so the redactor mislabels the region.

### lakeshore-home-comfort [interview QA]
30 seller turns; the interview ended on its own at turn 30 (governance said all critical sections were covered). It never quoted broker-only CRM content: no codename, no "recast", no "not verified", no valuation-meeting notes. The lease was handled well: at turn 12 it used the document's Aug 2028 date plus one 5-year option, and Tony corrected himself.

Violations of the founder's rules:

1. **Recap, praise or grading opener on about 8 of 31 AI turns.** `stripFillerPreamble` does not catch these:
   - T1: "That's a clear picture — Comfort Club as the base, heat pumps as a growth engine, and stronger close rates…"
   - T5: "That's important context — Dave staying provides continuity…"
   - T6: "That's cleaner than the TSSA side — …"
   - T13: "Good to know the landlord is receptive."
   - T19: "That's worth flagging — … but the track record speaks for itself."
   - T26: "That's a clean acquisition — …"
   - T27: "That's a familiar bottleneck in the trades right now — …"
   - Closing: "That comes through clearly … That's exactly what buyers want to see."

2. **It repeated the seller's wrong figures as fact without checking the documents on file.**
   - T8 and T24: "you mentioned you're at 3,100 members". The membership report says 2,900 active plus 214 suspended.
   - T14: "I see you've got 26 trucks". The fleet list says 24 vans plus 2 owner vehicles.
   - The doc-conflict reconcile guard did not fire for either.

3. **It re-asked facts already on file.**
   - Renewal/churn at T8: the report shows 10.9% attrition and the video call says about 11%.
   - Fleet loan balance at T14: $417K on the fleet list, $531K in the statements.
   - A/R at T15: the FY2024 statements show $505K. This is partly caused by bug 3, which left only the FY2022 $412K as the fact.
   - Heat-pump trajectory asked twice (T1 and T28) with the same question.
   - Estimating process at T7, which Tony had just described.

4. **It asked for a document already uploaded.** At T9 it asked Tony to have Denise upload the Comfort Club membership report, repeated this in the closing, and created a broker task "Get Comfort Club membership report with retention figures". The report is on file and extracted.

5. **The opening message has no greeting or introduction.** It starts "One thing I'd like to understand better: you mentioned…", referring to the broker's discovery call.

6. **It never probed the persona's evasive or contested topics.** No questions on Maria's $85K salary, the wrongful-dismissal claim, the $1.5M SDE claim, or what Dave has been promised.

Persona note: at T3–T4 Sonnet invented a supplier contact ("Mike Voltmere", his age, a son). I stopped the driver after an AI turn, tightened the no-invention rule and resumed the same session. The invented fact (subcontractorDependency) was corrected by a broker edit. Full transcript: …/seed-run/lakeshore-home-comfort/interview-transcript.jsonl (logs interview-part1.log and interview.log).

### pacific-coast-logistics
CIM planner failed on every attempt (fixed mid-run by commit ea4a36b): generateManifest (server/cim/layout-engine.ts, Sonnet 4.5, forced tool_choice cim_manifest, max_tokens 4000) returned stop_reason=max_tokens with 4000 output tokens. The streamed tool input was empty (a single input_json_delta with partial_json ""). 12 of 12 attempts failed on this deal, and it also hit beacon (ccce4ff4) and deal 1038d334. After the fix the first attempt failed with 'Connection error.' after about 6 minutes (a long non-streaming call), and the next succeeded.

### pacific-coast-logistics
Canonical figures were wrong (the same commit addresses it): collectCanonicalFigures strips digits from keys (key.replace(/[^a-z]/gi,'')), so revenue2021 and ebitda2021 matched as the headline Revenue and EBITDA. Because jsonb orders keys by length, the KB said 'Revenue: $25,480,000' (FY2021), 'EBITDA: $3,413,000' and 'Net income: … 2022'. Values over 80 characters (the real 'ebitda' fact) are skipped entirely.

### pacific-coast-logistics
CIM generation invented or distorted financials. The Historical Financial Performance table was internally inconsistent: operating expenses of $26.48M plus COGS of $21.7M on $31M revenue; EBITDA $4.78M vs the reported $3.547M; net income $2.17M vs $972,960. The EBITDA waterfall used made-up add-backs (Harjit $95K vs $165K, Surinder $85K vs $62K, interest $433K vs $395K), added the yard-rent normalization instead of subtracting it, and forced the total to about $3.9M.

### pacific-coast-logistics
CIM hallucinated customer names and shares: the Customer Diversification chart showed 'Fraser Valley Dairy Co-op 5.2%', 'Pacific Pet Food Distributors 4.8%' and 'Coastal Furniture Group 3.9%'. The real names (Silverleaf, Northshore Pet Nutrition, Lumen) were in the KB. Investment Highlights said 'Largest customer <20%' even though the 22.0% discrepancy had been resolved.

### pacific-coast-logistics
Resolving a discrepancy updates only one fact. After resolving 'Alderbrook revenue percentage' as 22.0%, stale ~18% values stayed in customerConcentration, customerBase, keyCustomerDetails and strengths (all sourced from the intro call, which outranks documents), and they reached the CIM.

### pacific-coast-logistics
Seller health reached the CIM: '2024 heart procedure' / 'health event' appeared in Executive Summary, Reason for Sale and Ideal Buyer Profile. It came from the questionnaire's reasonForSelling. Nothing filters health details on the questionnaire or document paths into CIM content (only the interview has the broker-private channel).

### pacific-coast-logistics
Blind location_map can never be served: buyerMediaLayoutData turns 'Surrey, BC, Canada' into a region, but blindLeakTerms treats 'British Columbia', 'Columbia' and 'Surrey BC' as leak terms, so buildBuyerCim holds the section back permanently. Blind buyers never get the map, and the print preview shows '1 section is still being redacted' forever. Repro: deal 00c84776, section d564fcec-803e-4978-80c9-c5e9d40d6279.

### pacific-coast-logistics
Blind redaction leaves bracket placeholders and over-redacts: the blind cover reads 'Major Metropolitan Area, [Province/State], Canada' while other sections say '…, BC', the map caption says '[Province]', and 'Washington State lanes (Seattle, Spokane)' became '(Major Metropolitan Area)'.

### pacific-coast-logistics
Scorecard layout was used for non-numeric values and rendered them as 'Satisfactory/100', 'PIP/100', '9.4%/100' and '0.11/100'. Its benchmark labels render outside the card, to the left of the page.

### pacific-coast-logistics
Rendering issues: the org chart overflows the right edge of the CIM page (Safety & Compliance nodes cut off). The metric_grid value '$31,020,000' wraps as '$31,020,00 / 0' in a 4-column grid. The donut legend and total show '13,560,000 $' and '31,020,000 $' (currency as a suffix). location_card appends 'sq ft' to non-area values ('4 acres sq ft', '4 acres with shop facility sq ft'). The anchor-customer stat_callout carries a hard-coded accentColor '#2E7D32' despite the theme system.

### pacific-coast-logistics
The cover date was generated as 'May 2025' for a CIM made in 2026. The CIM also turned the interview's 'promoting him in May' into 'promoted May 2025' (the actual date is May 2026).

### pacific-coast-logistics
Date-only source meta shows one day early on the Information tab: CRM note 2026-01-15 shows 'Jan 14', video call 2026-01-14 shows 'Jan 13', CRM note 2026-09-15 shows 'Sep 14'. A UTC-midnight date is being displayed in local time.

### pacific-coast-logistics
The discrepancy engine flags non-conflicts: warehouseSize (110,000 = 110,000) and yardRentActual ($8,000 = $8,000) are flagged even though both sides are equal. The Overview lists raw camelCase keys (yardRentActual, driverCount). 'accepted' items show no check icon but count as resolved.

### pacific-coast-logistics
'Add fact' with label 'Revenue' created a duplicate key 'annualRevenue2' instead of editing or warning about the existing annualRevenue.

### pacific-coast-logistics
revenueByYear was polluted by provenance-unaware merging: 2024 = 'roughly $31M' (from the broker's email) instead of $31,020,000 from the documents; '2025' came from the broker-only CRM note, whose own text says not to put FY25 in writing; there was a junk 'Last year' key. A broker-only CRM value inside a CIM-feeding fact is a leak path.

### pacific-coast-logistics
Knowledge-base leakage risk: 'Referral Source: Gary Lindqvist (…)' is a confirmed fact in the CIM knowledge base. It is broker process information, not CIM content.

### pacific-coast-logistics
No way to set or rename the blind codename: the app assigned 'Project Mosaic' while the broker's existing materials use 'Project Coastline'. I had to set it by SQL.

### pacific-coast-logistics
The Anthropic API credit balance ran out around 14:27 UTC. Every call returned 400 'credit balance is too low', including production's key, so live interviews and ingestion were affected. It recovered at 14:52 UTC.

### pacific-coast-logistics
Minor: the deal card on the deal list shows SDE for SDE deals but no EBITDA for EBITDA deals, so large deals show only asking price and revenue. Phase 4 lets the CIM go live before seller design approval (by design?).

### pacific-coast-logistics [interview QA]
Transcripts: …/seed-run/pacific-coast-logistics/interview-transcript.jsonl, plus interview-part1.log, interview-part2.log and interview.log. The run had 22 seller turns and ended by governance with shouldEnd and a closing message. The opening message was 3 sentences and asked a real gap question (open CVSE audits) instead of re-asking the uploaded facts. Good.

**Tone-rule violations: recap or praise openers that got past stripFillerPreamble**
- T1: "Good to have that documented — the clean June 2023 review and 9.4% OOS rate will land well with buyers and their insurers."
- T7: "That's a clean structure — no owner-operator classification exposure is increasingly rare and will matter to buyers."
- T12: "That's a clean pass-through structure — the index-linked mechanism removes most of the fuel volatility risk…"
- T13: "Good detail on the rate structure — that $8,350 per unit per week … gives buyers a clear picture…"
- T14: "That's a well-spec'd facility — 32-foot clear with 42 dock doors gives buyers real throughput capacity…"
- T15: "Turnover well below industry average with that tenure profile will matter to buyers…"
- T16: "That covers the key safety and compliance areas."
- T19: "That confirms the rate discipline is working."
- T20: "That's a clean regulatory picture — …"
- T21: a full paragraph recapping everything, including praise ("strong insurance position").
- T22 closing: praise-heavy.
- T17 is a dangling orphan sentence: "It shows operational leverage as the 3PL side scales." The filler guard appears to have stripped the first half of a sentence and left the rest.

**Internal machinery leaked to the seller**
- T15: "On the mandatory probes I need to check off: …"
- T17: "the coverage map shows revenue and EBITDA detail, but…"

**Re-asks and weak probes**
- T14 asked driver turnover, which was already on file (turnoverMetrics from the roster).
- T20 re-confirmed the $10K cargo deductible, which the seller had already stated twice (T1, T2).
- It never asked about the Alderbrook contract's termination or exit terms. The 90-day termination-for-convenience clause, the biggest buyer risk, never came up. The clause is in the shared Zoom transcript but was not extracted into facts either.
- It never picked up the 18% (intro call) vs 22% (documents) conflict.
- Industry probes misfired for a BC carrier: CARB/California compliance (T19), and BBB / consumer-protection complaints (T15) for a B2B carrier.
- T2 grammar slip: "when does the current policy term".

**Privacy**
- No broker-only CRM content was quoted: no Gary Lindqvist, "~80 trucks", "15-20%", health scare or T4C note from the CRM.
- When the seller volunteered the confidential Harvest Lane RFP (T8), the AI did not acknowledge the confidentiality request, but it stored the RFP only in _brokerPrivateNotes. Correct.

**Persona caveat**
- The Sonnet persona invented some details before I tightened it: insurance renewal April 1 with an 8–9% increase and $5M/$100K limits, "claim closed in December" (the bible says open), per-pallet and per-mile rates, $8,350 revenue per unit per week, and a 2.5% Alderbrook rate increase.
- I added a per-turn grounding reminder from T17. Some of these invented facts remain in extractedInfo (seller-interview source) and a few in the CIM: fleet metric $8,350/week; transition plan "April 1 insurance renewal".

### beacon-pharmacy
BLOCKER — CIM generation fails on rich deals. In layout-engine.ts, generateManifest uses max_tokens: 4000. Beacon's plan was 22 sections (reasoning up to about 190 characters plus content briefs up to about 560 characters each), which needs about 4,787 output tokens. Both attempts stop at max_tokens with an empty tool input, and the job fails with 'CIM generation failed while planning the document'. I reproduced this 4 times; a read-only probe with max_tokens 12000 returned 22 sections and stop_reason tool_use. Fix: raise max_tokens (e.g. 8–12K) or trim the per-section fields. Seeding got past it with a temporary 15-section house-outline template.

### beacon-pharmacy
Document extraction invents derived metrics and wrong structure. sde2024 '$845,252' (EBITDA plus owner salary only) came from the FY2024 compilation, which contains no SDE. sde2023 '$730,870' and sde '$743,870' were computed differently from two documents. ebitda2024 '$648,891' came from the T2 with odd meal and donation adjustments. ownerSalary2023 read 'included in $1,442,300'. saleType read 'Asset sale implied', inferred from the Zoom call even though the intro call explicitly says share sale. All of these flowed into the first CIM: cover SDE $845,252, and the Transaction section said 'structured as an asset sale'.

### beacon-pharmacy
annualRevenue stayed on the FY2023 compilation ('$8,640,200 (2023), $8,105,600 (2022)') after the FY2024 statements were ingested, so the newer year didn't supersede it. revenueByYear also gained a duplicate 'FY24: ~$9.1M (not final)' entry sourced from the broker-only CRM note.

### beacon-pharmacy
Resolving a discrepancy updates only the one mapped fact. The same wrong values stayed in narrative facts that feed the CIM: Daniel '15 years' in employees, keyEmployees, managementTeam, companyHistory and strengths; '1,200+ beds' in customerBase, revenueStreams and strengths; '~$9.4M' in keyFinancialNotes; and ltcContracts kept 'no single operator exceeds ~25% of LTC book' while customerConcentration says ~41%.

### beacon-pharmacy
Discrepancy detection is noisy and misses the material conflict. It did NOT flag Maplecrest concentration (the seller's 'quarter' vs 41%) or lease 2034 (CRM) vs 2029. It DID flag 5 non-conflicts where both sides agree: spouse $42K; $3,900/month vs $46,800/year; $640/month vs $7,680/year; 23 vs 23 employees; Mei-Lin 'since 2018' vs 7.1 years. It raised a false CRITICAL comparing adjusted EBITDA ~$780K with unadjusted EBITDA ($648,891), which blocks generation. revenue2023 '$8.64M vs $7.65M dispensary-only' is also not a conflict.

### beacon-pharmacy
Financial analyzer errors. It states FY2024 EBITDA as $679,312 while its own components (NI + tax + interest + amortization) sum to $660,252. It treats the ODB post-payment recovery as income (a negative add-back). Its working capital includes cash ($871,410) while its note says 'excluding cash', and it sets the peg equal to that figure. I corrected the normalization and working capital through PATCH financial-analysis.

### beacon-pharmacy
DD enrichment: generate-dd passes every document to generateDdOverrides regardless of visibility, including the broker_only CRM LOI note with competing IOIs and negotiation notes. No leak appeared in the final DD, but nothing prevents one. The first DD run also contradicted the approved named CIM, using the analyzer's $679,312 / $801,372 / $926,372. It invented a contractor name ('BioSafe Environmental Solutions'). It claimed concentration was 'higher than the 25% initially estimated in teaser materials'. It leaked internal wording ('per confirmed facts'). It took 4 DD regenerations after fact and normalization fixes to get a clean DD.

### beacon-pharmacy
Layout engine produces malformed two_column right columns: {content:'stats', layoutType:'icon_stat_row'} (a placeholder, and icon_stat_row has no sub-renderer) and a callout list with no layoutType. Both render as empty columns in the CIM (the literal word 'stats' in LTC, and only a heading in Compounding). Fixed with builder edits.

### beacon-pharmacy
The AI financial table mixed operating-expense definitions across columns: the FY2022 column showed FY2023's opex, and FY2023/FY2024 included amortization and interest, so rows didn't reconcile. It also 'estimated' FY2022 amortization and interest even though the FY2023 compilation has those comparatives. Fixed with a builder edit.

### beacon-pharmacy
Org chart renderer: when the owner has 6 or more direct reports, the chart overflows horizontally. The root node (Dr. Helen Park) is cut off at the right in the print preview at 1100px, and Daniel's subtree renders centred on its own.

### beacon-pharmacy
Source dates on the Information tab show one day early. A date-only sourceMeta is parsed as UTC and shown in local time: CRM LOI 2025-08-14 shows as 'Aug 13, 2025', staff list 2025-02-28 as 'Feb 27, 2025', and the Zoom call 2025-02-26 as 'Feb 25, 2025'.

### beacon-pharmacy
The Information tab headline says '1 critical section still needs work: Financial Summary' (9/10 critical covered), even though there are 3 full years of statements, normalization and 257 facts. This is likely a coverage-key mismatch for the financial summary section.

### beacon-pharmacy
The blind codename can't be chosen: the deal got 'Project Drift'. The manifest's 'Project Lighthouse' also appears inside the CRM LOI note, so the demo narrative and the app disagree. There is no app route to set a codename.

### beacon-pharmacy
There is no app route to edit a single DD override. Any builder edit drops that section's DD override, and the broker has to re-run the full DD (about 2.5 minutes, 17 sections).

### beacon-pharmacy [interview QA]
The interview ran 13 seller turns against a target of about 30, then ended itself (shouldEnd). Session id: 9b0018c4-50de-42bc-b7e4-31e61806a502. Transcript: seed-run/beacon-pharmacy/interview-transcript.jsonl.

WHAT WORKED:
- The opening was one sentence and went straight to a question grounded in a shared source: Daniel's equity interest, from the Zoom transcript.
- The broker-only CRM notes were never quoted.
- The interview never asked for anything the documents already covered: revenue, lease, staff and homes came from the documents.

TONE-RULE VIOLATIONS (recap or praise openers got past the filler guard):
- T3: "That's a clear picture — the OCP accreditation stays with the corporation, the DM change is the main timeline driver… Good to know Carol's handled the ODB side before."
- T4: "Exactly — buyers want to understand how the dispensing workload redistributes… that's a manageable transition…"
- T8: "That's a straightforward outcome — a routine audit… is exactly what buyers want to hear." This is the forbidden "buyers love that" pattern.
- T10: "A range of six to seven thousand active community patients is useful for now…"
- T11: "That's a helpful picture — Dr. Patel … is the main concentration point… The vet clinics sound sticky…"
- T12: "That's reassuring — the clinical relationships … sit with Mei-Lin and Daniel…"
- T13 (closing) was a long recap. That is acceptable for a close.

TURN WITH NO QUESTION: T6 was only a recap ("That's helpful — a more realistic split … gives buyers a clear picture.") with no question at all. The seller had to carry the conversation.

RE-ASK: T5 asked the seller to re-confirm figures she had given one turn earlier ("I have Daniel handling roughly half the total dispensing and you at around a quarter — does that sound right…?").

LEADING LEGAL CLAIM: At T8 the interviewer itself asserted "Ontario requires that pharmacy owners be licensed pharmacists" and asked the seller whether to flag it. The seller agreed and inflated it, and an inaccurate ownershipRestriction fact was recorded ("all shareholders must be pharmacists"). A seller claim about a "Health Canada narcotics dealer's licence" was also recorded without challenge.

COVERAGE GAPS: None of the planted conflicts or sensitive topics was probed before completion:
- Maplecrest concentration: the seller said "no operator more than about a quarter"; the workbook says 41%.
- The July 2023 narcotics loss.
- The seller's ~$9.4M revenue and ~1,200 beds.
- Daniel's tenure: 15 vs 11 years.
- The lease: 2034 vs 2029.
- The reason for sale.
The interview completed on document coverage alone.

DUPLICATE TASKS: The interview created 9 document-request tasks for 2 requests: 6× "Request RxNova pharmacist verification report" and 3× "Request RxNova active patient count report", re-created on successive turns.

PERSONA (my harness, not the product): even after tightening, the Sonnet persona invented details. These included the doctor names Patel, Chow, Khalil and Finnegan; a "2022" ODB audit (the bible says 2024, $6,200); workplace flu clinics; prepaid compliance packs; and "young kids". The interview recorded them as seller facts, which is correct behaviour for the product. I corrected or deleted those facts on the Information tab before generating the CIM. The old values survive only in fact history.

### great-lakes-plastics
1. The interview does not honour a seller's retraction. Diane said "Let me take those mold numbers back — I was guessing, and I don't want a guess ending up in the book", but toolingOwnership kept "15–18 molds owned … 240–250 customer molds … racking for ~300". I fixed it as a broker edit on the Information tab.

### great-lakes-plastics
2. Facts are re-asked across sessions despite the ALREADY ANSWERED block. In session 2, t107 re-asked resin suppliers (answered in session 1 and in the documents) and t108 re-asked the EV/ICE split (fact evVsIceSplit came from session 1 t14). The seller had to say "I already answered that".

### great-lakes-plastics
3. The filler/praise guard (stripFillerPreamble) misses whole-sentence grading preambles: "That's a candid assessment…", "That … is meaningful", "…is actually a strength", "That's a helpful reality check…", "That clarifies the regulatory picture…". This hit 7 of about 33 AI turns. Wrap-up turns also recap every topic.

### great-lakes-plastics
4. Document extraction loses details, which the interview then re-asks. Org chart: the key-people table (Megan Pryor, tenures) produced no facts, so the interview asked "Who is Megan?" and Sandra's tenure. Press list xlsx: 0 facts in the sources panel, so utilization and ages were asked. Quality summary: FDA status not captured, and the 'certifications' fact reduced to only "ISO Class 8 cleanroom (14,000 square feet)" with IATF 16949 and ISO 13485 missing.

### great-lakes-plastics
5. Opening /deal/:id/interview (broker interview page) on a deal whose interview is complete silently creates a new active interview_sessions row and makes an Opus opening call. In broker mode it greets "Welcome back, Diane…" and re-asks a known fact. I removed the stray session my screenshot created. I'm not sure whether the Overview's "Add more detail" button takes the broker to this page; I didn't check.

### great-lakes-plastics
6. The AI started wrapping up on its own at session-1 turn 21 with the critical Real Estate & Property section still partial; it had never asked about real estate. Completion governance only counts sections as covered or partial, so partial critical sections don't stop the wrap-up.

### great-lakes-plastics
7. whyItMatters is stale on the wrap-up turn: "anything else before we wrap?" carried the environmental-permits rationale.

### great-lakes-plastics
8. Facts are filed in the wrong Information section. Real Estate & Property contains currentHiring (website job postings), otherCurrentAssets ($352,470) and buildingsAndDepreciableAssets. roofCondition showed as missing even though the video call and CRM covered the $380K west roof. The seller later gave it in the interview.

### great-lakes-plastics
9. Broker-only CRM shorthand outranks the reviewed statements for headline facts. adjustedEbitda shows "adj $6.1M" sourced from a CRM note, and businessName and industry ("Custom injection molding") come from broker-only CRM sources. Worth checking that CIM generation can use these facts, or that the precise document values win.

### great-lakes-plastics
10. The counts disagree. The Information header says "261 facts from 22 sources" while the Sources panel says "27 sources". The Overview outline says "118 data points · 63 on file" while CIM quality says Buyer-ready 99 with 10/10 critical sections covered.

### great-lakes-plastics
11. On Overview Phase 2, the "Seller onboarding" task is struck through as done but still carries a "Waiting on seller" actor badge.

### great-lakes-plastics [interview QA]
What each screenshot shows:
- overview.png: Phase 1 complete, Phase 2 current (2/2 tasks). Interview outline shows "118 data points · 63 on file". "Interview complete" card with View transcript / Add more detail.
- overview2.png: the "Ready to build the CIM — Continue to Content Creation" CTA, Phases 3 and 4 not started, "23 sources · 23 read".
- information.png: 261 facts, Buyer-ready 99, 10/10 critical sections covered, seller card, source filter chips (CRM 34, Seller interview 38 …), sources panel with both sessions dated Sep 18 and Sep 21, CRM items tagged Broker only.
- information-financials.png: Financial Summary facts with source chips (call, email, reviewed FY2024 statements, interview turn 5, 1120-S).
- interview-review.png: the broker-private notes card.

Tone (founder rule: the reply is the next question, no recap or praise):
- 7 AI turns open with praise or grading. The filler guard did not strip any of them:
  - t10 "That's a candid assessment … flagging it proactively is the right move"
  - t13 "That $1.8 million Veridian catheter hub program is meaningful — close to 3% of current revenue"
  - t14 "That powertrain-agnostic mix is actually a strength"
  - t16 "That's a helpful reality check … shows the relationship is intact"
  - t19 "That's the kind of detail the attorney can confirm — in most cases stock deals avoid triggering assignment clauses" (borderline legal commentary)
  - t20 "That clarifies the regulatory picture — component suppliers typically stay off FDA's direct radar"
  - The session-1 closing message flatters the seller.
- Both wrap-ups (t22 and session-2 end) recap the whole conversation topic by topic.
- t8 opens "I'll flag that as something Tom can quantify" (acceptable acknowledgement of a deferral).
- The opening message is short, has no greeting fluff, and asks a good differentiation question.

Re-asking known facts (the rule is never re-ask):
- Session 2, t107: asked "Who supplies your resin…" although session 1 (t6) had already referred to "two main distributors plus a direct medical-grade supplier" and the documents list them. The seller replied "I already answered that". The AI said "You're right — I had that from earlier" and in the same message asked the EV-vs-ICE split, which she had answered in session 1 t14 (fact evVsIceSplit was on file). Two re-asks back to back, across sessions.
- Session 2, t102–103: asked Sandra's tenure and "Who is Megan, and what's her role?" Both are in the org chart PDF (Megan Pryor, Director Sales & Program Mgmt, 5 yrs; Sandra 7 yrs), but extraction never turned them into facts.
- t4–t5: asked fleet utilization and press age breakdown. The press list xlsx has 2024 utilization and year built for every press (the doc shows 0 facts in the sources panel).
- t11 (ISO 13485 last surveillance) and t19 (FDA registration status): both answered in the Quality Certifications summary.
- A stray third session opened when I visited /deal/:id/interview. Its opening question was "how many setup technicians…" (22 — in the org chart and the questionnaire).

Coverage and flow:
- At t21 the AI started the wrap-up itself with the critical Real Estate section still partial. It never asked about real estate, the roof or utilities in session 1; session 2 was needed for that.
- The financial core (add-backs, owner compensation, working capital) was never discussed with the seller. The documents cover it, but no checkpoint was visible.
- On the wrap-up turn ("anything else?") the whyItMatters is the stale environmental-permits rationale.
- Good behaviours: MV-417 was surfaced by a program-replacement follow-up, deferrals were routed to Tom, Rob and the attorney, disclosure of the sale to staff went to broker-private notes, and no CRM or broker-only content leaked.

Date framing: the seed sources are dated 2025, but the app's date is Sep 2026. The persona was told FY2024 is the latest year. The AI still said "IATF recert coming up fall 2026" and the seller spoke of closing in Q1 2026, which is in the past on the app's clock. Keep this in mind when demoing.

Persona embellishments: despite a strict prompt, the Sonnet seller added details that are not in the bible. They are now seller-sourced facts:
- mold return within ~30 days, an Ohio lien used twice, 40–50 inactive molds
- the Penta Career Center co-op and a $500 referral bonus
- cleanroom utilization 85–90% (the CRM note says ~80%)
- all-electric presses "oldest ~2015" (the press list shows 2012)
- Nate "8 years" as a toolmaker
- Sandra "from a Tier-1 in 2018", holds a CQA
- Megan rebuilt quoting in 2021 and has 2 program managers
- the quality team split as 10–11 inspectors, 3 engineers and lab techs
- a 2,000-amp service at 70–75% use, and a $200–250K chiller need
- a revolver draw during the 2021–22 resin spike
None of these contradict the bible's numbers, but the integrator may want them reviewed. Her made-up mold counts (15–18 owned, 240–250 customer molds) were taken back in the next turn and are corrected (see bug 1).

### buyers-brand
BLIND CIM PLACEHOLDER LEAK (buyer-facing): server/cim/redaction-engine.ts:226 gives the example 'Major Metropolitan Area, [Province/State]' and the model copies it literally. The Pacific blind cover shows 'Major Metropolitan Area, [Province/State], Canada' and regulatory_compliance shows 'NSC [Province] certificate'. Blind overrides on other deals (TrueNorth HVAC, Beacon, Lakeshore, Harbourline QA) also contain bracketed placeholders; I did not check which are the intended '[Address Withheld]' kind. I left the data alone because there is no app path to regenerate a single blind section.

### buyers-brand
MATCHING EXCLUSION TOO BROAD: in server/matching/engine.ts:449, the excluded-industry check reuses industryMatches(), which widens by industry family. Exclusions like 'New-build construction' or 'New-construction mechanical' therefore rule out a residential HVAC service business. The three best Lakeshore buyers (Declan Whitford/Ashbury 11/13 criteria, Stephanie Oakes/Oakridge 9/10, Kevin Brandt 8/12) fail the first pass, get no AI deep check, and drop out of Suggested buyers.

### buyers-brand
POST /api/deals/:id/match-buyers returns 500 on Pacific: 'invalid input syntax for type integer: "NaN"'. A buyer whose per-deal buyer_access.buyer_criteria is sparse (Balwinder Toor: only askingPriceMin/Max and lookingFor, exactly what applyNdaProfile writes for a CRM buyer) produces a NaN match score, and the whole batch fails part-way.

### buyers-brand
match-buyers AI qualitative scoring fails on every buyer with 'Unexpected non-whitespace character after JSON' (engine.ts:641 does JSON.parse on the raw text and the model adds text after the JSON). It silently falls back to the deterministic score only.

### buyers-brand
OUTSIDE-BUYER RESEARCH can finish 'done' with 0 results while its note describes the acquirers it found. Pacific's first run did this: every organisation was dropped by the citation/URL check in external-acquirers.ts (roughly lines 208–213). A re-run produced 3.

### buyers-brand
OUTSIDE-BUYER RESEARCH BRIEF IS NOT FULLY BLIND: blindBrief() in server/matching/external-acquirers.ts passes free-text extractedInfo fields (idealBuyer, businessType, revenueStreams) to a web-search agent unredacted. Pacific's brief contained the owner's son's first name (Manpreet), which appears in the returned note.

### buyers-brand
'Need more time' drops the buyer out of the reminder pipeline for good. POST /api/view/:token/decision sets decision=NULL, but getBuyerAccessUnderReview (server/storage.ts:699) selects decision='under_review' only. The code comment promises a fresh day-3/6/8 cycle.

### buyers-brand
Warning_sent does not by itself stop emails: runDecisionReminders stage 3 still auto-lapses (buyer email plus broker/seller notify) when decision='under_review' and the first view is 8+ days old. Seeding is safe only because every seeded row has a decision or NULL.

### buyers-brand
Suggested buyers dedupes by buyer_access.buyer_user_id only. An access row that isn't linked (grants link only email-verified accounts, e.g. Wei Zhang before signing the NDA) leaves that buyer suggested again, as if he had no access.

### buyers-brand
The Buyers page shows the 'Connect Pipedrive' banner while 24 contacts are Pipedrive-synced, because qa_cimgen and broker_demo have no integration row. This may look odd in a demo.

### buyers-brand
The brand logo is stored under production UPLOADS_DIR, so a local dev server (UPLOADS_DIR=/tmp/cimple-uploads-seed) shows an empty logo slot. This is environment-only; production serves it.
### harborview-it (finisher agent)
Interview: ended itself at turn 14-15 claiming critical sections covered while readiness showed 2 critical sections partial; 8 of 15 replies open with praise/grading/recap ("That's a clear-eyed read…", "Good — that's a clean vendor picture.", "That record is a genuine differentiator…", "…which is the distinction that matters for valuation.", close "one of the cleaner operational pictures I've seen") — stripFillerPreamble catches none; re-asked known facts (breach history asked on discovery call; $5M cyber/E&O limit on file; endpoint count 2,955 from MRR schedule); never probed planted conflicts because stale call values treated as known; seller-offered documents became notes not upload requests; opening turn starts on non-critical question.
Bugs: (1) SOURCE_RANK: call (5) outranks documents (3) and questionnaire (4); later same-rank source never replaces earlier → discovery-call mistakes beat lease, MRR schedule, questionnaire and a later Meet correction. (2) Resolved discrepancies mostly don't reach facts: discrepancyFactTarget returns nothing for AI-invented field names (maritimeSmilesMRRPercentage, kyleTransitionCommitment, customerCount); only 1 of 8 written back; generation adds resolved value alongside stale fact. (3) CIM generation not blocked when discrepancy check never ran. (4) Extraction stores arithmetic errors as facts (ebitda2023 amortization double-counted; sde built on wrong EBITDA; garbled ebitda; 2023 revenue includes investment revenue). (5) CIM writer: SDE counts owner comp twice; FY2022 column invented; debt shows long-term portion only; revenue streams computed from percentages. (6) Rendering: Investment Highlights cards break numbers mid-digit ("$6,212,4 / 00"); donut legend clipped right; Financial Summary "Revenue" row is a section header so its values are hidden, no total revenue line. (7) Source dates one day early (date-only meta parsed as UTC). (8) Source counts disagree (Information header vs Sources panel vs Overview). (9) Seller tokens appear in the request log (GET /api/invites/<token>) — also Railway logs.
