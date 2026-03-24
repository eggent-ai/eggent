---
name: sendforsign
description: "Use for SendForSign document-signing workflows via API: create/send/sign contracts, manage templates/placeholders/recipients/webhooks/clients/users, upload/download documents, and handle Russian and English requests."
version: 1.0.0
---

# SendForSign API Skill

This skill enables full interaction with the SendForSign API — a document signing platform. You can perform every operation available through their API.

## Required Resources

Load these required resources before execution:
- [SendForSign API Reference](references/api-reference.md)
- [PDF Render Script](scripts/render_pdf.py)

## Setup: Reading Credentials

Before making any API call, read credentials from the `.env` file in the current working directory:

```bash
# Read API key
grep SENDFORSIGN_API_KEY .env | cut -d '=' -f2
# Read optional client key
grep SENDFORSIGN_CLIENT_KEY .env | cut -d '=' -f2
```

If `.env` doesn't exist or the key is missing, ask the user to provide it or add it to `.env`:
```
SENDFORSIGN_API_KEY=your_key_here
SENDFORSIGN_CLIENT_KEY=your_client_key_here  # optional
```

## Making API Calls

**Base URL:** `https://api.sendforsign.com/api`

**Standard request pattern** (use curl via Bash):
```bash
curl -s -X POST https://api.sendforsign.com/api/<endpoint> \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": {...}}'
```

Always show the user:
1. What operation you're performing and why
2. The API call being made (endpoint + action)
3. The result (formatted nicely)
4. Any errors with a clear explanation of what went wrong

For full endpoint reference, see [SendForSign API Reference](references/api-reference.md).

## Document Markup

**Trigger:** user asks to "markup", "annotate", or "add placeholders to" an existing contract/template — or says something like "разметь документ", "поставь плейсхолдеры".

Document markup means: find all dynamic (variable) values in the document — things that change between different instances of the contract (names, dates, cities, amounts, etc.) — and replace them with placeholders that cover exactly those text spans.

### Markup workflow for PDF contracts

1. Render the PDF and extract all text elements with coordinates:
```bash
python3 ~/.claude/skills/sendforsign/scripts/render_pdf.py /path/to/doc.pdf /tmp/sfs_pages
```

