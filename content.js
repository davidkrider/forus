// content.js  (classic content script — runs in X's page, isolated world)
// Responsibilities:
//   1. Watch the timeline for new tweet nodes (MutationObserver).
//   2. Extract each tweet's text and a stable-ish id.
//   3. Batch new ones and ask the background worker to classify them.
//   4. Collapse + blur posts whose scores fail the keep/hide rule, with a "Show" reveal.
//   5. Stamp a compact v/n chip left of the Grok icon; click it for the score breakdown.
//   6. Drive a shadow-DOM activity panel so you can see verdicts as you scroll.
//   7. Listen for timeline GraphQL harvests (account stats, Community Notes) from page-hook.js.
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
  const verdictById = new Map(); // id -> last verdict
  const queue = []; // [{ id, text }] pending classification
  let flushTimer = null;
  let inFlight = 0;

  // Settings mirror, refreshed from storage. Defaults match lib/config.js.
  let settings = {
    enabled: true,
    minValueToKeep: 2,
    minNoiseToHide: 2,
    showPanel: true,
    useAccountSignals: true,
    useCommunityNotes: true
  };

  function applyConfig(c) {
    if (!c) return;
    settings.enabled = c.enabled ?? settings.enabled;
    settings.minValueToKeep = c.minValueToKeep ?? settings.minValueToKeep;
    settings.minNoiseToHide = c.minNoiseToHide ?? settings.minNoiseToHide;
    settings.showPanel = c.showPanel ?? settings.showPanel;
    settings.useAccountSignals = c.useAccountSignals ?? settings.useAccountSignals;
    settings.useCommunityNotes = c.useCommunityNotes ?? settings.useCommunityNotes;
    panel.setVisible(settings.showPanel);
    panel.setPaused(!settings.enabled);
    for (const v of verdictById.values()) {
      applyBotPrior(v, settings.useAccountSignals ? v.signals?.account : null);
    }
    if (!settings.enabled) {
      revealAll();
      clearScoreChips();
    } else {
      reapplyAll();
    }
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
      bio: bioNode ? bioNode.innerText.trim() : null
    };
  }

  const usersByHandle = new Map();
  const tweetsById = new Map();

  function extractTweetId(article) {
    const timeEl = ownQuery(article, 'a[href*="/status/"] time');
    const link = timeEl ? timeEl.closest("a") : ownQuery(article, 'a[href*="/status/"]');
    const href = link?.getAttribute("href") || "";
    const m = href.match(/\/status\/(\d+)/);
    return m ? m[1] : "";
  }

  function extractDomNote(article) {
    const pivot =
      ownQuery(article, '[data-testid="birdwatch_pivot"]') ||
      ownQuery(article, '[data-testid="birdwatch"]');
    if (pivot) {
      const text = pivot.innerText.replace(/\s+/g, " ").trim();
      if (text) return { status: "shown", text: text.slice(0, 500), id: null };
    }
    const href = ownQuery(article, 'a[href*="/i/birdwatch/"]');
    if (href) return { status: "shown", text: href.innerText.trim().slice(0, 500), id: null };
    return null;
  }

  // Keep in sync with lib/signals.js botScore().
  function botShape(account) {
    if (!account) return { score: 0, why: "" };
    const fol = Number(account.followers);
    const fing = Number(account.following);
    const tweets = Number(account.tweets);
    if (!Number.isFinite(fol) || !Number.isFinite(fing)) return { score: 0, why: "" };
    const sameMag = Math.abs(Math.log10(fol + 1) - Math.log10(fing + 1)) < 0.35;
    const material = fol >= 80 && fing >= 80;
    let age = null;
    if (account.createdAt) {
      const t = Date.parse(account.createdAt);
      if (Number.isFinite(t)) age = Math.max(0.04, (Date.now() - t) / 86400000);
    }
    const perDay = Number.isFinite(tweets) && age ? tweets / age : null;
    const fmt = (n) =>
      n >= 1e6
        ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "m"
        : n >= 1e3
          ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k"
          : String(Math.round(n));
    const bits = [];
    if (sameMag && material) bits.push(`follows≈followers (${fmt(fing)}/${fmt(fol)})`);
    if (perDay != null && perDay >= 25) bits.push(`${Math.round(perDay)} tweets/day`);
    if (age != null && age < 30 && material) bits.push(`joined ${Math.round(age)}d ago`);
    let score = 0;
    if (sameMag && material) score = 1;
    if (sameMag && material && perDay != null && perDay >= 25) score = 2;
    if (sameMag && material && perDay != null && perDay >= 60) score = 3;
    if (sameMag && material && age != null && age < 14 && perDay != null && perDay >= 20) {
      score = Math.max(score, 2);
    }
    if (sameMag && material && age != null && age < 7 && perDay != null && perDay >= 40) {
      score = 3;
    }
    if (!score) return { score: 0, why: "" };
    return { score, why: bits.join(" · ") };
  }

  function mergeAccount(sigAccount, author) {
    const handle = String(author?.handle || sigAccount?.handle || "")
      .replace(/^@/, "")
      .toLowerCase();
    const name = author?.name && author.name !== "Unknown" ? author.name : sigAccount?.name || "";
    const bio = author?.bio != null && author.bio !== "" ? author.bio : sigAccount?.bio;
    if (!sigAccount && !handle && !name) return null;
    const out = { ...(sigAccount || {}), handle, name };
    if (bio != null) out.bio = bio;
    return out;
  }

  function lookupSignals(tweetId, handle) {
    const key = String(handle || "")
      .replace(/^@/, "")
      .toLowerCase();
    const tw = tweetId ? tweetsById.get(tweetId) : null;
    const account = (key && usersByHandle.get(key)) || (tw?.handle && usersByHandle.get(tw.handle)) || null;
    let note = tw?.note || null;
    return { account, note };
  }

  function applyBotPrior(v, account) {
    if (!v) return v;
    v.signals = v.signals || {};
    v.signals.account = account || v.signals.account || null;
    if (!settings.useAccountSignals) {
      if (v.scores) {
        delete v.scores.bot;
        delete v.scores.persona;
      }
      if (v.breakdown) {
        delete v.breakdown.bot;
        delete v.breakdown.persona;
      }
      return v;
    }
    const bot = botShape(account);
    v.scores = { ...(v.scores || {}), bot: bot.score };
    v.breakdown = {
      ...(v.breakdown || {}),
      bot: { score: bot.score, level: bot.score, why: bot.why || "Not bot-shaped." }
    };
    return v;
  }

  function requeue(id, el) {
    if (!el?.isConnected) return;
    if (queue.some((it) => it.id === id)) return;
    const text = extractText(el);
    if (!text) return;
    queue.push(buildItem(el, id, text));
    scheduleFlush();
  }

  function buildItem(article, id, text) {
    const author = extractAuthor(article);
    const tweetId = extractTweetId(article);
    const handle = author.handle;
    if (tweetId) article.setAttribute("data-rf-tweet", tweetId);
    const sig = lookupSignals(tweetId, handle);
    const account = mergeAccount(sig.account, author);
    const domNote = extractDomNote(article);
    let note = sig.note;
    if (domNote && (!note || (domNote.status === "shown" && note.status !== "shown"))) {
      note = domNote;
    }
    return {
      id,
      text,
      tweetId,
      handle,
      account: settings.useAccountSignals ? account : null,
      note: settings.useCommunityNotes ? note : null,
      useAccountSignals: settings.useAccountSignals,
      useCommunityNotes: settings.useCommunityNotes
    };
  }

  function ingestHarvest(data) {
    for (const u of data.users || []) {
      if (!u?.handle) continue;
      const prev = usersByHandle.get(u.handle) || {};
      usersByHandle.set(u.handle, {
        handle: u.handle,
        name: u.name || prev.name || "",
        bio: u.bio || prev.bio || "",
        restId: u.restId || prev.restId || "",
        followers: u.followers ?? prev.followers ?? null,
        following: u.following ?? prev.following ?? null,
        tweets: u.tweets ?? prev.tweets ?? null,
        createdAt: u.createdAt || prev.createdAt || null
      });
    }
    for (const t of data.tweets || []) {
      if (!t?.tweetId) continue;
      const prev = tweetsById.get(t.tweetId) || {};
      const note =
        t.note?.status === "shown" ? t.note : t.note || prev.note || null;
      tweetsById.set(t.tweetId, {
        tweetId: t.tweetId,
        handle: t.handle || prev.handle || "",
        note
      });
    }
    for (const it of queue) {
      const sig = lookupSignals(it.tweetId, it.handle);
      if (sig.account) {
        it.account = mergeAccount(sig.account, {
          name: it.account?.name,
          handle: it.handle,
          bio: it.account?.bio
        });
      }
      if (sig.note && settings.useCommunityNotes) it.note = sig.note;
    }
    for (const [id, el] of elById) {
      if (!el?.isConnected) continue;
      const v = verdictById.get(id);
      if (!v?.scores) continue;
      const tweetId = el.getAttribute("data-rf-tweet") || extractTweetId(el);
      const author = extractAuthor(el);
      const sig = lookupSignals(tweetId, author.handle);
      const account = mergeAccount(sig.account, author);
      const prevBot = v.scores?.bot;
      const prevNote = v.signals?.note?.text || v.signals?.note?.status || "";
      const hadBio = Boolean(String(v.signals?.account?.bio || "").trim());
      applyBotPrior(v, account);
      if (settings.useCommunityNotes && sig.note) {
        v.signals = v.signals || {};
        v.signals.note = sig.note;
      }
      const nextBot = v.scores?.bot;
      const nextNote = v.signals?.note?.text || v.signals?.note?.status || "";
      const hasBio = Boolean(String(account?.bio || "").trim());
      if (settings.useAccountSignals && !hadBio && hasBio) {
        requeue(id, el);
      } else if (prevBot !== nextBot || prevNote !== nextNote) {
        applyOne(id, v);
      }
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (e.data?.source !== "forus-hook") return;
    ingestHarvest(e.data);
  });

  function collectNewTweets(root) {
    if (!root || root.nodeType !== 1) return;
    const found = [];
    if (root.matches?.('article[data-testid="tweet"]')) found.push(root);
    else {
      const host = root.closest?.('article[data-testid="tweet"]');
      if (host) found.push(host);
    }
    if (root.querySelectorAll) {
      for (const a of root.querySelectorAll('article[data-testid="tweet"]')) found.push(a);
    }
    const seen = new Set();
    for (const article of found) {
      if (seen.has(article)) continue;
      seen.add(article);
      if (article.hasAttribute(PROCESSED_ATTR)) {
        // X rebuilds tweet internals constantly; put the chip back if it vanished.
        ensureScoreChip(article);
        continue;
      }
      const text = extractText(article);
      if (!text) continue; // image-only / empty — leave visible
      const id = "rf" + counter++;
      article.setAttribute(PROCESSED_ATTR, id);
      elById.set(id, article);
      queue.push(buildItem(article, id, text));
      ensureScoreChip(article);
    }
    if (queue.length) scheduleFlush();
  }

  // --- Batching -------------------------------------------------------------

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 500); // wait for timeline GraphQL to land
  }

  function flush() {
    flushTimer = null;
    if (!settings.enabled || queue.length === 0) {
      queue.length = 0;
      return;
    }
    const batch = queue.splice(0, queue.length).map((it) => {
      const el = elById.get(it.id);
      if (!el || !el.isConnected) return it;
      const text = extractText(el) || it.text;
      return buildItem(el, it.id, text);
    });
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

  const VALUE_DIMS = ["payload"];
  const NOISE_DIMS = ["hijack", "vacuity", "persona"];
  const SIGNAL_NOISE_DIMS = ["bot"];

  function dimMax(scores, dims) {
    let m = 0;
    for (const d of dims) {
      const n = Number(scores?.[d]);
      if (Number.isFinite(n) && n > m) m = n;
    }
    return m;
  }

  function valueOf(v) {
    return dimMax(v?.scores, VALUE_DIMS);
  }

  function noiseOf(v) {
    return dimMax(v?.scores, [...NOISE_DIMS, ...SIGNAL_NOISE_DIMS]);
  }

  function formatScore(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "0";
    const r = Math.round(x * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }

  function scoreTag(v) {
    return `v${formatScore(valueOf(v))} n${formatScore(noiseOf(v))}`;
  }

  function scoreLabel(v) {
    if (!v?.scores) return "Scoring…";
    return `${shouldHide(v) ? "Hide" : "Keep"} ${scoreTag(v)}. Click for breakdown.`;
  }

  // Own-article query: quoted tweets are nested articles.
  function ownQuery(article, selector) {
    const nodes = article.querySelectorAll(selector);
    for (const n of nodes) {
      if (n.closest('article[data-testid="tweet"]') === article) return n;
    }
    return null;
  }

  function findScoreAnchor(article) {
    const grok = ownQuery(article, 'button[aria-label="Grok actions"]');
    const caret = ownQuery(article, '[data-testid="caret"]');
    const more = ownQuery(article, 'button[aria-label^="More"]');
    const btn = grok || caret || more;
    if (!btn) return null;

    // Park the chip as a sibling of the Grok/caret *cell* when that cell
    // lives in the compact top-right cluster — not in the User-Name row.
    const cell = btn.parentElement;
    const cluster = cell?.parentElement;
    if (
      cell &&
      cluster &&
      !ownQuery(cell, '[data-testid="User-Name"]') &&
      !ownQuery(cluster, '[data-testid="User-Name"]')
    ) {
      return cell;
    }
    return btn;
  }

  function ownScoreChip(article) {
    return ownQuery(article, ".rf-score");
  }

  function clearScoreChips() {
    closeScorePop();
    for (const chip of document.querySelectorAll(".rf-score")) chip.remove();
    for (const el of document.querySelectorAll("article.rf-scored")) {
      el.classList.remove("rf-scored");
    }
  }

  const SCORE_POP_CSS = `
    :host {
      display: block;
      position: fixed;
      z-index: 2147483647;
      width: 280px;
      max-width: calc(100vw - 16px);
      color-scheme: dark;
    }
    :host([hidden]) { display: none; }
    * { box-sizing: border-box; }
    .card {
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      color: #ece7da;
      background: #14130f;
      border: 1px solid #2c2a22;
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45);
      overflow: hidden;
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 10px 12px 8px;
      border-bottom: 1px solid #2c2a22;
    }
    .verdict {
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .verdict.keep { color: #6fbf73; }
    .verdict.hide { color: #e0772d; }
    .tag {
      margin-left: auto;
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      color: #ece7da;
    }
    .rule {
      padding: 8px 12px 10px;
      color: #8d8675;
      font-size: 11px;
      border-bottom: 1px solid #2c2a22;
    }
    .body {
      max-height: min(420px, calc(100vh - 24px));
      overflow: auto;
      padding: 6px 0 8px;
    }
    .sec {
      padding: 8px 12px 2px;
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #8d8675;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px 10px;
      padding: 6px 12px;
    }
    .row.win .name { color: #ece7da; }
    .name {
      font: 11px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #8d8675;
    }
    .n {
      font: 11px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      color: #8d8675;
    }
    .row.win.value .n { color: #6fbf73; }
    .row.win.noise .n { color: #e0772d; }
    .why {
      grid-column: 1 / -1;
      color: #ece7da;
      font-size: 11px;
      line-height: 1.35;
    }
    .mix {
      grid-column: 1 / -1;
      font: 10px/1.3 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #8d8675;
    }
    .acct, .note {
      padding: 8px 12px 10px;
      border-top: 1px solid #2c2a22;
      font-size: 11px;
      line-height: 1.35;
      color: #ece7da;
    }
    .acct {
      font: 10px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      color: #8d8675;
    }
    .note-k {
      display: block;
      margin-bottom: 4px;
      font: 10px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #8d8675;
    }
  `;

  let scorePop = null;
  let scorePopChip = null;
  let onScorePopOutside = null;

  function mixLabel(detail) {
    const probs = detail?.probabilities;
    if (!probs) return "";
    const entries = Object.entries(probs)
      .map(([k, p]) => [Number(k), Number(p)])
      .filter(([, p]) => Number.isFinite(p) && p > 0.04)
      .sort((a, b) => b[1] - a[1]);
    if (entries.length < 2) return "";
    return entries
      .slice(0, 3)
      .map(([k, p]) => `${k} ${Math.round(p * 100)}%`)
      .join("  ");
  }

  function ensureScorePop() {
    if (scorePop) return scorePop;
    const host = document.createElement("div");
    host.id = "rf-score-pop";
    host.hidden = true;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SCORE_POP_CSS;
    const card = document.createElement("div");
    card.className = "card";
    shadow.append(style, card);
    (document.documentElement || document.body).append(host);
    const halt = (e) => e.stopPropagation();
    for (const type of [
      "pointerdown",
      "mousedown",
      "mouseup",
      "click",
      "mouseenter",
      "mouseover"
    ]) {
      host.addEventListener(type, halt);
    }
    scorePop = { host, card };
    return scorePop;
  }

  function closeScorePop() {
    if (scorePopChip) {
      scorePopChip.setAttribute("aria-expanded", "false");
      scorePopChip = null;
    }
    if (scorePop) scorePop.host.hidden = true;
    if (onScorePopOutside) {
      document.removeEventListener("pointerdown", onScorePopOutside, true);
      document.removeEventListener("keydown", onScorePopKey, true);
      document.removeEventListener("scroll", onScorePopScroll, true);
      onScorePopOutside = null;
    }
  }

  function eventInScorePop(e) {
    const host = scorePop?.host;
    if (!host) return false;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    return path.includes(host) || e.target === host || host.contains(e.target);
  }

  function onScorePopScroll(e) {
    if (eventInScorePop(e)) return;
    closeScorePop();
  }

  function onScorePopKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeScorePop();
    }
  }

  function placeScorePop(chip) {
    const pop = ensureScorePop();
    const r = chip.getBoundingClientRect();
    const pad = 8;
    pop.host.hidden = false;
    const w = pop.host.offsetWidth;
    const h = pop.host.offsetHeight;
    let top = r.bottom + 6;
    let left = r.right - w;
    if (left < pad) left = pad;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
    pop.host.style.setProperty("--rf-top", top + "px");
    pop.host.style.setProperty("--rf-left", left + "px");
  }

  function appendDimRows(body, v, dims, kind) {
    const peak = kind === "value" ? valueOf(v) : noiseOf(v);
    for (const dim of dims) {
      const detail = v.breakdown?.[dim];
      const raw = detail?.score ?? v.scores?.[dim];
      const score = Number.isFinite(Number(raw)) ? Number(raw) : 0;
      const row = document.createElement("div");
      row.className = "row " + kind + (score === peak && peak > 0 ? " win" : "");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = dim;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = formatScore(score);
      row.append(name, n);
      const why = detail?.why;
      if (why) {
        const p = document.createElement("div");
        p.className = "why";
        p.textContent = why;
        row.append(p);
      }
      const mix = mixLabel(detail);
      if (mix) {
        const m = document.createElement("div");
        m.className = "mix";
        m.textContent = mix;
        row.append(m);
      }
      body.append(row);
    }
  }

  function renderScorePop(v) {
    const pop = ensureScorePop();
    const card = pop.card;
    card.replaceChildren();
    const hidden = shouldHide(v);
    const value = valueOf(v);
    const noise = noiseOf(v);

    const head = document.createElement("div");
    head.className = "head";
    const verdict = document.createElement("span");
    verdict.className = "verdict " + (hidden ? "hide" : "keep");
    verdict.textContent = hidden ? "Hide" : "Keep";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = scoreTag(v);
    head.append(verdict, tag);

    const rule = document.createElement("div");
    rule.className = "rule";
    rule.textContent = hidden
      ? `payload ${formatScore(value)} is below the keep line (${settings.minValueToKeep}) and noise ${formatScore(noise)} meets the hide floor (${settings.minNoiseToHide}).`
      : `payload ${formatScore(value)} meets the keep line (${settings.minValueToKeep}).`;

    const body = document.createElement("div");
    body.className = "body";
    const valueSec = document.createElement("div");
    valueSec.className = "sec";
    valueSec.textContent = "Payload";
    body.append(valueSec);
    appendDimRows(body, v, VALUE_DIMS, "value");
    const noiseSec = document.createElement("div");
    noiseSec.className = "sec";
    noiseSec.textContent = "Noise";
    body.append(noiseSec);
    appendDimRows(body, v, NOISE_DIMS.filter((d) => d !== "persona" || v.scores?.persona != null), "noise");
    if (v.scores && Object.prototype.hasOwnProperty.call(v.scores, "bot")) {
      appendDimRows(body, v, SIGNAL_NOISE_DIMS, "noise");
    }

    const account = v.signals?.account;
    if (
      account &&
      (account.name ||
        account.handle ||
        account.followers != null ||
        account.following != null ||
        account.tweets != null)
    ) {
      const acct = document.createElement("div");
      acct.className = "acct";
      const bits = [];
      if (account.name) bits.push(account.name);
      if (account.handle) bits.push("@" + String(account.handle).replace(/^@/, ""));
      if (account.followers != null) bits.push(`${account.followers} followers`);
      if (account.following != null) bits.push(`${account.following} following`);
      if (account.tweets != null) bits.push(`${account.tweets} tweets`);
      acct.textContent = bits.join(" · ");
      body.append(acct);
    }

    const note = v.signals?.note;
    if (note?.status) {
      const box = document.createElement("div");
      box.className = "note";
      const k = document.createElement("span");
      k.className = "note-k";
      k.textContent = note.status === "shown" ? "Community Note" : "Pending Community Note";
      box.append(k);
      const p = document.createElement("div");
      p.textContent =
        note.status === "shown" && note.text
          ? note.text
          : "A note is in rating. Not a hide signal.";
      box.append(p);
      body.append(box);
    }

    card.append(head, rule, body);
  }

  function openScorePop(chip) {
    const id = chip?.dataset?.id;
    const v = id ? verdictById.get(id) : null;
    if (!chip?.isConnected || !v?.scores) return;
    if (scorePopChip === chip && scorePop && !scorePop.host.hidden) {
      closeScorePop();
      return;
    }
    closeScorePop();
    renderScorePop(v);
    scorePopChip = chip;
    chip.setAttribute("aria-expanded", "true");
    placeScorePop(chip);
    onScorePopOutside = (e) => {
      if (eventInScorePop(e) || chip.contains(e.target)) return;
      closeScorePop();
    };
    document.addEventListener("pointerdown", onScorePopOutside, true);
    document.addEventListener("keydown", onScorePopKey, true);
    document.addEventListener("scroll", onScorePopScroll, true);
  }

  function ensureScoreChip(article) {
    if (!article || !article.isConnected) return;
    if (!settings.enabled || article.classList.contains("rf-hidden")) {
      const leftover = ownScoreChip(article);
      if (leftover) {
        if (scorePopChip === leftover) closeScorePop();
        leftover.remove();
      }
      article.classList.remove("rf-scored");
      return;
    }

    const id = article.getAttribute(PROCESSED_ATTR);
    if (!id) return;

    let chip = ownScoreChip(article);
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rf-score";
      chip.setAttribute("aria-expanded", "false");
      const stop = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup"]) {
        chip.addEventListener(type, stop);
      }
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openScorePop(chip);
      });
    }

    chip.dataset.id = id;
    const v = verdictById.get(id);
    if (!v) {
      chip.textContent = "…";
      chip.className = "rf-score pending";
      chip.setAttribute("aria-label", "Scoring…");
      chip.disabled = true;
    } else {
      const hidden = shouldHide(v);
      chip.disabled = false;
      chip.textContent = scoreTag(v);
      chip.className = "rf-score " + (hidden ? "hide" : "keep");
      chip.setAttribute("aria-label", scoreLabel(v));
      if (scorePopChip === chip && scorePop && !scorePop.host.hidden) {
        renderScorePop(v);
        placeScorePop(chip);
      }
    }

    const anchor = findScoreAnchor(article);
    if (anchor && anchor.parentNode) {
      chip.classList.remove("rf-score-float");
      article.classList.remove("rf-scored");
      if (anchor.previousElementSibling !== chip) {
        anchor.parentNode.insertBefore(chip, anchor);
      }
    } else {
      article.classList.add("rf-scored");
      chip.classList.add("rf-score-float");
      if (chip.parentNode !== article) article.appendChild(chip);
    }
  }

  // Keep if payload >= minValueToKeep. Hide only when payload is below that
  // AND noise >= minNoiseToHide.
  function shouldHide(v) {
    if (!v) return false;
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
    ensureScoreChip(el);
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
    const b = article.querySelector(":scope > .rf-banner");
    if (b) b.remove();
    ensureScoreChip(article);
  }

  function revealAll() {
    for (const el of document.querySelectorAll("article.rf-hidden")) {
      revealOne(el);
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
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
