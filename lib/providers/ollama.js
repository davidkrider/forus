// lib/providers/ollama.js
// Local model via Ollama. No API key. Free at the margin, fully private.
//
// Two setup gotchas (documented in CLAUDE.md):
//   1. Ollama must allow the extension's origin via CORS. Set the OLLAMA_ORIGINS env
//      var to include `chrome-extension://*` (or your extension id) and restart Ollama.
//   2. http://localhost/* is already in host_permissions so the background can reach it.

import { parseVerdicts } from "../json.js";

export async function classify({ settings, system, user, signal }) {
  const { model, endpoint } = settings;

  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json", // Ollama will constrain output to valid JSON.
      options: { temperature: 0 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.message?.content || "";
  return parseVerdicts(text);
}
