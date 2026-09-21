// lib/systemone.js
// Shared client for TypeSafe Jev (cloud) and local Laya-MLX (Apple Silicon).
// Both speak POST /v1/systemone with { state, questions } → { answers }.

import {
  FEW_SHOT,
  JEV_RUBRIC,
  SCORE_DIMS,
  SCORE_QUESTIONS,
  exampleVerdict,
  noiseScore,
  valueScore
} from "./rubric.js";
import { botScore, compactAccount, compactNote } from "./signals.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const LAYA_ENDPOINT = "http://127.0.0.1:8765/v1/systemone";
export const LAYA_MODEL = "aac6fef/laya-mlx";

function clip(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function buildState(items, compact) {
  const posts = {};
  const accounts = {};
  const notes = {};
  const postClip = compact ? 180 : 240;
  for (const it of items) {
    posts[it.id] = clip(it.text, postClip);
    const account = compactAccount(it.account, { compact });
    if (account) accounts[it.id] = account;
    const note = compactNote(it.note, compact ? 80 : 280);
    if (note?.status === "shown" && note.text) notes[it.id] = note;
  }

  const cap = compact ? 4 : 40;
  const examples = FEW_SHOT.map((e) => {
    const verdict = exampleVerdict(e);
    if (!verdict) return null;
    return { text: clip(e.text, compact ? 120 : 240), verdict };
  })
    .filter(Boolean)
    .slice(0, cap);

  const state = { rubric: JEV_RUBRIC, examples, posts };
  if (Object.keys(accounts).length) state.accounts = accounts;
  if (Object.keys(notes).length) state.notes = notes;
  return state;
}

function dimsForItem(item) {
  if (item?.useAccountSignals === false) {
    return SCORE_DIMS.filter((d) => d !== "persona");
  }
  return SCORE_DIMS;
}

function buildQuestions(items) {
  const questions = {};
  for (const it of items) {
    for (const dim of dimsForItem(it)) {
      const q = SCORE_QUESTIONS[dim];
      const target =
        dim === "persona"
          ? ` Score the account identity in state.accounts["${it.id}"] (name, handle, bio). Ignore the post text. If that account object is missing, score 0.`
          : ` Score the post keyed "${it.id}" in state.posts.`;
      questions[`${it.id}__${dim}`] = {
        type: "score",
        instructions: `${q.instructions}${target}`,
        criteria: q.criteria
      };
    }
  }
  return questions;
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(3, x));
}

function clampLevel(n) {
  const x = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(3, x));
}

function modalLevel(answer, fallbackScore) {
  const probs = answer?.probabilities;
  if (probs && typeof probs === "object") {
    let best = null;
    let bestP = -1;
    for (const [k, p] of Object.entries(probs)) {
      const n = Number(p);
      if (!Number.isFinite(n) || n < bestP) continue;
      bestP = n;
      best = Number(k);
    }
    if (Number.isFinite(best)) return clampLevel(best);
  }
  return clampLevel(fallbackScore);
}

function criterionFor(dim, level, answer) {
  const legend = answer?.legend;
  if (legend && typeof legend === "object") {
    const hit = legend[level] ?? legend[String(level)];
    if (hit != null && String(hit).trim()) return String(hit);
  }
  return SCORE_QUESTIONS[dim]?.criteria?.[level] || "";
}

function compactProbs(probs) {
  if (!probs || typeof probs !== "object") return null;
  const out = {};
  let any = false;
  for (let i = 0; i <= 3; i++) {
    const n = Number(probs[i] ?? probs[String(i)]);
    if (Number.isFinite(n) && n > 0) {
      out[i] = n;
      any = true;
    }
  }
  return any ? out : null;
}

function dimDetail(dim, answer) {
  const score = clampScore(answer?.score);
  const level = modalLevel(answer, score);
  const detail = {
    score,
    level,
    why: criterionFor(dim, level, answer)
  };
  if (typeof answer?.confidence === "number") detail.confidence = answer.confidence;
  const probs = compactProbs(answer?.probabilities);
  if (probs) detail.probabilities = probs;
  return detail;
}

function verdictFromAnswers(id, answers, item) {
  const scores = {};
  const breakdown = {};
  let confSum = 0;
  let confN = 0;
  for (const dim of SCORE_DIMS) {
    if (dim === "persona" && item?.useAccountSignals === false) continue;
    const a = answers[`${id}__${dim}`] || {};
    const detail = dimDetail(dim, a);
    scores[dim] = detail.score;
    breakdown[dim] = detail;
    if (typeof detail.confidence === "number") {
      confSum += detail.confidence;
      confN += 1;
    }
  }
  if (item?.useAccountSignals !== false) {
    const bot = botScore(item?.account);
    scores.bot = bot.score;
    breakdown.bot = {
      score: bot.score,
      level: bot.score,
      why: bot.why || "Not bot-shaped."
    };
  }
  const value = valueScore(scores);
  const noise = noiseScore(scores);
  const note = item?.useCommunityNotes === false ? null : item?.note || null;
  return {
    id,
    scores,
    breakdown,
    category: noise >= value ? "noise" : "value",
    confidence: confN ? confSum / confN : 1,
    reason: `payload ${value.toFixed(1)} · noise ${noise.toFixed(1)}`,
    signals: {
      account: item?.account || null,
      note: note && note.status ? note : null
    }
  };
}

export async function classify({
  endpoint,
  apiKey,
  model,
  items,
  signal,
  compact = false
}) {
  if (!items?.length) throw new Error("classify() needs items.");
  if (!endpoint) throw new Error("No System One endpoint set.");

  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model,
        state: buildState(items, compact),
        questions: buildQuestions(items)
      })
    });
  } catch (err) {
    if (compact || /127\.0\.0\.1|localhost/.test(endpoint)) {
      throw new Error(
        "Local Laya is not running. In a terminal: python scripts/laya_server.py"
      );
    }
    throw err;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`System One ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const answers = data.answers || {};
  return items.map((it) => verdictFromAnswers(it.id, answers, it));
}
