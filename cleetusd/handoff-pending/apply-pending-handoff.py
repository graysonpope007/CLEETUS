#!/usr/bin/env python3
"""Apply every handoff update this session could not write itself.

macOS repeatedly revoked the background session's access to ~/Desktop. Nothing
else was affected. This script applies, in order:

  1. A correction to section 15 — Playwright was not one of the browser faults.
  2. Section 17 — the tool sweep: missing-argument guard, browser recovery.
  3. A correction to section 14 — the six "recoverable" launch agents are NOT a
     pure path rewrite. This is the important one.
  4. Section 18 — why, in full.

Run from a terminal with Desktop access:

    python3 ~/cleetusd/handoff-pending/apply-pending-handoff.py

It asserts each anchor exists before editing, so it fails loudly rather than
half-applying. Safe to inspect first; re-running would duplicate sections, so
check with:

    grep -c 'id="s25"' ~/Desktop/Cleetus/CLEETUS-HANDOFF.html   # 0 = not applied
"""

import re
import sys

P = '/Users/grayson/Desktop/Cleetus/CLEETUS-HANDOFF.html'

try:
    s = open(P).read()
except PermissionError:
    sys.exit("Still cannot read the handoff — grant this terminal Desktop access and retry.")

if 'id="s25"' in s:
    sys.exit("Already applied (section 25 is present). Nothing to do.")


def swap(old, new, what):
    global s
    if old not in s:
        sys.exit(f"Anchor not found for {what}. The handoff has changed; apply by hand.")
    s = s.replace(old, new)


# ── 1. correction to section 15 ──────────────────────────────────────────────
swap(
    '''<p>Real page, real session, one tool call. Also fixed on the way: Playwright had been upgraded without
  its browser being re-downloaded, so it looked for <code>chromium-1234</code> against a cache holding
  <code>1208</code> and refused to launch.</p>''',
    '''<p>Real page, real session, one tool call.</p>
  <div class="card">
    <h4>Correction</h4>
    <p style="margin-bottom:0">An earlier draft credited a fourth fix: Playwright upgraded without its
    browser re-downloaded, looking for <code>chromium-1234</code> against a cache holding
    <code>1208</code>. That drift is real, but it was never the harness's problem &mdash; it launches
    with <code>channel: 'chrome'</code>, the Chrome already on this machine. The failure was in a bare
    <code>chromium.launch()</code> probe written while diagnosing, and the 95 MB download it prompted
    was not needed. Three faults, not four.</p>
  </div>''',
    "the section 15 correction")

# ── 3. correction to section 14 ──────────────────────────────────────────────
swap(
    '''<p>Six are a pure path rewrite. Four scripts exist nowhere on this disk &mdash; they only ever lived in
  the worktree and were lost when it was emptied. Those agents should be booted out rather than left
  respawning against nothing.</p>''',
    '''<p>Four scripts exist nowhere on this disk &mdash; they only ever lived in the worktree and were lost
  when it was emptied. Those agents should be booted out rather than left respawning against nothing.</p>

  <div class="card bad">
    <h4>Correction: the other six are NOT a pure path rewrite</h4>
    <p style="margin-bottom:0">This section originally said they were. A pre-flight (section 18) found
    that repointing them would produce a morning brief written to a directory that does not exist, which
    nobody would ever read. Do not run the rewrite below expecting a working brief &mdash; read section
    18 first.</p>
  </div>''',
    "the section 14 correction")

# ── corrections to what the outage actually cost ─────────────────────────────
# The loudest wrong claim: the brief Grayson reads was never affected.
swap(
    """    <p style="margin-bottom:0">The morning briefing is one of the ten. <b>The 7:03 brief &mdash; the
    thing section 01 calls "the number that matters", the reason the local model was stood up at all
    &mdash; has not run since 19 May.</b> So has the nightly consolidation, the vault sync, the memory
    reindex, the text monitor and the open-loop sweep. Every one of them is a piece of Cleetus's
    long-term memory and daily rhythm. The only visible symptom was a brief that did not arrive.</p>""",
    """    <p>Ten scheduled jobs stopped: the nightly consolidation, vault sync, memory reindex, text
    monitor, open-loop sweep, weekly brain analysis, a chat server, and a <code>morning_briefing.py</code>
    that writes markdown into a git vault and posts it to Slack. Every one is a piece of Cleetus's
    long-term memory and daily rhythm, and none has run since 19 May.</p>
    <p style="margin-bottom:0"><b>It is NOT the brief you read.</b> An earlier draft of this section said
    the 7:03 brief &mdash; "the number that matters" &mdash; had been dead since May. That was wrong, and
    wrong in the direction that causes alarm. There are two different briefs. The cloud app's is
    generated against the local model, stored in the database, and was written today at 00:21 ET. This
    dead one is a separate Slack/markdown job. Section 18.</p>""",
    "the section 14 cost card")

swap(
    """<b>That brief has not been
    delivered since 19 May</b>, for a reason that had nothing to do with the model and everything
    to do with a file path. Section 14.</p>""",
    """Still true today: this morning's arrived at 00:21 ET.
    (An earlier revision claimed this brief had been dead since 19 May. It confused it with a separate
    Slack/markdown job that really is dead &mdash; sections 14 and 18.)</p>""",
    "the section 01 'number that matters' card")



