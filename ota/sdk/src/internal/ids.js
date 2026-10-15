// UUID v4 for the `Idempotency-Key` of state-changing calls (ota/sdk/README.md §5.3, OADR-0016 point 6).
// `crypto.randomUUID` exists in Node 22, edge runtimes and secure browser contexts; a page served over plain HTTP
// (a non-secure context) has only `crypto.getRandomValues`, so the key is then formatted from 16 random bytes.

/**
 * A random UUID version 4 (RFC 9562), for example `0b6f0c51-1f3c-4f5e-9b1e-2d8a4c7e9f10`.
 * @returns {string}
 * @throws {TypeError} when the runtime has neither `crypto.randomUUID` nor `crypto.getRandomValues`
 */
export function uuidV4() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues !== "function") {
    throw new TypeError(
      "Velexis SDK: this runtime has no crypto.getRandomValues to generate idempotency keys",
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4 in the high nibble of byte 6, the RFC variant (binary 10) in the two high bits of byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
