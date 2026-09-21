// page-hook.js  (MAIN world — runs in X's page JS, document_start)
// Taps fetch/XHR that X already makes for the timeline. No extra API calls.
// Posts compact user + Community Note fields to the isolated content script.

(() => {
  const SOURCE = "forus-hook";
  const users = new Map(); // handle -> record
  const tweets = new Map(); // tweetId -> record
  const dirtyUsers = new Set();
  const dirtyTweets = new Set();
  let flushTimer = null;
  let hooked = false;

  function num(...cands) {
    for (const c of cands) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function asHandle(raw) {
    const s = String(raw || "").trim().replace(/^@/, "");
    return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s.toLowerCase() : "";
  }

  function parseUser(node) {
    if (!node || typeof node !== "object") return null;
    if (node.result && node.result !== node) return parseUser(node.result);
    if (node.user_results) return parseUser(node.user_results);
    const legacy = node.legacy && typeof node.legacy === "object" ? node.legacy : {};
    const core = node.core && typeof node.core === "object" ? node.core : {};
    const rc =
      node.relationship_counts || node.relationshipCounts || node.relationshipcounts || {};
    const tc = node.tweet_counts || node.tweetCounts || {};
    const handle = asHandle(core.screen_name || core.screenName || legacy.screen_name);
    if (!handle) return null;
    const followers = num(rc.followers, rc.follower_count, legacy.followers_count);
    const following = num(rc.following, rc.follow_count, legacy.friends_count);
    const tweetsN = num(tc.tweets, tc.tweet_count, legacy.statuses_count);
    const createdAt = core.created_at || core.createdAt || legacy.created_at || null;
    if (followers == null && following == null && tweetsN == null && !createdAt) return null;
    return {
      handle,
      restId: node.rest_id || node.restId || legacy.id_str || "",
      followers,
      following,
      tweets: tweetsN,
      createdAt: createdAt ? String(createdAt) : null
    };
  }

  function parseNote(pivot) {
    if (!pivot || typeof pivot !== "object") return null;
    const sub = pivot.subtitle;
    const text = typeof sub === "string" ? sub : sub && typeof sub.text === "string" ? sub.text : "";
    const id = pivot.note?.rest_id || pivot.note?.id || null;
    if (text && text.trim()) {
      return { status: "shown", text: text.trim().slice(0, 500), id: id ? String(id) : null };
    }
    if (pivot.note || pivot.destinationUrl || pivot.footer) {
      return { status: "pending", text: "", id: id ? String(id) : null };
    }
    return { status: "pending", text: "", id: null };
  }

  function parseTweet(node) {
    if (!node || typeof node !== "object") return null;
    if (
      node.result &&
      node.result !== node &&
      (node.result.rest_id || node.result.legacy || node.result.core)
    ) {
      return parseTweet(node.result);
    }
    if (node.tweet && node.tweet !== node) return parseTweet(node.tweet);
    const legacy = node.legacy && typeof node.legacy === "object" ? node.legacy : {};
    const tweetId = String(node.rest_id || node.restId || legacy.id_str || "");
    if (!/^\d{5,}$/.test(tweetId)) return null;
    const isTweet =
      node.__typename === "Tweet" ||
      node.__typename === "TweetWithVisibilityResults" ||
      typeof legacy.full_text === "string" ||
      !!node.birdwatch_pivot ||
      !!(legacy.id_str && (node.core?.user_results || node.author_user));
    if (!isTweet) return null;
    const user = parseUser(
      node.core?.user_results || node.author_user || node.author || legacy.user
    );
    let note = null;
    if (node.birdwatch_pivot) note = parseNote(node.birdwatch_pivot);
    else if (node.has_birdwatch_notes) note = { status: "pending", text: "", id: null };
    return { tweetId, handle: user?.handle || "", user, note };
  }

  function rememberUser(u) {
    if (!u) return;
    const prev = (u.handle && users.get(u.handle)) || {};
    const merged = {
      handle: u.handle || prev.handle || "",
      restId: u.restId || prev.restId || "",
      followers: u.followers ?? prev.followers ?? null,
      following: u.following ?? prev.following ?? null,
      tweets: u.tweets ?? prev.tweets ?? null,
      createdAt: u.createdAt || prev.createdAt || null
    };
    if (merged.handle) {
      users.set(merged.handle, merged);
      dirtyUsers.add(merged.handle);
    }
  }

  function rememberTweet(t) {
    if (!t?.tweetId) return;
    rememberUser(t.user);
    const prev = tweets.get(t.tweetId) || {};
    const note = t.note?.status === "shown" ? t.note : t.note || prev.note || null;
    tweets.set(t.tweetId, {
      tweetId: t.tweetId,
      handle: t.handle || t.user?.handle || prev.handle || "",
      note
    });
    dirtyTweets.add(t.tweetId);
  }

  function walk(node, seen, budget) {
    if (!budget.n || !node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    budget.n -= 1;
    const tw = parseTweet(node);
    if (tw) rememberTweet(tw);
    const u = parseUser(node);
    if (u) rememberUser(u);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, seen, budget);
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === "object") walk(v, seen, budget);
    }
  }

  function harvest(data) {
    if (!data || typeof data !== "object") return;
    walk(data, new WeakSet(), { n: 8000 });
    if (!flushTimer) flushTimer = setTimeout(flush, 80);
  }

  function flush() {
    flushTimer = null;
    const payload = {
      source: SOURCE,
      users: [...dirtyUsers].map((h) => users.get(h)).filter(Boolean),
      tweets: [...dirtyTweets].map((id) => tweets.get(id)).filter(Boolean)
    };
    dirtyUsers.clear();
    dirtyTweets.clear();
    if (!payload.users.length && !payload.tweets.length) return;
    window.postMessage(payload, window.location.origin);
  }

  function interestingUrl(raw) {
    const url = String(raw || "");
    return /\/i\/api\/graphql\//.test(url) || /\/graphql\//.test(url);
  }

  function hookFetch() {
    const orig = window.fetch;
    if (typeof orig !== "function") return;
    window.fetch = function (input, init) {
      const p = orig.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input && input.url;
        if (!interestingUrl(url)) return p;
        p.then((res) => {
          if (!res || !res.ok) return;
          res
            .clone()
            .json()
            .then(harvest)
            .catch(() => {});
        }).catch(() => {});
      } catch (_) {}
      return p;
    };
  }

  function hookXhr() {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this._forusUrl = url;
      } catch (_) {}
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener("load", function () {
          if (!interestingUrl(this._forusUrl)) return;
          try {
            harvest(JSON.parse(this.responseText));
          } catch (_) {}
        });
      } catch (_) {}
      return send.apply(this, arguments);
    };
  }

  if (!hooked) {
    hooked = true;
    hookFetch();
    hookXhr();
  }
})();