# ── 2 + 4. new sections ──────────────────────────────────────────────────────
S17 = '''
<section id="s17"><div class="wrap">
  <h2><span class="n">17</span>Asking every tool to prove itself</h2>

  <p class="lede"><code>browse</code> was offered to the model on every message and had never worked
  once. That is not the kind of bug you find by reading code &mdash; you find it by calling the thing.
  So every tool got called, with the arguments a model would plausibly send.</p>

  <p><code>node ~/cleetusd/bin/tools-check.mjs</code> exercises all 18 across 20 calls. It is
  deliberately <b>not</b> part of the doctor: it writes files, drives a browser and touches memory, so it
  is run on purpose rather than on a schedule. It leaves two probe records in
  <code>~/cleetus-memory</code>, named TOOLSWEEP, to be deleted after.</p>

  <h3>A missing argument is not an empty result</h3>
  <p>Called without its required <code>find</code>, <code>edit_file</code> searched the file for the
  literal string <code>undefined</code>, found nothing, and replied:</p>
  <pre>Not found in /tmp/probe.txt. Read the file and match the text exactly, including indentation.</pre>
  <p>Every word of that is advice for a <i>different</i> problem. Nothing in it suggests the call itself
  was malformed, so the model re-reads the file and retries the same broken call. <code>find_files</code>
  did the same: <code>Nothing named like "undefined"</code>, phrased as an empty search rather than an
  absent argument.</p>
  <p>Now checked once in <code>callTool</code>, from the schemas the tools already declare, so every tool
  gets it and no future one has to remember:</p>
  <pre>edit_file is missing required arguments: find (Exact text to replace. Must appear
exactly once.); replace. Nothing was done — call it again with find and replace.</pre>
  <p>An empty string counts as missing, because <code>""</code> is the shape a model produces when it
  knows it needs an argument and has nothing to put there.</p>

  <h3>The browser could not come back from being closed</h3>
  <div class="card bad">
    <p style="margin-bottom:0"><code>ensure()</code> began <code>if (ctx) return { ctx, page }</code> and
    never asked whether that context was still alive. The moment the browser went away &mdash; Grayson
    closing the window, a crash, the profile being cleaned up &mdash; every later call threw
    <code>Target page, context or browser has been closed</code>, and kept throwing until the whole
    harness was restarted. Nothing reopened it, because from inside it still looked open.</p>
  </div>
  <p>It now proves the context is alive before handing it back, relaunches if it is not, and drops its
  handles on the browser's own <code>close</code> event. Verified by closing the browser mid-session:
  open, close, then open / read / scroll all succeed, where previously everything after the close
  failed.</p>

  <h3>Result</h3>
  <p>20 calls, 0 broken. The 16 that were already fine are worth naming, because "it is registered" and
  "it works" had not been the same thing: <code>read_file</code>, <code>write_file</code>,
  <code>edit_file</code>, <code>list_dir</code>, <code>search_files</code>, <code>find_files</code>,
  <code>run_shell</code>, <code>vault_search</code>, <code>vault_read</code>, <code>remember_fact</code>,
  <code>save_skill</code>, <code>check_access</code>, <code>cloud_api</code>, <code>desk_light</code> and
  the four <code>web_*</code>. Test suite: 11 files, 34 tests.</p>
</div></section>
'''