2. Analyze text elements across all pages. Look for:
   - **Repeated values** — same text appearing 2+ times (strong signal: it's a dynamic field)
   - **Obvious variable fields** — dates, city names, person names, company names, amounts, contract numbers — even if they appear only once

3. Group findings into named placeholders. If the same value appears in multiple places (e.g. both parties' signature pages), one placeholder covers all occurrences via multiple `insertion` entries.

4. For each placeholder:
   - Create it via POST /api/placeholder (action: "create")
   - Place it via POST /api/placeholder (action: "update") with an `insertion` array — one entry per occurrence, each with exact `api_x/api_y/api_w/api_h` from the render script output

5. Show the user a summary table of all placeholders created, what text they cover, and how many pages.

### Markup workflow for HTML/text contracts

Find dynamic values in the HTML `value` field and replace them inline with placeholder tags (see Case 3 for tag format). Update the **contract's HTML** via POST /api/contract (action: "update") — this embeds the tags into the document body.

> **Note:** updating the contract HTML is NOT the same as updating a placeholder. To change a placeholder's name, value, or position — always use `POST /api/placeholder` (action: "update"). Never use the contract or template update endpoint for that.

## Word File Handling (.docx / .doc)

**If the user provides a Word file, STOP and ask before doing anything:**

> "How would you like to upload this document?
> 1. **Editable document** — text is extracted and uploaded as HTML. The document will be editable in SFS, but formatting may slightly change.
> 2. **PDF with fields** — document is converted to PDF. Styling is preserved exactly; sign fields can be added after upload."

### After the user responds:

#### Option 1 — Editable document (HTML)

1. Ensure a converter is available. Try pandoc first, fall back to LibreOffice:
```bash
# Check pandoc
which pandoc

# If missing on macOS:
brew install pandoc

# Check LibreOffice (fallback)
which soffice || which libreoffice

# If missing on macOS:
brew install --cask libreoffice
# If missing on Ubuntu/Debian:
apt-get install -y libreoffice fonts-liberation fonts-dejavu
# If missing on CentOS/RHEL:
yum install -y libreoffice fonts-liberation
```

2. Convert .docx to HTML:
```bash
pandoc "file.docx" -o /tmp/sfs_doc.html --wrap=none 2>/dev/null || \
soffice --headless --convert-to html "file.docx" --outdir /tmp/
```
3. Read the resulting HTML, strip outer tags (`<html>`, `<head>`, `<body>`, meta tags), keep only the `<body>` content.
4. Create a contract or template (Case 1 / Template Case A) using the extracted HTML as `value`.
5. **After uploading, immediately fetch the contract back and fix its styles** (see "HTML Style Cleanup" below).
6. Add placeholders and recipients if needed (Case 3 / Template Case B).

#### HTML Style Cleanup (always run after uploading an editable Word document)

After the contract is created, fetch its value via `action: "read"`, apply the following fixes in Python, then push back via `action: "update"`.

**Fix checklist:**

1. **Title** — find the first `<p>` containing the document title (usually all-caps or in the first 1–2 paragraphs). Add centering and bold:
```html
<p style="text-align: center; margin-bottom: 2px;"><strong>ДОГОВОР ПОСТАВКИ</strong></p>
```

2. **Body paragraphs (`<h2>`)** — pandoc converts numbered clauses to `<h2>`, making them look like huge headings. Convert all `<h2>` to `<p>`:
```python
html = re.sub(r'<h2>', '<p style="text-align: justify; margin: 6px 0; line-height: 1.5;">', html)
html = re.sub(r'</h2>', '</p>', html)
```

3. **Sub-items (`<h3>`)** — convert to indented `<p>`:
```python
html = re.sub(r'<h3>', '<p style="text-align: justify; margin: 4px 0 4px 36px; line-height: 1.5;">', html)
html = re.sub(r'</h3>', '</p>', html)
```

4. **Section headings (`<h1>`)** — keep as headings but add spacing:
```python
html = re.sub(r'<h1>', '<h1 style="font-size: 13pt; margin: 20px 0 8px; text-transform: uppercase;">', html)
```

5. **Table full-width** — SFS requires a specific pattern to make tables full-width. Do NOT use `style="width: 100%"` on the table element. Instead:
   - Add `data-full="true"` to `<table>`, `<colgroup>`, and every `<col>`
   - Remove the fixed pixel width from the table's `style` attribute (keep only `margin-right: auto;`)
   - Set column widths as percentages on `<col>` elements (equal split by default, e.g. 50%/50% for 2-col, 33%/33%/33% for 3-col)

```python
import re

# Remove fixed pixel width from table style
html = re.sub(
    r'(style="margin-right: auto;) width: \d+px;"',
    r'\1"',
    html
)

# Add data-full="true" to <table> tags that have ql-table class
html = re.sub(
    r'(<table class="ql-table"[^>]*?)(?! data-full)(>)',
    r'\1 data-full="true"\2',
    html
)

# Add data-full="true" to <colgroup> tags
html = re.sub(
    r'(<colgroup[^>]*?)(?! data-full)(>)',
    r'\1 data-full="true"\2',
    html
)

# Convert fixed pixel col widths to equal percentages
# Count cols per colgroup, assign equal % widths, add data-full="true"
def fix_colgroup(m):
    colgroup = m.group(0)
    cols = re.findall(r'<col ', colgroup)
    n = len(cols)
    pct = f"{100 // n}%"
    # Replace each <col ... > with percentage width + data-full
    colgroup = re.sub(
        r'<col([^>]*)>',
        lambda c: f'<col{re.sub(r" width=\"[^\"]*\"", "", c.group(1))} width="{pct}" data-full="true">',
        colgroup
    )
    return colgroup

html = re.sub(r'<colgroup[^>]*>.*?</colgroup>', fix_colgroup, html, flags=re.DOTALL)
```

6. **Table cell padding** — add padding to `<td>` cells:
```python
html = re.sub(
    r'<td class="ql-table-cell"',
    '<td class="ql-table-cell" style="padding: 8px 10px; vertical-align: top;"',
    html
)
```

#### Option 2 — PDF with fields

1. Ensure LibreOffice is available:
```bash
# Check
which soffice || which libreoffice

# If missing on macOS:
brew install --cask libreoffice
# If missing on Ubuntu/Debian:
apt-get install -y libreoffice fonts-liberation fonts-dejavu
# If missing on CentOS/RHEL:
yum install -y libreoffice fonts-liberation
```

2. Convert .docx to PDF:
```bash
soffice --headless --convert-to pdf "file.docx" --outdir /tmp/
```
3. Follow the standard PDF flow:
   - For a contract: Case 2, 4, or 5
   - For a template: Template Case C (create PDF contract → configure placeholders → convert to template)

---

## Decision Rules — Which Flow to Use

Before making any API calls, determine the correct flow based on what the user needs. There are five distinct cases. Pick exactly one.

### CRITICAL — How to update placeholders

**Updating a placeholder** (its name, value, or position on the page) is ALWAYS done via:
```
POST /api/placeholder   action: "update"
```

**Never** use `POST /api/contract action: "update"` or `POST /api/template action: "update"` to change placeholder data — those endpoints only update the document's HTML body (to embed or re-embed placeholder tags), not the placeholder configuration itself.

| Goal | Correct endpoint |
|------|-----------------|
| Change placeholder name, value, or insertion position | `POST /api/placeholder` → `action: "update"` |
| Embed placeholder tags into the document text | `POST /api/contract` → `action: "update"` |
| Embed placeholder tags into a template | `POST /api/template` → `action: "update"` |

### IMPORTANT — Before adding ANY placeholders (Cases 3, 4, 5)

Before creating new placeholders in a contract, always fetch the **full** placeholder list first, including auto-created special placeholders. To get them all, add the `X-Sendforsign-Component` header:

```bash
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "X-Sendforsign-Component: true" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "list",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY"
    }
  }'
```

Without `X-Sendforsign-Component: true` only regular placeholders are returned. With this header, you also get the **special placeholders** (signature, date signed, fullname, email) that the system **auto-creates** when a recipient is added.

#### How to read the response

Each placeholder in the response has an `id` field. **This `id` is the N that goes into the HTML tag.** Example response:

```
id: "1", name: "Name9",              isSpecial: false  → <placeholder1 ...>
id: "2", name: "Илья's signature",   isSpecial: true, specialType: 4  → <sign2 ...>
id: "2", name: "Илья's date signed", isSpecial: true, specialType: 1  → <date2 ...>
id: "2", name: "Илья's full name",   isSpecial: true, specialType: 2  → <fullname2 ...>
id: "2", name: "Илья's email",       isSpecial: true, specialType: 3  → <email2 ...>
id: "3", name: "Иван's signature",   isSpecial: true, specialType: 4  → <sign3 ...>
```

Key rules:
- The `id` field = the N in all HTML tags (`<placeholderN>`, `<signN>`, `<dateN>`, `<fullnameN>`, `<emailN>`)
- All 4 special placeholders for the same recipient share the same `id`
- **Special placeholders are auto-created by the system when you create a recipient — you do NOT create them manually**
- Regular placeholders (`isSpecial: false`) are created manually via the API
- Before adding new placeholders, find the highest `id` in the list and use the next number
- The `externalRecipientKey` field on special placeholders links them to the recipient
- The `placeholderKey` for special placeholders follows the pattern `{recipientKey}_{specialType}` (e.g., `e8c68...c4c_4` for signature)

---

### CASE 1 — Text contract, no placeholders

**Condition:** user wants a regular (HTML/text) contract without any fillable fields.

**Steps:**
1. Create contract directly — no special flags needed.

```bash
curl -s -X POST https://api.sendforsign.com/api/contract \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contract": {
        "name": "Contract Name",
        "value": "<p>Contract text in HTML</p>"
      }
    }
  }'
```

---

### CASE 2 — PDF contract (upload an existing PDF, no placeholders)

**Condition:** user has a PDF file and just wants to upload it as a contract, without adding any sign fields.

**Steps — strictly in this order:**
1. Create a contract with `"contractType": "pdf"` — this tells the API to expect a PDF upload.
2. Upload the PDF file.

```bash
# Step 1: Create PDF-type contract
curl -s -X POST https://api.sendforsign.com/api/contract \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contract": {
        "name": "Contract Name",
        "contractType": "pdf"
      }
    }
  }'
# → save contractKey from response

# Step 2: Upload the PDF
curl -s -X POST "https://api.sendforsign.com/api/upload_pdf?clientKey=CLIENT_KEY&contractKey=CONTRACT_KEY" \
  -H "X-Sendforsign-Key: $API_KEY" \
  -F "pdf=@/path/to/document.pdf;type=application/pdf"
```

---

### CASE 3 — Text contract with placeholders (regular and/or recipient-bound)

**Condition:** user wants a text/HTML contract with fillable fields — either simple text fields (company name, date, address) or recipient-bound fields (signature, date signed, fullname, email).

In text contracts, placeholders are **embedded directly in the HTML** as special tags. There are NO separate API calls to position them (unlike PDF contracts). Instead, you insert special HTML tags into the contract's `value` field and call contract update.

**There are two types of placeholders in text contracts:**

#### TYPE A — Regular placeholder (not tied to any recipient)

A simple fillable text field. Use this for things like company name, address, amounts, dates, etc. These are created **manually** via POST /api/placeholder with action "create".

**HTML tag pattern:**
```html
<p><span style="background-color: rgb(250, 250, 250);"><placeholderN class="placeholderClassN" contenteditable="false">{{{Placeholder Name}}}</placeholderN></span></p>
```

Rules:
- `N` is the placeholder's `id` from the placeholder list response (NOT an arbitrary number — fetch the list first!)
- The class is always `placeholderClassN` where N matches the `id`
- `contenteditable="false"` is mandatory
- The display text inside `{{{ }}}` is the placeholder's visible label
- Background color `rgb(250, 250, 250)` (light gray) for regular placeholders

**Examples:**
```html
<p><span style="background-color: rgb(250, 250, 250);"><placeholder1 class="placeholderClass1" contenteditable="false">{{{Company Name}}}</placeholder1></span></p>
<p><span style="background-color: rgb(250, 250, 250);"><placeholder2 class="placeholderClass2" contenteditable="false">{{{Contract Amount}}}</placeholder2></span></p>
```

#### TYPE B — Recipient-bound placeholder (tied to a specific recipient)

Fields that auto-fill with recipient data or require action from the recipient. There are exactly 4 sub-types, each with its own tag pattern.

**These are created AUTOMATICALLY by the system when you create a recipient — do NOT create them manually.** After creating a recipient, fetch the placeholder list (with `X-Sendforsign-Component: true`) to discover the auto-created special placeholders and their `id` values.

The `N` in the HTML tags = the **`id` field** from the placeholder list response. All 4 special placeholders for the same recipient share the same `id`.

Background color for all recipient placeholders: `rgb(245, 150, 0)` (orange).

**B1 — Recipient's signature:**
```html
<p><span style="background-color: rgb(245, 150, 0);"><signN class="signClassN" contenteditable="false">{{{RecipientName's signature}}}</signN></span></p>
```

**B2 — Recipient's date signed:**
```html
<p><span style="background-color: rgb(245, 150, 0);"><dateN class="dateClassN" contenteditable="false">{{{RecipientName's date signed}}}</dateN></span></p>
```

**B3 — Recipient's full name:**
```html
<p><span style="background-color: rgb(245, 150, 0);"><fullnameN class="fullnameClassN" contenteditable="false">RecipientName</fullnameN></span></p>
```

**B4 — Recipient's email:**
```html
<p><span style="background-color: rgb(245, 150, 0);"><emailN class="emailClassN" contenteditable="false">recipient@email.com</emailN></span></p>
```

#### Key differences between tag types:

| Tag | class | Content | Meaning |
|-----|-------|---------|---------|
| `<signN>` | `signClassN` | `{{{Name's signature}}}` | Signature field |
| `<dateN>` | `dateClassN` | `{{{Name's date signed}}}` | Auto-filled date |
| `<fullnameN>` | `fullnameClassN` | `RecipientName` (plain text, no `{{{ }}}`) | Auto-filled name |
| `<emailN>` | `emailClassN` | `recipient@email.com` (plain text, no `{{{ }}}`) | Auto-filled email |
| `<placeholderN>` | `placeholderClassN` | `{{{Label}}}` | Regular text field |

Note: `fullname` and `email` tags use **plain text** as content (no triple braces). `sign`, `date`, and regular `placeholder` tags use `{{{ }}}` wrapping.

#### Full workflow for CASE 3:

**Steps — strictly in this order:**
1. Create the text contract (same as Case 1).
2. If the contract needs recipient-bound fields: create each recipient (POST /api/recipient, action "create"). The system **auto-creates** 4 special placeholders per recipient (signature, date signed, fullname, email).
3. If the contract needs regular text placeholders: create each one manually (POST /api/placeholder, action "create").
4. **Fetch the full placeholder list** (with `X-Sendforsign-Component: true` header) to get all placeholders and their `id` values.
5. Build the full HTML using the `id` from each placeholder as the N in tags.
6. Update the contract's `value` field with the new HTML.

```bash
# Step 1: Create the contract
# (same as Case 1, save contractKey)

# Step 2: Create recipients (only if using TYPE B recipient placeholders)
curl -s -X POST https://api.sendforsign.com/api/recipient \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "recipients": [
        {
          "action": "sign",
          "fullname": "Ivan Petrov",
          "email": "ivan@example.com",
          "position": 1
        }
      ]
    }
  }'
# → System auto-creates 4 special placeholders for Ivan

# Step 3: Create regular placeholders (only for TYPE A text fields)
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "placeholder": {
        "name": "Company Name",
        "value": ""
      }
    }
  }'

# Step 4: Fetch ALL placeholders to get their id values
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "X-Sendforsign-Component: true" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "list",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY"
    }
  }'
# → Response example:
#   id: "1", name: "Company Name",           isSpecial: false          → use <placeholder1>
#   id: "2", name: "Ivan Petrov's signature", isSpecial: true, type: 4 → use <sign2>
#   id: "2", name: "Ivan Petrov's date signed", isSpecial: true, type: 1 → use <date2>
#   id: "2", name: "Ivan Petrov's full name", isSpecial: true, type: 2 → use <fullname2>
#   id: "2", name: "Ivan Petrov's email",     isSpecial: true, type: 3 → use <email2>

# Steps 5-6: Update contract value with placeholders embedded in HTML
# Use the id values from step 4 as N in the tags!
curl -s -X POST https://api.sendforsign.com/api/contract \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "update",
      "clientKey": "CLIENT_KEY",
      "contract": {
        "contractKey": "CONTRACT_KEY",
        "value": "<p>Contract between parties.</p><p>Company: <span style=\"background-color: rgb(250, 250, 250);\"><placeholder1 class=\"placeholderClass1\" contenteditable=\"false\">{{{Company Name}}}</placeholder1></span></p><p>Signed by:</p><p><span style=\"background-color: rgb(245, 150, 0);\"><fullname2 class=\"fullnameClass2\" contenteditable=\"false\">Ivan Petrov</fullname2></span></p><p><span style=\"background-color: rgb(245, 150, 0);\"><sign2 class=\"signClass2\" contenteditable=\"false\">{{{Ivan Petrov'"'"'s signature}}}</sign2></span></p><p><span style=\"background-color: rgb(245, 150, 0);\"><date2 class=\"dateClass2\" contenteditable=\"false\">{{{Ivan Petrov'"'"'s date signed}}}</date2></span></p>"
      }
    }
  }'
```

**No separate "place" API call is needed for text contracts. The placeholders live inside the HTML.**

#### Multiple recipients example

Assume placeholder list returned: regular placeholder id=1, Ivan's specials id=2, Maria's specials id=3.

```html
<!-- Regular placeholder uses its id from the list (id=1) -->
<p><span style="background-color: rgb(250, 250, 250);"><placeholder1 class="placeholderClass1" contenteditable="false">{{{Contract Amount}}}</placeholder1></span></p>

<!-- Ivan's fields use id=2 (from placeholder list) -->
<p><span style="background-color: rgb(245, 150, 0);"><sign2 class="signClass2" contenteditable="false">{{{Ivan's signature}}}</sign2></span></p>
<p><span style="background-color: rgb(245, 150, 0);"><date2 class="dateClass2" contenteditable="false">{{{Ivan's date signed}}}</date2></span></p>

<!-- Maria's fields use id=3 (from placeholder list) -->
<p><span style="background-color: rgb(245, 150, 0);"><sign3 class="signClass3" contenteditable="false">{{{Maria's signature}}}</sign3></span></p>
<p><span style="background-color: rgb(245, 150, 0);"><date3 class="dateClass3" contenteditable="false">{{{Maria's date signed}}}</date3></span></p>
```

**The N in every tag MUST come from the `id` field in the placeholder list response. Never guess or hardcode it.**

---

### CASE 4 — PDF contract with regular (basic) placeholders

**Condition:** user has a PDF and wants to add text fields (not signature-related) at specific positions on the pages — e.g., a text box where a name or date will appear.

**Steps — strictly in this order:**
1. Create contract with `"contractType": "pdf"`.
2. Upload the PDF file.
3. Render PDF pages to images (see PDF Coordinate Workflow below).
4. For each placeholder: call POST /api/placeholder with `action: "create"` to create it. Save the `placeholderKey`.
5. For each placeholder: call POST /api/placeholder with `action: "update"` and an `insertion` array to position it on the page ("Place basic placeholder").

```bash
# Steps 1-2: same as Case 2

# Step 4: Create the placeholder
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "placeholder": {
        "name": "company_name",
        "value": ""
      }
    }
  }'
# → save placeholderKey from response

# Step 5: Place the placeholder at a position on the PDF ("Place basic placeholder")
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "update",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "placeholders": [
        {
          "placeholderKey": "PLACEHOLDER_KEY",
          "insertion": [
            {
              "action": "update",
              "clientKey": "CLIENT_KEY",
              "id": "1",
              "pageId": "0",
              "positionX": "100",
              "positionY": "200",
              "width": "192",
              "height": "25"
            }
          ]
        }
      ]
    }
  }'
```

**Two separate API calls per placeholder: first "create", then "update" to place it. Never skip the create step.**

---

### CASE 5 — PDF contract with recipient sign fields (special placeholders)

**Condition:** user has a PDF and wants to add fields that are tied to a specific recipient — signature box, date of signing, recipient's name, or recipient's email.

Special placeholder types:
| specialType | Field | Who fills it |
|-------------|-------|-------------|
| 1 | Date signed | Auto-filled by system when recipient signs |
| 2 | Recipient's full name | Auto-filled from recipient profile |
| 3 | Recipient's email | Auto-filled from recipient profile |
| 4 | Signature | Recipient draws/types their signature |

**Steps — strictly in this order:**
1. Create contract with `"contractType": "pdf"`.
2. Upload the PDF file.
3. Create each recipient (POST /api/recipient, action: "create"). The system **auto-creates** 4 special placeholders per recipient (signature, date, fullname, email).
4. **Fetch the full placeholder list** (with `X-Sendforsign-Component: true`) to discover the auto-created special placeholders and their `placeholderKey` values.
5. Render PDF pages to images (see PDF Coordinate Workflow below).
6. For each sign field: call POST /api/placeholder with `action: "update"` using `isSpecial: true`, `specialType`, and the `placeholderKey` from step 4 to position it on the page.

```bash
# Steps 1-2: same as Case 2

# Step 3: Create recipient (repeat for each signer)
curl -s -X POST https://api.sendforsign.com/api/recipient \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "recipients": [
        {
          "action": "sign",
          "fullname": "John Signer",
          "email": "signer@example.com",
          "position": 1
        }
      ]
    }
  }'
# → System auto-creates 4 special placeholders for John

# Step 4: Fetch all placeholders to get their placeholderKey values
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "X-Sendforsign-Component: true" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "list",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY"
    }
  }'
# → Response includes auto-created special placeholders, e.g.:
#   placeholderKey: "abc123_4", specialType: 4 (signature)
#   placeholderKey: "abc123_1", specialType: 1 (date signed)
#   placeholderKey: "abc123_2", specialType: 2 (fullname)
#   placeholderKey: "abc123_3", specialType: 3 (email)

# Step 6: Place the special placeholder using placeholderKey from step 4
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "update",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "placeholders": [
        {
          "placeholderKey": "abc123_4",
          "isSpecial": true,
          "specialType": 4,
          "insertion": [
            {
              "action": "update",
              "clientKey": "CLIENT_KEY",
              "id": "1",
              "pageId": "0",
              "positionX": "144",
              "positionY": "672",
              "width": "192",
              "height": "58"
            }
          ]
        }
      ]
    }
  }'
```

**Two operations for special placeholders: create recipient (which auto-creates placeholders) → fetch placeholder list → place with "update". You do NOT manually create special placeholders — the system creates them for you.**

---

## PDF Coordinate Workflow

Use this whenever the task involves placing any placeholder on a PDF page (Cases 4 and 5).

### CRITICAL — `insertion` field format rules

Every `insertion` item MUST follow these rules, or the API will silently ignore the placement (returns 201 but nothing gets saved):

1. **All values must be STRINGS**, not numbers: `"id": "1"`, `"pageId": "0"`, `"positionX": "100"` — NOT `"id": 1`, `"pageId": 0`, `"positionX": 100`
2. **`id` starts from `"1"`**, not `"0"`. Use `"1"` for the first insertion, `"2"` for the second, etc.
3. **`action": "update"` and `"clientKey"` are required** inside each insertion item — for BOTH basic and special placeholders

Correct `insertion` example:
```json
"insertion": [
  {
    "action": "update",
    "clientKey": "CLIENT_KEY",
    "id": "1",
    "pageId": "0",
    "positionX": "100",
    "positionY": "200",
    "width": "150",
    "height": "50"
  }
]
```

Common mistakes that cause silent failures:
- Using numbers instead of strings → field not placed
- Using `"id": "0"` or `"id": 0` → field not placed
- Omitting `"action": "update"` → field not placed
- Omitting `"clientKey"` → field not placed

### Step 1 — Render PDF and extract positions

Requires `poppler` (install with `brew install poppler` if missing):

```bash
python3 ~/.claude/skills/sendforsign/scripts/render_pdf.py /path/to/document.pdf /tmp/sfs_pages
```

The script does two things at once:
1. Renders pages at **exactly 1000px wide** (= SFS coordinate space) → PNG images for visual reference
2. Extracts all text elements via `pdftohtml -xml` with **pre-calculated API coordinates**

Output per page:
- `image_path` — PNG for visual inspection
- `page_id` — 0-indexed (use as `pageId` in API)
- `text_elements` — list of all text strings with exact API coords: `api_x`, `api_y`, `api_w`, `api_h`

### Step 2 — Get coordinates for text fields

**For placeholders that cover existing text** (the most common case):

Search `text_elements` for the target string and use its `api_x/api_y/api_w/api_h` directly:

```python
# Example output for "19 марта 2025 года":
# {"text": "19 марта 2025 года", "api_x": 217, "api_y": 175, "api_w": 150, "api_h": 20}
```

Use `api_x` → `positionX`, `api_y` → `positionY`, `api_w` → `width`, `api_h` → `height`. No math needed.

**For non-text areas** (signature boxes, empty lines, images):

Read the `image_path` PNG visually. Since image is 1000px wide = API space, pixel coord = API coord directly.

### Step 3 — Signature block layout (for non-text areas)

For recipient sign fields placed in empty space below content:

```
positionY + 0:    [Signature]   w=192, h=58
positionY + 73:   [Full name]   w=192, h=25
positionY + 113:  [Date signed] w=192, h=25
```

**IMPORTANT — always check available vertical space before using standard dimensions.**

Standard h=58 for signature is a default, not a guarantee. Before placing a signature field, check the gap between the target position and the next text element below:

```python
# Find the next element below positionY on the same page
elements_below = [e for e in page['text_elements'] if e['api_y'] > positionY]
next_element_y = min(e['api_y'] for e in elements_below) if elements_below else page['height_px']
available_height = next_element_y - positionY
actual_height = min(58, available_height)  # never exceed the available gap
```

If `available_height < 58`, use `available_height` as height (or leave a 2px margin). Never place a field that overlaps the next text element below it.

Find the last text element on the page: `max(api_y + api_h for all text_elements)`. Add 100px margin for the first field.

For two recipients side by side: Recipient 1 positionX=70, Recipient 2 positionX=320.

For standard field dimensions (already expressed in 1000px API space — do NOT rescale these):

| Field type | API width | API height |
|-----------|-----------|------------|
| Signature (specialType 4) | **192** | **58** |
| Full name (specialType 2) | **192** | **25** |
| Date signed (specialType 1) | **192** | **25** |
| Email (specialType 3) | **192** | **25** |
| Regular placeholder | varies | **25** |

### Coordinate system
```
(0,0) ─────────────────→ positionX  (0 to 1000)
  │
  │    ┌──────────────┐  ← positionY
  │    │  placeholder │
  │    └──────────────┘
  │         ↑ width, height
  ↓
positionY  (0 to height×scale_to_api)
```
Origin is top-left of the page. Page width = 1000 API units always.

### If placement looks off after preview
- Fields too high → your pixel Y was too small, or you forgot to apply scale_to_api
- Fields too low → your pixel Y was too large
- Field too far right → decrease positionX
- **Everything shifted uniformly** → scale_to_api was not applied; multiply all coords by `1000 / image_width_px`

---

## Templates

Templates work like reusable contracts. The same Case flows apply — with two key rules:
1. Use `templateKey` instead of `contractKey` in all placeholder operations
2. PDF templates are not created directly — create a PDF contract first, then convert it

---

### TEMPLATE CASE A — Text template (no placeholders)

Same as Case 1, but endpoint is `/api/template`:

```bash
curl -s -X POST https://api.sendforsign.com/api/template \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "template": {
        "name": "Template Name",
        "value": "<p>Template text in HTML</p>"
      }
    }
  }'
```

Response: `{ templateKey, createTime }`

---

### TEMPLATE CASE B — Text template with placeholders

Same sequence as Case 3 for contracts, but use `templateKey` everywhere `contractKey` appeared:

**Steps — strictly in this order:**
1. Create template (Case A above) → save `templateKey`
2. Create recipients if needed (POST /api/recipient with `templateKey`)
3. Create regular placeholders (POST /api/placeholder with `templateKey`)
4. Fetch full placeholder list (`templateKey` + `X-Sendforsign-Component: true`)
5. Build HTML with placeholder tags using `id` values
6. Update the **template's HTML** via POST /api/template (action "update", with `templateKey`) — this embeds the placeholder tags into the template body. This is NOT how you update a placeholder's value or position; for that, always use POST /api/placeholder (action "update").

Key difference from Case 3: every API call uses `"templateKey": "..."` instead of `"contractKey": "..."`.

---

### TEMPLATE CASE C — PDF template

There is **no `templateType: "pdf"`** in the API. To create a PDF template:

**Steps — strictly in this order:**
1. Follow Case 2, 4, or 5 fully for a PDF **contract** (create contract → upload PDF → add/place all placeholders)
2. Convert the finished contract to a template:

```bash
curl -s -X POST https://api.sendforsign.com/api/template \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "convert",
      "clientKey": "CLIENT_KEY",
      "template": {
        "name": "Template Name",
        "contractKey": "CONTRACT_KEY"
      }
    }
  }'
```

Note: content and placeholders are copied; placeholder values are cleared.

---

### Creating a contract from a template

**ALWAYS follow this sequence — never skip step 1:**

**Step 1 — Fetch template placeholders first**

Before creating the contract, list all placeholders of the template and show them to the user:

```bash
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "list",
      "clientKey": "CLIENT_KEY",
      "templateKey": "TEMPLATE_KEY"
    }
  }'
```

Show the user a table of all placeholders (`name`, `placeholderKey`, current `value`). Ask for the values to fill in if not already provided.

**Step 2 — Create contract and fill placeholders in one API call**

Use the "Create from template + fill placeholders" call. **Always include `placeholderKey` (from Step 1) for every placeholder** — this guarantees the correct placeholder is targeted. Also include `name` for readability:

```bash
curl -s -X POST https://api.sendforsign.com/api/contract \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contract": {
        "templateKey": "TEMPLATE_KEY",
        "name": "New Contract from Template"
      },
      "placeholders": [
        { "placeholderKey": "abc-111", "name": "client_name", "value": "Acme Corp" },
        { "placeholderKey": "abc-123", "name": "date",        "value": "2026-03-19" }
      ]
    }
  }'
```

**Rule:** always provide `placeholderKey` for each entry — it is the unambiguous identifier. `name` may be added alongside for readability but is not relied upon for matching.

---

## Table Placeholders (HTML contracts and templates only)

Table placeholders let you inject a dynamic table (with headers and rows) into an HTML contract or template. **This does NOT work for PDF contracts.**

### Flow — strictly in this order:

**Step 1 — Create the placeholder** (same as any regular placeholder):
```bash
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "placeholder": {
        "name": "goods_table",
        "value": ""
      }
    }
  }'
# → save placeholderKey from response
```

**Step 2 — Embed the placeholder tag in the contract HTML** (same as regular placeholder — see Case 3):
```html
<p><span style="background-color: rgb(250, 250, 250);"><placeholderN class="placeholderClassN" contenteditable="false">{{{goods_table}}}</placeholderN></span></p>
```
Update the **contract's HTML** via POST /api/contract (action: "update") to embed the tag in the right place. This is a contract HTML update — not a placeholder update.

**Step 3 — Fill it with table data** via a separate update call using `table` instead of `value`:
```bash
curl -s -X POST https://api.sendforsign.com/api/placeholder \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "update",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY",
      "placeholder": {
        "placeholderKey": "PLACEHOLDER_KEY",
        "table": {
          "columns": ["Item", "Qty", "Price"],
          "rows": [
            ["Widget A", 10, 9.99],
            ["Widget B", 5, 19.99]
          ]
        }
      }
    }
  }'
```

Note: `placeholderKey` and `table` are nested inside `placeholder` (singular), not at the top `data` level.

### Creating a contract from a template with a table placeholder

When using `action: "create"` with a `templateKey`, you can pass `table` instead of `value` directly in the `placeholders` array — no separate update call needed:

```bash
curl -s -X POST https://api.sendforsign.com/api/contract \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "create",
      "clientKey": "CLIENT_KEY",
      "contract": {
        "templateKey": "TEMPLATE_KEY",
        "name": "New Contract"
      },
      "placeholders": [
        { "placeholderKey": "abc-111", "name": "client_name", "value": "Acme Corp" },
        {
          "placeholderKey": "abc-222",
          "name": "goods_table",
          "table": {
            "columns": ["Item", "Qty", "Price"],
            "rows": [
              ["Widget A", 10, 9.99],
              ["Widget B", 5, 19.99]
            ]
          }
        }
      ]
    }
  }'
```

This is the key advantage of table placeholders in templates — pass `table` instead of `value` and the table is rendered automatically at contract creation time.

**Rule:** always include `placeholderKey` for every entry (both `value` and `table` placeholders) to guarantee correct targeting.

---

## Personal Recipient Links

Every recipient (signer, approver, viewer) has a unique personal link for accessing the document:

```
https://app.sendforsign.com/sharing/{recipientKey}
```

To get all recipient links for a contract, list its recipients:

```bash
curl -s -X POST https://api.sendforsign.com/api/recipient \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "action": "list",
      "clientKey": "CLIENT_KEY",
      "contractKey": "CONTRACT_KEY"
    }
  }'
```

The response includes `recipientKey` for each recipient. Build the link as:
`https://app.sendforsign.com/sharing/{recipientKey}`

**Always provide these links** after adding recipients to a contract — it's how each person accesses their copy to sign, approve, or view.

---

## Error Handling

- **401 Unauthorized**: API key is wrong or expired token. Check `SENDFORSIGN_API_KEY` in `.env`.
- **4xx errors**: User error — missing keys, invalid credentials, resource not found, rate limits. Read the error message and explain it clearly.
- **5xx errors**: Server-side issue with SendForSign. Suggest retrying later.

## Account Structure

SendForSign uses a 3-tier hierarchy:
- **Platform** (your account) — uses API key directly
- **Client** — a customer/organization within your platform (identified by `clientKey`)
- **Client User** — individual team members within a client (identified by `userKey`)

Most operations require a `clientKey`. If `SENDFORSIGN_CLIENT_KEY` is set in `.env`, use it as the default. Otherwise ask the user which client to operate on, or list clients first.

## AI API (Beta)

For natural language contract generation:
```bash
curl -s -X POST https://aiapi.sendforsign.com/webhook/aiapi \
  -H "X-Sendforsign-Key: $API_KEY" \
  -H "clientKey: $CLIENT_KEY" \
  -H "secretKey: $SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a freelance services agreement between Acme Corp and John Doe for web development"}'
```

Returns AI-generated contract text + a 30-minute preview URL.

---

For the complete API reference with all endpoints, parameters, and examples, read [SendForSign API Reference](references/api-reference.md).
