// Stable device identities; Apple Home still supplies live labels and states.
export const DEV = {
  DESK: '26020384186219540601c4e7ae271d8e',
  NIGHT: '26020301084529540601c4e7ae271e4a',
  DIFFUSER: '25110588025417641101c4e7ae23b4de',
};
export const HUE = {
  KEYS_LIGHT: '0cc68bee-3f8b-4e1c-88ad-c10ae7eddfd1',
  TURTLE_BULB: '17cb8aa6-4ad2-416e-a621-ea02c21093d1',
  LAMP1: 'a8e801f1-70ec-4a7e-a418-219c8b1dc7f2',
  LAMP4: '8f2d924a-da4d-45cd-8e61-482a3bbc1576',
};
export const PROTECTED_CONTROLS = new Map([
  [`meross:${DEV.NIGHT}:5`, 'Phone And Pi is locked on this panel'],
]);
export const CONTROL_LAYOUT = [
  { name: 'Lights', number: 1, kind: 'hue', items: [
    { kind: 'hue', lightId: HUE.KEYS_LIGHT, label: 'Keys light' },
    { kind: 'hue', lightId: HUE.TURTLE_BULB, label: 'Turtle light' },
    { kind: 'hue', lightId: HUE.LAMP1, label: 'Bulb 1' },
    { kind: 'hue', lightId: HUE.LAMP4, label: 'Bulb 4' },
  ] },
  { name: 'Daily', number: 2, kind: 'mixed', items: [
    { kind: 'wemo', host: '192.168.1.156', label: 'Keys screen' },
    { kind: 'meross', uuid: DEV.DESK, channel: 4, label: 'Desk screen' },
    { kind: 'diffuser', uuid: DEV.DIFFUSER, label: 'Diffuser' },
  ] },
  { name: 'Media', number: 3, kind: 'mixed', items: [
    { kind: 'appletv', label: 'Apple TV · GP TV' },
    // Apple Home ZMKFSERVICE instance 21 -> Meross channel 4, verified 24 Sep.
    { kind: 'meross', uuid: DEV.NIGHT, channel: 4, label: 'Apple TV power',
      confirm: 'This cuts power to Apple TV and ends playback or AirPlay. Tap again to confirm. Use Sleep in the remote for everyday use.' },
    { kind: 'govee', device: 'Keys monitors', label: 'Keys speakers',
      confirm: 'Keys speakers are powered monitors. Cutting power can pop the drivers. Tap again to confirm.' },
    { kind: 'merossMerge', uuid: DEV.DESK, channels: [1, 2], label: 'Main Monitors' },
  ] },
  { name: 'Power', number: 4, kind: 'mixed', items: [
    { kind: 'meross', uuid: DEV.DESK, channel: 3, label: 'Helix' },
    { kind: 'meross', uuid: DEV.DESK, channel: 5, label: 'Desk USB' },
    { kind: 'meross', uuid: DEV.NIGHT, channel: 3, label: 'Turtle lamp outlet' },
    { kind: 'meross', uuid: DEV.NIGHT, channel: 5, label: 'Phone And Pi' },
  ] },
];