S18 = '''
<section id="s18"><div class="wrap">
  <h2><span class="n">18</span>The morning brief cannot just be repointed</h2>

  <p class="lede">Section 14 said six of the ten dead agents were "a pure path rewrite". Before
  recommending that anyone run it, the six were checked properly. They are not.</p>

  <div class="card">
    <h4>First, which brief this is</h4>
    <p style="margin-bottom:0">There are two, and an earlier revision of this document confused them.
    <b>The brief you actually read is fine</b> &mdash; the cloud app generates it against the local
    model and stores it in the database; today's was written at 00:21 ET and <code>/api/health</code>
    has been reporting it green throughout. The dead one is <code>morning_briefing.py</code>: a
    separate job that writes a markdown note into a git-tracked vault and posts a summary to Slack.
    Losing it costs the Slack summary and the vault note, not the brief itself.</p>
  </div>

  <h3>What does hold up</h3>
  <p>All six compile under the python their plists name. <code>dotenv</code> and <code>anthropic</code>
  are installed for it. <code>integrations/</code> is present next to the scripts, and
  <code>chat/adapters</code> and <code>chat/core</code> are present for the chat server. So the imports
  are fine and the code is intact.</p>

  <h3>What does not</h3>
  <p><b>The vault is computed from the script's own location.</b></p>
  <pre>VAULT = Path(__file__).parents[2] / "vault"</pre>
  <p>That is the whole problem. Moving the scripts moves the vault with them:</p>
  <div class="scroll"><table>
    <tr><th>Script at</th><th>VAULT resolves to</th><th>Exists?</th></tr>
    <tr><td>the old worktree</td><td><code>&hellip;/naughty-fermat-4efa9a/vault</code></td><td><span class="tag bad">no</span> emptied with the worktree</td></tr>
    <tr><td><code>~/.claude/scripts</code> (after a repoint)</td><td><code>/Users/grayson/vault</code></td><td><span class="tag bad">no</span> never existed</td></tr>
    <tr><td>&mdash;</td><td>the real Obsidian vault in iCloud</td><td><span class="tag ok">yes</span> but nothing points at it</td></tr>
  </table></div>
  <p>So a repointed morning brief would run, succeed, and write
  <code>/Users/grayson/vault/10-Daily/&lt;date&gt;.md</code> into a directory it creates for the purpose
  &mdash; which nobody opens, and which is not the Obsidian vault. It would look fixed and deliver
  nothing. That is the same shape as every other fault in this document.</p>

  <p><b>The vault it wants was never really there.</b> Exactly one vault file is tracked in the home
  repo &mdash; <code>cleetus/.claude/worktrees/vault/10-Daily/2026-04-23.md</code> &mdash; and it is
  deleted in the working tree right now. The docstring says it "commits vault", so this was meant to be
  a git-tracked markdown vault, separate from Obsidian. It has one day in it, from 23 April.</p>

  <p><b><code>CLEETUS_ROOT</code> points somewhere empty.</b> The plists set it to
  <code>/Users/grayson/cleetus</code>, which contains only the hollow worktree and a
  <code>.DS_Store</code>. The scripts do <code>load_dotenv(Path(os.environ["CLEETUS_ROOT"]) / ".env")</code>
  and there is no <code>.env</code> there. <code>load_dotenv</code> does not complain about a missing
  file &mdash; it loads nothing and returns.</p>

  <p><b>Keys are half there.</b> <code>ANTHROPIC_API_KEY</code> is in the 90-key mirror.
  <code>ALPHA_VANTAGE_KEY</code> and <code>STOCK_TICKERS</code> are not &mdash; though that section
  degrades to a polite "key not set" line rather than crashing, and the tickers have a default.</p>

  <h3>So what would actually revive it</h3>
  <ol>
    <li>Repoint <code>ProgramArguments</code> to <code>~/.claude/</code> (section 14).</li>
    <li>Decide where its vault lives, and make <code>parents[2]/vault</code> land there &mdash; a
      <code>~/vault</code> symlink, or an edit to the script. <b>If that target is the Obsidian vault,
      expect it to hang:</b> iCloud does not serve launchd agents, which is exactly why cleetusd's own
      memory was moved to <code>~/cleetus-memory</code>. A git-tracked <code>~/vault</code> avoids that
      entirely and matches what the script was written to do.</li>
    <li>Put a <code>.env</code> at <code>$CLEETUS_ROOT</code> with at least
      <code>ANTHROPIC_API_KEY</code>, or point <code>CLEETUS_ROOT</code> at a directory that has one.</li>
    <li>Then read one brief before trusting the schedule.</li>
  </ol>

  <div class="card">
    <h4>Why this was worth an hour</h4>
    <p style="margin-bottom:0">The tempting move was to run six <code>sed</code> commands, watch the
    doctor go green, and report the morning brief restored. It would have gone green. The brief still
    would not have arrived, and the next person would have inherited a system that claims to be healthy
    &mdash; which is worse than the honest red it shows today.</p>
  </div>
</div></section>
'''

S19 = '''
<section id="s19"><div class="wrap">
  <h2><span class="n">19</span>The flight map was dark, and nothing said so</h2>

  <p class="lede">Making the doctor stop skipping one check found that the flight map had been
  returning <code>{"ok":false,"error":"no_adsb_feed_reachable"}</code> in production. Every component
  in the chain was behaving correctly.</p>

  <h3>How a check that always skipped hid it</h3>
  <p>The flights check needed a session cookie the doctor did not have, so it skipped &mdash; every run,
  for as long as it has existed. A check that always skips is the same as no check. The site takes a
  password login that <code>cloud_api</code> had been using all along; borrowing it costs one request,
  and the check went red the first time it could actually run.</p>

  <h3>An empty answer is not an answer</h3>
  <pre>{"ac":[], "msg": "No error", "total": 0}</pre>
  <p>That is adsb.lol, HTTP 200, for every anchor on earth. Perfectly well-formed and completely empty.
  The source loop read:</p>
  <pre>if (Array.isArray(ac)) return { source: name, aircraft: normalise(ac) };</pre>
  <p><code>[]</code> is an Array. So the first source won with nothing, the fallbacks were never
  reached, and the map went dark &mdash; while every part of the chain reported success in its own
  terms. The sweeper "succeeded" with 0 aircraft. The ingest correctly refused an empty sweep. The
  endpoint said <code>no_adsb_feed_reachable</code>, which was true and named none of this.</p>

  <h3>Where the aircraft went</h3>
  <div class="scroll"><table>
    <tr><th>Source</th><th>Status</th></tr>
    <tr><td>adsb.lol</td><td><span class="tag bad">empty</span> 200 OK, "No error", zero aircraft over Atlanta at midday</td></tr>
    <tr><td>airplanes.live</td><td><span class="tag bad">403</span> "please contact us" &mdash; public access closed</td></tr>
    <tr><td><b>adsb.fi</b></td><td><span class="tag ok">works</span> real traffic, under the key <code>aircraft</code> rather than <code>ac</code></td></tr>
  </table></div>
  <p>adsb.fi is now tried first. The other two are kept rather than deleted &mdash; feeds come back, and
  a dead one costs a single failed request to check. A source now only wins when it actually produced
  aircraft, and a reachable-but-empty source is remembered separately from nobody answering, because a
  genuinely empty sky exists at 3am mid-Pacific and should not read as total failure.</p>

  <h3>Result</h3>
  <pre>before   ok:false   error: no_adsb_feed_reachable
after    ok:true    4,862 aircraft   20/20 anchors   swept_by: mac-studio</pre>
  <p>Doctor: 24 checks, all cloud checks green. Test suite: 12 files, 39 tests, including one that
  fails if anyone reintroduces <code>if (Array.isArray(ac)) return</code>.</p>

  <div class="card">
    <h4>My own probe made the same mistake</h4>
    <p style="margin-bottom:0">Testing the three feeds by hand, I counted <code>d["ac"]</code> and
    reported adsb.fi as returning 0 aircraft too. It was returning plenty &mdash; under
    <code>aircraft</code>. Had I trusted that probe, the conclusion would have been "all three feeds are
    dead, nothing to be done". Dumping the raw body instead of the parsed count is what found it.</p>
  </div>
</div></section>
'''

