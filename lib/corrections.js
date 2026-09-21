// lib/corrections.js
// User-labeled posts. Newest first. The hard cap is how many we keep on disk;
// config.maxCorrections is how many of those get sent with each Jev call.

const STORAGE_KEY = "forusCorrections";
const LEGACY_KEYS = ["keeplineCorrections", "replyFilterCorrections"];
export const HARD_CAP = 50;

export async function loadCorrections() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, ...LEGACY_KEYS]);
  if (Array.isArray(stored[STORAGE_KEY])) return stored[STORAGE_KEY];
  for (const key of LEGACY_KEYS) {
    if (Array.isArray(stored[key])) return stored[key];
  }
  return [];
}

export async function addCorrection({ text, verdict, category }) {
  const list = await loadCorrections();
  const next = list.filter((c) => c.text !== text);
  next.unshift({
    text,
    verdict: verdict || undefined,
    category: category || undefined,
    at: Date.now()
  });
  while (next.length > HARD_CAP) next.pop();
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export function recent(list, n) {
  const count = Math.max(0, Math.min(HARD_CAP, Number(n) || 0));
  return list.slice(0, count);
}
