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
| `look` | Describes what a camera can see. Does not know whose face it is. |
| `who_is_there` `learn_face` `known_faces` | Names the face. See below. |

**There is no path allowlist.** That was deliberate: the next project always
lives in the directory nobody thought to list. What replaces a restriction is a
**record** — every tool call is written into the run file as it happens.

## Faces

`look` describes; it cannot identify. Asked "is that Grayson" a vision model
says yes, because that is the likely sentence and it has never seen his face.
So identity is measured instead: YuNet finds faces, SFace turns each into 128
numbers, and a face gets a name only if those numbers land close enough to the
ones taken at enrolment.

```sh
node bin/face.mjs learn Grayson     # waits up to 40s for a face turned at the lens
node bin/face.mjs who               # who is in front of the room camera
node bin/face.mjs list
node bin/face.mjs forget Grayson
node bin/face.mjs selftest          # models + camera, without needing a known face
```

Enrolments live in `~/cleetus-memory/faces/gallery.json`, and every crop that
was learned from is kept alongside in `crops/` — an enrolment is a claim about
whose face it is, and looking is the only way to check that claim later.

**The threshold is 0.45, not SFace's shipped 0.363.** At 0.363 a stranger in a
photo on this Mac — same colouring, same curly fair hair — scored 0.394 and
would have been called Grayson by name. Grayson himself runs 0.634–0.870 live.
If he starts going unrecognised, run `learn` again in that day's light (it
appends) rather than lowering the number.

**There is no liveness check.** A photograph held up to the camera identifies as
the person in it. This answers "who is at my desk"; it must never gate a lock.

The two models are not in git — 37MB of downloadable binary. Fetch them into
`models/face/`:

```sh
mkdir -p models/face && cd models/face
curl -sSLo yunet.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
curl -sSLo sface.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
```

Note `media.githubusercontent.com`, not `raw.` — opencv_zoo stores these in git
LFS, and `raw.` serves a 133-byte pointer file that OpenCV rejects with a
confusing parse error rather than "this is not a model".

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

## Decensoring the model itself

`bin/heretic-laguna.sh` runs [Heretic](https://github.com/p-e-w/heretic) over
Laguna-XS-2.1, the model this daemon runs on. Directional ablation, with the
ablation strength chosen automatically by co-minimising refusal rate against KL
divergence from the original.

Be straight about what it does: **it suppresses refusal broadly**, not only the
false ones. Heretic's own headline result is harmful-prompt refusals going
97/100 to 3/100. The model comes out more willing about everything, and it is
wired into a process holding the shell, the disk and the bank credentials.

Four facts this Mac forces, all measured rather than assumed:

| | |
|---|---|
| Laguna-XS-2.1 is 66.9 GB in bf16 | against 68.7 GB of RAM shared with the OS. It does not fit. |
| bitsandbytes 0.49 works on Apple Silicon | verified: a 4-bit quantize/dequantize round trip on MPS. ~20 GB loaded. This is the only reason any of this is possible here. |
| Heretic's own merge does not fit | it reloads the base model unquantized and warns it can freeze the machine. So `--export-strategy ADAPTER`, and `bin/merge_lora_streaming.py` applies the LoRA one shard at a time at ~6 GB peak. Verified **bit-identical** to peft's own merge across all 311 tensors of a test model. |
| `--device-map auto` fails | accelerate sizes the device by what is free *now*, decides part of the model goes to CPU, and bitsandbytes refuses to be split. Pin it: `--device-map mps`. |

Two more traps, both of which cost hours:

**Heretic needs a pty.** Even with `--trial-index` and `--model-action` set it
builds prompt\_toolkit objects that touch the terminal, and with stdout
redirected that is `OSError` errno 22 — raised *after* the optimisation
finishes, which is the most expensive place in the run to fail. Hence
`script -q /dev/null`.

**Do not take the tokenizer fix.** transformers warns that this tokenizer uses
"an incorrect regex pattern" and offers `fix_mistral_regex=True`. That pattern
is the one poolside shipped and the one Ollama uses at inference. Tokenizing
differently from deployment would put the measurement out of step with the
thing being measured.

The run is staged and resumable — `download`, `abliterate`, `merge`, `package`,
`activate` — and each stage skips itself if its output already exists.
`bin/heretic-probe.py` times one generation at 4-bit and prints what the
configured trial count would therefore cost, so the length of the run is known
before it is started rather than after.

The config lives in `~/models/heretic-work/config.toml` and adds a **second
refusal objective** to Heretic's stock one, because the stock one is not what
this model actually fails at. The failures recorded in `agent.mjs` are
capability denials — "I cannot access the Georgia DOR website" from an agent
holding `web_open`. So a second scorer runs on `heretic/capability-prompts.txt`,
which is drawn from what Grayson actually asks, **with cleetusd's real system
prompt attached**. That last part is the whole point: evaluated bare, "read
~/cleetus-memory/MEMORY.md" *should* be refused, and optimising that away would
tune the model to lie. With the access asserted in the prompt, a denial is
false, and minimising it makes the model honest rather than compliant.

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
