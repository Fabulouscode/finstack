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

export type DnsResolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

/** Where a delivery may go: the URL, and the one address it must connect to. */
export type UrlResolution =
  | { ok: true; url: URL; address: string; family: 4 | 6 }
  | { ok: false; reason: string };

/**
 * Decides whether FinStack may call a URL: https (plain http only where
 * private URLs are allowed, i.e. local development), no credentials in the
 * URL, and no private or internal addresses.
 *
 * The hostname is resolved once, every address is checked, and the caller
 * connects to the checked address (DNS pinning). Resolving again at connect
 * time would let a DNS server answer "public" to the check and "internal"
 * to the connection (DNS rebinding).
 */
@Injectable()
export class WebhookUrlPolicy {
  /** Replaceable in tests. */
  resolver: DnsResolver = (host) => lookup(host, { all: true });

  constructor(
    @Inject(outboundWebhooksConfig.KEY)
    private readonly config: OutboundWebhooksConfig,
  ) {}

  /** The reason the URL is refused, or null if it may be called. */
  async check(raw: string): Promise<string | null> {
    const resolution = await this.resolve(raw);
    return resolution.ok ? null : resolution.reason;
  }

  async resolve(raw: string): Promise<UrlResolution> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'Not a valid URL' };
    }
    const httpAllowed = !this.config.requireHttps;
    if (
      url.protocol !== 'https:' &&
      !(httpAllowed && url.protocol === 'http:')
    ) {
      return { ok: false, reason: 'The URL must use https' };
    }
    if (url.username || url.password) {
      return { ok: false, reason: 'The URL must not contain credentials' };
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: { address: string; family: number }[];
    try {
      addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await this.resolver(host);
    } catch {
      return { ok: false, reason: `Cannot resolve ${host}` };
    }
    const [first] = addresses;
    if (!first) {
      return { ok: false, reason: `Cannot resolve ${host}` };
    }
    if (
      !this.config.allowPrivateUrls &&
      addresses.some(({ address }) => isPrivate(address))
    ) {
      return {
        ok: false,
        reason: 'The URL points to a private or internal address',
      };
    }
    return {
      ok: true,
      url,
      address: first.address,
      family: first.family === 6 ? 6 : 4,
    };
  }
}
