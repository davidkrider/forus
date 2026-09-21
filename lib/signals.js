// lib/signals.js
// Local priors from X's own timeline payload — not extra fetches.
// Bot-shaped follow graphs can count as noise. They never override a real point:
// hide is still value < keep AND max(noise, bot) >= hide floor.
//
// Display name / handle / bio are NOT scored here. Those go to Jev as the
// persona question (controversial / costume identity).

export function ageDays(createdAt) {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0.04, (Date.now() - t) / 86400000);
}

function fmtCount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "?";
  if (x >= 1e6) return (x / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
  if (x >= 1e3) return (x / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(x));
}

function clipField(s, max) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Same-order-of-magnitude follows/followers plus a tweet firehose.
// Score 1 never hides on its own at the default floor of 2.
export function botScore(account) {
  if (!account) return { score: 0, why: "" };
  const fol = Number(account.followers);
  const fing = Number(account.following);
  const tweets = Number(account.tweets);
  if (!Number.isFinite(fol) || !Number.isFinite(fing)) return { score: 0, why: "" };

  const sameMag = Math.abs(Math.log10(fol + 1) - Math.log10(fing + 1)) < 0.35;
  const material = fol >= 80 && fing >= 80;
  const age = ageDays(account.createdAt);
  const perDay = Number.isFinite(tweets) && age ? tweets / age : null;

  const bits = [];
  if (sameMag && material) bits.push(`follows≈followers (${fmtCount(fing)}/${fmtCount(fol)})`);
  if (perDay != null && perDay >= 25) bits.push(`${Math.round(perDay)} tweets/day`);
  if (age != null && age < 30 && material) bits.push(`joined ${Math.round(age)}d ago`);

  let score = 0;
  if (sameMag && material) score = 1;
  if (sameMag && material && perDay != null && perDay >= 25) score = 2;
  if (sameMag && material && perDay != null && perDay >= 60) score = 3;
  if (sameMag && material && age != null && age < 14 && perDay != null && perDay >= 20) {
    score = Math.max(score, 2);
  }
  if (sameMag && material && age != null && age < 7 && perDay != null && perDay >= 40) {
    score = 3;
  }

  if (!score) return { score: 0, why: "" };
  return { score, why: bits.join(" · ") };
}

export function compactAccount(account, { compact = false } = {}) {
  if (!account) return null;
  const out = {};
  const name = clipField(account.name, 48);
  if (name) out.name = name;
  if (account.handle) out.handle = String(account.handle).replace(/^@/, "");
  const bio = clipField(account.bio, compact ? 80 : 160);
  if (bio) out.bio = bio;
  if (Number.isFinite(Number(account.followers))) out.followers = Number(account.followers);
  if (Number.isFinite(Number(account.following))) out.following = Number(account.following);
  if (Number.isFinite(Number(account.tweets))) out.tweets = Number(account.tweets);
  if (account.createdAt) out.joined = String(account.createdAt);
  return Object.keys(out).length ? out : null;
}

export function compactNote(note, maxText) {
  if (!note?.status) return null;
  const text = String(note.text || "").replace(/\s+/g, " ").trim();
  if (note.status === "shown" && text) {
    const clipped = maxText && text.length > maxText ? text.slice(0, maxText - 1) + "…" : text;
    return { status: "shown", text: clipped };
  }
  if (note.status === "pending") return { status: "pending" };
  return null;
}
