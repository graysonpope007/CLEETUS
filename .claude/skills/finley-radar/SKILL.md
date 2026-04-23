---
name: finley-radar
description: Check for upcoming Finley dates (birthday Dec 20, anniversaries, planned calendar events) and propose allergy-safe, alcohol-free gift and experience ideas. Writes proposals to vault/30-Projects/Cleetus/finley/. Triggers automatically when heartbeat detects a Finley date within 14 days, or when Grayson asks about Finley gift/date ideas.
argument-hint: [--days N] [--occasion "birthday|anniversary|date"]
---

# finley-radar

Proactively surfaces Finley-related dates and proposes thoughtful, constraint-compliant ideas.

## ABSOLUTE CONSTRAINTS — CHECK EVERY PROPOSAL
1. **NO TREE NUTS.** No almonds, cashews, pistachios, walnuts, pecans, hazelnuts, macadamia, Brazil nuts, pine nuts, or any tree-nut-derived ingredient. This applies to restaurants, recipes, gifts with food, and any experience involving food.
2. **NO ALCOHOL.** Neither Grayson nor Finley drinks. No wine, beer, cocktails, spirits, hard cider, or alcohol-containing products. No "wine + paint" nights, no wineries, no brewery tours.

These constraints are non-negotiable. If a proposal would be ruined by the allergy or alcohol rule, discard it entirely — don't just add a disclaimer.

## Workflow

1. **Check dates** — Run `scripts/check_finley_dates.py` to pull upcoming Finley calendar events + check the Dec 20 birthday window.

2. **Generate proposals** — For each upcoming occasion within 14 days:
   - Load `references/allergy-constraints.md` to guide idea generation
   - Produce 3–5 distinct gift or experience ideas
   - Verify EVERY idea against tree-nut and alcohol constraints before writing
   - Tailor to Athens GA / Evans GA area when relevant (restaurants, venues, activities)

3. **Write to vault** — Save proposals to `vault/30-Projects/Cleetus/finley/YYYY-MM-DD_<occasion>.md`

4. **Notify Grayson** — Post a brief summary to Slack DM D0AMJ560C2W: "Finley's [occasion] is in X days — I've drafted some ideas."

## Proposal File Format

```markdown
---
occasion: birthday | anniversary | date-night | <other>
date: YYYY-MM-DD
window_days: <days until occasion>
created: YYYY-MM-DD
---

# Finley — [Occasion Title]

[1–2 sentence context: why now, what you know about what she'd enjoy]

## Ideas

### [Idea 1 Title]
[Description — what it is, why she'd like it, where/how to arrange it]
**Allergy check:** [Confirm: no tree nuts] ✓
**Alcohol check:** [Confirm: no alcohol] ✓

### [Idea 2 Title]
...
```

## Scripts
- `scripts/check_finley_dates.py` — Google Calendar lookup + Dec 20 hardcoded birthday check

## References
- `references/allergy-constraints.md` — Full tree-nut list + no-alcohol rule, loaded before every proposal
- `references/finley-profile.md` — Mirrors vault/20-People/Finley.md, updated when preferences are added
