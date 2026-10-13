import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/** How a key file stores its bytes: one base64 value (`openssl rand -base64 32`) or a PEM document. */
export type KeyFileEncoding = "base64" | "pem";

export interface ReadKeyFileOptions {
  /** Minimum length of the key material in bytes, after decoding the base64 value or the PEM body. */
  readonly minBytes: number;
  /** Default `"base64"`. */
  readonly encoding?: KeyFileEncoding;
}

/** Why a key file was refused. */
export type KeyFileProblem =
  "missing" | "not-a-file" | "unreadable" | "permissions" | "empty" | "invalid-encoding" | "too-short";

/**
 * A key file failed the checks of `readKeyFile`. The message names the path and the reason; it never
 * contains any byte of the file. `detail` is the reason without the path, for messages that must not
 * repeat a configuration value (`ConfigError`).
 */
export class KeyFileError extends Error {
  override readonly name = "KeyFileError";
  readonly problem: KeyFileProblem;
  readonly path: string;
  readonly detail: string;

  constructor(path: string, problem: KeyFileProblem, detail: string) {
    super(`Key file ${path} ${detail}`);
    this.path = path;
    this.problem = problem;
    this.detail = detail;
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;
// O_NONBLOCK keeps a FIFO or device named by mistake from blocking start-up; it changes nothing for regular files.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Decodes strict base64 (line breaks allowed); `undefined` when the text is not base64. */
function decodeBase64(text: string): Buffer | undefined {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64.test(compact)) {
    return undefined;
  }
  return Buffer.from(compact, "base64");
}

function assertMinBytes(minBytes: number): void {
  if (!Number.isSafeInteger(minBytes) || minBytes < 1) {
    throw new TypeError("readKeyFile(): minBytes must be a positive integer");
  }
}

function openKeyFile(path: string): number {
  try {
    return openSync(path, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new KeyFileError(path, "missing", "does not exist");
    }
    throw new KeyFileError(path, "unreadable", `cannot be opened by this process (${code})`);
  }
}

/**
 * Reads a key file and checks it before returning its key material (ADR-0010, Key material on the VM).
 *
 * It throws a `KeyFileError` when the file is missing or not a regular file, when its mode grants any
 * access to group or others (`mode & 0o077`; use 0400 or 0600), when it is not valid base64 or holds no
 * PEM block, or when the decoded key is shorter than `minBytes`.
 *
 * - `encoding: "base64"` (default) returns the decoded key bytes. Callers may `fill(0)` the buffer after use.
 * - `encoding: "pem"` returns the PEM text as stored (for `crypto.createPrivateKey` or `jose`), after
 *   checking that the body of its first PEM block decodes to at least `minBytes` bytes.
 *
 * The content is never part of an error message.
 */
export function readKeyFile(
  path: string,
  options: ReadKeyFileOptions & { readonly encoding?: "base64" },
): Buffer;
export function readKeyFile(path: string, options: ReadKeyFileOptions & { readonly encoding: "pem" }): string;
export function readKeyFile(path: string, options: ReadKeyFileOptions): Buffer | string;
export function readKeyFile(path: string, options: ReadKeyFileOptions): Buffer | string {
  const { minBytes, encoding = "base64" } = options;
  assertMinBytes(minBytes);

  // One descriptor for the checks and the read, so the file cannot be swapped in between.
  const fd = openKeyFile(path);
  let content: Buffer;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new KeyFileError(path, "not-a-file", "is not a regular file");
    }
    if ((stats.mode & 0o077) !== 0) {
      const mode = (stats.mode & 0o777).toString(8).padStart(4, "0");
      throw new KeyFileError(
        path,
        "permissions",
        `is accessible by group or others (mode ${mode}); restrict it to mode 0400 or 0600`,
      );
    }
    content = readFileSync(fd);
  } finally {
    closeSync(fd);
  }

  const text = content.toString("utf8");
  if (text.trim().length === 0) {
    throw new KeyFileError(path, "empty", "is empty");
  }

  if (encoding === "pem") {
    const block = PEM_BLOCK.exec(text);
    const der = block?.[2] === undefined ? undefined : decodeBase64(block[2]);
    if (der === undefined) {
      throw new KeyFileError(path, "invalid-encoding", "does not contain a valid PEM block");
    }
    const length = der.length;
    der.fill(0);
    content.fill(0);
    if (length < minBytes) {
      throw new KeyFileError(path, "too-short", `holds a PEM key shorter than ${minBytes} bytes`);
    }
    return text;
  }

  const key = decodeBase64(text);
  content.fill(0);
  if (key === undefined) {
    throw new KeyFileError(path, "invalid-encoding", "is not valid base64");
  }
  if (key.length < minBytes) {
    key.fill(0);
    throw new KeyFileError(path, "too-short", `decodes to fewer than ${minBytes} bytes`);
  }
  return key;
}
