// lib/providers/openai.js
// Any OpenAI-compatible chat-completions endpoint. This is your "rent a cloud LLM"
// path: point `endpoint` at OpenAI, OpenRouter, Together, Groq, a self-hosted vLLM /
// text-generation-inference box, etc., set `model` and `apiKey`, and it works.
//
// If you use a custom host, add it to host_permissions in manifest.json (or grant it
// via optional permissions) or the background fetch will be blocked.

import { parseVerdicts } from "../json.js";

export async function classify({ settings, system, user, signal }) {
  const { apiKey, model, endpoint } = settings;

  const headers = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      // Ask for a JSON object. Supported by OpenAI + most compatible servers; harmless
      // if ignored because parseVerdicts is tolerant.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI-compatible ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  return parseVerdicts(text);
}
