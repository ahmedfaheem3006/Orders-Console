import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Stored format: "scrypt$<salt hex>$<hash hex>". A random salt per user means
// two users with the same password get different hashes.
// Uses Node's default scrypt cost (N=16384, r=8, p=1).
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  // A malformed hash decodes to fewer bytes; two empty buffers would compare equal.
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  // Constant-time comparison so response time does not leak how many bytes matched.
  return timingSafeEqual(actual, expected);
}
