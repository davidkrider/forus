// lib/json.js
// Tolerant extraction of the {"verdicts":[...]} payload from a model response.
// Small models occasionally wrap JSON in prose or code fences; we recover gracefully.

import { CATEGORIES } from "./rubric.js";

export function parseVerdicts(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Empty model response");
  }

  let text = rawText.trim();

  // Strip ```json ... ``` fences if present.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    // Fall back to the outermost { ... } span.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in model response");
    }
    obj = JSON.parse(text.slice(start, end + 1));
  }

  const verdicts = Array.isArray(obj) ? obj : obj.verdicts;
  if (!Array.isArray(verdicts)) {
    throw new Error("Model response missing 'verdicts' array");
  }

  return verdicts
    .filter((v) => v && v.id != null)
    .map((v) => ({
      id: String(v.id),
      category: CATEGORIES.includes(v.category) ? v.category : "neutral",
      confidence:
        typeof v.confidence === "number"
          ? Math.max(0, Math.min(1, v.confidence))
          : 0.5,
      reason: typeof v.reason === "string" ? v.reason.slice(0, 80) : ""
    }));
}
