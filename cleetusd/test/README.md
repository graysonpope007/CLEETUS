# Tests

Most of these assert on SOURCE rather than on behaviour, and that is deliberate:
much of what matters here is what the model is told, and a brief that lost a
sentence is a real regression with no runtime symptom until the day it costs an
answer.

That makes one failure mode common enough to name.

## Assert the property, not its punctuation

Five assertions broke in a single night on changes that were entirely correct:

- `Math.max(maxSteps, CONFIG.maxStepsCeiling)` pinned as a stand-in for "a run
  cannot extend forever" — broke when the ceiling became agent-aware and both
  branches stayed bounded
- `!used.some(…) && isRefusal(answer)` pinned as "the override never fires when
  a picture was already made" — broke when a second trigger joined the refusal
- a 400-character proximity match for "the guard runs before the prompt is
  built" — broke when a paragraph of comment was written between the two lines
- two `\s*\n\s*` adjacency pins — either would break on a reformat, or on one
  inserted comment

A test that fails when a correct change is made does not protect the property.
It teaches whoever hits it to edit the test rather than read it, and the next
person to genuinely break that property finds an assertion everybody has
learned to adjust.

So:

- **ordering** — compare `indexOf` positions, rather than matching two lines as
  neighbours across `\s*\n\s*`
- **parts** — assert the pieces a condition must contain, not the exact
  expression that contains them
- **shape** — "every branch of this bound is finite" beats "this bound is
  written exactly like so"
- **name the consequence** in the assertion message, so a failure says what
  broke for the user rather than which regex missed

## Windows read what they are pointed at

`indexOf` finds the FIRST match. agent.mjs has two `for (const call of
res.toolCalls)` loops and doctor.mjs has a note about three separate occasions
when a fixed-size window read past what it was looking at. Slice between two
landmarks you have checked, or use `lastIndexOf`, and prove the slice is the one
you meant before trusting a green result.

## Make it fail once

A green assertion proves nothing until it has been seen to go red. Break the
thing it guards, watch it fail, put it back. Several assertions in here were
passing for the wrong reason until that was done — one checked that an answer
mentioned "glm" in a test whose request contained the word GLM.

## Do not mutate his real state

Tests run against the real machine. In one night, checks in this repo left a
key in the keyring, twenty-two zero-byte PNGs in the media folder, a truncated
improve-state, and two junk lines in an agent's memory. Use a temp dir, override
`CLEETUS_MEMORY_ROOT` / `CLEETUSD_MEDIA_OUT` / `CLEETUSD_REFS_DIR` /
`CLEETUSD_DROPS_DIR`, and put back anything you touch in a `finally` — noting
that `process.exit()` does not run one.
