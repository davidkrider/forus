# AGENTS.md — ForUs

Context for an AI pair-programmer (Cursor, Claude Code, etc.) working on this project.

## What this is

A Chrome (MV3) browser extension that filters **noise** on X (Twitter) —
engineered packaging and empty posts — while deliberately **never hiding real
contribution**, even when that contribution is blunt, terse, sarcastic, or harshly
worded. Each post is scored 0–3 on four independent Jev scales: **payload** (contribution)
vs **hijack** (engineered outrage/recruitment), **vacuity** (no thought / tabloid-empty),
and **persona** (how costume-like or controversial the account identity is). A local
**bot** prior from follow/tweet stats also counts as noise. Keep if payload ≥ the keep
line; hide only if payload is below that **and** max(hijack, vacuity, persona, bot, region)
clears the hide floor.

The backend is a typed decision model, not a chat LLM. **Jev** (TypeSafe cloud) or
**Laya** ([laya-mlx](https://github.com/mizorewww/laya-mlx) on Apple Silicon). Same
System One contract (`POST /v1/systemone`).

Built for personal use. GitHub-ready. The threat model is "I don't want to read
engineered outrage," not "ship to the Chrome Web Store."

## The single most important design constraint

The whole point is the line between **"blunt but real"** and **"pure noise."** A sharply
worded correct rebuttal must survive; a contentless sneer must not. If a change makes the
filter hide substantive-but-harsh posts, that change is wrong even if it "cleans up" the
timeline. When tuning, optimize for **precision against false positives on value**,
not for hiding more. The rubric encodes this; see `lib/rubric.js`. Hide rule:

`hide = payload < minValueToKeep AND noise ≥ minNoiseToHide` (defaults 2 and 2),
where noise is max(hijack, vacuity, persona, bot, region).

## Architecture

```
content.js ──{type:"classify", items}──▶ background.js ──▶ systemone.classify()
   ▲  (X page, isolated world)              (service worker)        │
   └──────────────{verdicts}───────────────────────────────────────┘
page-hook.js (MAIN world) harvests timeline GraphQL → postMessage → content.js
        Jev cloud  or  local laya-mlx (scripts/laya_server.py)
```

- **content.js** — runs in the X page. MutationObserver watches the virtualized timeline,
  extracts post text via `data-testid` selectors, batches new posts, and collapses/blurs
  the ones the verdict says to hide (with a "Show post" reveal). Also hosts the activity
  panel. Holds **no credentials**.
- **page-hook.js** — MAIN-world fetch/XHR hook. Reads User counts, whether you
  follow the author, profile location, and Community Notes from timeline JSON X
  already loaded. No extra profile or following-list calls. The only request it
  originates is the opt-in, throttled "Account based in" lookup.
- **background.js** — the only place with the API key. Checks the cache, batches misses into
  one System One call (one post at a time for local Laya), stores results, returns `{id: verdict}`.
  Also serves the popup's "test".
- **lib/systemone.js** — TypeSafe Jev or local Laya-MLX. Four Score questions per post
  (payload, hijack, vacuity, persona). Local bot overlay after answers.
- **scripts/laya_server.py** — wraps `laya-mlx` behind `POST /v1/systemone`.
- **lib/rubric.js** — rubric, score questions, few-shot examples. The file you'll edit most.
- **lib/cache.js** — in-memory LRU keyed on a hash of post text (X re-renders the same
  posts constantly while scrolling; without this we'd reclassify each many times).
- **popup.\*** — settings UI: backend (Jev vs Laya), API key or local endpoint, sliders, test.

### File map

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest; permissions, content-script matches, background worker |
| `content.js` | DOM extraction + hide/reveal UX (the brittle part) |
| `page-hook.js` | MAIN-world harvest of timeline GraphQL (counts, notes) |
| `content.css` | Collapse/blur styles + reveal banner |
| `background.js` | Cache + batch + System One dispatch; holds the key |
| `lib/config.js` | Defaults + `chrome.storage.local` helpers |
| `lib/rubric.js` | Score questions, Jev rubric, few-shot examples |
| `lib/signals.js` | Bot-shaped prior from follower/following/volume/age; compact name/handle/bio for Jev |
| `lib/cache.js` | LRU text→verdict cache + FNV-1a hash |
| `lib/systemone.js` | Jev cloud + local Laya client |
| `scripts/laya_server.py` | Local laya-mlx HTTP wrapper |
| `popup.{html,css,js}` | Settings UI |

## Loading & developing

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the toolbar popup. Paste a TypeSafe API key **or** switch to Laya after
   `python scripts/laya_server.py`. Click **Test**.
3. Visit x.com and scroll. A **ForUs** panel in the bottom-right logs each verdict.
   Hidden posts collapse to identity + **Show post**.
4. After editing files, hit the **reload** ↻ on the extension card. Content-script changes
   also need a page refresh. Turn the panel off from the popup once you trust the filter.

Jev lives at `https://api.typesafe.ai/v1/systemone` (model `jev-1.13.0`). Local Laya
is [laya-mlx](https://github.com/mizorewww/laya-mlx) served by `scripts/laya_server.py`
at `http://127.0.0.1:8765/v1/systemone`. Each post is four Score questions (payload,
hijack, vacuity, persona). Built-in
few-shots live in `lib/rubric.js` (`FEW_SHOT`). English Laya is 512-token context, so
local calls send one post at a time.

## Known brittleness / gotchas

- **X DOM churn.** Everything keys off `article[data-testid="tweet"]` and
  `[data-testid="tweetText"]`. These are the stable foothold (X's own tests use them) but
  can still change. If extraction silently stops, check these selectors first.
- **No timeline-vs-thread distinction yet.** v1 classifies every tweet article that
  scrolls into view. Harmless (root posts usually score as value) but a precision
  refinement worth adding.
- **Service-worker eviction clears the cache.** Acceptable for v1; back it with
  `chrome.storage.session` to persist across restarts.
- **MV3 worker lifecycle.** The worker sleeps; the content script handles
  `chrome.runtime.lastError` and silently skips if the worker is briefly unavailable.

## Refinement backlog (roughly priority-ordered)

1. **Tune the rubric** against your own false positives by editing `FEW_SHOT` and
   `SCORE_QUESTIONS` in `lib/rubric.js`.
2. **Cheap pre-filter** before Jev: obvious cases via heuristics, spending API calls
   only on the ambiguous middle. Bot-shaped accounts already raise noise locally.
3. **Persist the cache** in `chrome.storage.session`.
4. **Safari port:** the WebExtension code is shared; wrap via Xcode's
   `safari-web-extension-converter` at the end.

Named entity / topic mutes (Kardashians, etc.) stay on **X's muted words**. ForUs does
not duplicate that denylist. X does not expose how many people blocked or muted an account.

**Region filter.** `blockedRegions` is a local `region` noise score, overlaid in
`content.js` (not a Jev question, so editing the list re-applies without
reclassifying). Two sources: profile `location` (self-typed, on the timeline User,
score 2) and "Account based in" (`about_profile.account_based_in`, score 3).
"Based in" is **not** on the timeline User. `page-hook.js` reads it passively when X
loads `AboutAccountQuery` itself. With `fetchBasedIn` on, it also sends that query
per new author using X's own captured headers: one every 2.5 s, at most 120 an hour,
15-minute backoff on 429, results cached 30 days in `chrome.storage.local`
(`forusBasedIn`). The query id is learned from X's own traffic, with hardcoded
fallbacks that will rot.
Whether **you follow** the author is already on the timeline User object
(`relationship_perspectives.following`); we do not fetch your following list.

## Conventions

- Plain JS, ES modules in the worker/popup; the content script is a classic (non-module)
  script on purpose so nothing sensitive lands in the page context.
- No build step, no dependencies — load-unpacked must keep working.
- Credentials live only in `background.js` / `chrome.storage`. Never pass the API key to
  the content script or into the page.
- Keep the four Jev score dimensions in sync across `lib/rubric.js` (`SCORE_DIMS` /
  `SCORE_QUESTIONS`), `lib/systemone.js`, and the popup sliders (`minValueToKeep` /
  `minNoiseToHide`). Local `bot` noise from `lib/signals.js` is not a Jev question.
  Name / handle / bio are scored by Jev as `persona`, not by pattern lists.
