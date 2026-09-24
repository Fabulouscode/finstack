import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id (the library default) with m=19 MiB, t=2, p=1, matching the OWASP
 * Password Storage Cheat Sheet minimum recommendation.
 */
@Injectable()
export class PasswordHasher {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // Malformed or foreign hash format: treat as a failed match.
      return false;
    }
  }

  /**
   * Burns the same CPU time as a real verification. Call when the user does
   * not exist so response timing doesn't reveal which emails are registered.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('finstack-dummy-password-for-timing');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
