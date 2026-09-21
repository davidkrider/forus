# ForUs

A Chrome extension that hides **noise** on X (Twitter) — ragebait, propaganda, and
contentless sneers — without hiding blunt disagreement.

Each post is scored 0–3 on six independent scales:

- **Value:** useful, interesting, funny
- **Noise:** ragebait, propaganda, stupid

Keep if `max(value) ≥ 2`. Hide only if value is below that **and** `max(noise) ≥ 2`.
A sharply worded correct rebuttal stays visible. An empty sneer does not.

The classifier is a typed decision model, not a chat LLM. Two backends:

- **Jev** (TypeSafe cloud) — paste an API key
- **Laya** ([laya-mlx](https://github.com/mizorewww/laya-mlx), local on Apple Silicon) — same System One contract, ~10ms/question, no key

Not affiliated with X or Twitter.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select this folder.
3. Open the toolbar popup. Either paste a TypeSafe API key, **or** pick **Laya (local MLX)** after starting the local server (below). Click **Test**.
4. Visit [x.com](https://x.com) and scroll.

Hidden posts collapse to the author's identity plus **Show post**. Click the small
**rf** mark on a tweet to label Keep or Hide; those examples are sent with later calls.

## Config

| Control | Default | Meaning |
|---------|---------|---------|
| Keep if value ≥ | 2 | Highest of useful / interesting / funny |
| Hide if noise ≥ | 2 | Highest of ragebait / propaganda / stupid |
| Corrections sent | 20 | Recent Keep/Hide labels included in each Jev call |

Your API key (cloud only) is stored in `chrome.storage.local` on this device. It never goes into the page.

## Local Laya (Apple Silicon)

Same rubric, same keep/hide line, no cloud round-trip. Needs macOS 14+ and Python 3.11+.

```bash
pip install laya-mlx
python scripts/laya_server.py
```

First run downloads `aac6fef/laya-mlx`. Then in the popup: **Backend → Laya (local MLX)** → **Test**. Default endpoint is `http://127.0.0.1:8765/v1/systemone`.

English Laya is a 512-token model, so local calls score one post at a time. Still far faster than the cloud API.

## Develop

No build step. Edit, hit **reload** on the extension card, refresh x.com. The rubric
lives in `lib/rubric.js` — that's the file you'll change most. See `AGENTS.md` for
architecture notes.
