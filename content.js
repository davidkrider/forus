// content.js  (classic content script — runs in X's page, isolated world)
// Responsibilities:
//   1. Watch the timeline for new tweet nodes (MutationObserver).
//   2. Extract each tweet's text and a stable-ish id.
//   3. Batch new ones and ask the background worker to classify them.
//   4. Collapse + blur replies whose verdict is in the hide list, with a "Show" reveal.
//
// This is the part most likely to break when X ships DOM changes. The one stable
// foothold is data-testid attributes (their own test suite depends on them).
//
// No imports here on purpose: the API key and provider logic live in the background
// worker, so nothing sensitive is ever exposed to the page context.

(() => {
  const PROCESSED_ATTR = "data-rf-id";
  let counter = 0;
  const elById = new Map(); // id -> element (so we can act on the verdict later)
  const queue = []; // [{ id, text }] pending classification
  let flushTimer = null;

  // Settings mirror, refreshed from storage. Defaults match lib/config.js.
  let settings = {
    enabled: true,
    hideCategories: ["dismissive", "ragebait", "bad_faith"],
    minConfidence: 0.6
  };

  function loadSettings() {
    chrome.storage.local.get("replyFilterConfig", (res) => {
      const c = res.replyFilterConfig;
      if (c) {
        settings.enabled = c.enabled ?? settings.enabled;
        settings.hideCategories = c.hideCategories ?? settings.hideCategories;
        settings.minConfidence = c.minConfidence ?? settings.minConfidence;
      }
    });
  }
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.replyFilterConfig) {
      loadSettings();
      if (!settings.enabled) revealAll();
    }
  });

  // --- Extraction -----------------------------------------------------------

  function extractText(article) {
    const node = article.querySelector('[data-testid="tweetText"]');
    return node ? node.innerText.trim() : "";
  }

  function collectNewTweets(root) {
    const articles = root.querySelectorAll
      ? root.querySelectorAll('article[data-testid="tweet"]')
      : [];
    for (const article of articles) {
      if (article.hasAttribute(PROCESSED_ATTR)) continue;
      const text = extractText(article);
      if (!text) continue; // image-only / empty — leave visible
      const id = "rf" + counter++;
      article.setAttribute(PROCESSED_ATTR, id);
      elById.set(id, article);
      queue.push({ id, text });
    }
    if (queue.length) scheduleFlush();
  }

  // --- Batching -------------------------------------------------------------

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 350); // debounce bursts of scroll-rendered nodes
  }

  function flush() {
    flushTimer = null;
    if (!settings.enabled || queue.length === 0) {
      queue.length = 0;
      return;
    }
    const batch = queue.splice(0, queue.length);
    chrome.runtime.sendMessage({ type: "classify", items: batch }, (resp) => {
      if (chrome.runtime.lastError || !resp) return; // worker asleep / no-op
      if (!resp.ok) {
        console.warn("[Reply Filter]", resp.error);
        return;
      }
      applyVerdicts(resp.verdicts);
    });
  }

  // --- Applying verdicts ----------------------------------------------------

  function shouldHide(v) {
    return (
      v &&
      settings.hideCategories.includes(v.category) &&
      v.confidence >= settings.minConfidence
    );
  }

  function applyVerdicts(verdicts) {
    for (const id of Object.keys(verdicts)) {
      const el = elById.get(id);
      if (!el || !el.isConnected) continue;
      if (shouldHide(verdicts[id])) hide(el, verdicts[id]);
    }
  }

  function hide(article, verdict) {
    if (article.classList.contains("rf-hidden")) return;
    article.classList.add("rf-hidden");

    const banner = document.createElement("div");
    banner.className = "rf-banner";
    banner.innerHTML =
      `<span class="rf-label">Hidden &middot; ${verdict.category}</span>` +
      `<button class="rf-show" type="button">Show reply</button>`;
    banner.querySelector(".rf-show").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      article.classList.remove("rf-hidden");
      banner.remove();
    });
    article.prepend(banner);
  }

  function revealAll() {
    for (const el of document.querySelectorAll("article.rf-hidden")) {
      el.classList.remove("rf-hidden");
      const b = el.querySelector(".rf-banner");
      if (b) b.remove();
    }
  }

  // --- Observe --------------------------------------------------------------

  collectNewTweets(document);
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) collectNewTweets(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
