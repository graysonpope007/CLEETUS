// src/ui.mjs — the Cleetus dashboard, served by cleetusd itself.
//
// WHY THIS IS SERVED FROM HERE AND NOT FROM THE DECK
// The deck lives on https://cleetusai.com. A page on https cannot fetch
// http://127.0.0.1:8767 without tripping mixed-content and private-network
// rules, and routing it the other way (cloud -> tunnel -> this Mac) needs a
// root-owned cloudflared edit. Serving the page from cleetusd sidesteps both:
// the page and the API are the same origin, both plain http on loopback, so
// there is nothing to block. The deck reaches it with an ordinary link, which
// is a top-level navigation and therefore allowed.
//
// The practical result is the thing Grayson actually asked for: a Cleetus that
// can read his files, reachable by clicking the chat box on the deck.
//
// Palette and type are lifted from cleetusv2/index.html on purpose — this is
// the same instrument, not a second product.

export const DASHBOARD = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cleetus &middot; Local</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --ground:#16111f; --panel:#1e1829; --screen:#0e0917; --screen2:#150f22;
  --amber:#f0b13f; --coral:#e8412a; --teal:#5f9e93;
  --mauve:#6b6572; --cream:#efe6d8; --dim:#9d94a6; --faint:#6a6376;
  --sans:'Chakra Petch',ui-sans-serif,system-ui,sans-serif;
  --mono:'DM Mono',ui-monospace,Menlo,monospace;
}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{background:var(--ground);color:var(--cream);font-family:var(--sans);
  height:100%;-webkit-font-smoothing:antialiased}
body{display:grid;grid-template-columns:210px 1fr 260px;gap:10px;padding:10px;overflow:hidden}
@media(max-width:900px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr auto;overflow:auto}
  .rail,.side{max-height:none}}

