// src/literal.mjs — telling the difference between "make me something" and
// "make THIS", and behaving differently.
//
// Everything else in this daemon is built to improve what Grayson said. The
// image agent's brief tells it to turn a rough ask into a concrete visual
// prompt; writeAndRender asks the model to expand a sentence into "subject,
// pose, clothing, setting, time of day, light, lens, framing"; media_cli.py
// appends a photographic style. Each of those is right, and each of them is a
// variation on what he actually typed.
//
// That is fine when the ask is rough. It is the entire complaint when it is
// not. "Do EXACTLY what I say without any variation" is not a request for a
// better prompt writer — it is a request for the improvement to STOP when he
// has already been specific, because at that point every added word is a thing
// he did not ask for arriving in his picture.
//
// So the question this file answers is not "how do I make this better" but
// "has he already told me what he wants". Three answers:
//
//   verbatim  he quoted a prompt, or said to use his words exactly. His text
//             IS the prompt. Nothing is added, not even the house style.
//   literal   he was specific, or constrained it, or is CORRECTING a previous
//             answer for adding things. Nothing is invented; the house style
//             still applies, because that is how it looks and not what is in it.
//   open      a rough ask. Expand it, which is what he wants and has always
//             wanted for this shape of request.
//
// The second reason this file exists separately: it is not about images. "Do
// what I said" is a property of the whole assistant, and the clause below goes
// into every agent's system prompt, not just the one holding a sampler.

/* ── Verbatim ─────────────────────────────────────────────────────────────────
   Two ways in, and quoting is the important one. A person who types
   quotation marks around a prompt has already decided what the prompt is;
   there is no reading of that gesture under which rewriting it is correct. */
const SAY_VERBATIM = new RegExp([
  "\\bword for word\\b",
  "\\bverbatim\\b",
  "\\buse (?:this|these|my|the following)\\b[^.]{0,30}\\b(?:exactly|as ?is|as written)\\b",
  "\\b(?:exactly|precisely) (?:this|these|as (?:i )?(?:wrote|typed|said))\\b",
  "\\bthis exact (?:prompt|wording|text|description)\\b",
  "\\bexact(?:ly)? (?:this )?prompt\\b",
  "\\bdon'?t (?:re)?word\\b",
  "\\bno paraphras",
].join("|"), "i");

/* Straight and curly quotes both. A phone types curly ones and a laptop types
   straight ones, and treating only one as a quotation means the feature works
   on his desk and not in his hand. */
const QUOTED = /["“‘']([^"”’']{8,600})["”’']/;

/* ── Literal ──────────────────────────────────────────────────────────────────
   These are the words people use when the thing they are asking for has edges.
   Deliberately broad, because the cost of the two mistakes is not symmetric:
   being literal about a rough ask produces a plainer picture, and being
   creative about a precise one produces the wrong picture and the message
   "that is not what I asked for". */
const SAYS_LITERAL = new RegExp([
  "\\bexactly\\b", "\\bexact\\b", "\\bprecisely\\b", "\\bliterally\\b", "\\bspecifically\\b",
  "\\bnothing else\\b", "\\bnothing but\\b", "\\bnothing more\\b", "\\band that'?s it\\b",
  "\\bonly (?:that|this|what)\\b", "\\bjust (?:that|this|what|the)\\b",
  "\\bno (?:extra|additional|other|more)\\b",
  "\\bdo ?n'?o?t add\\b", "\\bstop adding\\b", "\\bwithout adding\\b", "\\bquit adding\\b",
  "\\bdo ?n'?o?t change\\b", "\\bstop changing\\b", "\\bdo ?n'?o?t (?:embellish|elaborate|improve|enhance)\\b",
  "\\bas (?:i )?(?:said|asked|described|wrote)\\b", "\\blike (?:i )?(?:said|asked)\\b",
  "\\bkeep it (?:simple|exactly|the same)\\b", "\\bleave (?:it|the rest) (?:alone|as is)\\b",
  "\\bsame (?:prompt|thing|seed|image) (?:but|except)\\b",
].join("|"), "i");

