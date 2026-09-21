// lib/cache.js
// Tiny LRU cache: text -> verdict. X's timeline is virtualized, so the same posts
// re-render constantly as you scroll. Without this you'd reclassify each tweet dozens
// of times. This is the single highest-leverage performance piece.
//
// The cache lives in the service worker's memory and is cleared if the worker is
// evicted by the browser. That's acceptable for v1 (recompute is cheap). To persist
// across worker restarts, back it with chrome.storage.session — see AGENTS.md.

const MAX_ENTRIES = 2000;
const store = new Map(); // insertion-ordered; we exploit that for LRU

// FNV-1a, 32-bit. Short stable key from arbitrary post text.
export function hashText(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function get(key) {
  if (!store.has(key)) return undefined;
  const value = store.get(key);
  // Touch: move to most-recently-used position.
  store.delete(key);
  store.set(key, value);
  return value;
}

export function set(key, value) {
  if (store.has(key)) store.delete(key);
  store.set(key, value);
  while (store.size > MAX_ENTRIES) {
    store.delete(store.keys().next().value); // evict oldest
  }
}

export function del(key) {
  store.delete(key);
}
