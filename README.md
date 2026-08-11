# CLEETUS

`/Users/grayson` tracked as a git repo (origin: `graysonpope007/CLEETUS`). It holds
several independent projects that were developed on separate branches and merged
together, plus the Cleetus agent itself.

> `.gitignore` denies everything by default and allowlists only tracked paths.
> That guard is deliberate — without it `git add -A` here would stage all of
> `$HOME`, including `~/.ssh` and shell history. Adding a project? Add a matching
> `!` pair.

## Projects

| Path | What it is |
|---|---|
| `cleetus/` | Cleetus agent — vault, skills, daily notes |
| `.claude/` | Second-brain build: hooks, scripts, integrations, launchd jobs, skills |
| `.agent/plans/` | PRDs and migration plans for the second brain |
| `gp-productions-booking/` | GP Productions booking site |
| `calm-therapy-template/` | Stillwater single-page mockup |

## Sweet Tea Pedigree

Two separate builds of the STEAP site live here, merged from unrelated histories:

- **Shopify theme** (Dawn-based) — `layout/`, `sections/`, `snippets/`, `templates/`,
  `config/`, `locales/`, plus the Magnolia booking desk (`book.html`, `bands.html`,
  `venues.html`, `manage.html`, `server.mjs`). See
  [docs/sweet-tea-pedigree-shopify-theme.md](docs/sweet-tea-pedigree-shopify-theme.md).
- **Cloudflare Pages site** — static marketing + merch with Stripe/Printify
  Pages Functions. See
  [docs/sweet-tea-pedigree-cloudflare-site.md](docs/sweet-tea-pedigree-cloudflare-site.md)
  and `DEPLOY-GUIDE.md`.

These two are alternative approaches to the same band site, not one system. Check
which one is actually deployed before editing either.