S20 = '''
<section id="s20"><div class="wrap">
  <h2><span class="n">20</span>Two Cleetuses, different instructions</h2>

  <p class="lede">cleetusd reads the agent briefs off the disk. The web app fetches them as static
  assets from the deployed site. Nobody had checked that those were the same text.</p>

  <h3>They were not</h3>
  <pre>skin     disk 2,736 chars   live   903
deals    disk 4,139 chars   live   813
brief    disk 3,065 chars   live   621
fashion  disk 2,669 chars   live   899</pre>
  <p>Those live figures are exactly the pre-training sizes. The Opus 5 pass rewrote all 18 briefs on
  disk and they were never committed, so every specialist in the web app has been answering from the
  old short brief while the same specialist in the deck used the new one. Both halves work perfectly
  from their own point of view, which is why nothing said anything. One commit of
  <code>brain/agents/</code> fixes it &mdash; and auto-deploys, so it is a deliberate act.</p>
  <p>The doctor now samples four briefs and compares disk against what the site serves.</p>

  <h3>Outlook: the answer was in the same object</h3>
  <pre>GET /api/microsoft/mail  →  {"ok":true,"connected":false,"messages":[]}</pre>
  <p>The health check graded <code>ms.ok</code> &mdash; which means "the request succeeded" &mdash; and
  reported <b>outlook: connected</b>. The field that answers the actual question, <code>connected:
  false</code>, was sitting in the same response being ignored. The endpoint returns that shape
  deliberately so the dashboard can show a "Connect Outlook" prompt; only the health check was reading
  the wrong field. Outlook mail has not been working, and the pill has been green.</p>

  <h3>Push: the same shape again</h3>
  <p><code>push</code> reported <code>ok:true, "phone registered"</code> while its own <code>last</code>
  field said <code>{note: "no_devices", sent: 0}</code> &mdash; the most recent real push reached
  nobody. It was grading registration while the answer to delivery sat beside it. Now a push that has
  not been attempted lately is fine; one that was attempted and reached zero devices is not.</p>

  <h3>Calendar and mail, counted</h3>
  <p><code>google</code> was graded <code>Array.isArray(cal)</code> &mdash; the same test that let the
  flight map die, since <code>[]</code> passes it. An empty calendar <i>is</i> legitimate, so it still
  counts as green, but the detail now reads "connected, 20 events" rather than just "connected".
  Reading "connected, 0 events" on a day you know you had meetings is the difference.</p>

  <div class="card">
    <h4>The pattern, stated plainly</h4>
    <p style="margin-bottom:0">Four times now the truth has been present in the same object as the
    lie: <code>{ok:true, connected:false}</code>, <code>{registered, sent:0}</code>,
    <code>{"msg":"No error","total":0}</code>, <code>{ok:true, error:"no_adsb_feed_reachable"}</code>.
    Nothing was hidden. Each check simply graded the field that was easy to reach instead of the field
    that answered the question.</p>
  </div>

  <p>The cloud app's eight integration checks are also pulled into the doctor now (28 checks), because
  a red pill on a page nobody has open is not a signal. It reads green today only because production
  still runs the old <code>health.js</code>; the fix is uncommitted, and outlook goes red when it
  ships.</p>
</div></section>
'''

