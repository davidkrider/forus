// lib/providers/anthropic.js
// Anthropic Messages API. Requires an API key from console.anthropic.com.
//
// NOTE: a Claude Pro/Max subscription does NOT work here — that only authenticates
// the claude.ai web app. You need a separate API key with a small credit balance.
// For Haiku classifying short replies the cost is fractions of a cent per call.
//
// The `anthropic-dangerous-direct-browser-access` header is required because the API
// rejects browser-origin requests by default. The key only ever lives in the
// background service worker, never in the page/content script.

import { parseVerdicts } from "../json.js";

export async function classify({ settings, system, user, signal }) {
  const { apiKey, model, endpoint } = settings;
  if (!apiKey) throw new Error("Anthropic API key not set (open the extension popup).");

  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return parseVerdicts(text);
}
