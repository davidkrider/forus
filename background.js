// background.js (service worker, type: module)
// The only place that holds the API key and talks to the model. The content script
// never sees credentials. Flow:
//   content.js --{classify, items}--> background --> cache check --> provider call -->
//   cache store --> {verdicts} --> content.js
//
// Also handles a "test" message from the popup so users can verify their backend.

import { loadConfig } from "./lib/config.js";
import { getProvider } from "./lib/providers/index.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./lib/rubric.js";
import * as cache from "./lib/cache.js";

async function classifyItems(items) {
  // items: [{ id, text }]. id is the content-script's per-element id; we key the cache
  // on text so re-rendered duplicates with new ids still hit.
  const result = {}; // id -> verdict
  const misses = []; // items needing a model call
  const missKeyById = {};

  for (const it of items) {
    const key = cache.hashText(it.text);
    const cached = cache.get(key);
    if (cached) {
      result[it.id] = cached;
    } else {
      misses.push(it);
      missKeyById[it.id] = key;
    }
  }

  if (misses.length === 0) return result;

  const config = await loadConfig();
  const provider = getProvider(config.provider);
  const settings = config.providers[config.provider];

  const system = SYSTEM_PROMPT;
  const user = buildUserMessage(misses);

  // Abort if the model hangs.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let verdicts;
  try {
    verdicts = await provider.classify({
      settings,
      system,
      user,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  // Map verdicts back by id, store fresh ones in the cache by text-hash.
  const byId = {};
  for (const v of verdicts) byId[v.id] = v;

  for (const it of misses) {
    const v = byId[it.id] || { category: "neutral", confidence: 0, reason: "no verdict" };
    result[it.id] = v;
    cache.set(missKeyById[it.id], v);
  }

  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "classify") {
    classifyItems(msg.items)
      .then((verdicts) => sendResponse({ ok: true, verdicts }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep the message channel open for the async response
  }

  if (msg?.type === "test") {
    // Single-item smoke test from the popup.
    classifyItems([{ id: "test", text: "cope harder, nobody asked" }])
      .then((verdicts) => sendResponse({ ok: true, verdict: verdicts.test }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});