S21 = '''
<section id="s21"><div class="wrap">
  <h2><span class="n">21</span>Finishing the integration sweep</h2>

  <p class="lede">Four integrations had been checked. These are the rest, verified by asking for real
  data rather than trusting the word "connected".</p>

  <div class="scroll"><table>
    <tr><th>Integration</th><th>Asked for</th><th>Got</th></tr>
    <tr><td>Google Calendar</td><td>events</td><td><span class="tag ok">20</span></td></tr>
    <tr><td>Gmail</td><td>unread</td><td><span class="tag ok">6</span> &mdash; matches "six emails waiting" in today's brief</td></tr>
    <tr><td>Outlook</td><td>unread</td><td><span class="tag bad">connected:false</span> section 20</td></tr>
    <tr><td>Plaid</td><td>accounts</td><td><span class="tag ok">2, ready</span></td></tr>
    <tr><td>Schwab</td><td>balances</td><td><span class="tag ok">3</span></td></tr>
    <tr><td>Snapshots</td><td>net worth history</td><td><span class="tag ok">real series</span></td></tr>
    <tr><td>Ledger P&amp;L</td><td>2026 by entity</td><td><span class="tag warn">12 of 342 rows</span> see below</td></tr>
  </table></div>

  <h3>The P&amp;L describes 3% of the year</h3>
  <pre>rowCount  342
untagged  {count: 330, moneyIn: 17833.39, moneyOut: 27310.43}</pre>
  <p>330 of 342 ledger rows belong to no entity &mdash; roughly $45,000 of money movement sitting
  outside the P&amp;L. The tagged figures (Creo income $8,601, personal expenses $2,151) are correct
  and describe about 3% of the year.</p>
  <p><b>This is not a bug.</b> The endpoint reports <code>untagged</code> at the top level, honestly,
  and the books agent is already instructed that "a P&amp;L reported without that percentage is a lie by
  omission". It is bookkeeping left to do, not code to fix.</p>
  <p>What was wrong is that <b>the tax agent had no such rule</b>, and tax is where quoting an
  incomplete P&amp;L does real damage: a quarterly estimate sized off 3% of the year is not
  conservative, it is wrong in the direction that underpays. Its brief now states the current numbers
  and requires the untagged figure alongside any P&amp;L number. Asked for a quarterly estimate
  afterwards, it led with the gap and asked for the 2024 safe-harbor figure instead of quoting
  something false.</p>

  <h3>Eight briefs referenced a tool that no longer exists</h3>
  <p>Replacing <code>browse</code> with the <code>web_*</code> primitives (section 17) left nine
  mentions of <code>browse</code> across fashion, deals, music, hair, skin, poker, stocks and tax
  &mdash; instructions to call something no longer registered. Aliasing would have been the wrong fix,
  because the arguments differ: <code>browse</code> took a plain-English instruction,
  <code>web_open</code> takes a URL. Each mention was rewritten in the sense it was written.</p>
  <p>The lesson became a check rather than a note. Backticked snake_case is the convention in these
  files for naming a tool, so the doctor now extracts every one and asserts it resolves in the
  registry &mdash; 19 briefs, all clean. Verified by putting a dead name back in
  <code>stocks.md</code> and watching it go red, because a check that has never failed has not been
  tested.</p>
</div></section>
'''

S22 = '''
<section id="s22"><div class="wrap">
  <h2><span class="n">22</span>What the agents do when they do not know</h2>

  <p class="lede">Per-agent memory was tested end to end and works exactly as designed. Testing it
  turned up something worse than a broken feature: a confident invention.</p>

  <h3>Memory: verified</h3>
  <p>Told the skin agent a fact, then asked three agents about it cold. The skin agent recalled it, the
  generalist knew it, an unrelated specialist did not. The skin agent also wrote it into the matching
  prompt in <code>40-Areas/Health/body.md</code>, which is how the dossiers are meant to fill in over
  time. Every trace of the test fact was then removed from the vault, agent memory and the run log.</p>

  <h3>The unrelated agent did not say "I don't know". It made something up.</h3>
  <p>Asked about the same invented product name, the nutrition agent replied that it was a memory
  testing utility for x86 systems in the late 1990s, booted into DOS or minimal Linux, run overnight to
  catch bad RAM, since superseded by MemTest86+. Fluent, specific, entirely fabricated, no tool calls,
  no hedge.</p>
  <p>The prompt was partly responsible. <b>"No corporate hedging, no filler, no disclaimers"</b> reads
  as an instruction never to admit ignorance, and the model resolved the conflict by producing
  something that sounded right. The two rules now sit next to each other and the conflict is settled in
  the text:</p>
  <pre>If you do not know something, say so in one short sentence and stop... Never fill
the gap with something that merely sounds right; a confident invention is the
single worst thing you can hand him, because he will act on it. "No hedging"
means do not pad an answer you actually have. It is not permission to
manufacture one you do not.</pre>
  <p>Retested with two invented terms against nutrition and tax. Both declined cleanly.</p>

  <h3>And the opposite fault, in the same breath</h3>
  <p>Declining honestly, the tax agent added that it "cannot access the Georgia DOR website" &mdash;
  while holding <code>web_open</code>, carrying a brief that tells it to verify rates against
  dor.georgia.gov. Refusing a capability it has is the same failure as refusing to read a file, and it
  was going unrecorded because <code>looksFailed</code> had no words for browsing. It does now, with
  tests both ways: refusing to browse counts as a failure, admitting genuine ignorance does not. That
  second test matters &mdash; grading an honest "I don't know" as a failure would send it to the cloud
  teacher to be fixed and train the behaviour straight back out.</p>

  <h3>Three services would not have come back</h3>
  <p>The doctor caught the air trackpad missing entirely, with an orphaned ffmpeg still holding its
  camera. That led to the policy behind it: <code>airpad</code>, <code>cleetusd</code> and
  <code>web</code> all carried <code>KeepAlive: {SuccessfulExit: false}</code>, which means launchd
  will not restart them after a <i>clean</i> exit. For a daemon that should never exit, that is a
  silent permanent death. Now unconditional, which adds no crash-loop risk because a failing service
  restarted under either policy.</p>
  <div class="card">
    <h4>Two self-inflicted faults while fixing it</h4>
    <p style="margin-bottom:0"><code>launchctl bootout</code> is asynchronous. Bootstrapping straight
    after it silently does nothing, and cleetusd and airpad sat down until the second attempt &mdash;
    wait for the service to leave the domain before loading it again. And PlistBuddy rewrites the whole
    file, dropping every XML comment: the notes explaining why each service exists and how to restart
    it were gone in one command. Restored by editing the original text instead.</p>
  </div>

  <h3>Plaid, an hour apart</h3>
  <pre>19:50   /api/plaid/accounts   ready, 2 accounts
21:00   /api/plaid/accounts   {"ready":false,"reason":"no_banks"}
21:00   /api/plaid/spending   ready, in $4,276 / out $3,371</pre>
  <p>The link is alive &mdash; spending returns real transactions. It is the accounts endpoint
  specifically, reporting no checking or debit accounts on the linked institutions. Caught only because
  the cloud app's own health is now pulled into the doctor. Whether it is a transient balance refresh
  or an item needing re-link is Grayson's to judge; the point is that it changed within the hour and
  something noticed.</p>
  <p>A cold doctor pass runs in 2.3s across 29 checks, comfortably inside the deck's 45s abort.</p>
</div></section>
'''

