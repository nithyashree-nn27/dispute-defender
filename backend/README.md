# Local AI setup

Dispute analysis uses Ollama, a free local model runner. The model runs on the
backend machine; no paid AI API key is required. Local inference needs available
memory and can be slower on CPU-only machines.

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. Start Ollama and download the default model:

   ```powershell
   ollama pull qwen2.5:7b
   ```

3. Optionally add these settings to `backend/.env`:

   ```dotenv
   OLLAMA_BASE_URL=http://127.0.0.1:11434
   OLLAMA_MODEL=qwen2.5:7b
   ```

The defaults above are used when the settings are omitted. Open **AI Assistant**
in the app to check whether Ollama is reachable and the configured model is
installed. If the model is missing, the status panel shows the matching
`ollama pull` command.

Analysis compares buyer-submitted evidence records available in PayPal dispute
details with the seller's saved evidence, summarizes the buyer's claims,
assesses the seller's records, identifies supported conflicts, prioritizes next
steps, lists evidence gaps, and drafts a response. The evidence-completeness
score measures how complete the submitted material appears; it is not a
prediction of winning. Buyer statements are treated as claims, not verified
facts. Adding seller evidence or syncing changed PayPal dispute details clears
the previous analysis so the case can be analyzed again using current evidence.
The current text model receives attachment names only; it does not read image
or document contents. Analysis does not predict the outcome. Review all
generated content for accuracy before using it or submitting evidence to PayPal.
Dispute Defender is a seller workspace: it does not contact or represent the
buyer. The seller controls every step: syncing disputes, adding evidence,
requesting analysis, reviewing the response, and approving its submission.
There is no background sync, automatic analysis, or automatic submission.
PayPal, not this application, decides the outcome. For
chargeback/pre-arbitration/arbitration stages, follow PayPal's case-specific
instructions; this app does not currently submit supporting information for
those escalated stages.

# PayPal Sandbox testing

The backend uses PayPal Sandbox by default. It switches to live only when
`PAYPAL_ENV=live` is explicitly set. Keep it unset or set it to `sandbox` while
testing.

## Set up the test accounts and app

1. In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/),
   create or select one Sandbox **Business** account (the seller) and one
   Sandbox **Personal** account (the buyer).
2. Under **Apps & Credentials**, select **Sandbox** and create a REST app for
   the Business account. Copy that app's Sandbox client ID and secret.
3. Add the following values to `backend/.env`. Use the Sandbox app credentials,
   never live credentials, and do not commit this file:

   ```dotenv
   APP_PASSWORD=choose-a-local-app-password
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID=your-sandbox-client-id
   PAYPAL_CLIENT_SECRET=your-sandbox-client-secret
   ```

4. Start the backend and frontend. Sign into Dispute Defender using
   `APP_PASSWORD`, not either PayPal account password.

## Seller-controlled dispute response workflow

The workflow is initiated by the buyer in PayPal. The seller signs in, selects
**Sync PayPal** to load or refresh disputes, and then opens a case to add
supporting evidence. AI analysis is available only after seller evidence has
been saved; it compares the dispute details with buyer and seller evidence and
generates a draft response. The seller must review the analysis and draft,
confirm that the content is accurate, and explicitly submit the requested
evidence to PayPal. The backend does not sync, analyze, or submit disputes in
the background.

The **AI assistant** panel can check local AI availability and run analysis on
request. It never submits evidence. The PayPal action submits formal dispute
evidence, not a buyer chat message.

## Exercise a dispute

Dispute Defender does not include a checkout flow and cannot create Sandbox
payments or disputes. First create a Sandbox payment to the Business account
using a PayPal Sandbox checkout integration or sample app, and complete payment
as the Personal buyer. Then use PayPal's Sandbox account tools to raise a
dispute against that transaction if the Sandbox account exposes that option.
Creating a payment alone does not create a dispute.

Once PayPal has a dispute on the Business account:

1. Sign in to Dispute Defender and select **Sync PayPal**. Sync uses the Business account's
   Sandbox REST app credentials and lists disputes visible to that seller.
2. Open the dispute and add the scenario's seller evidence.
3. Run **Analyze evidence** to review claims, evidence gaps, and the generated
   response draft.
4. Review and edit the response, confirm the evidence is accurate, and select
   **Submit to PayPal**.
5. Confirm the submission outcome in Dispute Defender and PayPal.

The seller explicitly starts each sync and analysis; no background process
submits or drafts responses. The tracking IDs and text in manual test scenarios
should be clearly marked as fictional; they are for analysis only.

Sandbox behavior and dispute availability can differ from live PayPal. If the
Sandbox buyer cannot raise a dispute for a test payment, this app cannot
manufacture one; use a PayPal-provided Sandbox dispute/test fixture if available
for your account, or test analysis separately with local sample data.

Each saved evidence record can include one JPEG or PNG image up to 5 MB. The
image is stored with that evidence in the local SQLite database and associated
with the matching evidence type. When you submit that type to PayPal, the
associated image is included. This is an application-side limit; PayPal may
apply additional document rules. The image and structured evidence details are
sent in separate requests because PayPal's published Customer Disputes
specification documents a multipart `evidence-file` field but does not document
a JSON metadata field in that same multipart request. If the image upload
succeeds but PayPal does not confirm the details request, check the dispute in
PayPal before retrying to avoid duplicate evidence.

The dispute details page previews seller images stored by this app. It also
previews buyer-submitted image attachments when PayPal includes a downloadable
document URL under its content-documents API and the seller's PayPal API access
can retrieve it. PayPal documents downloadable evidence URLs as a limited-
release capability, so some buyer attachments may appear by name without an
available image preview. The AI does not inspect image contents.

The case page displays the seven stages from buyer dispute creation through
seller-approved submission. The backend rejects analysis when no seller
evidence exists, requires current analysis and explicit seller confirmation
before submission, and invalidates analysis when evidence or synced PayPal
details change.
