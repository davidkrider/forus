# AGENTS.md — Reply Filter

Context for an AI pair-programmer (Cursor, Claude Code, etc.) working on this project.

## What this is

A Chrome (MV3) browser extension that filters **dismissive, rage-bait, and bad-faith
replies on X (Twitter)** using an LLM, while deliberately **never hiding substantive
disagreement** — even when that disagreement is blunt, terse, or harshly worded. The
backend is pluggable: Anthropic (Claude API), any OpenAI-compatible cloud endpoint, or
a local Ollama model.

Built for personal use, not for the Chrome Web Store. The threat model is "I don't want
to read engineered outrage," not "ship to strangers."

## The single most important design constraint

The whole point is the line between **"blunt but real"** and **"pure noise."** A sharply
worded correct rebuttal must survive; a contentless sneer must not. If a change makes the
filter hide substantive-but-harsh replies, that change is wrong even if it "cleans up" the
timeline. When tuning, optimize for **precision against false positives on `substantive`**,
not for hiding more. The rubric encodes this; see `lib/rubric.js`.

## Architecture

```
content.js ──{type:"classify", items}──▶ background.js ──▶ provider.classify()
   ▲  (X page, isolated world)              (service worker)        │
   └──────────────{verdicts}───────────────────────────────────────┘
```

- **content.js** — runs in the X page. MutationObserver watches the virtualized timeline,
  extracts reply text via `data-testid` selectors, batches new replies, and collapses/blurs
  the ones the verdict says to hide (with a "Show reply" reveal). Holds **no credentials**.
- **background.js** — the only place with the API key. Checks the cache, batches misses into
  one model call, stores results, returns `{id: verdict}`. Also serves the popup's "test".
- **lib/providers/** — one module per backend, all implementing the same `classify()` contract.
- **lib/rubric.js** — the system prompt + few-shot examples. The file you'll edit most.
- **lib/cache.js** — in-memory LRU keyed on a hash of reply text (X re-renders the same
  replies constantly while scrolling; without this we'd reclassify each many times).
- **popup.\*** — settings UI: pick backend, enter key/model/endpoint, choose categories,
  set the confidence floor, test the backend.

### File map

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest; permissions, content-script matches, background worker |
| `content.js` | DOM extraction + hide/reveal UX (the brittle part) |
| `content.css` | Collapse/blur styles + reveal banner |
| `background.js` | Cache + batch + provider dispatch; holds the key |
| `lib/config.js` | Defaults + `chrome.storage.local` helpers |
| `lib/rubric.js` | System prompt, few-shot examples, user-message builder |
| `lib/json.js` | Tolerant `{"verdicts":[...]}` parser |
| `lib/cache.js` | LRU text→verdict cache + FNV-1a hash |
| `lib/providers/index.js` | Provider registry |
| `lib/providers/{anthropic,openai,ollama}.js` | Backends |
| `popup.{html,css,js}` | Settings UI |

## Provider contract

To add a backend, create `lib/providers/<name>.js` exporting:

```js
export async function classify({ settings, system, user, signal }) {
  // settings: the provider's block from config (apiKey/model/endpoint/...)
  // system:   the rubric system prompt (string)
  // user:     the batch payload (string) from buildUserMessage()
  // signal:   AbortSignal (30s timeout)
  // return:   Array<{ id, category, confidence, reason }>
  //           category ∈ substantive | neutral | dismissive | ragebait | bad_faith
}
```

Register it in `lib/providers/index.js` and add a defaults block in `lib/config.js`.
Nothing else needs to change. Use `parseVerdicts()` from `lib/json.js` to normalize output.

## Loading & developing

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open the toolbar popup, choose a backend, fill in credentials, click **Test backend**.
3. Visit a thread on x.com and scroll. Hidden replies collapse to a banner with **Show reply**.
4. After editing files, hit the **reload** ↻ on the extension card. Content-script changes
   also need a page refresh.

### Backend setup notes

- **Claude (Anthropic):** Needs an **API key** from console.anthropic.com — a Claude
  Pro/Max subscription does **not** work for API calls (it only authenticates the claude.ai
  web app). The Anthropic provider sends `anthropic-dangerous-direct-browser-access: true`
  because the API rejects browser-origin requests by default. Default model is Haiku-class;
  cost for short-reply classification is a fraction of a cent per call.
- **OpenAI-compatible (cloud):** Set `endpoint`, `model`, `apiKey` for OpenAI, OpenRouter,
  Together, Groq, or a rented vLLM/TGI box. **Custom hosts must be added to
  `host_permissions` in `manifest.json`** (or granted via the declared
  `optional_host_permissions`) or the background fetch is blocked.
- **Local (Ollama):** No key. Ollama must allow the extension origin via CORS — set
  `OLLAMA_ORIGINS` to include `chrome-extension://*` (or the specific extension id) and
  restart Ollama. `http://localhost/*` is already in `host_permissions`. A 3B model
  (llama3.2:3b, qwen2.5:3b, gemma2:2b, phi3.5) is plenty for tone classification.

## Known brittleness / gotchas

- **X DOM churn.** Everything keys off `article[data-testid="tweet"]` and
  `[data-testid="tweetText"]`. These are the stable foothold (X's own tests use them) but
  can still change. If extraction silently stops, check these selectors first.
- **No reply-vs-root distinction yet.** v1 classifies every tweet article that scrolls into
  view, not strictly "replies below the focal post." Harmless (root posts come back
  substantive/neutral) but a precision refinement worth adding — gate on being in the
  conversation list under a `/status/` URL.
- **Service-worker eviction clears the cache.** Acceptable for v1; back it with
  `chrome.storage.session` to persist across restarts.
- **MV3 worker lifecycle.** The worker sleeps; the content script handles
  `chrome.runtime.lastError` and silently skips if the worker is briefly unavailable.

## Refinement backlog (roughly priority-ordered)

1. **Tune the rubric** against your own false positives. Add real misclassified replies to
   `FEW_SHOT` in `lib/rubric.js`. This beats changing models.
2. **Cheap pre-filter** before the LLM: obvious cases via heuristics or a small toxicity
   classifier (DistilBERT-class / `toxic-bert`), spending LLM calls only on the ambiguous
   middle. Lowers cost/latency; pairs well with a local model.
3. **Reply-only gating** (see brittleness note).
4. **Persist the cache** in `chrome.storage.session`.
5. **Feedback loop:** a thumbs-down on a hidden/shown reply that appends to the few-shot set,
   turning real corrections into rubric improvements.
6. **In-browser model option** (WebLLM / transformers.js via WebGPU) for a zero-dependency
   local path — runs in an offscreen document, not the service worker.
7. **Safari port:** the WebExtension code is shared; wrap via Xcode's
   `safari-web-extension-converter` at the end. Needs a Mac + Apple Developer account ($99/yr)
   to keep installed. Develop in Chrome, port last.

## Conventions

- Plain JS, ES modules in the worker/popup; the content script is a classic (non-module)
  script on purpose so nothing sensitive lands in the page context.
- No build step, no dependencies — load-unpacked must keep working. Don't introduce bundling
  unless there's a strong reason; if you do, keep an unbundled dev path.
- Credentials live only in `background.js` / `chrome.storage`. Never pass the API key to the
  content script or into the page.
- Keep the rubric's category set in sync across `lib/rubric.js` (`CATEGORIES`), the popup
  checkboxes, and `lib/config.js` defaults.
