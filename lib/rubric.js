// lib/rubric.js
// Three orthogonal 0–3 axes. Hide posts that are engineered to provoke or that
// add nothing — WITHOUT hiding genuine disagreement, including disagreement
// that is blunt, terse, sarcastic, or harsh.
//
// Tune by editing SCORE_QUESTIONS / JEV_RUBRIC and, especially, by adding few-shot
// examples drawn from posts you've actually seen misclassified. Examples move the
// needle more than swapping wording.

export const VALUE_DIMS = ["payload"];
export const NOISE_DIMS = ["hijack", "vacuity"];
export const SCORE_DIMS = [...VALUE_DIMS, ...NOISE_DIMS];
// Local prior from account stats. Not a Jev question. Counts in max(noise).
export const SIGNAL_NOISE_DIMS = ["bot"];

export const KEEP_SCORES = {
  payload: 3,
  hijack: 0,
  vacuity: 0,
  bot: 0
};

export const HIDE_SCORES = {
  payload: 0,
  hijack: 0,
  vacuity: 3,
  bot: 0
};

// Jev Score questions. criteria[0] is the low end, criteria[3] the high end.
export const SCORE_QUESTIONS = {
  payload: {
    instructions:
      "How much contribution is in this post — a claim, a reason, a correction, evidence, a real question, a concrete fact, or actual humor? Tone does not matter. A blunt, rude, or sarcastic post that makes a real point scores high. A witty joke that is itself the point scores high. An empty sneer, a slogan, or 'lol' as contempt scores 0. A 'you'd never hear the end of it / if [group] did this' dunk that never names the practice, cites coverage, or states a checkable double standard is a slogan, not a point. Novelty helps but is not required: a precise familiar correction still scores high.",
    criteria: [
      "Nothing to take away. No claim, no reason, no question, no fact, no real joke. Or a paste-ready comparative dunk with no specified 'this'.",
      "A thin or obvious point, a vague question, or a mild quip that does not carry the post.",
      "A real claim, correction, source, genuine question, or actual joke that could change what a careful reader thinks — or that is genuinely funny.",
      "High-signal: precise correction, mechanism, evidence, a question that probes the topic, or humor that is itself the contribution."
    ]
  },
  hijack: {
    instructions:
      "Is the packaging built to inflame, recruit, or farm engagement, or is it just strongly held? Passionate, angry, or moral language aimed at a claim is not hijack. Disagreement is not hijack. Pile-on bait, ALL CAPS panic, 'you people' theater, paste-ready slogans, strawmen, 'if [group] did this you'd never hear the end of it' without a specified this, and 'comment YES / a thread 🧵' traps are.",
    criteria: [
      "Not engineered. Even if blunt or angry, it is aimed at a claim or a joke.",
      "Spicy framing or a familiar talking point, but still applied to this post.",
      "Engineered heat or recruitment: moral panic, identity bait, canned slogan, performative outrage, inviting a pile-on.",
      "Pure engagement trap or agitprop. The goal is fury, clicks, or a paste-ready line — not to say something."
    ]
  },
  vacuity: {
    instructions:
      "Is there a thought present that tracks, even if you think it is wrong? Wrong is not vacuous. Rude is not vacuous. A famous person in a real post (a claim, a fact about an industry, labor, or the law, or a joke that uses them as a punchline) is not vacuous. Score high only for no thought: empty sneer, word salad, platitude, AI filler, or tabloid celebrity chatter (paparazzi, dating/breakup theater, outfits, feud recaps, parasocial drama).",
    criteria: [
      "A thought is present. May be wrong, rude, simple, or mention a famous person, but it tracks and has public-interest content.",
      "Sloppy, thin, or a celebrity's personal life in passing — but there is still a point.",
      "Mostly empty: contentless dumb, tabloid, platitude, or slop, with little else.",
      "Pure vacuity. No thought. Empty sneer, word salad, who-dated-whom, what they wore, or parasocial drama."
    ]
  }
};

export const JEV_RUBRIC = `Judge this X post on three independent 0–3 scales.

Payload: contribution. A claim, reason, correction, fact, real question, or actual joke. Blunt, rude, or sarcastic posts that make a real point score high. A real joke scores high. Empty sneer scores 0. "If [group] did this you'd never hear the end of it" with no named practice, no citation, no checkable double standard is a slogan — payload 0–1.

Hijack: engineered packaging — outrage, recruitment, slogans, engagement traps, identity-bait comparatives. Anger at a claim ≠ hijack. Disagreement ≠ hijack. A real double-standard argument with a specified rite and a specified coverage gap is a claim, not hijack.

Vacuity: no thought / no public-interest content — empty sneer, slop, platitude, tabloid celebrity chatter. Wrong ≠ vacuous. A famous person in a real post ≠ vacuous.

If state.accounts has follow/tweet stats: a firehose with follows≈followers is extra noise context. It does not reduce payload. A real point still scores high.

If state.notes has a shown Community Note, treat that text as context about the post. A pending note (status only, no text) is not a hide signal and is not a verdict.

A post can score high on both payload and noise. Prefer giving payload its due.`;

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
  return maxScore(scores, [...NOISE_DIMS, ...SIGNAL_NOISE_DIMS]);
}

// Keep if payload >= minValueToKeep. Hide only when payload is below that AND
// max(hijack, vacuity, bot) >= minNoiseToHide. Defaults: keep at 2, hide noise at 2.
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
  { text: "The punchline only works if you know the Fed funds the deficit in the same window.", verdict: "keep" },
  { text: "cope harder", verdict: "hide" },
  { text: "nobody asked for your opinion grandpa", verdict: "hide" },
  { text: "So you LITERALLY want people to starve. Wild that this is allowed.", verdict: "hide" },
  { text: "Typical of THIS crowd to pretend they care now lol", verdict: "hide" },
  { text: "So your argument is that we should ban all cars? Insane take.", verdict: "hide" },
  { text: "Studio dropped it because reshoots blew the budget 40%, not because she was 'cancelled'.", verdict: "keep" },
  { text: "wait they broke up??? I'm actually shaking", verdict: "hide" },
  { text: "Did you SEE what she wore to the Met", verdict: "hide" },
  { text: "Kapparot is a chicken waved over the head before Yom Kippur. If the charge is a coverage double standard, name the comparable rite and the actual stories — not 'if Muslims you'd never hear the end of it'.", verdict: "keep" },
  { text: "If Muslims did this pagan ass shit, you’d never hear the end of it", verdict: "hide" },
  { text: "Comment YES if you agree 🧵", verdict: "hide" }
];
