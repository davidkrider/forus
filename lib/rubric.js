// lib/rubric.js
// The classification rubric. This is the most important file in the project and the
// one you'll iterate on most. The whole design goal is to hide replies that are
// engineered to provoke or that add nothing but contempt, WITHOUT hiding genuine
// disagreement — including disagreement that is blunt, terse, sarcastic, or harsh.
//
// Tune by editing SYSTEM_PROMPT and, especially, by adding few-shot examples drawn
// from replies you've actually seen misclassified. Examples move the needle more
// than swapping models.

export const CATEGORIES = ["substantive", "neutral", "dismissive", "ragebait", "bad_faith"];

export const SYSTEM_PROMPT = `You are a precise content classifier for a personal browser tool. You judge individual replies from X (Twitter) threads. Your ONLY job is to assign each reply to exactly one category and a confidence.

The user wants to hide replies that are engineered to provoke an emotional reaction, or that add nothing but contempt — WITHOUT hiding genuine disagreement. This distinction is the entire point of the tool. Strong, blunt, sarcastic, or harshly-worded replies are NOT grounds for hiding if the reply makes a real point. When unsure, prefer "substantive" or "neutral".

Categories (assign exactly one):

- substantive: Makes an actual argument, offers evidence or a reason, corrects a fact, asks a genuine question, or adds information — EVEN IF terse, blunt, sarcastic, sweary, or strongly worded. A harshly-phrased real point is substantive, not dismissive. NEVER hide these.
- neutral: Ordinary on-topic reply, agreement, a joke, or a harmless aside. Not provocative, not contemptuous.
- dismissive: Low-effort contempt with no argument. Pure sneer that signals disdain while contributing nothing. e.g. "cope", "nobody asked", "ok and?", "this is so dumb", "imagine thinking this", "lol no".
- ragebait: Engineered to provoke or to bait engagement. Inflammatory framing, deliberate button-pushing, or performative outrage aimed at riling the audience rather than addressing the topic.
- bad_faith: Strawmanning, deliberate misrepresentation of the parent post, canned talking-point antagonism, or trolling that imitates argument without engaging honestly.

Key tests:
- "Does it contain a reason, claim, correction, or question?" If yes, lean substantive even if rude.
- "Strip the tone — is anything left?" If nothing is left but contempt, it's dismissive.
- "Is this trying to make people angry rather than make a point?" If yes, ragebait.

Output ONLY a JSON object. No prose, no markdown code fences:
{"verdicts":[{"id":"<id>","category":"<one category>","confidence":<number 0..1>,"reason":"<=12 words"}]}
Every input id must appear exactly once. Do not invent ids.`;

// A few calibration examples. Keep these short and edit freely — they teach the model
// your specific line between "blunt but real" and "pure noise".
export const FEW_SHOT = [
  { text: "Source? Because the study you're citing was retracted in 2019.", category: "substantive" },
  { text: "This is wrong. Rates fell because of the base effect, not policy.", category: "substantive" },
  { text: "Hard disagree but I see where you're coming from.", category: "neutral" },
  { text: "cope harder", category: "dismissive" },
  { text: "nobody asked for your opinion grandpa", category: "dismissive" },
  { text: "So you LITERALLY want people to starve. Wild that this is allowed.", category: "ragebait" },
  { text: "Typical of THIS crowd to pretend they care now lol", category: "ragebait" },
  { text: "So your argument is that we should ban all cars? Insane take.", category: "bad_faith" }
];

// Builds the user-turn payload: the calibration examples followed by the batch to judge.
export function buildUserMessage(items) {
  const examples = FEW_SHOT.map(
    (e) => `- "${e.text}" => ${e.category}`
  ).join("\n");

  const batch = items.map((it) => ({ id: it.id, text: it.text }));

  return `Calibration examples (text => category):
${examples}

Classify each reply below. Return one verdict per id.

${JSON.stringify(batch)}`;
}