S23 = '''
<section id="s23"><div class="wrap">
  <h2><span class="n">23</span>The half he talks to could not send email</h2>

  <p class="lede">Asked how email should work, Grayson picked <b>"send freely to anyone"</b> over
  draft-and-approve. The cloud endpoint was built for exactly that. The local Cleetus &mdash; the one
  with the disk, the shell and the cameras, the one he actually talks to &mdash; had no send tool at
  all. The decision was made and the capability was built, on opposite sides of the system.</p>

  <h3>send_email</h3>
  <p>Calls <code>/api/google/send</code>, which sends as him for real, logs every message to
  <code>sent_emails</code> <i>before</i> the call so a mistake is findable afterwards, and has one kill
  switch, <code>EMAIL_SEND_ENABLED=0</code>. Outlook cannot send at all: that grant is
  <code>Mail.ReadWrite</code>, which does not cover it.</p>
  <p><b>No confirmation step in the tool, deliberately.</b> cleetusd is already the most privileged
  thing on this machine; a prompt here would only train the model to answer its own prompt. The real
  protections are the session, the record written before the send, and a switch that works without a
  deploy. Reproducing them badly in the tool would make the system look safer while changing
  nothing.</p>
  <p>One guard that is worth its weight: an address with no <code>@</code> in it is refused by name.
  The realistic failure is the model writing "Isaiah" where the address goes, and that fails in a way
  nobody sees.</p>

  <h3>Verified without sending anything</h3>
  <pre>POST /api/google/send  {to:"", subject:"", body:""}  →  {"ok":false,"error":"no_recipient"}</pre>
  <p>Which proves the session carried, the route exists, and the kill switch is not engaged &mdash;
  everything except the final Gmail call. <b>No test email was sent.</b> The first one should be his,
  knowingly, not a surprise in his sent folder.</p>

  <div class="card warn">
    <h4>A conflict for Grayson to settle</h4>
    <p><code>brain/agents/writing.md</code> says, in two places:</p>
    <pre>Nothing goes out until he says "send it."
Never send, reply, or post anything. Draft only, every time, no exception
for "he obviously wants this sent."</pre>
    <p style="margin-bottom:0">That brief predates the "send freely" decision and directly contradicts
    it. It has NOT been changed, because the two readings lead to different behaviour and only he knows
    which he meant: the decision may have been about what the system should be capable of, while the
    writing agent specifically stays a drafter. Asked to send a test message, the writing agent refused
    and cited its own brief &mdash; capability present, policy declining, which is a coherent place to
    leave it. Every other agent will send when asked.</p>
  </div>

  <h3>Also this round</h3>
  <p>Plaid recovered on its own: <code>ready=false, no_banks</code> at 21:00, <code>ready=true</code>
  with two accounts by 22:00. A genuine hour-long transient, seen only because the cloud app's health
  is now inside the doctor.</p>
  <p>19 tools, 46 tests.</p>
</div></section>
'''

