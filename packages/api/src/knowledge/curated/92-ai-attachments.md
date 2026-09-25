## AI Features & Attachments

### AI Processing Overview
Vibe MyBooks uses AI for automatic transaction categorization, receipt OCR, bill scanning,
and bank statement parsing. An administrator must configure an AI provider before these
features are available. Go to **Admin → AI Processing →** to set up.

**Supported AI Providers:**
- Anthropic (Claude Sonnet 4, Haiku 4.5)
- OpenAI (GPT-4o, GPT-4o-mini)
- Google Gemini (Gemini 2.5 Flash, Pro)
- Ollama (self-hosted models — no API key required)
- OpenAI-compatible (self-hosted: llama.cpp, LM Studio, vLLM)

### Vibe AI Router (per feature)
Admin → AI has a **Vibe AI Router** card (super admin). Once the router is
connected with `vibe enable` (VIBE_AI_ROUTER_URL + VIBE_AI_TOKEN), an admin can
turn it on and choose **Direct** or **Router** for each feature:
categorization and AI judgment, receipt reading, bill reading, document type
detection, bank statement extraction and check reads, vendor lookups, chat,
report narratives, Trial Balance tax mapping, and Close Review AI. Changes
apply immediately. Direct features keep using the providers on the page.
GLM-OCR page reading and the local extraction model are always direct.
Statements default to Direct; routing them asks for confirmation, scrubs
statement text of personal details unless the admin ticks "the router keeps
bank statements on this server", and only sends check images with that box
or cloud vision on. Newly routing a feature requires companies to re-accept
AI consent. A router outage fails the routed feature (no silent fallback to
direct). The old VIBE_AI_MODE=router env switch still works until an admin
saves a choice here; in that mode everything except statements is routed.

### AI Transaction Categorization
When bank feed items are imported (via Plaid or CSV), AI can automatically assign expense
or income categories.

- Enable under **Admin → AI Processing →** with the "Auto-categorize bank feed items on
  import" toggle.
- A **confidence threshold** (default 0.7 / 70%) controls how certain the AI must be
  before accepting a categorization. Lower thresholds accept more suggestions but with
  less accuracy.
- You can customize the categorization prompt to match your business's terminology.
- Review AI suggestions in the **Bank Feed →** — each item shows the suggested category
  and confidence score.

### Receipt OCR
Snap a photo or upload an image of a receipt, and AI extracts the vendor name, date, total,
and tax amount.

1. On any transaction, open the attachment panel and click **Capture Receipt**.
2. Drag and drop or browse for the receipt image.
3. If AI OCR is enabled ("Auto-OCR receipts on upload"), the system automatically extracts
   data and shows it with a confidence score (e.g., "87% confidence").
4. Review and edit any extracted fields before creating the expense.
5. The receipt image is automatically attached to the resulting transaction.

### Bill OCR / Document Scanning
Two ways to use it:
- **Enter Bill** — drop one PDF or image on the form and it pre-fills from the extraction.
- **Payables → Bill Capture** (feature flag `AP_BILL_CAPTURE_V1`) — upload MANY bills at once.
  Each becomes a queue row (Queued → Reading → Ready to review → Entered). Clicking a row opens
  the document beside a pre-filled bill form. Choose **Detailed** lines (the AI's line items)
  or **Single line at the total** (one account, the vendor's default expense account + tag);
  the choice is remembered per vendor. Unknown vendors can be created on post (address read
  from the bill). Possible duplicates (same vendor + invoice number, or same total + date) show a
  banner with a link and a "Post anyway" override. **Post & next** walks the stack. One file =
  one bill (a multi-page PDF is one bill). If AI is off or consent is missing the upload still
  lands as "Ready — not scanned" for manual keying with the image beside the form. Portal
  contacts with "Can upload bills" get a "Send us bills" tile and see Received / Being
  processed / Entered (no amounts); staff are emailed on upload.

### AI Bank Statement Parsing
Upload a bank or credit card statement PDF, and the AI extracts individual transactions.
This is useful when Plaid isn't available or for credit card statements that can't be
connected electronically.

Uploaded statements appear on **Banking > Statement Processing** with their status
(Processing, Pending review, Imported, Failed). A failed or pending-review statement can
be **Re-processed** from that list — extraction re-runs from the original file, which
helps after an OCR engine outage or timeout. Already-imported statements can't be
re-processed (that would risk duplicate transactions); upload the file again instead.

### In-App Chat Assistant
The chat assistant (the speech bubble icon in the bottom-right) can answer questions about
the app, explain accounting concepts, and help you navigate to the right screen. It reads
the current screen context to give relevant answers.

**Data access levels** (configured by admin):
- **None** — general help only
- **Contextual** — can see what screen you're on and what fields are filled
- **Full** — can look up balances and lists for your company (read-only)

The assistant never creates, edits, or deletes data — it guides you to the right screen
instead.

### Attachments
You can attach files (receipts, invoices, contracts, supporting documents) to any
transaction, invoice, or bill.

**Attaching Files:**
- Open a transaction and click the attachment/paperclip icon.
- **Upload new** — drag and drop or browse for a file.
- **Attach existing** — pick a file already in your attachment library.

**Attachment Library:**
View all uploaded files across your company at **Attachment Library →** in the sidebar.
Files can be re-attached to other transactions from here.

Attachments support any file type. The count of attachments appears as a badge on
transactions, invoices, and bills in list views.
