// Id generation that works in insecure contexts (crypto.randomUUID is only
// available on https / localhost; the headset may load over plain http on LAN).

let counter = 0;

export function randomId(prefix = ''): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  let core: string;
  if (c && typeof c.randomUUID === 'function') {
    core = c.randomUUID().replace(/-/g, '').slice(0, 16);
  } else {
    core = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(-16);
  }
  counter = (counter + 1) % 0xffff;
  return prefix + core + counter.toString(36);
}
