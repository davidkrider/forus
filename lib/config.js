// lib/config.js
// Central configuration: defaults, storage helpers, and the per-provider settings shape.
// Used by both the background worker and the popup. Stored in chrome.storage.local.

export const DEFAULT_CONFIG = {
  enabled: true,
  provider: "anthropic", // "anthropic" | "openai" | "ollama"

  // Which categories get hidden, and the confidence floor below which we leave a
  // reply visible. "substantive" and "neutral" are NEVER hidden by design.
  hideCategories: ["dismissive", "ragebait", "bad_faith"],
  minConfidence: 0.6,

  // Per-provider settings. Only the selected provider's block is used at runtime.
  providers: {
    anthropic: {
      apiKey: "",
      model: "claude-haiku-4-5-20251001",
      endpoint: "https://api.anthropic.com/v1/messages"
    },
    openai: {
      // Works against any OpenAI-compatible endpoint: OpenAI, OpenRouter, Together,
      // a rented vLLM/TGI box, etc. Just change endpoint + model + key.
      apiKey: "",
      model: "gpt-4o-mini",
      endpoint: "https://api.openai.com/v1/chat/completions"
    },
    ollama: {
      // Local. No key. Requires `OLLAMA_ORIGINS` to allow the extension origin.
      model: "llama3.2:3b",
      endpoint: "http://localhost:11434/api/chat"
    }
  }
};

const STORAGE_KEY = "replyFilterConfig";

// Deep-ish merge so new default keys appear for users with older stored config.
function merge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(override || {})) {
    const a = base?.[k];
    const b = override[k];
    out[k] =
      a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(b)
        ? merge(a, b)
        : b;
  }
  return out;
}

export async function loadConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const config = merge(DEFAULT_CONFIG, stored[STORAGE_KEY] || {});
  if (!(config.provider in DEFAULT_CONFIG.providers)) {
    config.provider = DEFAULT_CONFIG.provider;
  }
  return config;
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

export function onConfigChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      callback(merge(DEFAULT_CONFIG, changes[STORAGE_KEY].newValue || {}));
    }
  });
}
