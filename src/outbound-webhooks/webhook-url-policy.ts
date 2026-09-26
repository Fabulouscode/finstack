import { Inject, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { outboundWebhooksConfig } from '../config/outbound-webhooks.config';
import type { OutboundWebhooksConfig } from '../config/outbound-webhooks.config';

/** Addresses customers must not make FinStack call (SSRF). */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // includes cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3], // multicast and reserved
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127], // unspecified and loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

function isPrivate(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return PRIVATE.check(mapped[1], 'ipv4');
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Decides whether FinStack may call a URL: https (plain http only where
 * private URLs are allowed, i.e. local development), no credentials in the
 * URL, and no private or internal addresses. Checked when an endpoint is
 * saved and again before each delivery, since DNS can change.
 */
@Injectable()
export class WebhookUrlPolicy {
  constructor(
    @Inject(outboundWebhooksConfig.KEY)
    private readonly config: OutboundWebhooksConfig,
  ) {}

  /** The reason the URL is refused, or null if it may be called. */
  async check(raw: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'Not a valid URL';
    }
    const httpAllowed = !this.config.requireHttps;
    if (
      url.protocol !== 'https:' &&
      !(httpAllowed && url.protocol === 'http:')
    ) {
      return 'The URL must use https';
    }
    if (url.username || url.password) {
      return 'The URL must not contain credentials';
    }
    if (this.config.allowPrivateUrls) {
      return null;
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isIP(host)
        ? [host]
        : (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      return `Cannot resolve ${host}`;
    }
    if (addresses.length === 0 || addresses.some(isPrivate)) {
      return 'The URL points to a private or internal address';
    }
    return null;
  }
}
