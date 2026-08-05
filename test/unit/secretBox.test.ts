import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveSecretBoxKey, openSecret, sealSecret } from "../../src/core/api/secretBox.js";

const key = deriveSecretBoxKey(randomBytes(32));

describe("secretBox", () => {
  it("round-trips a secret", () => {
    expect(openSecret(sealSecret("client-secret", key), key)).toBe("client-secret");
  });

  it("produces a different blob every time, so equal secrets are not equal at rest", () => {
    expect(sealSecret("same", key)).not.toBe(sealSecret("same", key));
  });

  it("returns null rather than throwing when the key rotated", () => {
    const sealed = sealSecret("client-secret", key);
    expect(openSecret(sealed, deriveSecretBoxKey(randomBytes(32)))).toBeNull();
  });

  it("rejects a tampered ciphertext", () => {
    const parts = sealSecret("client-secret", key).split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0xff, 0);
    parts[3] = flipped.toString("base64url");
    expect(openSecret(parts.join("."), key)).toBeNull();
  });

  it("rejects junk and unknown versions instead of throwing", () => {
    expect(openSecret("", key)).toBeNull();
    expect(openSecret("v2.a.b.c", key)).toBeNull();
    expect(openSecret("not-sealed-at-all", key)).toBeNull();
  });

  it("derives a distinct key from the same material as the signing key", () => {
    const material = randomBytes(32);
    expect(deriveSecretBoxKey(material).equals(material)).toBe(false);
    expect(deriveSecretBoxKey(material).equals(deriveSecretBoxKey(material))).toBe(true);
  });
});
