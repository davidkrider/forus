// lib/rubric.js
// The classification rubric. This is the most important file in the project and the
// one you'll iterate on most. Hide posts that are engineered to provoke or that add
// nothing but contempt, WITHOUT hiding genuine disagreement — including disagreement
// that is blunt, terse, sarcastic, or harsh.
//
// Tune by editing SCORE_QUESTIONS / JEV_RUBRIC and, especially, by adding few-shot
// examples drawn from posts you've actually seen misclassified. Examples move the
// needle more than swapping wording.

export const VALUE_DIMS = ["useful", "interesting", "funny"];
export const NOISE_DIMS = ["ragebait", "propaganda", "stupid"];
export const SCORE_DIMS = [...VALUE_DIMS, ...NOISE_DIMS];

export const KEEP_SCORES = {
  useful: 3,
  interesting: 2,
  funny: 0,
  ragebait: 0,
  propaganda: 0,
  stupid: 0
};

export const HIDE_SCORES = {
  useful: 0,
  interesting: 0,
  funny: 0,
  ragebait: 0,
  propaganda: 0,
  stupid: 3
};

// Jev Score questions. criteria[0] is the low end, criteria[3] the high end.
export const SCORE_QUESTIONS = {
  useful: {
    instructions:
      "How much does this post give a reader something to work with — a reason, a correction, evidence, a real question, or a concrete fact? Tone does not matter. A blunt, rude, or sarcastic post that makes a real point scores high. An empty sneer scores 0.",
    criteria: [
      "Nothing to take away. No claim, no reason, no question, no fact.",
      "A thin or obvious point, or a vague question that does not really engage.",
      "A real claim, correction, source, or genuine question that could change what a careful reader thinks.",
      "High-signal: precise correction, mechanism, evidence, or a question that actually probes the topic."
    ]
  },
  interesting: {
    instructions:
      "How much does this add a non-obvious angle, detail, or connection? Familiar talking points and generic agreement score low even if well-worded.",
    criteria: [
      "Generic, canned, or empty. You've seen this a thousand times.",
      "On-topic but unsurprising. No new information.",
      "A new angle, a concrete detail, or a non-obvious connection.",
      "Genuinely surprising or insightful. You'd remember it."
    ]
  },
  funny: {
    instructions:
      "Is there actual humor that contributes, or is 'lol' just contempt? A witty jab that also makes a point can score high on both funny and useful.",
    criteria: [
      "No joke, or the 'joke' is only a sneer (lol, lmao, 'imagine thinking this').",
      "A mild quip that does not carry the post.",
      "Actually funny: wit, irony, or a joke that still has a point.",
      "Genuinely clever. The humor is itself the contribution."
    ]
  },
  ragebait: {
    instructions:
      "Is this engineered to inflame, or is it just strongly held? Passionate, angry, or moral language aimed at a claim is not ragebait. Pile-on bait, ALL CAPS panic, and 'you people' theater are.",
    criteria: [
      "Not trying to inflame. Even if blunt or angry, it is aimed at a claim.",
      "Spicy framing, but still about the topic.",
      "Engineered heat: moral panic, identity bait, performative outrage, inviting a pile-on.",
      "Pure engagement trap. The goal is to make people furious, not to say something."
    ]
  },
  propaganda: {
    instructions:
      "Is this an original thought, or a paste-ready line? Disagreement is not propaganda. A slogan, strawman, or party-script that would fit under any similar tweet is.",
    criteria: [
      "Original thought, or a claim with a reason. Disagreement alone is not propaganda.",
      "Familiar talking point, but at least applied to this post.",
      "Canned slogan or script that could be pasted under any similar tweet.",
      "Agitprop: strawman, coordinated-feeling line, no engagement with what was actually said."
    ]
  },
  stupid: {
    instructions:
      "Is there a thought present that tracks, even if you think it is wrong? Wrong is not stupid. Rude is not stupid. Score high only for incoherence, not having read the post, or contentless dumb.",
    criteria: [
      "Coherent. May be wrong, rude, or simple, but it tracks.",
      "Sloppy or confused, or missing an obvious distinction, but there is a thought.",
      "Internally incoherent, a category error, or confidently false in a way that shows they did not read the post.",
      "Contentless dumb: no thought present. Empty sneer, word salad, or 'this is so dumb' with nothing else."
    ]
  }
};

export const JEV_RUBRIC = `Judge this X post on six independent 0–3 scales.

Value (useful, interesting, funny): contribution. Blunt, rude, or sarcastic posts that make a real point score high on useful.

Noise (ragebait, propaganda, stupid): engineered outrage, canned agitprop, or contentless dumb. Wrong ≠ stupid. Disagreement ≠ propaganda. Anger at a claim ≠ ragebait.

A post can score high on both value and noise. Prefer giving value its due.`;

export function maxScore(scores, dims) {
  let m = 0;
  for (const d of dims) {
    const n = Number(scores?.[d]);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}

export function valueScore(scores) {
  return maxScore(scores, VALUE_DIMS);
}

export function noiseScore(scores) {
  return maxScore(scores, NOISE_DIMS);
}

// Keep if value >= minValueToKeep. Hide only when value is below that AND
// noise >= minNoiseToHide. Defaults: keep at 2, hide noise at 2.
export function hideByScores(scores, { minValueToKeep = 2, minNoiseToHide = 2 } = {}) {
  if (!scores) return false;
  const value = valueScore(scores);
  const noise = noiseScore(scores);
  return value < minValueToKeep && noise >= minNoiseToHide;
}

export function exampleVerdict(e) {
  if (e?.verdict === "keep" || e?.verdict === "hide") return e.verdict;
  if (e?.category === "substantive" || e?.category === "neutral") return "keep";
  if (e?.category) return "hide";
  return null;
}

// Calibration examples. Keep these short and edit freely — they teach the model
// your specific line between "blunt but real" and "pure noise".
export const FEW_SHOT = [
  { text: "Source? Because the study you're citing was retracted in 2019.", verdict: "keep" },
  { text: "This is wrong. Rates fell because of the base effect, not policy.", verdict: "keep" },
  { text: "Hard disagree but I see where you're coming from.", verdict: "keep" },
  { text: "cope harder", verdict: "hide" },
  { text: "nobody asked for your opinion grandpa", verdict: "hide" },
  { text: "So you LITERALLY want people to starve. Wild that this is allowed.", verdict: "hide" },
  { text: "Typical of THIS crowd to pretend they care now lol", verdict: "hide" },
  { text: "So your argument is that we should ban all cars? Insane take.", verdict: "hide" }
];