S24 = '''
<section id="s24"><div class="wrap">
  <h2><span class="n">24</span>The camera that was working the whole time</h2>

  <p class="lede">"The camera doesn't work" turned out to be four separate faults stacked on top of
  each other, and every one of them presented as nothing happening while every readout stayed green.
  It is the best example in this whole document of why a health field that cannot go red is worse
  than no health field.</p>

  <h3>It was pointing at the television</h3>
  <p><code>config.json</code> had <code>display: null</code>, and null meant <i>the first non-main
  display</i>. That is display 3 &mdash; the LG. So the pointer was being driven correctly, at full
  rate, on a screen nobody was looking at. Nothing was broken and nothing reported a fault. null now
  means the main display, and the picker names screens by EDID vendor, because two of the three here
  are 1920&times;1080 and "1920&times;1080" identifies neither.</p>

  <h3>The tracker thread had been dead for hours</h3>
  <p>MediaPipe's video mode rejects a timestamp that is not strictly increasing &mdash; by raising, on
  the calling thread. It was being fed <code>int(time.time()*1000)</code>, a wall clock that steps
  backwards whenever ntpd corrects it. One correction, thread gone.</p>
  <p>Everything downstream carried on looking healthy, which is the part worth remembering: the camera
  reader is a different thread, the HTTP server is another, and the last annotated frame stays in
  memory, so the live view kept serving it. A frozen JPEG is indistinguishable from a very still room.
  The loop is supervised now, the clock is monotonic, and the timestamp is a counter that cannot
  repeat.</p>

  <h3>The camera was sending one picture over and over</h3>
  <p>Of 68 consecutive frames pulled off the wire, <b>one</b> was distinct. Frame counters read 70fps,
  ffmpeg sat at 1200% CPU, the multipart stream was byte-perfect, 434 frames arrived in six seconds.
  All true. All irrelevant.</p>
  <p>The C920 advertises exactly <code>30.000030</code> fps. Ask for 30, or let ffmpeg default to
  29.97, and avfoundation pads the stream with duplicate frames rather than admitting it cannot serve
  the rate. Asking for the exact value gives 100% unique frames and drops ffmpeg to 10% CPU. The
  original setting made it worse still: uncompressed 1080p is ~124 MB/s and this is a USB 2.0 device,
  which measured <b>0.2 real frames per second</b>.</p>
  <table>
    <tr><th>capture</th><th>real fps</th></tr>
    <tr><td>1920&times;1080 uncompressed (as configured)</td><td>0.2</td></tr>
    <tr><td>1280&times;720</td><td>5.2</td></tr>
    <tr><td>864&times;480 at 30.000030</td><td>19</td></tr>
  </table>
  <p>Resolution barely moves the rate, which was the surprise &mdash; 432&times;240 and 864&times;480
  both give 19. Room light was tested and refuted (Litra off 19.3, full 19.0), as was contention with
  the BRIO, which is on a different USB bus. The camera has simply negotiated its 20fps mode. Past
  that needs manual UVC exposure control or a different camera; the BRIO measures 27.</p>

  <h3>A polite restart could not fix it</h3>
  <p>The watchdog tested that <code>_seq</code> advances &mdash; and duplicates advance
  <code>_seq</code>, so the check meant to catch a frozen stream was blind to the way this one freezes.
  It now judges content as a <i>rate</i>: a stuck capture still emits one genuinely new frame a second,
  so any consecutive-identical test resets on that frame and never fires. Hundreds delivered against a
  handful distinct is what is unambiguous.</p>
  <p>And its restart did not work. <code>_restart_proc</code> sent SIGTERM; ffmpeg spinning on
  avfoundation does not unwind politely, so the USB session was still half-open when the replacement
  opened the device and inherited the same wedged mode. SIGKILL, and two seconds before reopening.
  Verified live: stuck at 11&ndash;24 distinct and 1200% CPU, self-healed to 49 of 51 distinct at
  9.6%.</p>

  <div class="card">
    <h4>The habit this leaves behind</h4>
    <p style="margin-bottom:0">Count <b>distinct</b> frames, never delivered frames.
    <code>real_fps</code> in <code>/api/state</code> counts content changes and <code>fps</code> counts
    arrivals; when they disagree, believe the smaller one. Every fault above was visible in that one
    ratio and invisible in everything else.</p>
  </div>

  <h3>Calibration</h3>
  <p>The mapping trimmed a fixed 18% off each frame edge and stretched the rest over the screen, which
  assumes the box you gesture in is centred and square-on to the lens. Neither is true: he sits low and
  left of centre, and the camera sees the plane at an angle, so the swept rectangle arrives as a
  trapezoid. <code>/calibrate</code> fits a homography from four measured corners &mdash; an affine
  transform cannot do it, the two perspective terms are the point. It measures his <b>reach</b>, not the
  screen, so one calibration holds whether the cursor drives one display or all three. Measured reach:
  56% &times; 31% of frame.</p>
  <p>Scrolling is calibrated separately, because it is a different gesture measured against different
  things: a hold to find the jitter he cannot help, a sweep to find how far he can comfortably reach.
  It was previously measured in <i>screen pixels</i>, so the same movement scrolled a different amount
  on the television than on the portrait panel. Normalised now, with gain applied once at the end.</p>

  <p>Also: the tracker was handing MediaPipe the full frame when the landmarker works on ~256px, so a
  full-size colour conversion and an extra resize were being paid for nothing. It gets a 384px copy;
  the overlay keeps the full frame. Tracking went from 14 delivered / 12 distinct to 28 / 22.</p>
</div></section>
'''

