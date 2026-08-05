import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for the handful of secrets the platform has to be
 * able to read back.
 *
 * Almost everything credential-shaped here is hashed instead (passwords with
 * scrypt, session and API tokens with sha256) because it only ever has to be
 * *compared*. A MangaDex personal client secret is different: it is replayed
 * verbatim to MangaDex's token endpoint on every login, so it has to survive
 * the round trip. Sealing it means a database dump — a backup, a read-only
 * replica, an `\copy` in a support session — is not a pile of usable MangaDex
 * client credentials.
 *
 * The key never lives in the database: it is derived from the same material as
 * the cookie signing key (SESSION_SECRET, else ADMIN_TOKEN) with a distinct
 * HKDF info string, so the two uses can never produce the same key. Rotating
 * that material makes existing sealed secrets unreadable, which surfaces as
 * "re-enter your client secret" at the next login rather than as silent
 * corruption — `openSecret` returns null instead of throwing.
 */

/** Prefix so a future algorithm change is distinguishable, not ambiguous. */
const VERSION = "v1";
const IV_BYTES = 12;

export function deriveSecretBoxKey(material: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", material, "publoader-secretbox-v1", "md-client-secret", 32));
}

export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** null for anything that does not decrypt *and* authenticate cleanly. */
export function openSecret(sealed: string, key: Buffer): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, truncated blob, tampered tag — all the same to the caller.
    return null;
  }
}
