import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

const ipv4Number = ip => ip.split('.').reduce((value, octet) => (value << 8) | Number(octet), 0);

export function lanBinding(address, interfaces = networkInterfaces()) {
  const entry = Object.values(interfaces).flat().find(item =>
    item?.family === 'IPv4' && !item.internal && item.address === address);
  const privateAddress = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
  const prefix = Number(entry?.cidr?.split('/')[1]);
  if (!entry || !privateAddress || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) {
    throw new Error('The saved LAN address is unavailable. Use --lan-address with the PC’s current private IPv4 address.');
  }
  const mask = -1 << (32 - prefix);
  const network = ipv4Number(address) & mask;
  return {
    address,
    includes(remote) { return isIPv4(remote) && (ipv4Number(remote) & mask) === network; },
  };
}

