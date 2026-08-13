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

    grep -c 'id="s19"' ~/Desktop/Cleetus/CLEETUS-HANDOFF.html   # 0 = not applied
"""

import re
import sys

P = '/Users/grayson/.claude/jobs/8403b0d8/tmp/patchtest.html'

try:
    s = open(P).read()
except PermissionError:
    sys.exit("Still cannot read the handoff — grant this terminal Desktop access and retry.")

if 'id="s19"' in s:
    sys.exit("Already applied (section 19 is present). Nothing to do.")


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

swap('<footer><div class="wrap">', S17.strip() + '\n\n' + S18.strip() + '\n\n' + S19.strip() + '\n\n<footer><div class="wrap">',
     "the new sections")
swap('  <li><a href="#s16"><span>16</span>The improve loop</a></li>\n</ol>',
     '  <li><a href="#s16"><span>16</span>The improve loop</a></li>\n'
     '  <li><a href="#s17"><span>17</span>Every tool proved</a></li>\n'
     '  <li><a href="#s18"><span>18</span>The brief cannot be repointed</a></li>\n'
     '  <li><a href="#s19"><span>19</span>The flight map was dark</a></li>\n</ol>',
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