.rail,.main,.side{background:var(--panel);border-radius:6px;overflow:hidden;display:flex;flex-direction:column}
.lightrow{display:flex;flex-wrap:wrap;gap:4px;padding:4px 8px 8px}
.lbtn{font:inherit;font-size:.6rem;letter-spacing:.04em;text-transform:uppercase;color:var(--ink);
  background:var(--screen2);border:1px solid #2b2140;border-radius:3px;padding:3px 7px;cursor:pointer}
.lbtn:hover{background:#241a36;border-color:#3c2f58}
.lbtn:disabled{opacity:.45;cursor:default}
#light-state.on{color:#ffcf7a}
.hdr{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid #2a2337}
.hdr b{font-size:.68rem;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:var(--amber)}
.hdr .dot{width:7px;height:7px;border-radius:50%;background:var(--teal)}
.hdr .dot.bad{background:var(--coral)}

/* Agents */
.rail{overflow-y:auto}
.agent{display:block;width:100%;text-align:left;background:none;border:0;color:var(--cream);
  font-family:var(--sans);font-size:.72rem;padding:7px 11px;cursor:pointer;border-left:2px solid transparent}
.agent:hover{background:var(--screen2)}
.agent.on{background:var(--screen);border-left-color:var(--amber);color:var(--amber)}
.agent small{display:block;color:var(--faint);font-size:.58rem;line-height:1.3;margin-top:1px}
.group{padding:9px 11px 3px;font-size:.55rem;letter-spacing:.18em;text-transform:uppercase;color:var(--faint)}

/* Chat */
.main{position:relative}
.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:11px;
  font-size:.82rem;line-height:1.55}
.msg{max-width:78ch;white-space:pre-wrap;word-wrap:break-word}
.msg.me{color:var(--amber);font-family:var(--mono);font-size:.76rem}
.msg.err{color:var(--coral)}
.msg.sys{color:var(--faint);font-size:.68rem;font-family:var(--mono)}
.steps{border-left:2px solid var(--mauve);padding-left:9px;margin:2px 0;display:flex;flex-direction:column;gap:2px}
.step{font-family:var(--mono);font-size:.66rem;color:var(--dim)}
.step b{color:var(--teal);font-weight:500}
.step i{color:var(--faint);font-style:normal}
.ask{display:flex;gap:7px;padding:10px;border-top:1px solid #2a2337}
.ask input{flex:1;background:var(--screen);border:1px solid #2f2740;border-radius:4px;
  color:var(--cream);font-family:var(--sans);font-size:.82rem;padding:9px 11px}
.ask input:focus{outline:none;border-color:var(--amber)}
.ask button{background:var(--amber);color:#241a08;border:0;border-radius:4px;
  padding:0 15px;font-weight:700;cursor:pointer;font-family:var(--sans)}
.ask button:disabled{opacity:.4;cursor:default}

/* Side */
.side{overflow-y:auto}
.kv{display:flex;gap:7px;align-items:baseline;padding:4px 11px;font-size:.66rem}
.kv .k{color:var(--faint);font-size:.58rem;letter-spacing:.08em;text-transform:uppercase;min-width:74px}
.kv .v{color:var(--cream);font-family:var(--mono);font-size:.66rem}
.kv .v.ok{color:var(--teal)} .kv .v.bad{color:var(--coral)}
.side h3{padding:11px 11px 4px;font-size:.55rem;letter-spacing:.18em;text-transform:uppercase;color:var(--amber)}
.item{padding:4px 11px;font-size:.64rem;color:var(--dim);font-family:var(--mono);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>

<aside class="rail">
  <div class="hdr"><b>Agents</b></div>
  <div id="agents"></div>
</aside>

<main class="main">
  <div class="hdr">
    <span class="dot" id="dot"></span>
    <b id="title">Cleetus &middot; local</b>
    <span style="margin-left:auto;font-family:var(--mono);font-size:.6rem;color:var(--faint)" id="model">—</span>
  </div>
  <div class="log" id="log">
    <div class="msg sys">Running on your Mac. Real access to your files, your shell and your vault — ask him to read something.</div>
  </div>
  <form class="ask" id="form" autocomplete="off">
    <input id="in" placeholder="Ask Cleetus — he can open your files" autofocus>
    <button type="submit" id="send">Send</button>
  </form>
</main>

<aside class="side">
  <div class="hdr"><b>Reach</b></div>
  <div id="access"></div>
  <h3>Air trackpad</h3>
  <div id="pad">
    <div class="kv"><span class="k">state</span><span class="v" id="pad-state">checking…</span></div>
  </div>

  <h3>Desk light</h3>
  <div id="light">
    <div class="kv"><span class="k">state</span><span class="v" id="light-state">checking…</span></div>
    <div class="lightrow">
      <button class="lbtn" data-light="toggle">Toggle</button>
      <button class="lbtn" data-light="brightness" data-value="25">25%</button>
      <button class="lbtn" data-light="brightness" data-value="60">60%</button>
      <button class="lbtn" data-light="brightness" data-value="100">100%</button>
      <button class="lbtn" data-light="temp" data-value="2700">Warm</button>
      <button class="lbtn" data-light="temp" data-value="6500">Cool</button>
    </div>
  </div>

  <h3>Health</h3>
  <div id="doctor"><div class="item">checking…</div></div>

  <h3>Skills learned</h3>
  <div id="skills"></div>
  <h3>Recent work</h3>
  <div id="runs"></div>
</aside>

<script type="module">
const $ = id => document.getElementById(id);
let AGENT = null;

const say = (cls, text) => {
  const p = document.createElement('div');
  p.className = 'msg ' + cls;
  p.textContent = text;
  $('log').appendChild(p);
  $('log').scrollTop = $('log').scrollHeight;
  return p;
};

// ── boot ──
const health = await fetch('/health').then(r => r.json()).catch(() => null);
if (health) {
  $('model').textContent = health.model;
  $('dot').className = 'dot' + (health.ok ? '' : ' bad');
  $('title').innerHTML = 'Cleetus &middot; local';
}

const { agents } = await fetch('/agents').then(r => r.json());
const GROUPS = {
  Body: ['hair','skin','muscle','nutrition','fitness'],
  Presentation: ['fashion','redesign'],
  'Money and work': ['deals','finance','stocks','tax','books','booking','writing','image','music','brief','poker'],
  Itself: ['builder'],
};
const byId = Object.fromEntries(agents.map(a => [a.id, a]));
const rail = $('agents');

function addAgent(a, on) {
  const b = document.createElement('button');
  b.className = 'agent' + (on ? ' on' : '');
  b.innerHTML = '<span></span><small></small>';
  b.firstChild.textContent = a.label;
  b.lastChild.textContent = a.blurb;
  b.onclick = () => {
    AGENT = a.id === 'cleetus' ? null : a.id;
    [...rail.querySelectorAll('.agent')].forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('in').placeholder = a.id === 'cleetus'
      ? 'Ask Cleetus — he can open your files'
      : 'Ask the ' + a.label.toLowerCase() + ' agent';
    $('in').focus();
  };
  rail.appendChild(b);
}
if (byId.cleetus) addAgent(byId.cleetus, true);
for (const [name, ids] of Object.entries(GROUPS)) {
  const h = document.createElement('div');
  h.className = 'group'; h.textContent = name;
  rail.appendChild(h);
  for (const id of ids) if (byId[id]) addAgent(byId[id], false);
}

// ── what he can actually reach. A denial must never look like an empty folder.
fetch('/access').then(r => r.json()).then(a => {
  const box = $('access');
  for (const [name, t] of Object.entries(a.targets)) {
    const row = document.createElement('div');
    row.className = 'kv';
    const ok = t.state === 'ok';
    row.innerHTML = '<span class="k"></span><span class="v"></span>';
    row.firstChild.textContent = name;
    row.lastChild.textContent = ok ? t.items + ' items' : t.state.toUpperCase();
    row.lastChild.className = 'v ' + (ok ? 'ok' : 'bad');
    box.appendChild(row);
  }
}).catch(() => {});

/* The air trackpad runs as its own process on 8768 (its own camera, its own
   failure mode — if it wedges, the rest of Cleetus is unaffected).

   The video is rendered unconditionally rather than after a successful state
   fetch. The first version gated the whole panel on that fetch, so any hiccup
   left an empty box with no explanation — worse than useless, because a blank
   panel looks like a broken page rather than a specific thing being down. */
(function airpad() {
  const box = $('pad');
  if (!box) return;
  box.innerHTML =
    '<img id="pad-img" src="/airpad/stream.mjpg" ' +
    'style="width:100%;min-height:110px;background:var(--screen);' +
    'border-radius:4px;display:block;margin:2px 0 6px">' +
    '<div class="kv"><span class="k">mode</span><span class="v" id="pad-mode">…</span></div>' +
    '<div class="kv"><span class="k">fps</span><span class="v" id="pad-fps">…</span></div>' +
    '<div class="kv"><span class="k">display</span><span class="v" id="pad-disp">…</span></div>';

  // A stream that never loads is its own signal, and one the JSON poll cannot
  // give: the image is fetched by the browser, not by this script.
  const img = $('pad-img');
  img.onerror = () => {
    img.style.display = 'none';
    $('pad-mode').textContent = 'no video';
    $('pad-mode').className = 'v bad';
  };

  async function poll() {
    try {
      const t = await fetch('/airpad/state', { signal: AbortSignal.timeout(2500) }).then(r => r.json());
      $('pad-mode').textContent = t.mode === 'idle' ? 'no hand' : t.mode;
      $('pad-mode').className = 'v ' + (t.engaged ? 'ok' : '');
      $('pad-fps').textContent = t.fps;
      $('pad-disp').textContent = t.display;
    } catch {
      // Say which half is unreachable. The video and the state come from the
      // same process but over different mechanisms, and they fail separately.
      $('pad-mode').textContent = 'state unreachable';
      $('pad-mode').className = 'v bad';
    }
  }
  poll();
  setInterval(poll, 700);
})();

/* The desk light. Buttons, not a chat sentence, because "turn the light on" is
   a thing you want at the speed of a click.

   Every button reads the answer back from the device and shows THAT, rather
   than optimistically painting the state it asked for. The light is across the
   room and a stale label is worse than a slow one. */
(function desklight() {
  const box = $('light');
  if (!box) return;
  const label = $('light-state');
  const buttons = [...box.querySelectorAll('.lbtn')];

  function paint(d) {
    if (!d || d.ok === false) {
      label.textContent = d && d.error === 'no_device' ? 'not plugged in' : 'unreachable';
      label.className = 'v bad';
      buttons.forEach(b => b.disabled = true);
      return;
    }
    label.textContent = d.on === null ? 'unknown' : d.on ? 'on' : 'off';
    label.className = 'v' + (d.on ? ' on' : '');
    buttons.forEach(b => b.disabled = false);
  }

  async function call(params) {
    buttons.forEach(b => b.disabled = true);
    try {
      const q = new URLSearchParams(params).toString();
      paint(await fetch('/light?' + q, { signal: AbortSignal.timeout(9000) }).then(r => r.json()));
    } catch {
      paint({ ok: false });
    }
  }

  box.addEventListener('click', e => {
    const b = e.target.closest('.lbtn');
    if (!b) return;
    const p = { action: b.dataset.light };
    if (b.dataset.value) p.value = b.dataset.value;
    call(p);
  });

  call({ action: 'state' });
  // Slow poll: it catches the physical button on the light itself being
  // pressed, without hammering a USB device every second.
  setInterval(() => call({ action: 'state' }), 15000);
})();

/* Health. Twenty checks, each one a fault that has actually happened here and
   announced itself in no way at all.

   Only failures are listed. A wall of green trains you to stop reading it,
   which is how the report becomes as useless as having no report — so the
   healthy state is one quiet line and the broken state is loud. */
(function doctor() {
  const box = $('doctor');
  if (!box) return;

  async function poll() {
    let d;
    try {
      d = await fetch('/doctor', { signal: AbortSignal.timeout(45000) }).then(r => r.json());
    } catch {
      box.innerHTML = '<div class="item" style="color:var(--coral)">health check did not answer</div>';
      return;
    }
    box.textContent = '';

    if (d.failed.length) {
      for (const f of d.failed) {
        const el = document.createElement('div');
        el.className = 'item';
        el.style.color = 'var(--coral)';
        el.textContent = '× ' + f.area + ': ' + f.name;
        el.title = f.detail + (f.fix ? '\\n\\nfix: ' + f.fix : '');
        box.appendChild(el);
      }
    } else {
      const el = document.createElement('div');
      el.className = 'item';
      el.textContent = d.checks + ' checks, all clear';
      box.appendChild(el);
    }

    // How old the answer is. A doctor that has silently stopped running would
    // otherwise keep showing its last all-clear forever — the exact failure
    // mode this whole panel exists to catch.
    const age = document.createElement('div');
    age.className = 'item';
    age.style.color = 'var(--faint)';
    age.textContent = d.age_seconds === null ? 'never run'
      : d.age_seconds < 90 ? 'just now'
      : 'as of ' + Math.round(d.age_seconds / 60) + 'm ago';
    box.appendChild(age);
  }

  poll();
  setInterval(poll, 60000);
})();

fetch('/skills').then(r => r.json()).then(d => {
  const box = $('skills');
  if (!d.skills.length) { box.innerHTML = '<div class="item">none yet</div>'; return; }
  for (const s of d.skills) {
    const el = document.createElement('div');
    el.className = 'item'; el.textContent = s.title; el.title = s.when;
    box.appendChild(el);
  }
}).catch(() => {});

fetch('/runs').then(r => r.json()).then(d => {
  const box = $('runs');
  if (!d.runs.length) { box.innerHTML = '<div class="item">nothing yet</div>'; return; }
  for (const r of d.runs) {
    const el = document.createElement('div');
    el.className = 'item';
    el.textContent = (r.status === 'failed' ? '× ' : '· ') + r.title;
    if (r.status === 'failed') el.style.color = 'var(--coral)';
    box.appendChild(el);
  }
}).catch(() => {});

// ── chat, streamed so tool calls appear as they happen ──
const HISTORY = [];

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('in').value.trim();
  if (!q) return;
  $('in').value = '';
  $('send').disabled = true;
  say('me', '> ' + q);
  HISTORY.push({ role: 'user', content: q });

  const steps = document.createElement('div');
  steps.className = 'steps';
  $('log').appendChild(steps);
  const thinking = say('sys', 'thinking…');

  try {
    const res = await fetch('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: HISTORY.slice(-12), agent: AGENT }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'agent') {
          thinking.textContent = 'working as the ' + ev.agent + ' agent…';
        } else if (ev.type === 'step') {
          const s = document.createElement('div');
          s.className = 'step';
          s.innerHTML = '<b></b> <i></i>';
          s.firstChild.textContent = ev.tool;
          s.lastChild.textContent = ev.detail || '';
          steps.appendChild(s);
          $('log').scrollTop = $('log').scrollHeight;
        } else if (ev.type === 'done') {
          thinking.remove();
          say('', ev.answer || '(no answer)');
          HISTORY.push({ role: 'assistant', content: ev.answer || '' });
        } else if (ev.type === 'error') {
          thinking.remove();
          say('err', ev.error);
        }
      }
    }
  } catch (err) {
    thinking.remove();
    say('err', 'lost the connection to cleetusd: ' + err.message);
  } finally {
    $('send').disabled = false;
    $('in').focus();
  }
});
</script>
</body>
</html>`;
