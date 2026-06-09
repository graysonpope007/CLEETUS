# Stillwater — Calm Therapy Template

A single-page template for a calm/therapy practice site. Soft warm palette, fuzzy
ambient layer, smooth scroll, editorial typography.

## Stack

Just `index.html`. No build step. Open it or serve it.

```
python3 -m http.server 8765
# → http://localhost:8765
```

## What's in it

- Hero with eyebrow, headline, lede, CTAs, parallax image
- Trust strip with credentials / insurance
- Philosophy quote
- 3-step "Listen / Locate / Loosen" approach
- About / founder bio with parallax image
- Our Therapists — 4-up directory grid
- Specialties — 8 things the practice works with
- Testimonials — editorial column, not a sales block
- Begin / pricing — dark cocoa anchor with intro-call CTA
- FAQ — accordion
- Footer

## Motion

- Lenis smooth-scroll (wheel + anchor + back-to-top all lerp through the same easing)
- Selective text-appear (hero stagger on load + section H2s on scroll)
- Hero/about image parallax
- Scroll progress bar at top
- Begin section bloom-in on viewport enter
- Active nav-link tracking
- Hero scroll cue
- FAQ accordion expand/collapse
- Respects `prefers-reduced-motion`

## Brand notes

- Background: pale eucalyptus mist (`#E8EBE2`)
- Type: Fraunces (serif headlines, italic accents) + Inter 400 body
- Voice: "you don't need to arrive composed" — warm, slow, not corporate
