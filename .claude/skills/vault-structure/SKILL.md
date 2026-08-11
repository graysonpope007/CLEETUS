---
name: vault-structure
description: Teach the agent Cleetus's vault file organization conventions. Use before any vault write to ensure files land in the right place with the right naming format. Triggers on "where should I save", "what folder", or any vault write operation.
---

# Vault Structure

## Root Files (always at vault root)
- `SOUL.md` — Cleetus persona and behavioral rules. Edit rarely; core identity.
- `USER.md` — Grayson's profile, integrations, GLM roster, Finley profile. Update when facts change.
- `MEMORY.md` — Active projects and key context. Keep concise — loaded every session.
- `HABITS.md` — Daily pillars checklist. Reset by heartbeat each morning.
- `HEARTBEAT.md` — What the heartbeat monitors. Edit when adding new watch items.

## Folder Conventions

| Folder | What goes here | Naming format |
|--------|---------------|---------------|
| `00-Inbox/` | Unsorted captures, quick notes | `YYYY-MM-DD_topic.md` |
| `10-Daily/` | Morning briefings + session logs | `YYYY-MM-DD.md` (one per day, append-only) |
| `20-People/` | Contact notes — Finley, artists, venues | `FirstName-LastName.md` or `Finley.md` |
| `30-Projects/GLM/` | GLM label ops, artist notes, contracts | `artist-name_topic.md` |
| `30-Projects/STEAP/` | STEAP band notes, booking, promo | `topic.md` or `YYYY-MM-DD_venue.md` |
| `30-Projects/Cleetus/` | Cleetus build notes | `topic.md` |
| `30-Projects/Cleetus/finley/` | Finley gift/date proposals | `YYYY-MM-DD_occasion.md` |
| `30-Projects/The-Gringos/` | Gringos advance work | `topic.md` |
| `40-Areas/Label-Ops/` | Ongoing label ops reference | `topic.md` |
| `40-Areas/Booking/` | Booking templates, contacts | `topic.md` |
| `40-Areas/School/` | Course notes, assignments | `COURSE_topic.md` |
| `40-Areas/Health/` | Health logs | `topic.md` |
| `40-Areas/Finance/` | Finance notes (no raw account numbers) | `topic.md` |
| `50-Resources/` | Reference material, templates | `topic.md` |
| `60-Archive/` | Anything no longer active | original filename |
| `drafts/active/` | Heartbeat-generated reply drafts | `YYYY-MM-DD_<type>_<slug>.md` |
| `drafts/sent/` | Drafts that resulted in a sent reply | same as active |
| `drafts/expired/` | Drafts older than 24h, not sent | same as active |

## Git Commit Convention
Every vault write should be followed by a commit:
```
git -C vault add <file>
git -C vault commit -m "<scope>: <short description>"
```
Examples:
- `daily: 2026-04-23 morning briefing`
- `steap: venue follow-up draft — Exit/In`
- `finley: Dec 20 birthday proposal`
- `glm: Aislin Ward booking notes`

## Security
- Never write API keys, OAuth tokens, passwords, or account numbers to the vault.
- Never write Finley's tree-nut allergy suggestions that include tree nuts.
- Never write alcohol recommendations.