/* He is CORRECTING, which is the strongest signal in the file.
   Every one of these is a sentence that only gets typed after something was
   added, changed or dropped that he did not ask for. Treating the next attempt
   as a fresh creative brief is how a correction turns into a second wrong
   picture, and that is the loop this is here to break. */
const CORRECTING = new RegExp([
  // Past tense as well as present: "i never SAID anything about a beach" is
  // the same sentence as "i never say", and it is the one people actually type.
  "\\bi (?:did ?n'?o?t|never) (?:ask(?:ed)?|say|said|want(?:ed)?|mention(?:ed)?)\\b",
  "\\bthat'?s not what i\\b", "\\bnot what i (?:asked|said|wanted)\\b",
  "\\bwhy (?:did|is) (?:you|it|there)\\b[^.]{0,40}\\b(?:add|added|change|changed|extra)\\b",
  "\\bi (?:asked|said) for\\b",
  "\\byou (?:added|changed|ignored|left out|forgot|missed)\\b",
  "\\bstop (?:doing|making) (?:that|it)\\b",
  "\\bagain,? (?:but|and)\\b",
].join("|"), "i");

/**
 * Is he telling us the last answer was wrong?
 *
 * Exported because two different things need it and they need the SAME
 * definition: literalMode uses it to stop treating a correction as a fresh
 * brief, and corrections.mjs uses it to decide there is a lesson to record.
 * Two regexes that drift apart would mean the assistant behaves as though it
 * has been corrected while learning nothing from it, which is the worse half
 * of both.
 */
export function isCorrection(question) {
  return CORRECTING.test(String(question || ""));
}

/* ── Negations, which a sampler reads backwards ──────────────────────────────
   "A quiet beach at sunrise, no people" puts the token `people` in the prompt.
   Cross-attention has no operator for "not"; it has a vector for `people`, and
   the picture comes back with people on the beach. This is the single most
   reliable way to get an image that contradicts its own prompt, and it looks
   from the outside exactly like the model ignoring an instruction — which is
   what he has been telling us it does.

   The fix is not a better sentence, it is the other input. Diffusion models
   have a negative prompt for precisely this, and it works. So a negation in
   what he said is LIFTED out of the positive prompt and put where the sampler
   can act on it. */
//
// The opener is whitespace or punctuation rather than a list of conjunctions.
// The first version required one of `^ , ; . and but`, which meant "a city
// street with no cars and no signage" caught the signage and lost the cars —
// the word before "no cars" is "with", and "with" was not on the list. A
// negation lifter that silently drops one of two negations is worse than none,
// because the picture comes back with cars in it and the prompt still says no.
const NEGATION = new RegExp(
  "(?:^|[,;.]|\\s)" +
  "(?:with\\s+)?(?:absolutely\\s+|definitely\\s+)?" +
  "\\b(?:no|without(?:\\s+any)?|not\\s+any|zero|never\\s+any)\\s+" +
  "([a-z][a-z0-9 '\\-]{1,44}?)" +
  "(?=\\s*(?:,|;|\\.|$|\\band\\b|\\bbut\\b|\\bwith\\b))",
  "gi",
);

// "a hat" and "hat" are the same thing to a sampler, and the article is one
// more token out of a budget that is already the tightest thing here.
const LEADING_ARTICLE = /^(?:a|an|the|any|some)\s+/i;

// Phrases that begin with "no"/"without" but are instructions to US, not things
// to keep out of the picture. Lifting "no rush" into a negative prompt is a
// small absurdity that produces a slightly worse image for no reason.
const NOT_A_SUBJECT = /^(?:rush|hurry|worries|problem|need|idea|preference|particular (?:order|reason)|more than \d|longer than|later than|paraphras\w*|changes?|variation\w*|extra (?:words|padding))\b/i;

/**
 * What he wants kept OUT, taken from what he said.
 *
 * Returns { terms, cleaned } — the things to push into the negative prompt,
 * and his sentence with those clauses removed so the word does not sit in the
 * positive prompt arguing with them.
 */
