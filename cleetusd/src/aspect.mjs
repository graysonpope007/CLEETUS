// src/aspect.mjs — the shape, when nobody said what the shape should be.
//
// A contradiction that had been sitting in plain sight. Grayson's own brief
// says it twice:
//
//   "Otherwise assume 4:5."
//   "square only when square is genuinely what it is for. Square is the
//    default and it is the wrong shape for most photographs of people."
//
// And the code, handed no `aspect`, renders 1024x1024. So the documented rule
// and the machine's behaviour disagreed, and the machine won every time the
// model forgot to pass the parameter — which the behaviour check caught it
// doing twice in one evening, on a woman in a gym and on a red cube.
//
// This is not a case for a firmer instruction. The instruction is already
// there and is already emphatic; the model forgets it under load like anything
// else. The fix is that forgetting should land on his stated default instead
// of on the shape he has twice said is wrong.
//
// WHAT THIS IS NOT. It is not a decision about content, so it does not belong
// with literal.mjs. Shape is how a picture is cropped, and something has to
// choose it — declining to choose IS choosing square. The one rule it does
// share: whatever it picks, it says so, because a silent crop is the most
// visible unasked-for change there is.

// The use he named, in his words, mapped to what this machine can render.
// Ordered most specific first: "story" and "reel" are 9:16 whatever else the
// sentence says, and an album cover is square even when it has a person on it.
const BY_USE = [
  [/\b(story|stories|reel|reels|tiktok|short|spotify canvas|canvas|vertical video)\b/i, "tall"],
  [/\b(album cover|single cover|cover art|podcast cover|album art|logo|icon|avatar|profile (?:picture|photo|pic)|sticker|thumbnail for (?:spotify|apple music))\b/i, "square"],
  [/\b(hero|banner|header|billboard|desktop wallpaper|widescreen|panorama|panoramic|youtube thumbnail|og image|open graph|cinematic still)\b/i, "wide"],
  [/\b(instagram (?:feed|post)|feed post|flyer|poster|magazine|book cover|portrait orientation)\b/i, "portrait"],
];

// A person is taller than they are wide. The same list writeAndRender uses,
// kept here so there is one answer to this question rather than two.
const PEOPLE = /\b(woman|man|girl|guy|boy|person|people|portrait|model|her|him|his|body|figure|face|couple|crowd|band|singer|bassist|player|athlete|dancer)\b/i;

// Things that are wider than they are tall by their nature.
const SCENE = /\b(landscape|skyline|horizon|vista|mountain range|coastline|beach|desert|field|forest|street|city|room|interior|kitchen|studio|stage|sunset|sunrise|panorama)\b/i;

/**
 * The shape for this prompt, and why.
 *
 * Returns { aspect, why } or null when the prompt gives no signal at all and
 * even the fallback would be a guess too far — in which case the caller leaves
 * it alone and the model's own default applies.
 */
export function inferAspect(prompt) {
  const text = String(prompt || "");
  if (!text.trim()) return null;

  for (const [re, aspect] of BY_USE) {
    const m = re.exec(text);
    if (m) return { aspect, why: `it is for a ${m[0].toLowerCase()}` };
  }

  const person = PEOPLE.exec(text);
  const scene = SCENE.exec(text);
  // A person IN a scene is still a photograph of a person. "a bassist on a dim
  // club stage" is portrait, not landscape, and getting that backwards is the
  // single most common framing mistake there is.
  if (person) return { aspect: "portrait", why: `it is a photograph of a ${person[0].toLowerCase()}` };
  if (scene) return { aspect: "landscape", why: `it is a ${scene[0].toLowerCase()}` };

  // His documented fallback, in his own words: "Otherwise assume 4:5." Better
  // than square, which he has twice written down as the wrong answer, and
  // better than nothing, because nothing IS square.
  return { aspect: "portrait", why: "nothing named a use or a subject, and his standing default is 4:5" };
}
