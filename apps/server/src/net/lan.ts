// LAN address discovery (for TLS SANs and the "open this on the headset" URLs).
import os from 'node:os';

export interface LanAddress {
  address: string;
  /** OS interface name, e.g. "Wi-Fi", "Ethernet 4", "vEthernet (WSL)". */
  iface: string;
  /**
   * True for addresses the Quest can plausibly reach: private-range IPv4 on a
   * physical-looking interface. False for link-local (169.254/16) and virtual
   * adapters (WSL/Hyper-V, Docker, VirtualBox, VMware, VPN tunnels), whose
   * addresses come and go — they must not force a certificate regeneration
   * (which makes the user re-accept the cert on the headset).
   */
  primary: boolean;
}

const VIRTUAL_IFACE = /vethernet|wsl|hyper-?v|docker|vbox|virtualbox|vmware|vmnet|loopback|tailscale|zerotier|wireguard|\bwg\d|tun\d|tap\d|utun|npcap|bluetooth|^br-|^veth|^virbr/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function classify(address: string, iface: string): LanAddress {
  return { address, iface, primary: PRIVATE.test(address) && !VIRTUAL_IFACE.test(iface) };
}

/** Non-internal IPv4 addresses with their interface; primary ones first, link-local last. */
export function lanInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LanAddress[] {
  const out = new Map<string, LanAddress>();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      // Node reports family as 'IPv4' (or 4 on some versions).
      if ((a.family === 'IPv4' || (a.family as unknown) === 4) && !a.internal && !out.has(a.address)) out.set(a.address, classify(a.address, name));
    }
  }
  const rank = (x: LanAddress) => (x.primary ? 0 : x.address.startsWith('169.254.') ? 2 : 1);
  return [...out.values()].sort((a, b) => rank(a) - rank(b));
}

/** Non-internal IPv4 addresses, primary (reachable LAN) ones first. */
export function lanIPv4s(): string[] {
  return lanInterfaces().map((x) => x.address);
}