export function liftNegations(text) {
  const raw = String(text || "");
  const terms = [];
  let cleaned = raw;
  for (const m of raw.matchAll(NEGATION)) {
    const term = m[1].trim().replace(/\s+/g, " ").replace(LEADING_ARTICLE, "");
    if (!term || NOT_A_SUBJECT.test(term)) continue;
    terms.push(term);
    // The clause comes out whole. Leaving the word behind is the entire bug
    // this function exists for: `people` sitting in the positive prompt puts
    // people in the picture, whatever the negative prompt says about them.
    cleaned = cleaned.replace(m[0], m[0][0] === "," || m[0][0] === ";" ? m[0][0] : " ");
  }
  // Tidy what removing a clause leaves behind: doubled commas, a comma with a
  // space in front of it, a dangling conjunction at either end.
  // Order matters, and it was wrong once: collapsing whitespace BEFORE removing
  // a stranded conjunction puts the space back, so "no cars and no signage"
  // tidied to "a city street , wet asphalt" with the gap still in it.
  // Conjunctions first, then spacing, then the ends.
  cleaned = cleaned
    .replace(/\b(?:and|but|with)\b\s*(?=[,;.]|$)/gi, "")
    .replace(/([,;])\s*(?=[,;])/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,;.!?])/g, "$1")
    .replace(/^[\s,;]+|[\s,;]+$/g, "")
    .trim();
  return { terms: [...new Set(terms)], cleaned: cleaned || raw };
}

/* The lead-in that introduced a verbatim instruction is not part of it.
   "use this exact prompt: a red cube on white" must render a red cube on
   white, not the sentence about prompts. With quotation marks the quoted span
   already answers this; without them, the colon or the marker phrase is the
   boundary. */
const VERBATIM_LEADIN =
  /^[\s\S]{0,80}?(?:\bexact(?:ly)?\b|\bverbatim\b|\bword for word\b|\bas written\b|\bas ?is\b)[^:]{0,40}?:\s*/i;
const BARE_LEADIN =
  /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:make|draw|generate|create|render|paint|do|give me|show me)\s+(?:me\s+)?(?:exactly|precisely|literally)?\s*(?:this|it)?\s*[:,-]?\s*/i;

/**
 * The text a verbatim turn should actually use.
 *
 * The quoted span when there is one, otherwise his message with the sentence
 * that announced the instruction taken off the front.
 */
export function verbatimText(question, quoted) {
  if (quoted) return quoted.trim();
  const q = String(question || "").trim();
  const afterMarker = q.replace(VERBATIM_LEADIN, "").trim();
  const text = (afterMarker && afterMarker !== q) ? afterMarker : q.replace(BARE_LEADIN, "").trim();
  // Never hand back nothing. A lead-in that ate the whole message means the
  // stripping was wrong, and his own sentence beats an empty prompt.
  return text || q;
}

/**
 * Has he already told us what he wants?
 *
 * `question` is the message that triggered this turn. `history` is only read
 * for the correction case, because "again, but darker" is literal on the
 * strength of the turn BEFORE it and there is nothing in the message itself
 * that says so.
 */
export function literalMode(question, history = []) {
  const q = String(question || "");
  const reasons = [];

  const quoted = QUOTED.exec(q)?.[1]?.trim() || null;
  if (SAY_VERBATIM.test(q)) reasons.push("he asked for his words to be used as written");
  if (quoted && (SAY_VERBATIM.test(q) || SAYS_LITERAL.test(q))) {
    reasons.push("he put the prompt in quotation marks");
  }
  if (reasons.length) return { level: "verbatim", quoted, reasons };

  // Quoting on its own is verbatim too. A person who types quotation marks
  // around eight or more words has decided what the prompt is; there is no
  // reading of that under which rewriting it is what they wanted.
  if (quoted && quoted.split(/\s+/).length >= 4) {
    return { level: "verbatim", quoted, reasons: ["he put the prompt in quotation marks"] };
  }

  if (CORRECTING.test(q)) reasons.push("he is correcting a previous answer, not starting a new brief");
  if (SAYS_LITERAL.test(q)) reasons.push("he said to keep to what he asked for");
  const { terms } = liftNegations(q);
  if (terms.length) reasons.push(`he named ${terms.length} thing(s) to leave out`);

  // A repeat of a request he has already made is a correction whether or not
  // he used one of the words above: he would not be typing it twice if the
  // first one had landed.
  if (!reasons.length && repeatedAsk(q, history)) {
    reasons.push("he has asked for this before in this thread");
  }

  if (reasons.length) return { level: "literal", quoted, reasons };
  return { level: "open", quoted: null, reasons: [] };
}

