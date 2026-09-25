import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_LAYOUT, DEV, HUE, PROTECTED_CONTROLS } from '../src/control-layout.mjs';
import { validateTVCommand } from '../src/appletv.mjs';

test('the first group contains exactly the four requested bulbs in order', () => {
  const group = CONTROL_LAYOUT[0];
  assert.equal(group.number, 1);
  assert.deepEqual(group.items.map(i => i.lightId), [HUE.KEYS_LIGHT, HUE.TURTLE_BULB, HUE.LAMP1, HUE.LAMP4]);
  assert.ok(group.items.every(i => i.kind === 'hue'));
});
test('the second group contains only the two screens and diffuser', () => {
  assert.equal(CONTROL_LAYOUT[1].number, 2);
  assert.deepEqual(CONTROL_LAYOUT[1].items.map(i => i.label), ['Keys screen', 'Desk screen', 'Diffuser']);
});
test('Apple TV and its verified Home mains outlet are separate, guarded controls', () => {
  const media = CONTROL_LAYOUT[2].items;
  assert.ok(media.some(i => i.kind === 'appletv' && /GP TV/.test(i.label)));
  const power = media.find(i => i.label === 'Apple TV power');
  assert.equal(power.uuid, DEV.NIGHT); assert.equal(power.channel, 4); assert.match(power.confirm, /cuts power/);
  assert.ok(PROTECTED_CONTROLS.has(`meross:${DEV.NIGHT}:5`), 'protection must survive unavailable Home names');
});
test('remote request validation rejects unknown commands and invalid numeric payloads', () => {
  for (const input of [{action:'exec',value:'ls'}, {action:'set_volume',value:101}, {action:'seek',value:-1}, {action:'seek',value:NaN}, {action:'seek',value:'20'}]) {
    assert.throws(() => validateTVCommand(input));
  }
  assert.deepEqual(validateTVCommand({action:'set_volume',value:0}), {action:'set_volume',payload:{value:0}});
});
test('media URLs cannot address files or carry embedded credentials', () => {
  for (const value of ['file:///Users/grayson/.pyatv.conf','javascript:alert(1)','https://user:pass@example.com/movie.mp4']) {
    assert.throws(() => validateTVCommand({action:'play_url',value}));
  }
  assert.equal(validateTVCommand({action:'stream_audio',value:'https://example.com/music.mp3'}).payload.value,'https://example.com/music.mp3');
});
test('touch and output payloads stay bounded', () => {
  assert.throws(() => validateTVCommand({action:'swipe',points:[0,0,1001,500],duration:100}));
  assert.throws(() => validateTVCommand({action:'swipe',points:[0,0,100,500],duration:0}));
  assert.throws(() => validateTVCommand({action:'add_output',devices:['arbitrary shell ; text']}));
  assert.equal(validateTVCommand({action:'swipe',points:[100,500,900,500],duration:250}).payload.duration,250);
});
