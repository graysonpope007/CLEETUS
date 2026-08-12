# cleetusd

Cleetus as a process on the Mac Studio, instead of a website that phones home.

## Why this exists

The model was always local. The **agent** was not. Every message went

```
browser -> Cloudflare Pages -> back down the tunnel -> Ollama -> back up
```

A Cloudflare worker is a sandbox with no disk, so Cleetus could only reason
about a file if a human pasted it in. That is the entire reason he could never
pick up whatever Grayson was working on.

`cleetusd` puts the loop on the same machine as the model and the files:

```
you -> cleetusd -> laguna (Ollama, localhost) 
                -> your disk, your shell, your vault
                -> cleetus-web (browser)  |  cleetusai.com (money, calendar)
```

The web app becomes a face for this. It stops being the thing itself.

## Running

```bash
cd ~/cleetusd
npm start                     # http://127.0.0.1:8767
node bin/ask.mjs "what am I lifting today"
node bin/ask.mjs --agent skin "forehead is breaking out again"
```

One dependency (`@anthropic-ai/sdk`, for the teacher). Node 22, and Ollama
already running.

```bash
node test/plumbing.test.mjs   # 25 checks, throwaway vault + memory root
node test/guards.test.mjs     # 7 checks on the self-improvement guards
```

## What he can do

| Tool | |
|---|---|
| `read_file` `write_file` `edit_file` | Any file on the Mac. Writes keep a `.bak`. |
| `list_dir` `search_files` `find_files` | ripgrep across the disk. |
| `run_shell` | zsh, 120s timeout. `CLEETUSD_NO_SHELL=1` takes it away. |
| `vault_search` `vault_read` | The Obsidian brain. |
| `remember_fact` `save_skill` | His own memory, as markdown. |
| `cloud_api` | Plaid, Schwab, calendar, training, food — via the deployed app. |
| `browse` | cleetus-web. Reads execute, commits queue for approval. |

**There is no path allowlist.** That was deliberate: the next project always
lives in the directory nobody thought to list. What replaces a restriction is a
**record** — every tool call is written into the run file as it happens.

## Memory, as files you can open

Markdown, not a table, because a row in a database that shapes what your
assistant does is a thing you cannot argue with.

```
~/cleetus-memory/runs/2026-08-12-1430-close-the-books.md   what he did
~/cleetus-memory/skills/close-the-books-for-a-month.md     how to do it again
vault/MEMORY.md                                            what you told him
```

**Why not straight into the vault.** The first launchd start wedged: every
request touching `~/Library/Mobile Documents` parked in
`__opendir2 → open$NOCANCEL` and never came back. Not slow, not denied —
`$NOCANCEL` cannot be interrupted, so the thread was gone for good. The same
call from a terminal answered instantly. It read fine after a restart, so it
is a cold or evicted iCloud path blocking on first touch, and it will recur
whenever the provider evicts. A personal assistant must not stop working
because a sync daemon is thinking.

So writes go to plain local disk and every vault read is time-boxed
(`CLEETUSD_FS_TIMEOUT_MS`, default 3s). A blocked vault is reported to the
model as a fact — "the vault is not readable from here" — so it says so
instead of guessing at your notes. `/health` shows `vault.reachable`.

To see runs and skills in Obsidian:

```bash
ln -s ~/cleetus-memory/runs   "$VAULT/30-Projects/Cleetus/runs"
ln -s ~/cleetus-memory/skills "$VAULT/30-Projects/Cleetus/skills"
```

Symlinks inside an iCloud-synced vault are worth knowing about before you run
that: they work on this Mac, they do not reliably sync to Obsidian on a phone.

