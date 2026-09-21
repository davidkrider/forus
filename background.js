// background.js (service worker, type: module)
// Holds the API key (cloud Jev) and talks to System One — either TypeSafe or
// a local laya-mlx server. The content script never sees credentials.

import { loadConfig } from "./lib/config.js";
import {
  classify,
  JEV_ENDPOINT,
  JEV_MODEL,
  LAYA_ENDPOINT,
  LAYA_MODEL
} from "./lib/systemone.js";
import { KEEP_SCORES } from "./lib/rubric.js";
import * as cache from "./lib/cache.js";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function classifyItems(items) {
  const result = {};
  const misses = [];
  const missKeyById = {};

  for (const it of items) {
    const key = cache.hashText(
      [it.text, it.account?.handle || "", it.account?.name || "", it.account?.bio || "", it.note?.status || "", it.note?.text || ""].join("\n")
    );
    const cached = cache.get(key);
    if (cached) {
      result[it.id] = { ...cached, cached: true };
    } else {
      misses.push(it);
      missKeyById[it.id] = key;
    }
  }

  if (misses.length === 0) return result;

  const config = await loadConfig();
  const local = config.backend === "laya";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), local ? 60000 : 30000);

  let verdicts;
  try {
    const batches = chunk(misses, local ? 1 : misses.length);
    verdicts = [];
    for (const batch of batches) {
      const part = await classify({
        endpoint: local ? config.layaEndpoint || LAYA_ENDPOINT : JEV_ENDPOINT,
        apiKey: local ? "" : config.apiKey,
        model: local ? config.layaModel || LAYA_MODEL : JEV_MODEL,
        items: batch,
        signal: controller.signal,
        compact: local
      });
      verdicts.push(...part);
    }
  } finally {
    clearTimeout(timeout);
  }

  const byId = {};
  for (const v of verdicts) byId[v.id] = v;

  for (const it of misses) {
    const v = byId[it.id] || {
      scores: KEEP_SCORES,
      category: "value",
      confidence: 0,
      reason: "no verdict"
    };
    result[it.id] = { ...v, cached: false };
    cache.set(missKeyById[it.id], v);
  }

  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "classify") {
    classifyItems(msg.items)
      .then((verdicts) => sendResponse({ ok: true, verdicts }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "test") {
    classifyItems([{ id: "test", text: "cope harder, nobody asked" }])
      .then((verdicts) => sendResponse({ ok: true, verdict: verdicts.test }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});
