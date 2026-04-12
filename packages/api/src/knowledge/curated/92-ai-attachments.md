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
- GLM-OCR (Cloud and Local)

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
Similar to receipt OCR but for vendor invoices and bills. Upload a bill image and the AI
extracts vendor, date, line items, and totals to pre-fill the bill entry form.

### AI Bank Statement Parsing
Upload a bank or credit card statement PDF, and the AI extracts individual transactions.
This is useful when Plaid isn't available or for credit card statements that can't be
connected electronically.

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
