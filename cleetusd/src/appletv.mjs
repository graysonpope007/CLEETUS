// One persistent pyatv child, using the Mac's existing pairing. No credentials
// cross the API or go to the Pi. Explicit command allowlist; no shell strings.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PYTHON = process.env.APPLETV_PYTHON || join(homedir(), 'Library/Application Support/pipx/venvs/pyatv/bin/python');
const SCRIPT = fileURLToPath(new URL('../bin/appletv-panel.py', import.meta.url));
const SIMPLE = new Set('up down left right select menu home top_menu play pause play_pause stop next previous skip_forward skip_backward screensaver control_center guide channel_up channel_down wake sleep home_hold app_switcher volume_up volume_down text_clear touch_click'.split(' '));

export function validateTVCommand(input) {
  if (!input || typeof input.action !== 'string') throw new Error('Choose an Apple TV command');
  const { action, value } = input;
  if (SIMPLE.has(action)) return { action, payload: {} };
  if (action === 'set_volume' || action === 'seek') {
    const max = action === 'set_volume' ? 100 : 604800;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`Value must be between 0 and ${max}`);
    return { action, payload: { value } };
  }
  if (action === 'shuffle' || action === 'repeat') {
    const values = action === 'shuffle' ? ['Off', 'Albums', 'Songs'] : ['Off', 'Track', 'All'];
    if (!values.includes(value)) throw new Error('Invalid playback mode');
    return { action, payload: { value } };
  }
  if (['launch_app', 'switch_account', 'text_set', 'text_append', 'play_url', 'stream_audio'].includes(action)) {
    if (typeof value !== 'string' || value.length > (action.startsWith('text_') ? 2000 : 2048) || (!value && !action.startsWith('text_'))) throw new Error('A valid value is required');
    if (action === 'play_url' || action === 'stream_audio') {
      let u; try { u = new URL(value); } catch { throw new Error('Enter a media URL'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an http or https media URL without embedded credentials');
    }
    return { action, payload: { value } };
  }
  if (action === 'swipe') {
    if (!Array.isArray(input.points) || input.points.length !== 4 || input.points.some(n => !Number.isInteger(n) || n < 0 || n > 1000)) throw new Error('Invalid touch coordinates');
    if (!Number.isInteger(input.duration) || input.duration < 50 || input.duration > 2000) throw new Error('Invalid swipe duration');
    return { action, payload: { points: input.points, duration: input.duration } };
  }
  if (['add_output', 'remove_output', 'set_output'].includes(action)) {
    if (!Array.isArray(input.devices) || input.devices.length < 1 || input.devices.length > 8 || input.devices.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9:-]{6,128}$/.test(v))) throw new Error('Enter valid AirPlay output identifiers');
    return { action, payload: { devices: input.devices } };
  }
  throw new Error('Unknown Apple TV command');
}

let child, buffer = '', sequence = 0;
const pending = new Map();
function failPending(message) {
  for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ ok: false, connected: false, error: message }); }
  pending.clear();
}
function start() {
  if (child) return;
  const p = spawn(PYTHON, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  child = p; buffer = '';
  // pyatv stderr can contain protocol diagnostics. Do not expose or log it.
  p.stderr.resume();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', chunk => {
    if (child !== p) return;
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const { id, result } = JSON.parse(line); const req = pending.get(id); if (req) { clearTimeout(req.timer); pending.delete(id); req.resolve(result); } } catch { /* library chatter is not a response */ }
    }
  });
  p.on('error', () => { if (child === p) { child = null; failPending('Apple TV bridge could not start. Check the installed pyatv environment.'); } });
  p.on('exit', () => { if (child === p) { child = null; failPending('Apple TV connection closed. Try again.'); } });
  p.stdin.on('error', () => { if (child === p) failPending('Apple TV connection closed. Try again.'); });
}
function request(action, payload = {}) {
  if (pending.size >= 3) return Promise.resolve({ ok: false, error: 'Apple TV is busy. Wait for the current command.' });
  start();
  return new Promise(resolve => {
    const id = ++sequence;
    const timer = setTimeout(() => { const p = child; child = null; failPending('Apple TV timed out. Check its power and Wi-Fi.'); p?.kill(); }, 22000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ id, action, payload }) + '\n');
  });
}
let cached = null, at = 0, reading = null;
export async function appleTVStatus() {
  if (cached && Date.now() - at < 2500) return { ...cached, age_ms: Date.now() - at };
  if (!reading) reading = request('state').then(data => { cached = data; at = Date.now(); return data; }).finally(() => { reading = null; });
  return { ...await reading, age_ms: 0 };
}
export async function appleTVCatalog() { return request('catalog'); }
export async function appleTVCommand(input) {
  const { action, payload } = validateTVCommand(input);
  const result = await request(action, payload); at = 0; return result;
}
export function closeAppleTV() { child?.kill(); child = null; failPending('Apple TV connection closed.'); }
process.once('exit', closeAppleTV);
