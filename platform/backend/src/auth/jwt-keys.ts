// The keys of a JWT signing key rotation (FIX-W48-PLATFORM, lead decision (15f) of 2026-11-11; ADR-0010 "Rotation":
// JWT keys rotate by `kid`, and the old public key stays valid for one token lifetime). JWT_PREVIOUS_PUBLIC_KEY_FILE
// names the public half of the key JWT_PRIVATE_KEY_FILE held before a rotation, so the API still accepts the access
// tokens it signed with that key for their last 15 minutes while it signs with the new key only
// (platform/docs/runbooks/platform-operations.md §7). config.ts checks the file with these functions when the
// configuration is loaded (so the API, the worker and the CLI refuse a wrong one alike), and TokenService reads the key
// with them at start-up. This file imports nothing of the app (config.ts imports it).
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

/**
 * The DER length of an Ed25519 public key in SPKI (`openssl pkey -pubout`): the least JWT_PREVIOUS_PUBLIC_KEY_FILE may
 * hold.
 */
export const JWT_PUBLIC_KEY_MIN_BYTES = 44;

/** The label of the first PEM block of a file. */
const FIRST_PEM_LABEL = /-----BEGIN ([A-Z0-9 ]+)-----/;

/**
 * The Ed25519 public key of the PEM text of JWT_PREVIOUS_PUBLIC_KEY_FILE. Throws an `Error` whose message is the reason
 * (never a byte of the file, never its path): the file must hold the public key alone, as one SPKI block
 * (`-----BEGIN PUBLIC KEY-----`), never a private key (the old private key is destroyed during the rotation: only its
 * public half verifies), and of type Ed25519.
 */
export function previousPublicKeyOf(pem: string): KeyObject {
  if (FIRST_PEM_LABEL.exec(pem)?.[1] !== "PUBLIC KEY" || pem.includes("PRIVATE KEY-----")) {
    throw new Error("must hold only a public key (PEM, `-----BEGIN PUBLIC KEY-----`), never a private key");
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: pem, format: "pem" });
  } catch {
    throw new Error("does not hold a readable PEM public key");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `holds a key of type ${publicKey.asymmetricKeyType ?? "unknown"}; platform tokens are signed with Ed25519`,
    );
  }
  return publicKey;
}

/** The public half of the Ed25519 private key in `pem` (JWT_PRIVATE_KEY_FILE); `undefined` when it is none. */
export function signingPublicKeyOf(pem: string): KeyObject | undefined {
  try {
    const privateKey = createPrivateKey({ key: pem, format: "pem" });
    return privateKey.asymmetricKeyType === "ed25519" ? createPublicKey(privateKey) : undefined;
  } catch {
    return undefined;
  }
}

/** True when `a` and `b` are the same public key (their SPKI bytes), so they have the same JWK thumbprint (`kid`). */
export function isSamePublicKey(a: KeyObject, b: KeyObject): boolean {
  return a.export({ format: "der", type: "spki" }).equals(b.export({ format: "der", type: "spki" }));
}