/** Has he asked for substantially this before? Cheap and deliberately loose. */
function repeatedAsk(question, history) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
  const now = words(question);
  if (now.size < 4) return false;
  for (const m of history) {
    if (m?.role !== "user") continue;
    const text = Array.isArray(m.content)
      ? m.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
      : String(m.content || "");
    if (!text || text.trim() === String(question).trim()) continue;
    const then = words(text);
    if (then.size < 4) continue;
    let shared = 0;
    for (const w of now) if (then.has(w)) shared++;
    if (shared / now.size >= 0.6) return true;
  }
  return false;
}

/**
 * The clause that goes into the system prompt.
 *
 * Written as a rule about THIS turn rather than a standing instruction,
 * because a standing "always be literal" is what produces a flat assistant on
 * the rough asks where the expansion is the value. Empty string on `open`, so
 * the ordinary case costs nothing and reads exactly as it did.
 */
export function literalClause(mode) {
  if (!mode || mode.level === "open") return "";
  const why = mode.reasons.length ? ` (${mode.reasons.join("; ")})` : "";

  if (mode.level === "verbatim") {
    return "\n\nDO THIS ONE EXACTLY AS WRITTEN" + why + ". His words are the specification, not a " +
      "starting point. Use them as they are: do not rewrite, reword, expand, shorten, reorder, " +
      "translate or 'improve' them, and do not add a single element he did not name — no extra " +
      "objects, people, weather, mood, styling or detail. If you are generating from it, the prompt " +
      "is his text" + (mode.quoted ? ` — specifically: "${mode.quoted}"` : "") + ". If something " +
      "he asked for is genuinely impossible, do the rest and say plainly which part you could not " +
      "do. Never quietly substitute something near it and hand that back as though it were what he " +
      "asked for.";
  }

  return "\n\nHE HAS ALREADY BEEN SPECIFIC" + why + ". Keep every element he named, in his words " +
    "where they are usable, and ADD NOTHING he did not ask for — no invented objects, people, " +
    "settings, weather, clothing, props or backstory. You may still choose how it is lit and shot " +
    "if he did not say, because that is how it looks rather than what is in it. Anything he told " +
    "you to leave out must actually be absent. " +
    /* ── The exclusions are a place to invent too ─────────────────────────
       Caught by bin/image-behaviour-check.mjs rather than by reasoning about
       it. Asked for "an empty beach at sunrise, no people", the model wrote a
       negative prompt of "people, figures, boats, footprints, litter, clouds".
       Only one of those is his. Clouds in particular is not a neutral
       addition: a sunrise with no clouds is a different photograph, and he
       would have had no idea why he kept getting a bare sky.

       Adding things is the complaint whichever input they go in, and the
       negative prompt is the one nobody thinks to look at. */
    "The things you EXCLUDE are his to choose as well: put in the negative prompt only what he " +
    "actually said to leave out, plus the model's own quality defaults. Do not add exclusions of " +
    "your own — telling the sampler to avoid clouds on a sunrise he never mentioned is inventing, " +
    "and it is harder for him to spot than an invented object because he never sees the reason. " +
    "If he is correcting you, the fix is to change the " +
    "one thing he named and leave everything else exactly as it was — a correction is not a fresh " +
    "brief, and re-rolling the whole thing is how the same complaint arrives twice.";
}
