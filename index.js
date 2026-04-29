// MLA Chart Renderer
//
// Accepts POST /process-html with { html: string }
// Returns { html: string, charts_rendered: number, charts_failed: number }
//
// For each [MERMAID]...[/MERMAID] block in the input:
//   1. POST the Mermaid syntax to kroki.io to render as PNG
//   2. Upload the PNG to Google Drive
//   3. Set the file to "anyone with link can view"
//   4. Replace the marker with <img src="..." width="600" />
//
// Invalid Mermaid (kroki returns non-2xx) is silently dropped — the marker is removed
// and the prose continues unchanged. No broken charts in the output Doc.

import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "5mb" }));

// ---- Config from environment ----
const PORT = process.env.PORT || 3000;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const KROKI_URL = process.env.KROKI_URL || "https://kroki.io/mermaid/png";
const IMAGE_WIDTH = parseInt(process.env.IMAGE_WIDTH || "600", 10);

if (!DRIVE_FOLDER_ID) throw new Error("DRIVE_FOLDER_ID env var required");
if (!SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var required");

// ---- Google Drive auth ----
const credentials = JSON.parse(SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });

// ---- Render one Mermaid block to PNG via kroki.io ----
async function renderMermaid(mermaidSyntax) {
  const res = await fetch(KROKI_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: mermaidSyntax,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`kroki ${res.status}: ${errText.slice(0, 200)}`);
    err.kroki = true;
    throw err;
  }

  return Buffer.from(await res.arrayBuffer());
}

// ---- Upload PNG to Drive, return public URL ----
async function uploadToDrive(pngBuffer, fileName) {
  // Convert Buffer to a Readable stream for Drive's media body
  const { Readable } = await import("stream");
  const stream = Readable.from(pngBuffer);

  const fileMetadata = {
    name: fileName,
    parents: [DRIVE_FOLDER_ID],
  };

  const fileRes = await drive.files.create({
    requestBody: fileMetadata,
    media: { mimeType: "image/png", body: stream },
    fields: "id",
    supportsAllDrives: true,
  });

  const fileId = fileRes.data.id;

  // Make publicly viewable
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
    supportsAllDrives: true,
  });

  // Standard public URL pattern (matches existing infographic image URL format)
  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}

// ---- Process one Mermaid block end to end. Returns the replacement HTML or null on failure. ----
async function processOneMermaid(mermaidSyntax, idx) {
  try {
    const trimmed = mermaidSyntax.trim();
    if (!trimmed) {
      console.warn(`[chart ${idx}] empty mermaid block, skipping`);
      return null;
    }

    const png = await renderMermaid(trimmed);
    const fileName = `chart-${Date.now()}-${idx}.png`;
    const url = await uploadToDrive(png, fileName);

    return `<p style="text-align:center;"><img src="${url}" width="${IMAGE_WIDTH}" /></p>`;
  } catch (err) {
    console.warn(`[chart ${idx}] failed: ${err.message}`);
    return null; // signals "drop the marker, keep the prose"
  }
}

// ---- Main entry: process all markers in an HTML blob ----
async function processHtml(html) {
  // Match [MERMAID] ... [/MERMAID] blocks. Non-greedy, captures the inner content.
  const markerRe = /\[MERMAID\]([\s\S]*?)\[\/MERMAID\]/g;

  const matches = [];
  let m;
  while ((m = markerRe.exec(html)) !== null) {
    matches.push({ full: m[0], inner: m[1], index: m.index });
  }

  if (matches.length === 0) {
    return { html, charts_rendered: 0, charts_failed: 0 };
  }

  // Process all charts in parallel — kroki + Drive uploads aren't free latency-wise,
  // and there's no order dependency between charts.
  const replacements = await Promise.all(
    matches.map((match, i) => processOneMermaid(match.inner, i)),
  );

  // Walk the original HTML and substitute each marker. We iterate matches in order,
  // building the output string segment by segment. This avoids regex-replace edge cases
  // with special characters in the URL.
  let out = "";
  let cursor = 0;
  let rendered = 0;
  let failed = 0;

  matches.forEach((match, i) => {
    out += html.slice(cursor, match.index);
    const replacement = replacements[i];
    if (replacement) {
      out += replacement;
      rendered++;
    } else {
      // Failed → drop the marker entirely. Prose flows through.
      failed++;
    }
    cursor = match.index + match.full.length;
  });
  out += html.slice(cursor);

  return { html: out, charts_rendered: rendered, charts_failed: failed };
}

// ---- HTTP endpoints ----
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "mla-chart-renderer", version: "1.0.0" });
});

app.post("/process-html", async (req, res) => {
  const { html } = req.body || {};
  if (typeof html !== "string") {
    return res.status(400).json({ error: "Missing or invalid 'html' field" });
  }

  try {
    const result = await processHtml(html);
    console.log(`processed: rendered=${result.charts_rendered}, failed=${result.charts_failed}`);
    res.json(result);
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`mla-chart-renderer listening on ${PORT}`);
});
