import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { securityConfig } from '../../config/security.config';
import type { SecurityConfig } from '../../config/security.config';

const VERSION = 'v1';

/**
 * Encrypts secrets FinStack must read back later (e.g. webhook signing
 * secrets), with AES-256-GCM under DATA_ENCRYPTION_KEY. Stored as
 * `v1.<iv>.<ciphertext>.<tag>` (base64url); tampering fails decryption.
 * Secrets only ever compared (API keys, passwords) are hashed instead.
 */
@Injectable()
export class SecretBox {
  constructor(
    @Inject(securityConfig.KEY) private readonly config: SecurityConfig,
  ) {}

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.config.dataEncryptionKey,
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  open(sealed: string): string {
    const [version, iv, ciphertext, tag] = sealed.split('.');
    if (version !== VERSION || !iv || !ciphertext || !tag) {
      throw new Error('Unrecognised sealed secret');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.config.dataEncryptionKey,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
