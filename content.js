// content.js  (classic content script — runs in X's page, isolated world)
// Responsibilities:
//   1. Watch the timeline for new tweet nodes (MutationObserver).
//   2. Extract each tweet's text and a stable-ish id.
//   3. Batch new ones and ask the background worker to classify them.
//   4. Collapse + blur posts whose scores fail the keep/hide rule, with a "Show" reveal.
//   5. Drive a shadow-DOM activity panel so you can see verdicts as you scroll.
//
// This is the part most likely to break when X ships DOM changes. The one stable
// foothold is data-testid attributes (their own test suite depends on them).
//
// No imports here on purpose: the API key and Jev logic live in the background
// worker, so nothing sensitive is ever exposed to the page context.

(() => {
  const PROCESSED_ATTR = "data-rf-id";
  let counter = 0;
  const elById = new Map(); // id -> element (so we can act on the verdict later)
  const textById = new Map(); // id -> post text (for corrections)
  const verdictById = new Map(); // id -> last verdict
  const queue = []; // [{ id, text }] pending classification
  let flushTimer = null;
  let inFlight = 0;

  // Settings mirror, refreshed from storage. Defaults match lib/config.js.
  let settings = {
    enabled: true,
    minValueToKeep: 2,
    minNoiseToHide: 2,
    showPanel: true
  };

  function applyConfig(c) {
    if (!c) return;
    settings.enabled = c.enabled ?? settings.enabled;
    settings.minValueToKeep = c.minValueToKeep ?? settings.minValueToKeep;
    settings.minNoiseToHide = c.minNoiseToHide ?? settings.minNoiseToHide;
    settings.showPanel = c.showPanel ?? settings.showPanel;
    panel.setVisible(settings.showPanel);
    panel.setPaused(!settings.enabled);
    if (!settings.enabled) revealAll();
    else reapplyAll();
  }

  function loadSettings() {
    chrome.storage.local.get(["forusConfig", "keeplineConfig", "replyFilterConfig"], (res) => {
      applyConfig(res.forusConfig || res.keeplineConfig || res.replyFilterConfig);
    });
  }

  // --- Activity panel -------------------------------------------------------
  // Shadow DOM so X's stylesheet can't restyle it. Dark instrument matching
  // the popup: counts on the header, a live log of each verdict, click a row
  // to scroll that post into view.

  const PANEL_CSS = `
    :host {
      display: block;
      position: fixed;
      right: 16px;
      bottom: 72px;
      z-index: 2147483646;
      width: 320px;
      max-width: calc(100vw - 24px);
      color-scheme: dark;
    }
    :host([hidden]) { display: none; }
    * { box-sizing: border-box; }
    .wrap {
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      color: #ece7da;
      background: #14130f;
      border: 1px solid #2c2a22;
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45);
      overflow: hidden;
    }
    .wrap.paused { opacity: 0.72; }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid #2c2a22;
      cursor: default;
    }
    .title {
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #8d8675;
      flex: 1;
    }
    .status {
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #8d8675;
    }
    .wrap[data-kind="busy"] .status { color: #e0772d; }
    .wrap[data-kind="error"] .status { color: #e26d6d; }
    .icon {
      appearance: none;
      width: 22px; height: 22px;
      border: 1px solid #2c2a22;
      border-radius: 6px;
      background: transparent;
      color: #ece7da;
      font: 14px/1 sans-serif;
      cursor: pointer;
    }
    .icon:hover { background: #1c1a15; }
    .counts {
      padding: 6px 10px;
      font: 10px/1.3 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #8d8675;
      border-bottom: 1px solid #2c2a22;
    }
    .log {
      max-height: 340px;
      overflow: auto;
    }
    .wrap.collapsed .counts,
    .wrap.collapsed .log { display: none; }
    .wrap.collapsed .head { border-bottom: 0; cursor: pointer; }
    .empty {
      padding: 16px 12px;
      color: #8d8675;
      font-size: 12px;
    }
    .row {
      display: block;
      width: 100%;
      text-align: left;
      appearance: none;
      border: 0;
      border-bottom: 1px solid #2c2a22;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 8px 10px;
      cursor: pointer;
    }
    .row:hover { background: #1c1a15; }
    .row-top {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 3px;
    }
    .action {
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #8d8675;
    }
    .row.hide .action { color: #e0772d; }
    .row.keep .action { color: #6fbf73; }
    .row.error .quote { color: #e26d6d; }
    .cat {
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #ece7da;
    }
    .conf {
      margin-left: auto;
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #8d8675;
    }
    .quote {
      color: #ece7da;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      margin-top: 2px;
      font-size: 11px;
      color: #8d8675;
    }
  `;

  const panel = createPanel();
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.forusConfig) applyConfig(changes.forusConfig.newValue);
    else if (changes.keeplineConfig) applyConfig(changes.keeplineConfig.newValue);
    else if (changes.replyFilterConfig) applyConfig(changes.replyFilterConfig.newValue);
  });

  function createPanel() {
    const MAX = 80;
    const host = document.createElement("div");
    host.id = "rf-host";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const head = document.createElement("div");
    head.className = "head";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "ForUs";

    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "idle";

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "icon";
    collapseBtn.title = "Collapse";
    collapseBtn.textContent = "–";

    head.append(title, status, collapseBtn);

    const counts = document.createElement("div");
    counts.className = "counts";
    counts.textContent = "0 seen · 0 hidden · 0 kept";

    const log = document.createElement("div");
    log.className = "log";

    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Scroll the timeline. New posts show up here.";
    log.append(empty);

    wrap.append(head, counts, log);
    shadow.append(style, wrap);
    (document.documentElement || document.body).append(host);
    host.addEventListener("mousedown", (e) => e.stopPropagation());
    host.addEventListener("click", (e) => e.stopPropagation());

    const stats = { seen: 0, hidden: 0, kept: 0 };
    const rows = new Map(); // id -> row element
    let collapsed = false;
    let paused = false;

    function renderCounts() {
      counts.textContent = `${stats.seen} seen · ${stats.hidden} hidden · ${stats.kept} kept`;
    }

    function setStatus(kind, detail) {
      wrap.dataset.kind = kind;
      if (paused) {
        status.textContent = "paused";
        return;
      }
      if (kind === "busy") status.textContent = `classifying ${detail}…`;
      else if (kind === "error") status.textContent = "error";
      else status.textContent = inFlight > 0 ? `classifying ${inFlight}…` : "idle";
    }

    function refreshBusy() {
      if (paused) {
        setStatus("idle");
        return;
      }
      setStatus(inFlight > 0 ? "busy" : "idle", inFlight);
    }

    collapseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      collapsed = !collapsed;
      wrap.classList.toggle("collapsed", collapsed);
      collapseBtn.textContent = collapsed ? "+" : "–";
      collapseBtn.title = collapsed ? "Expand" : "Collapse";
    });

    head.addEventListener("click", (e) => {
      if (e.target === collapseBtn) return;
      if (!collapsed) return;
      collapseBtn.click();
    });

    function ensureLogReady() {
      if (empty.parentNode) empty.remove();
    }

    function trim() {
      while (log.childElementCount > MAX) {
        const old = log.lastElementChild;
        for (const [id, row] of rows) {
          if (row === old) rows.delete(id);
        }
        old.remove();
      }
    }

    function snippet(text) {
      const one = String(text || "").replace(/\s+/g, " ").trim();
      return one.length > 90 ? one.slice(0, 89) + "…" : one;
    }

    function makeRow(id, text) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row pending";
      row.dataset.id = id;

      const top = document.createElement("div");
      top.className = "row-top";
      const action = document.createElement("span");
      action.className = "action";
      action.textContent = "…";
      const cat = document.createElement("span");
      cat.className = "cat";
      cat.textContent = "pending";
      const conf = document.createElement("span");
      conf.className = "conf";
      top.append(action, cat, conf);

      const quote = document.createElement("div");
      quote.className = "quote";
      quote.textContent = snippet(text);

      const meta = document.createElement("div");
      meta.className = "meta";

      row.append(top, quote, meta);
      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = elById.get(id);
        if (el && el.isConnected) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      });
      return { row, action, cat, conf, meta };
    }

    return {
      setVisible(on) {
        host.hidden = !on;
      },
      setPaused(on) {
        paused = on;
        wrap.classList.toggle("paused", on);
        refreshBusy();
      },
      pending(items) {
        ensureLogReady();
        for (const it of items) {
          if (rows.has(it.id)) continue;
          const bits = makeRow(it.id, it.text);
          rows.set(it.id, bits);
          log.prepend(bits.row);
        }
        trim();
        refreshBusy();
      },
      verdict(id, v, hidden) {
        let bits = rows.get(id);
        if (!bits) {
          ensureLogReady();
          bits = makeRow(id, "");
          rows.set(id, bits);
          log.prepend(bits.row);
          trim();
        }
        bits.row.className = "row " + (hidden ? "hide" : "keep");
        bits.action.textContent = hidden ? "hide" : "keep";
        bits.cat.textContent = scoreTag(v);
        bits.conf.textContent = "";
        const parts = [];
        if (v.reason) parts.push(v.reason);
        parts.push(v.cached ? "cache" : "model");
        bits.meta.textContent = parts.join(" · ");
      },
      error(message) {
        ensureLogReady();
        const row = document.createElement("div");
        row.className = "row error";
        const quote = document.createElement("div");
        quote.className = "quote";
        quote.textContent = message || "Classification failed";
        row.append(quote);
        log.prepend(row);
        trim();
        setStatus("error");
      },
      count(hidden) {
        stats.seen += 1;
        if (hidden) stats.hidden += 1;
        else stats.kept += 1;
        renderCounts();
      },
      refreshBusy
    };
  }

  // --- Extraction -----------------------------------------------------------

  function extractText(article) {
    const node = article.querySelector('[data-testid="tweetText"]');
    return node ? node.innerText.trim() : "";
  }

  function extractAuthor(article) {
    // Identity only — copied into our banner so we don't leave X's user-name
    // node live (that would bring hover cards back). Profile bios are not in
    // the tweet card; User-Name is display name + @handle.
    const nameBlock = article.querySelector('[data-testid="User-Name"]');
    const lines = nameBlock
      ? nameBlock.innerText.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
    let name = "";
    let handle = "";
    for (const line of lines) {
      if (line === "·") continue;
      if (/^\d+\s*[smhd]$/i.test(line)) continue;
      if (/^[A-Z][a-z]{2}\s+\d/.test(line)) continue; // "Mar 4" timestamps
      if (!handle && /^@[\w.]+/.test(line)) {
        handle = line.split(/\s+/)[0];
        continue;
      }
      if (!name) name = line;
    }
    if (!handle) {
      const href = article.querySelector('a[href^="/"][role="link"]')?.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9_]+)/);
      if (m && !["i", "home", "explore", "search"].includes(m[1])) handle = "@" + m[1];
    }
    const avatarImg = article.querySelector(
      '[data-testid="Tweet-User-Avatar"] img, img[src*="profile_images"]'
    );
    const bioNode = article.querySelector('[data-testid="UserDescription"]');
    return {
      name: name || "Unknown",
      handle,
      avatar: avatarImg?.currentSrc || avatarImg?.src || "",
      bio: bioNode ? bioNode.innerText.trim() : ""
    };
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
      textById.set(id, text);
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
    inFlight += batch.length;
    panel.pending(batch);
    panel.refreshBusy();

    chrome.runtime.sendMessage({ type: "classify", items: batch }, (resp) => {
      inFlight = Math.max(0, inFlight - batch.length);
      if (chrome.runtime.lastError || !resp) {
        panel.error(
          chrome.runtime.lastError?.message ||
            "No response from background worker — reload the extension."
        );
        panel.refreshBusy();
        return;
      }
      if (!resp.ok) {
        panel.error(resp.error || "Classification failed");
        panel.refreshBusy();
        return;
      }
      applyVerdicts(resp.verdicts);
      panel.refreshBusy();
    });
  }

  // --- Applying verdicts ----------------------------------------------------

  function dimMax(scores, dims) {
    let m = 0;
    for (const d of dims) {
      const n = Number(scores?.[d]);
      if (Number.isFinite(n) && n > m) m = n;
    }
    return m;
  }

  function valueOf(v) {
    return dimMax(v?.scores, ["useful", "interesting", "funny"]);
  }

  function noiseOf(v) {
    return dimMax(v?.scores, ["ragebait", "propaganda", "stupid"]);
  }

  function scoreTag(v) {
    return `v${valueOf(v)} n${noiseOf(v)}`;
  }

  // Keep if value >= minValueToKeep. Hide only when value is below that
  // AND noise >= minNoiseToHide. Explicit rf labels win.
  function shouldHide(v) {
    if (!v) return false;
    if (v.forceKeep) return false;
    if (v.forceHide) return true;
    return valueOf(v) < settings.minValueToKeep && noiseOf(v) >= settings.minNoiseToHide;
  }

  function applyVerdicts(verdicts) {
    for (const id of Object.keys(verdicts)) {
      const v = verdicts[id];
      verdictById.set(id, v);
      applyOne(id, v);
      panel.count(shouldHide(v));
    }
  }

  function applyOne(id, v) {
    const hidden = shouldHide(v);
    panel.verdict(id, v, hidden);
    const el = elById.get(id);
    if (!el || !el.isConnected) return;
    if (hidden) {
      if (el.classList.contains("rf-hidden")) {
        const label = el.querySelector(".rf-label");
        if (label) label.textContent = "Hidden · " + scoreTag(v);
      } else {
        hide(el, v);
      }
    } else {
      revealOne(el);
    }
  }

  function reapplyAll() {
    for (const [id, v] of verdictById) applyOne(id, v);
  }

  function hide(article, verdict) {
    if (article.classList.contains("rf-hidden")) return;
    article.classList.add("rf-hidden");

    const author = extractAuthor(article);

    const banner = document.createElement("button");
    banner.className = "rf-banner";
    banner.type = "button";

    if (author.avatar) {
      const avatar = document.createElement("img");
      avatar.className = "rf-avatar";
      avatar.src = author.avatar;
      avatar.alt = "";
      banner.append(avatar);
    }

    const who = document.createElement("span");
    who.className = "rf-who";
    const name = document.createElement("span");
    name.className = "rf-name";
    name.textContent = author.name;
    who.append(name);
    if (author.handle) {
      const handle = document.createElement("span");
      handle.className = "rf-handle";
      handle.textContent = author.handle;
      who.append(handle);
    }
    if (author.bio) {
      const bio = document.createElement("span");
      bio.className = "rf-bio";
      bio.textContent = author.bio;
      who.append(bio);
    }
    banner.append(who);

    const aside = document.createElement("span");
    aside.className = "rf-aside";
    const label = document.createElement("span");
    label.className = "rf-label";
    label.textContent = "Hidden · " + scoreTag(verdict);
    const affordance = document.createElement("span");
    affordance.className = "rf-show";
    affordance.textContent = "Show post";
    aside.append(label);
    attachMark(aside, article.getAttribute(PROCESSED_ATTR), false);
    aside.append(affordance);
    banner.append(aside);

    // X binds hover/click on the article (and via delegation on ancestors).
    // Stop those events at the banner so a collapsed row never opens a tweet,
    // hover card, or media preview. Reveal is click-only, on this button.
    const block = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    for (const type of [
      "mouseenter",
      "mouseover",
      "mousemove",
      "mouseleave",
      "pointerenter",
      "pointerover",
      "pointermove",
      "pointerdown",
      "mousedown",
      "mouseup",
      "auxclick"
    ]) {
      banner.addEventListener(type, block);
    }
    banner.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealOne(article);
    });
    article.prepend(banner);
  }

  function revealOne(article) {
    article.classList.remove("rf-hidden");
    const id = article.getAttribute(PROCESSED_ATTR);
    const b = article.querySelector(":scope > .rf-banner");
    if (b) b.remove();
    if (id) attachMark(article, id, true);
  }

  function revealAll() {
    for (const el of document.querySelectorAll("article.rf-hidden")) {
      revealOne(el);
    }
  }

  const VERDICT_BUTTONS = [
    ["keep", "Keep"],
    ["hide", "Hide"]
  ];

  function attachMark(host, id, floating) {
    if (!host || !id) return;
    const article = elById.get(id);
    let mark = article && article.querySelector(".rf-mark");
    if (!mark) {
      mark = document.createElement("button");
      mark.type = "button";
      mark.className = "rf-mark";
      mark.textContent = "rf";
      mark.title = "Correct this label";
      const stop = (e) => e.stopPropagation();
      for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup"]) {
        mark.addEventListener(type, stop);
      }
      mark.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPicker(mark, id);
      });
    }
    mark.classList.toggle("rf-mark-float", !!floating);
    if (floating && article) article.classList.add("rf-marked");
    host.appendChild(mark);
  }

  let picker = null;
  let pickerId = null;
  let onPickerOutside = null;

  function closePicker() {
    if (picker) picker.hidden = true;
    pickerId = null;
    if (onPickerOutside) {
      document.removeEventListener("pointerdown", onPickerOutside, true);
      onPickerOutside = null;
    }
  }

  function openPicker(anchor, id) {
    if (!picker) picker = createPicker();
    if (pickerId === id && !picker.hidden) {
      closePicker();
      return;
    }
    pickerId = id;
    picker.hidden = false;
    const current = verdictById.get(id);
    const currentVerdict = current?.forceHide ? "hide" : current?.forceKeep ? "keep" : shouldHide(current) ? "hide" : "keep";
    for (const btn of picker.querySelectorAll("[data-verdict]")) {
      btn.classList.toggle("on", btn.dataset.verdict === currentVerdict);
    }
    const rect = anchor.getBoundingClientRect();
    const pad = 8;
    let top = rect.bottom + 6;
    let left = rect.right - 140;
    if (left < pad) left = pad;
    if (left + 140 > window.innerWidth - pad) left = window.innerWidth - 140 - pad;
    if (top + 120 > window.innerHeight - pad) top = Math.max(pad, rect.top - 126);
    picker.style.top = top + "px";
    picker.style.left = left + "px";

    if (onPickerOutside) document.removeEventListener("pointerdown", onPickerOutside, true);
    onPickerOutside = (e) => {
      if (picker.contains(e.target) || e.target === anchor || anchor.contains(e.target)) return;
      closePicker();
    };
    document.addEventListener("pointerdown", onPickerOutside, true);
  }

  function createPicker() {
    const el = document.createElement("div");
    el.id = "rf-picker";
    el.hidden = true;
    const title = document.createElement("div");
    title.className = "rf-picker-title";
    title.textContent = "This post should";
    el.append(title);
    for (const [value, label] of VERDICT_BUTTONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.verdict = value;
      btn.textContent = label;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        submitCorrection(pickerId, value);
      });
      el.append(btn);
    }
    const stop = (e) => e.stopPropagation();
    for (const type of [
      "mouseenter",
      "mouseover",
      "mousemove",
      "pointerdown",
      "mousedown",
      "click"
    ]) {
      el.addEventListener(type, stop);
    }
    document.documentElement.append(el);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePicker();
    });
    return el;
  }

  function submitCorrection(id, verdict) {
    const text = textById.get(id);
    closePicker();
    if (!id || !text) return;
    chrome.runtime.sendMessage({ type: "correct", text, verdict }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        panel.error(resp?.error || chrome.runtime.lastError?.message || "Could not save correction");
        return;
      }
      const v = resp.verdict;
      verdictById.set(id, v);
      applyOne(id, v);
    });
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
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
