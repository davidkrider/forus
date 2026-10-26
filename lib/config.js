// lib/config.js
// Defaults + chrome.storage.local.

export const DEFAULT_CONFIG = {
  enabled: true,
  backend: "jev", // "jev" (TypeSafe cloud) | "laya" (local MLX)
  apiKey: "",
  layaEndpoint: "http://127.0.0.1:8765/v1/systemone",
  layaModel: "aac6fef/laya-mlx",

  // Keep if payload >= minValueToKeep.
  // Hide only if payload is below the keep line AND
  // max(hijack, vacuity, persona, bot) >= minNoiseToHide.
  minValueToKeep: 2,
  minNoiseToHide: 2,

  // Harvest follower/following/volume, display name, handle, and bio from the
  // timeline payload X already loaded. Bot-shaped graphs raise noise locally;
  // name/handle/bio go to Jev as the persona score. Neither overrides a real point.
  useAccountSignals: true,
  // Accounts you follow (from timeline User.relationship_perspectives, not a
  // following-list fetch) get −1 on the noise used to hide. Hijack 3 still hides.
  lenientOnFollows: true,
  // Regions to treat as noise (country/region names, e.g. "Russia", "Nigeria").
  // Matched against X's "Account based in" (score 3) and the self-typed profile
  // location (score 2). Counts in max(noise); a real point still keeps.
  blockedRegions: [],
  // Opt-in: look up "Account based in" for authors not seen before. One throttled,
  // cached request per new author. Off means only what X loads on its own.
  fetchBasedIn: false,
  // Shown Community Notes go to Jev as context. Pending notes (CN contributors)
  // are a badge only — not a hide bit. Named mutes stay on X, not here.
  useCommunityNotes: true,

  // Live classification overlay on x.com. On by default while tuning;
  // turn it off from the popup once you trust the filter.
  showPanel: true
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