- **runs/** — one file per task, opened *before* the work starts so a crash
  still leaves a trace. Every tool call appended as it happens.
- **skills/** — procedural memory. A skill is a *procedure* ("to close the
  books: pull the ledger, group by business, reconcile against Plaid"), not a
  rule ("don't open the brief with weather"). Retrieved by keyword, so the
  prompt does not grow without bound as they accumulate. Wrong skill? Delete
  the file. It is gone on the next request, no deploy.
- **MEMORY.md** — durable facts, read into every prompt.

## Agents

20 specialists. Each declares what context it is *entitled to* before it
speaks — that `needs` field is the difference between advice for Grayson and
advice for anyone. A skin agent that does not know he trains five days a week
and sweats in a helmet is a search engine with a personality.

Body: `hair` `skin` `muscle` `nutrition` `fitness`
Presentation: `fashion` `redesign`
Money and work: `deals` `finance` `stocks` `tax` `books` `booking` `writing`
`image` `music` `brief` `poker`
Itself: `builder`
Front door: `cleetus`

Routing runs on the 8B gate so picking a specialist does not queue behind the
33B that does the actual work.

Dossiers live in the vault at `40-Areas/Health/` and are currently **unfilled
templates**. Agents are told to say "you haven't told me that yet" rather than
invent. Filling `body.md` is the single highest-value thing you can do for the
body agents.

## Teacher models

```bash
node bin/teach.mjs "what it was asked" "what went wrong"
node bin/teach.mjs --agent skin "recommend a routine" "It stacked three actives at once"
```

Claude Opus 5 writes the **procedure** laguna should follow next time, and it
lands in `skills/` as markdown. This is distillation into instructions, not
weights — and it is paid for once. Falling back to a cloud model on every hard
request would mean the hard requests are never local, which is the arrangement
this daemon exists to end.

It fires automatically when a run genuinely fails (empty answer, or the tool
loop ran and produced nothing) — deliberately narrow, because a teacher call on
every answer is a cloud call on every answer.

**This is the one place in cleetusd that sends anything off the machine.** It
sends the task and what went wrong. Never file contents, vault text, or account
data. `CLEETUSD_NO_TEACHER=1` switches it off; unset `ANTHROPIC_API_KEY` and it
never runs.

Worth knowing: the teacher is told to return `worth_saving: false` for one-offs.
A skill that never applies again costs a retrieval slot forever.

## Self-improvement

```bash
node bin/improve.mjs --dry     # find the work, change nothing
node bin/improve.mjs           # fix one thing, ship it, revert if health drops
node bin/improve.mjs --stop    # off
node bin/improve.mjs --go      # on
```

One pass: find something genuinely wrong, record health **before** touching
anything, let the builder agent fix one thing, run the gates, push to main,
wait for the deploy to actually finish, compare health to the baseline, and
`git revert` if a failure appeared that was not there before.

It refuses to run when:

| | why |
|---|---|
| the tree is dirty | your uncommitted work is not the loop's to ship, and a revert would take it with it |
| health is already red | it could not tell its own damage from damage that was already there |
| three changes have shipped today | `CLEETUSD_IMPROVE_CAP` |
| `~/cleetus-memory/STOP-IMPROVING` exists | the off switch |

It will not edit its own machinery or anything matching `.env` — a loop that
edits its own revert path can put itself somewhere it cannot get back from.
If the builder finds no real cause it is told to change nothing and say so,
because a loop that invents work is worse than one that does nothing.

Every guard has a test: `node test/guards.test.mjs`.

Schedule it with `com.cleetus.improve.plist` (every 6 hours, `RunAtLoad` off).
Read `src/improve.mjs` before you load it — it pushes to production unattended.

## The dashboard

```
http://127.0.0.1:8767
```

Agents down the left, chat in the middle, and a right rail showing what he can
actually reach plus the skills and runs so far. Chat streams over SSE, so each
tool call appears the moment it fires — you watch him open your files rather
than waiting for a block of text.

**Why cleetusd serves this rather than the deck.** A page on
`https://cleetusai.com` cannot fetch `http://127.0.0.1` — mixed content and
private-network rules — and routing the other way needs a root-owned
cloudflared edit. Serving the page from the daemon makes page and API the same
origin, so there is nothing left to block. The deck reaches it with an ordinary
link, which is a navigation and allowed where a fetch is not.

**How a browser gets past the bearer.** It cannot attach an Authorization
header to a navigation, so `/`, `/skills`, `/runs` and `/chat/stream` are
admitted on `isLocalBrowser`: a loopback peer **and** no forwarding headers.
The second half is load-bearing — if 8767 ever goes behind cloudflared, the
tunnel connects from 127.0.0.1 too, so a plain loopback check would admit the
internet. `test/localbrowser.test.mjs` covers all of it, including a source
check that fails if `server.mjs` drifts from the rule.

## Reaching it from off the Mac

`~/Desktop/Cleetus/finish-cleetusd-tunnel.sh` puts cleetusd behind Caddy on
:8783 and points `me.cleetusai.com` at it, matching how llm/studio/web are
already done. It generates its own token rather than sharing one, backs up
every file it touches, validates both configs before restarting anything, and
prints an undo.

Read it before running it. Everything already on that tunnel is smaller than
this: llm is a model, studio is a camera, web is a browser. This is the machine.

**What it does and does not buy you.** It makes cleetusd reachable; it does not
by itself give you a usable phone UI, because a phone browser cannot send a
bearer header any more than the deck can. The intended follow-up is a Pages
Function that proxies `/api/cleetus` to `me.cleetusai.com` and adds the token
server-side — then the phone talks to cleetusai.com as normal and never sees a
credential. Until that exists, the tunnel is for programmatic callers.

## Configuration

Read from `~/Documents/Claude/Projects/Cleetus V2/cleetus.env`, overridable by
real env vars.

| | |
|---|---|
| `CLEETUSD_PORT` | default 8767 |
| `CLEETUSD_TOKEN` | bearer, required once exposed through the tunnel |
| `CLEETUSD_MODEL` | default `laguna-xs-2.1:q8_0` |
| `CLEETUSD_NO_SHELL=1` | kill switch for the shell alone |
| `CLEETUSD_MAX_STEPS` | tool-loop ceiling, default 12 |
| `CLEETUS_VAULT` | override the vault path (the tests use this) |
| `CLEETUS_MEMORY_ROOT` | where runs/skills are written, default `~/cleetus-memory` |
| `CLEETUSD_FS_TIMEOUT_MS` | vault read timeout, default 3000 |
| `CLEETUSD_IMPROVE_CAP` | autonomous changes per day, default 3 |
| `CLEETUSD_NO_TEACHER=1` | never call the cloud teacher |
| `CLEETUSD_TEACHER_MODEL` | default `claude-opus-5` |

## Whether he can actually see the whole disk

`GET /access`, or the `check_access` tool, probes every protected location and
reports `ok` / `denied` / `blocked`. There is no allowlist in this codebase —
but "permitted by the code" and "reachable by the process" are different things
on macOS, and the gap is otherwise invisible: a TCC denial and an empty folder
are the same result from `readdir`.

Probes run as killable child processes rather than `fs.readdir`, for a reason
worth knowing. A timed-out `readdir` is **not cancelled** — the `open()` stays
in the kernel holding one of libuv's four filesystem threads forever. Four
wedged reads and Cleetus cannot touch the disk at all, including local paths
that would answer instantly. The first version of the audit reported
`~/cleetus-memory` and `~/cleetusv2` as blocked for exactly that reason, and
they are plain local directories. The launch agent now sets
`UV_THREADPOOL_SIZE=64`, which does not fix a wedge but stops one wedge taking
everything down with it.

Binds to **127.0.0.1 only**. Exposure is the tunnel's job, behind Caddy's
bearer gate, the same shape `llm.cleetusai.com` already uses. Binding this to
`0.0.0.0` would put an unauthenticated shell on the wifi.
