p = '/Users/grayson/Desktop/Cleetus/CLEETUS-HANDOFF.html'
s = open(p).read()

S15 = '''
<section id="s15"><div class="wrap">
  <h2><span class="n">15</span>The browser, working for the first time</h2>

  <p class="lede">The <code>browse</code> tool was advertised to the model on every message and had
  <b>never</b> worked. Three independent faults were stacked, and each one hid the next.</p>

  <h3>Fault one: nothing ran the harness</h3>
  <p><code>~/cleetus-web</code> exists, its 36 policy tests pass, and it starts cleanly. There was simply
  no launch agent for it, so it only existed when someone started it by hand &mdash; and a process
  started that way does not survive the session that spawned it. It now has
  <code>com.cleetus.web</code>, matching the airpad pattern.</p>

  <h3>Fault two: the endpoint did not exist</h3>
  <p>The tool posted a plain-English instruction to <code>/api/run</code>. The harness speaks
  <code>/api/open</code>, <code>/api/page</code>, <code>/api/act</code>, <code>/api/pending</code>,
  <code>/api/approve</code> &mdash; primitives meant to be driven by an agent. There is no
  <code>/api/run</code> and never has been. So even a running harness would have 404'd, while the tool
  reported "the harness is not answering &mdash; start it with <code>npm start</code>". Starting it
  would not have helped.</p>

  <h3>Fault three: it was calling the internet to reach itself</h3>
  <p><code>CONFIG.webHarness</code> read <code>CLEETUS_WEB_URL</code> from the shared env file, where it
  is set to <code>https://web.cleetusai.com</code> for the deployed app's benefit. That hostname is
  <b>NXDOMAIN</b> &mdash; it was never added to the tunnel ingress, which carries only
  <code>llm.</code> and <code>me.</code>. cleetusd was resolving a nonexistent public hostname to reach a
  service listening on its own machine. It now reads <code>CLEETUSD_WEB_URL</code> and defaults to
  loopback, so the cloud app's setting can never drag it off-box again. The doctor asserts it.</p>

  <h3>The fix, and why it is not another loop</h3>
  <p><code>browse</code> is gone. In its place are four primitives &mdash; <code>web_open</code>,
  <code>web_read</code>, <code>web_act</code>, <code>web_pending</code> &mdash; driven by the tool loop
  cleetusd already has. Building a second LLM loop inside a tool would have meant two loops to debug and
  two places for this exact class of bug to hide.</p>

  <p><b>The safety contract is preserved and is the point.</b> Reads execute; commits queue. Anything the
  other side of the screen cannot take back comes back as a <code>pending_id</code> instead of happening.
  Credential fields are refused outright. <b>No <code>approve</code> tool is exposed</b> &mdash; cleetusd
  holds the disk and the shell, and letting it release its own held actions would empty the only gate
  the harness exists to provide. There is a test asserting no such tool exists and that
  <code>/api/approve</code> appears nowhere in the schemas handed to the model.</p>

  <h3>Proof</h3>
  <pre>Q: open amazon.com and tell me what you actually see on the page
   tools: ["web_open"]          ← one call
   "I'm signed into your Amazon account. Delivery location is set to North Augusta,
    SC 29841. Prime membership is active. There's 1 item currently in your cart..."</pre>
  <p>Real page, real session, one tool call. Also fixed on the way: Playwright had been upgraded without
  its browser being re-downloaded, so it looked for <code>chromium-1234</code> against a cache holding
  <code>1208</code> and refused to launch.</p>

  <div class="card">
    <h4>An orphan, again</h4>
    <p style="margin-bottom:0">The launch agent kept dying with <code>EADDRINUSE</code>. A copy of the
    harness I had started by hand was still holding :8766, reparented to PID&nbsp;1 &mdash; and
    <code>pkill -f 'cleetus-web/src/server.mjs'</code> did not match it, because it had been started as
    <code>cd ~/cleetus-web && node src/server.mjs</code> and its command line carried the <i>relative</i>
    path. Exactly the shape of the orphaned ffmpeg that halved the camera frame rate. When a port is held
    by something that should not be there, resolve the PID from the port
    (<code>lsof -nP -iTCP:8766 -sTCP:LISTEN -t</code>) rather than pattern-matching a command line you
    assume you know.</p>
  </div>

  <h3>Doctor: now 24 checks</h3>
  <p>Added: <code>com.cleetus.web</code> is running · the harness answers on 8766 · and the browser
  harness is addressed on loopback, which is the check that catches fault three coming back.
  Test suite is 9 files, 24 tests, all passing.</p>
</div></section>
'''

s = s.replace('<footer><div class="wrap">', S15.strip() + '\n\n<footer><div class="wrap">')
s = s.replace('  <li><a href="#s14"><span>14</span>Ten dead services</a></li>\n</ol>',
              '  <li><a href="#s14"><span>14</span>Ten dead services</a></li>\n'
              '  <li><a href="#s15"><span>15</span>The browser working</a></li>\n</ol>')

# Keep the reference sections honest.
s = s.replace(
  '<tr><td>Browser harness (<code>browse</code> tool)</td><td><span class="tag warn">not running</span></td>\n        <td><code>~/cleetus-web</code> exists, :8766 is dead, no launch agent</td></tr>',
  '<tr><td>Browser, signed into his accounts</td><td><span class="tag ok">live</span></td>\n'
  '        <td>real Amazon page in one <code>web_open</code>; commits still queue for a human</td></tr>')
s = s.replace('<tr><td>8766</td><td>cleetus-web browser harness</td><td>none locally</td><td>no &mdash; <b>currently down</b></td></tr>',
              '<tr><td>8766</td><td>cleetus-web browser harness</td><td>none locally</td><td>no &mdash; deliberately not in the ingress</td></tr>')
s = s.replace('''      <li><b>The browser harness is not running.</b> <code>~/cleetus-web</code> exists, :8766 is dead,
        and there is no launch agent for it &mdash; so the <code>browse</code> tool fails every time it
        is called. Either give it an agent or stop advertising the tool to the model.</li>
''', '')
s = s.replace('<div><b>Doctor</b>20 checks · 1 red</div>', '<div><b>Doctor</b>24 checks · 1 red</div>')
s = s.replace('<div><b>Agents · tools</b>20 · 15</div>', '<div><b>Agents · tools</b>20 · 18</div>')
s = s.replace('<tr><td>The doctor &mdash; 20 checks</td>', '<tr><td>The doctor &mdash; 24 checks</td>')

open(p, 'w').write(s)
print("added section 15 and refreshed the affected rows")
print("balanced:", s.count('<section') == s.count('</section>'))
