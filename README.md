# MLA Chart Renderer

Small Node service that processes `[MERMAID]...[/MERMAID]` markers in HTML, rendering each via kroki.io and replacing the marker with an `<img>` tag pointing at the rendered PNG (uploaded to Google Drive).

Used by the MLA Textbook Chapters Make.com scenario, sat between the HTML compose step and the Drive-upload-and-convert-to-Doc step.

## What it does

```
input HTML:
  ...prose...
  [MERMAID]
  flowchart TD
    A --> B
  [/MERMAID]
  ...more prose...

output HTML:
  ...prose...
  <p style="text-align:center;"><img src="https://drive.google.com/uc?export=view&id=..." width="600" /></p>
  ...more prose...
```

Failed renders (invalid Mermaid, etc.) are silently dropped — the marker is removed, the prose continues unchanged. No broken charts in the output Doc.

## Setup

### 1. Google Cloud project + service account

You need a service account that can write to the Textbook Chapters Drive folder.

1. Go to console.cloud.google.com → create or select a project (use existing Medibuddy project if you have one)
2. Enable the **Google Drive API** (APIs & Services → Library → search "Drive API" → Enable)
3. IAM & Admin → Service Accounts → Create Service Account
   - Name: `mla-chart-renderer`
   - Skip role assignment (we'll use Drive sharing instead)
4. After creation, click into the service account → Keys → Add Key → Create New Key → JSON
5. Download the JSON file. Keep it safe — this is the credential.

### 2. Share Drive folder with the service account

The service account has an email like `mla-chart-renderer@<project>.iam.gserviceaccount.com` (it's in the JSON file under `client_email`).

1. Open the Textbook Chapters → img Drive folder
2. Click Share
3. Add the service account email as **Editor**
4. Save (don't notify, the service account isn't a real user)

### 3. Get the Drive folder ID

The folder ID is the long string in the folder's URL after `/folders/`. For the existing img folder, that's `1MX96o7hxJnNr-0HEDEpUOSmwjpqUfpuv`.

### 4. Deploy to Railway

In Railway:
1. New project → Deploy from GitHub (push this code to a new repo first)
2. Variables:
   - `DRIVE_FOLDER_ID` = `1MX96o7hxJnNr-0HEDEpUOSmwjpqUfpuv` (or whichever folder)
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = paste the entire contents of the JSON key file as a single string
   - `IMAGE_WIDTH` = `600` (optional, defaults to 600)
3. Deploy. Railway gives you a public URL like `https://mla-chart-renderer-production.up.railway.app`.

### 5. Test the deployment

```bash
curl https://your-railway-url.up.railway.app/
# → {"ok":true,"service":"mla-chart-renderer","version":"1.0.0"}

curl -X POST https://your-railway-url.up.railway.app/process-html \
  -H "Content-Type: application/json" \
  -d '{"html":"Before [MERMAID]flowchart TD\n  A[Start] --> B[End][/MERMAID] After"}'
# → {"html":"Before <p style=\"text-align:center;\"><img src=\"https://drive.google.com/...\" width=\"600\" /></p> After","charts_rendered":1,"charts_failed":0}
```

If both work, the service is healthy.

### 6. Wire into the Make scenario

In your Make scenario, after Compose a String (which builds the assembled HTML) and before the Drive Upload module:

1. Add an HTTP module
   - URL: `https://your-railway-url.up.railway.app/process-html`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body type: Raw → JSON
   - Body: `{ "html": "{{<id of Compose a String>.text}}" }` — the variable picker will give you the right reference
   - Parse response: Yes
2. The HTTP module's response will contain `data.html` — the processed HTML with charts rendered.
3. Update the Drive Upload module's `Data` field to use this processed HTML instead of the raw Compose a String output.

## Local development

```bash
cd chart-renderer
npm install

# Set env vars (in .env or shell)
export DRIVE_FOLDER_ID=1MX96o7hxJnNr-0HEDEpUOSmwjpqUfpuv
export GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'  # paste key file content

npm run dev
# Service runs on http://localhost:3000
```

## API

### `GET /`
Health check. Returns `{ok: true, ...}`.

### `POST /process-html`
Body: `{"html": "<string>"}` (max 5MB)

Response 200: `{"html": "<processed string>", "charts_rendered": N, "charts_failed": N}`
Response 400: `{"error": "..."}` if input is malformed.
Response 500: `{"error": "..."}` if Drive upload or auth fails (unrecoverable; not per-chart).

Per-chart kroki failures don't bubble up as 500 — they're logged and the marker is silently dropped.

## How the regex works

The marker regex is `/\[MERMAID\]([\s\S]*?)\[\/MERMAID\]/g`:
- `[\s\S]*?` matches any character including newlines, non-greedy
- `g` flag iterates all matches

This handles multi-line Mermaid blocks correctly. The non-greedy match means two markers in the same string are kept separate (rather than the regex spanning from the first `[MERMAID]` to the last `[/MERMAID]`).

## Failure modes and what happens

| Failure | Effect |
|---|---|
| kroki.io down | All chart blocks fail → markers dropped, prose intact |
| Invalid Mermaid syntax (e.g. unclosed bracket) | That chart fails → marker dropped, others continue |
| Drive upload fails (rare — auth issue) | Chart fails → marker dropped, error logged |
| Service account permission missing | Drive uploads fail → all charts dropped, errors logged |
| Empty Mermaid block (`[MERMAID][/MERMAID]`) | Skipped, marker dropped |
| Service crashes mid-request | 500 returned, Make HTTP module errors |

The deliberate design: per-chart failures are silent (so chapters always generate). Service-level failures (auth, Drive permissions) are visible (so they get fixed).

## Cost

- kroki.io: free, no auth, no rate limit (be reasonable)
- Drive uploads: counts against the service account's storage quota (15GB free)
- Railway: depends on your plan; this service is lightweight, sub-second per request

Net cost per chapter generation: £0.
