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

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const LAYA_ENDPOINT = "http://127.0.0.1:8765/v1/systemone";
export const LAYA_MODEL = "aac6fef/laya-mlx";

function clip(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function buildState(items, userExamples, compact) {
  const posts = {};
  const postClip = compact ? 180 : 240;
  for (const it of items) posts[it.id] = clip(it.text, postClip);

  const cap = compact ? 4 : 40;
  const examples = [...FEW_SHOT, ...(userExamples || [])]
    .map((e) => {
      const verdict = exampleVerdict(e);
      if (!verdict) return null;
      return { text: clip(e.text, compact ? 120 : 240), verdict };
    })
    .filter(Boolean)
    .slice(0, cap);

  return { rubric: JEV_RUBRIC, examples, posts };
}

function buildQuestions(items) {
  const questions = {};
  for (const it of items) {
    for (const dim of SCORE_DIMS) {
      const q = SCORE_QUESTIONS[dim];
      questions[`${it.id}__${dim}`] = {
        type: "score",
        instructions: `${q.instructions} Score the post keyed "${it.id}" in state.posts.`,
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

function verdictFromAnswers(id, answers) {
  const scores = {};
  let confSum = 0;
  let confN = 0;
  for (const dim of SCORE_DIMS) {
    const a = answers[`${id}__${dim}`] || {};
    scores[dim] = clampScore(a.score);
    if (typeof a.confidence === "number") {
      confSum += a.confidence;
      confN += 1;
    }
  }
  const value = valueScore(scores);
  const noise = noiseScore(scores);
  return {
    id,
    scores,
    category: noise >= value ? "noise" : "value",
    confidence: confN ? confSum / confN : 1,
    reason: `value ${value.toFixed(1)} · noise ${noise.toFixed(1)}`
  };
}

export async function classify({
  endpoint,
  apiKey,
  model,
  items,
  userExamples,
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
        state: buildState(items, userExamples, compact),
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
  return items.map((it) => verdictFromAnswers(it.id, answers));
}
