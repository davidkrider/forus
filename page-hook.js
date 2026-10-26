// page-hook.js  (MAIN world — runs in X's page JS, document_start)
// Taps fetch/XHR that X already makes for the timeline. Posts compact user +
// Community Note fields to the isolated content script. The only request it
// makes on its own is the opt-in "Account based in" lookup below.

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
    const name = String(core.name || legacy.name || "").trim();
    const bio = String(
      node.profile_bio?.description ||
        node.profileBio?.description ||
        legacy.description ||
        ""
    ).trim();
    const followers = num(rc.followers, rc.follower_count, legacy.followers_count);
    const following = num(rc.following, rc.follow_count, legacy.friends_count);
    const tweetsN = num(tc.tweets, tc.tweet_count, legacy.statuses_count);
    const createdAt = core.created_at || core.createdAt || legacy.created_at || null;
    const loc = String(
      (typeof node.location === "object" ? node.location?.location : "") ||
        legacy.location ||
        ""
    ).trim();
    const about = node.about_profile || node.aboutProfile || null;
    const basedIn =
      about && typeof about === "object"
        ? String(about.account_based_in || about.accountBasedIn || "").trim()
        : null;
    const rp = node.relationship_perspectives || node.relationshipPerspectives || {};
    const iFollow =
      rp.following === true || rp.following === false
        ? rp.following
        : legacy.following === true || legacy.following === false
          ? legacy.following
          : null;
    return {
      handle,
      name,
      bio: bio.slice(0, 240),
      restId: node.rest_id || node.restId || legacy.id_str || "",
      followers,
      following,
      tweets: tweetsN,
      createdAt: createdAt ? String(createdAt) : null,
      iFollow,
      location: loc.slice(0, 80),
      basedIn
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
      name: u.name || prev.name || "",
      bio: u.bio || prev.bio || "",
      restId: u.restId || prev.restId || "",
      followers: u.followers ?? prev.followers ?? null,
      following: u.following ?? prev.following ?? null,
      tweets: u.tweets ?? prev.tweets ?? null,
      createdAt: u.createdAt || prev.createdAt || null,
      iFollow: typeof u.iFollow === "boolean" ? u.iFollow : prev.iFollow,
      location: u.location || prev.location || "",
      basedIn: typeof u.basedIn === "string" ? u.basedIn : prev.basedIn ?? null
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

  // --- "Account based in" lookups (opt-in; content.js decides which handles) --
  // Reuses the headers X's own client sends, so the request looks like opening
  // the About sheet. Throttled hard; stops on 429.

  const FALLBACK_ABOUT_IDS = ["zs_jFPFT78rBpXv9Z3U2YQ", "XRqGa7EeokUU5kppkh13EA"];
  const ABOUT_GAP_MS = 2500;
  const ABOUT_PER_HOUR = 120;
  const ABOUT_BACKOFF_MS = 15 * 60 * 1000;
  const xHeaders = {};
  let aboutQueryId = "";
  let origFetch = null;
  const aboutQueue = [];
  const aboutQueued = new Set();
  const aboutSent = [];
  let aboutTimer = null;
  let aboutPausedUntil = 0;

  function learnFromRequest(url, headers) {
    const m = String(url || "").match(/\/graphql\/([A-Za-z0-9_-]+)\/AboutAccountQuery/);
    if (m) aboutQueryId = m[1];
    if (!headers) return;
    const get = (k) =>
      typeof headers.get === "function" ? headers.get(k) : headers[k] ?? headers[k.toLowerCase()];
    for (const k of [
      "authorization",
      "x-csrf-token",
      "x-twitter-auth-type",
      "x-twitter-active-user",
      "x-twitter-client-language"
    ]) {
      const v = get(k);
      if (v) xHeaders[k] = String(v);
    }
  }

  function csrfFromCookie() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function postAbout(handle, basedIn, status) {
    window.postMessage(
      { source: SOURCE, about: [{ handle, basedIn: basedIn || "", status }] },
      window.location.origin
    );
  }

  function scheduleAbout() {
    if (aboutTimer || !aboutQueue.length) return;
    const wait = Math.max(ABOUT_GAP_MS, aboutPausedUntil - Date.now());
    aboutTimer = setTimeout(runAbout, wait);
  }

  async function runAbout() {
    aboutTimer = null;
    if (!aboutQueue.length) return;
    const now = Date.now();
    if (now < aboutPausedUntil) return scheduleAbout();
    while (aboutSent.length && now - aboutSent[0] > 3600000) aboutSent.shift();
    if (aboutSent.length >= ABOUT_PER_HOUR) {
      aboutPausedUntil = aboutSent[0] + 3600000;
      window.postMessage({ source: SOURCE, aboutStatus: "hourly-cap" }, window.location.origin);
      return scheduleAbout();
    }
    if (!xHeaders.authorization || document.hidden) return scheduleAbout();

    const handle = aboutQueue.shift();
    aboutQueued.delete(handle);
    aboutSent.push(now);
    const headers = {
      ...xHeaders,
      "x-csrf-token": csrfFromCookie() || xHeaders["x-csrf-token"] || "",
      "content-type": "application/json"
    };
    const ids = [...new Set([aboutQueryId, ...FALLBACK_ABOUT_IDS].filter(Boolean))];
    const vars = encodeURIComponent(JSON.stringify({ screenName: handle }));
    let done = false;
    for (const id of ids) {
      try {
        const res = await origFetch.call(
          window,
          `/i/api/graphql/${id}/AboutAccountQuery?variables=${vars}`,
          { headers, credentials: "include" }
        );
        if (res.status === 404) continue;
        if (res.status === 429) {
          aboutPausedUntil = Date.now() + ABOUT_BACKOFF_MS;
          aboutQueue.unshift(handle);
          aboutQueued.add(handle);
          window.postMessage({ source: SOURCE, aboutStatus: "rate-limited" }, window.location.origin);
          done = true;
          break;
        }
        if (!res.ok) break;
        const data = await res.json();
        aboutQueryId = id;
        const about = data?.data?.user_result_by_screen_name?.result?.about_profile;
        postAbout(handle, about?.account_based_in, about ? "ok" : "none");
        done = true;
        break;
      } catch (_) {
        break;
      }
    }
    if (!done) postAbout(handle, "", "error");
    scheduleAbout();
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d?.source !== "forus-content" || d.type !== "about-lookup") return;
    for (const raw of d.handles || []) {
      const h = asHandle(raw);
      if (!h || aboutQueued.has(h)) continue;
      aboutQueued.add(h);
      aboutQueue.push(h);
    }
    while (aboutQueue.length > 200) aboutQueued.delete(aboutQueue.shift());
    scheduleAbout();
  });

  function hookFetch() {
    const orig = window.fetch;
    if (typeof orig !== "function") return;
    origFetch = orig;
    window.fetch = function (input, init) {
      const p = orig.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input && input.url;
        if (!interestingUrl(url)) return p;
        learnFromRequest(url, init?.headers || (typeof input === "object" ? input.headers : null));
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
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this._forusUrl = url;
        this._forusHeaders = {};
      } catch (_) {}
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        if (this._forusHeaders) this._forusHeaders[String(k).toLowerCase()] = v;
      } catch (_) {}
      return setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (interestingUrl(this._forusUrl)) learnFromRequest(this._forusUrl, this._forusHeaders);
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