S25 = '''
<section id="s25"><div class="wrap">
  <h2><span class="n">25</span>Two pages, and an answer that stopped mid-sentence</h2>

  <p class="lede">The dashboard with the trackpad, the light and the agents on it existed only at
  <code>127.0.0.1:8767</code>. That is not a page on the site: no link to it, nothing to open from a
  phone, and it disappeared the moment he left the desk.</p>

  <h3>/reach</h3>
  <p>Read-only state travels through <code>/api/reach</code>, which holds the bearer server-side and
  forwards over the existing tunnel, so the page works from anywhere. Anything that <b>moves the
  cursor</b> does not: those routes go straight to <code>127.0.0.1:8767</code>, and cleetusd refuses
  them for any request carrying forwarding headers &mdash; so a valid token arriving through the tunnel
  is turned away too. Verified against the live tunnel with a real token: <code>not_local</code>.</p>
  <p>The middleware lifts three CSP rules for that path alone. The one that matters is
  <code>upgrade-insecure-requests</code>, which rewrites <code>http://127.0.0.1</code> to
  <code>https://</code> &mdash; cleetusd does not speak it, and the failure is invisible: no violation
  to read, the request simply never arrives. The same rule had been silently blocking the deck's own
  probe of cleetusd on every load, which is why the "open full Cleetus" link never appeared even sitting
  at the Mac.</p>

  <h3>/ruview</h3>
  <p>RuView reads presence, breathing and heart rate out of the disturbance a body makes in ambient
  WiFi. The band-1 left screen was the sun's altitude; it is the house now &mdash; same rings, because
  the reference puts a ring target there, but they are node range instead of orbits and the dot that
  moves is a person.</p>
  <p>Every field is read off the real API, taken from the sensing server's handlers rather than guessed,
  and the readable endpoints are an allowlist by exact name: the server also exposes training, model
  loading and recording, none of which should become reachable just because the read path did. Nothing
  is invented when the server is absent, which is the state it is in until the hardware exists &mdash;
  and that matters more here than anywhere else on the deck, because a plausible dot on a presence
  sensor is a claim that somebody is in the house.</p>

  <h3>The chat was answering with its own preamble</h3>
  <p>Answers stopped mid-thought, on a colon: <i>"Let me check the Cleetus V2 project for GP
  Productions or any studio/location related code:"</i> with fourteen tool calls of real work above it
  and no conclusion.</p>
  <p>The loop assigned <code>answer = res.text || answer</code> every pass. This model narrates before
  it acts, so a turn that calls tools usually carries a line of text with them &mdash; a preamble, not
  an answer &mdash; and each one overwrote the last. Run out of steps and the final preamble <i>is</i>
  the result. Only a turn that calls no tools is an answer now.</p>
  <p>The salvage pass meant to catch this could never fire: it was gated on the answer being empty, and
  it was never empty, it was half a sentence. And appending "now answer" to the transcript produced
  more narration, because after twenty tool calls the context <i>is</i> a tool loop. It builds a fresh
  two-message prompt from the findings instead, at lower temperature, and asks again if the reply still
  ends on a promise.</p>
  <p><code>looksFailed</code> returned false for all of these &mdash; <code>used.length &gt; 0</code>
  meant "it did some work" and exited early &mdash; so the one failure a user actually complains about
  was the only one the teacher never saw. Same question, same 20 tool calls: 378 characters ending on a
  colon, against 1,479 that lead with the conclusion and name the paths.</p>

  <h3>A specialist for the desk</h3>
  <p>New <b>studio</b> agent, alongside the builder. It owns the trackpad, the cameras, the light and
  the desk watcher, and its brief is mostly the habits above: measure before theorising, count distinct
  frames, ask the device what it supports, never trust a field that is only assigned once.</p>
</div></section>
'''

swap('<footer><div class="wrap">', S17.strip() + '\n\n' + S18.strip() + '\n\n' + S19.strip() + '\n\n' + S20.strip() + '\n\n' + S21.strip() + '\n\n' + S22.strip() + '\n\n' + S23.strip() + '\n\n' + S24.strip() + '\n\n' + S25.strip() + '\n\n<footer><div class="wrap">',
     "the new sections")
swap('  <li><a href="#s16"><span>16</span>The improve loop</a></li>\n</ol>',
     '  <li><a href="#s16"><span>16</span>The improve loop</a></li>\n'
     '  <li><a href="#s17"><span>17</span>Every tool proved</a></li>\n'
     '  <li><a href="#s18"><span>18</span>The brief cannot be repointed</a></li>\n'
     '  <li><a href="#s19"><span>19</span>The flight map was dark</a></li>\n'
     '  <li><a href="#s20"><span>20</span>Two Cleetuses</a></li>\n'
     '  <li><a href="#s21"><span>21</span>Integration sweep</a></li>\n'
     '  <li><a href="#s22"><span>22</span>When they do not know</a></li>\n'
     '  <li><a href="#s23"><span>23</span>Sending email</a></li>\n'
     '  <li><a href="#s24"><span>24</span>The camera that was working</a></li>\n'
     '  <li><a href="#s25"><span>25</span>Two pages, and half an answer</a></li>\n</ol>',
     "the table of contents")

s = s.replace('  <p><b>Tests.</b> 10 files, 31 tests:', '  <p><b>Tests.</b> 11 files, 34 tests:')
s = s.replace('<tr><td>The morning briefing</td><td><span class="tag bad">down</span></td>\n        <td>same cause. It has not run since 19 May 2026</td></tr>',
              '<tr><td>The morning brief you read</td><td><span class="tag ok">live</span></td>\n'
              '        <td>written today 00:21 ET, local model, stored in the DB</td></tr>\n'
              '    <tr><td>The Slack/markdown brief job</td><td><span class="tag bad">down</span></td>\n'
              '        <td>a different thing; not run since 19 May &mdash; section 18</td></tr>')

open(P, 'w').write(s)

ids = re.findall(r'<section id="([^"]+)"', s)
hrefs = re.findall(r'<li><a href="#([^"]+)"', s)
bad = [t for t in ('div', 'table', 'tr', 'td', 'li', 'p', 'pre')
       if len(re.findall(r'<%s[ >]' % t, s)) != s.count('</%s>' % t)]
print(f"applied. sections={len(ids)} toc_complete={not [i for i in ids if i not in hrefs]} unbalanced={bad or 'none'}")
