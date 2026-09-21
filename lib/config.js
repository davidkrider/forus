// lib/config.js
// Defaults + chrome.storage.local.

export const DEFAULT_CONFIG = {
  enabled: true,
  backend: "jev", // "jev" (TypeSafe cloud) | "laya" (local MLX)
  apiKey: "",
  layaEndpoint: "http://127.0.0.1:8765/v1/systemone",
  layaModel: "aac6fef/laya-mlx",

  // Keep if max(useful, interesting, funny) >= minValueToKeep.
  // Hide only if that value is below the keep line AND
  // max(ragebait, propaganda, stupid) >= minNoiseToHide.
  minValueToKeep: 2,
  minNoiseToHide: 2,

  // Live classification overlay on x.com. On by default while tuning;
  // turn it off from the popup once you trust the filter.
  showPanel: true,

  // How many of your recent Keep/Hide labels to send with each call.
  // 0 = don't send them (exact-text overrides still apply). Cap is 50.
  maxCorrections: 20
};

export const STORAGE_KEY = "forusConfig";
const LEGACY_KEYS = ["keeplineConfig", "replyFilterConfig"];

function merge(base, override) {
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    if (k in base) out[k] = override[k];
  }
  return out;
}

function pickApiKey(raw) {
  if (raw?.apiKey) return raw.apiKey;
  return raw?.providers?.jev?.apiKey || "";
}

export async function loadConfig() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, ...LEGACY_KEYS]);
  const raw = stored[STORAGE_KEY] || stored.keeplineConfig || stored.replyFilterConfig || {};
  const config = merge(DEFAULT_CONFIG, raw);
  config.apiKey = pickApiKey(raw) || config.apiKey || "";
  if (config.backend !== "laya") config.backend = "jev";
  return config;
}

export async function saveConfig(config) {
  const next = merge(DEFAULT_CONFIG, config);
  next.apiKey = String(config?.apiKey || "");
  next.backend = config?.backend === "laya" ? "laya" : "jev";
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

export function onConfigChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const change = changes[STORAGE_KEY] || changes.keeplineConfig || changes.replyFilterConfig;
    if (change) callback(merge(DEFAULT_CONFIG, change.newValue || {}));
  });
}
