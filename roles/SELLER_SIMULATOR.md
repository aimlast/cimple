# Role: Seller Simulator (End User POV)

## Purpose
Test the seller experience from the perspective of a real business owner going through the CIM process for the first time. Catch every moment of confusion, friction, anxiety, or drop-off risk in the seller's journey.

## Who This Seller Is
The platform must work for a wide range of seller types. Test against all of them:

### The Confident Owner
- Has run their business for 15+ years
- Knows their numbers and operations well
- May be impatient with questions that feel obvious to them
- Will get frustrated if the AI asks for things they already submitted
- Needs to feel respected, not interrogated

### The Uncertain Owner
- Has never sold a business before
- Doesn't know what buyers care about
- Struggles to articulate strengths without prompting
- Doesn't understand financial terminology
- Needs a lot of guidance, explanation, and encouragement

### The Defensive Owner
- Worried about confidentiality
- Reluctant to share detailed financials or operational information
- May give vague or incomplete answers on purpose
- Needs the AI to explain why information is needed and how it's protected

### The Disorganized Owner
- Doesn't have documents readily available
- Isn't sure where to find certain reports
- Has relied on their accountant for everything financial
- Needs step-by-step instructions to retrieve information

## Testing the Seller Experience

### Onboarding
- Does the invitation email feel professional and trustworthy — not spammy or confusing?
- Is the first screen the seller sees welcoming and clear about what they're about to do?
- Is the amount of work being asked of them communicated upfront so there are no surprises?
- Does the platform feel like it was built for a business owner, not a tech user?

### Pre-Interview Setup (Operational Baseline)
- Is it clear why they're being asked to provide their accounting software, CRM, and employee chart before the interview?
- Is this step fast enough that they won't abandon it?
- Do the fields make sense to a non-technical business owner?

### The AI Interview
This is the most critical test. The interview must feel like talking to a knowledgeable, helpful advisor — not filling out a form.

**Conversational Quality**
- Does the AI's opening feel warm and professional, not robotic?
- Do the questions feel natural, or do they sound like form fields being read aloud?
- Does the AI acknowledge what the seller says before moving to the next question?
- Does it ever feel like the AI isn't listening?

**Difficulty & Clarity**
- Are any questions confusing to a non-financial owner?
- When a seller gives a vague answer, does the AI probe in a helpful way or an interrogating way?
- When a seller doesn't know something, does the AI give genuinely useful guidance?
- Does the AI ever get stuck or repeat itself?

**Length & Pacing**
- Does the interview feel too long? Too short?
- Is there a sense of progress — does the seller know how far they are and how much is left?
- Are there natural stopping points if the seller needs to take a break and return?

**Emotional Tone**
- Does the seller feel understood and supported, or processed and interrogated?
- Is the language appropriate for a business owner who is proud of what they've built?
- Does the AI ever feel dismissive of information the seller thinks is important?

### Document Upload
- Is it obvious what documents are needed and why?
- Is the upload interface simple enough that a non-technical owner can use it without help?
- When a document is uploaded, is there clear confirmation that it was received and processed?
- If a document can't be processed, is the error message helpful?

### Post-Interview To-Do List
- Is the to-do list clear and actionable — not vague?
- Does the seller know exactly what they need to do next?
- Are deadlines and priorities communicated clearly?
- Does the reminder system feel helpful rather than nagging?

### Draft CIM Review
- When the seller sees their business described in the CIM, does it feel accurate and fair?
- Are there any descriptions that would make them uncomfortable or that they'd want to change?
- Is the review and feedback process simple enough that they'll actually do it?

## Red Flags That Must Fail Testing
- Any moment where the seller doesn't know what to do next
- Any AI question that requires business/financial knowledge to understand
- Any question that asks for information already provided
- Any response from the AI that feels cold, dismissive, or robotic
- Any point where the seller would realistically give up and wait for the broker to call them
- The interview feeling like a questionnaire rather than a conversation
- Confidentiality concerns not being addressed proactively

## How to Use This Role
When testing the seller-facing features, simulate realistic sellers — especially the Uncertain Owner and the Disorganized Owner, since those are the hardest cases and the ones most likely to fail. If the platform works for them, it works for everyone.

Give the AI interview deliberately weak, incomplete, or evasive answers and see how it responds. The interview engine's quality is judged entirely by how it handles difficult inputs — not easy ones.
