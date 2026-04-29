// Quick local check — verify the regex parsing logic without making any network calls.
// Run with: node test-regex.js

const sample = `<h1>Acute bronchitis</h1>
<p>Some prose before any chart.</p>

[MERMAID]
flowchart TD
  A[Suspected acute bronchitis] --> B{Red flags?}
  B -->|Yes| C[Admit, urgent CXR]
  B -->|No| D[Supportive care]
[/MERMAID]

<p>Prose between two charts.</p>

[MERMAID]
flowchart LR
  X --> Y --> Z
[/MERMAID]

<p>Trailing prose.</p>`;

const markerRe = /\[MERMAID\]([\s\S]*?)\[\/MERMAID\]/g;

const matches = [];
let m;
while ((m = markerRe.exec(sample)) !== null) {
  matches.push({ full: m[0], inner: m[1].trim(), index: m.index });
}

console.log(`Found ${matches.length} marker(s):\n`);
matches.forEach((match, i) => {
  console.log(`--- Chart ${i + 1} (at index ${match.index}) ---`);
  console.log(match.inner);
  console.log();
});

// Verify the rebuild logic produces correct HTML when each marker is replaced
const fakeReplacements = matches.map((_, i) => `<IMG${i + 1}>`);
let out = "";
let cursor = 0;
matches.forEach((match, i) => {
  out += sample.slice(cursor, match.index);
  out += fakeReplacements[i];
  cursor = match.index + match.full.length;
});
out += sample.slice(cursor);

console.log("--- Rebuilt HTML (with IMG placeholders) ---");
console.log(out);
