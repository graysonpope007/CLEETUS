import re, sys
P='/Users/grayson/Desktop/Cleetus/CLEETUS-HANDOFF.html'
s=open(P).read()
if 'id="s44"' in s: sys.exit("already present")
before=len(re.findall(r'<section id="',s))

S44 = '''
<section id="s44"><div class="wrap">
  <h2><span class="n">44</span>How long, not just what</h2>

  <p class="lede">The health log from section 43 was being written and read by nothing. A record
  nobody consults is a slower version of no record.</p>

  <p><code>/doctor</code> now walks that log backwards for each failing check and reports when the
  current streak began. Backwards through the <i>streak</i>, not a grep for the first occurrence ever:
  a check that failed yesterday, recovered, and failed again an hour ago has been failing for an hour,
  and any other answer is a lie about the present.</p>
  <pre>every launch agent's program exists    since 2026-08-13T09:50:26Z
agent briefs match the deployed site   since 2026-08-13T09:50:26Z</pre>
  <p>The deck shows it as an age, because "32m" reads faster than a timestamp when scanning a panel,
  with the full ISO time in the tooltip alongside the fix.</p>

  <div class="card bad">
    <h4>It rendered correctly and was invisible</h4>
    <p>First attempt appended the duration to the end of each line. The panel rows are
    <code>white-space: nowrap</code> with <code>text-overflow: ellipsis</code>, so the end of the line
    is precisely what gets clipped:</p>
    <pre>× services: every launch agent's prog…</pre>
    <p style="margin-bottom:0">The value was in the DOM, correct, and cut off. Information placed
    where it gets truncated has not been delivered. Moving it in front of the check name puts it in
    the part that always survives:</p>
  </div>
  <pre>× 32m services: every launch agent's …
× 32m cleetusd: agent briefs match th…</pre>
  <p>Caught by screenshotting the panel rather than trusting that the API returned the field. The API
  had returned it correctly the whole time.</p>

  <p>Also visible on the deck now, from section 41: <b>MAIL, MESSAGES and SAFARI all reading DENIED</b>
  in the reach panel, where previously only Mail appeared. 60 tests, 35 checks.</p>
</div></section>
'''

s = s.replace('<footer><div class="wrap">', S44.strip() + '\n\n<footer><div class="wrap">')
s = s.replace('  <li><a href="#s43"><span>43</span>The doctor had no memory</a></li>',
              '  <li><a href="#s43"><span>43</span>The doctor had no memory</a></li>\n  <li><a href="#s44"><span>44</span>How long, not just what</a></li>')
open(P,'w').write(s)
ids=re.findall(r'<section id="([^"]+)"',s); hrefs=re.findall(r'<li><a href="#([^"]+)"',s)
bad=[t for t in ('div','table','tr','td','li','p','pre') if len(re.findall(r'<%s[ >]'%t,s))!=s.count('</%s>'%t)]
print(f"  sections {before} -> {len(ids)} | toc complete: {not [i for i in ids if i not in hrefs]} | unbalanced: {bad or 'none'}")
