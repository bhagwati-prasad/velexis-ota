// The multipart upload `console.settings.assets.upload` (task SDK-012 step 2, ota/sdk/docs/extensions.md §2 and §3.2,
// ota/sdk/README.md §5.3 Bodies, OADR-0012 point 2): the SDK builds `multipart/form-data` from a `Blob` or `File` and
// `kind` (and `fileName` when given), with the text parts first; the request carries the file and kind parts and an
// `Idempotency-Key` (AC1), reused when the upload is sent again after 503; the `Content-Type` and its boundary are
// left to `fetch` (internal/http.js sets none, and a caller's `Content-Type` is dropped), so a real `Request` encodes
// a body the server can parse; a call without params, a `file` that is not a `Blob`, a missing `kind` or a blank
// `fileName` is a `TypeError` before any request. Requests go to the fake fetch only; waits run on fake timers.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVelexisClient } from "../../src/index.js";
import { op } from "../../src/internal/operations.js";
import { createFakeFetch, errorResponse } from "../helpers/fake-fetch.js";

/** Fake keys and tokens with the right shapes; none of them works anywhere. */
const SK = "sk_test_sdk012_fake_multipart";
const STAFF_AT = "at_sdk012_fake_multipart";

const BASE_URL = "https://api.ota.example.com";
const PATH = "/v1/console/settings/assets";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The first bytes of a PNG file (its signature and the start of the IHDR chunk); the server sniffs the type. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** A `StorefrontAsset` as the API answers an upload (the shape of the document's example). */
const ASSET = {
  id: "ast_01JA6B2C3D4E5F6G7H8J9K0M1N",
  kind: "logo",
  contentType: "image/png",
  sizeBytes: 16,
  width: 640,
  height: 160,
  fileName: "acme-logo.png",
  url: "https://api.ota.example.com/v1/assets/acme/ast_01JA6B2C3D4E5F6G7H8J9K0M1N.png",
  createdAt: "2026-10-12T09:30:00Z",
};

/** @typedef {import("../helpers/fake-fetch.js").RecordedRequest} RecordedRequest */

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A server-mode client as the OTA admin builds it (OADR-0018 point 1).
 * @param {typeof globalThis.fetch} fetch
 * @param {Partial<import("../../src/index.js").VelexisClientOptions>} [extra]
 */
const staffClient = (fetch, extra = {}) =>
  createVelexisClient({
    secretKey: SK,
    accessToken: STAFF_AT,
    sessionKind: "staff",
    environment: "test",
    fetch,
    ...extra,
  });

/** A logo as a `File`, the way a browser form or `fs.openAsBlob` gives it. */
const logoFile = () => new File([PNG_BYTES], "acme-logo.png", { type: "image/png" });

/**
 * The parts of a recorded multipart request: name, text value or file (its name, type and bytes), in order.
 * @param {RecordedRequest | undefined} request
 */
async function partsOf(request) {
  expect(request?.body).toBeInstanceOf(FormData);
  const form = /** @type {FormData} */ (request?.body);
  return Promise.all(
    [...form.entries()].map(async ([name, value]) =>
      typeof value === "string"
        ? [name, value]
        : [
            name,
            { name: value.name, type: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] },
          ],
    ),
  );
}

describe("console.settings.assets.upload", () => {
  it("is the route table's only multipart operation, with a required Idempotency-Key [SDK-012 AC1]", () => {
    const multipart = Object.entries(op).filter(([, entry]) => entry.body === "multipart");
    expect(multipart.map(([key]) => key)).toEqual(["console_settings_assets_upload"]);
    expect(op.console_settings_assets_upload).toMatchObject({
      method: "POST",
      path: PATH,
      pathParams: [],
      queryParams: [],
      headerParams: {},
      idempotency: "required",
      retry: "idempotent",
      environment: true,
    });
  });

  it("sends the kind, fileName and file parts of a File with a generated Idempotency-Key [SDK-012 AC1]", async () => {
    const fake = createFakeFetch([{ status: 201, body: ASSET }]);
    const client = staffClient(fake.fetch);

    const asset = await client.console.settings.assets.upload({
      file: logoFile(),
      kind: "logo",
      fileName: "Acme logo (dark background)",
    });

    expect(asset).toEqual(ASSET);
    expect(fake.requests).toHaveLength(1);
    const request = /** @type {RecordedRequest} */ (fake.requests[0]);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${BASE_URL}${PATH}`);
    // The text parts come first, so a server that reads the stream part by part knows the kind before the file.
    expect(await partsOf(request)).toEqual([
      ["kind", "logo"],
      ["fileName", "Acme logo (dark background)"],
      ["file", { name: "acme-logo.png", type: "image/png", bytes: [...PNG_BYTES] }],
    ]);
    expect(request.headers["idempotency-key"]).toMatch(UUID_V4);
    // fetch sets the Content-Type with its boundary; the SDK sets none and sends no JSON.
    expect(request.headers).not.toHaveProperty("content-type");
    expect(request.json).toBeUndefined();
    expect(request.headers).toMatchObject({
      accept: "application/json",
      "x-api-key": SK,
      authorization: `Bearer ${STAFF_AT}`,
      "x-velexis-environment": "test",
    });
    expect(request.init.cache).toBe("no-store");
  });

  it("sends a plain Blob as the file part and no fileName part when the call gives none [SDK-012 AC1]", async () => {
    const fake = createFakeFetch([{ status: 201, body: { ...ASSET, kind: "favicon", fileName: "blob" } }]);
    const client = staffClient(fake.fetch);

    await client.console.settings.assets.upload({
      file: new Blob([PNG_BYTES], { type: "image/png" }),
      kind: "favicon",
    });

    // FormData names a Blob's file part `blob`; the server takes that name when no fileName part comes.
    expect(await partsOf(fake.requests[0])).toEqual([
      ["kind", "favicon"],
      ["file", { name: "blob", type: "image/png", bytes: [...PNG_BYTES] }],
    ]);
    expect(fake.requests[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
  });

  it("leaves the boundary to fetch: a real Request encodes both parts under multipart/form-data with its boundary [SDK-012 AC1]", async () => {
    /** @type {{ contentType: string | null, kind: unknown, file: unknown, text: string }[]} */
    const encoded = [];
    const fake = createFakeFetch([
      async (request) => {
        // What fetch does with the init the SDK passes: the runtime's own Request encodes the form.
        const real = new Request(request.url, {
          method: request.method,
          headers: request.init.headers,
          body: /** @type {FormData} */ (request.body),
        });
        const contentType = real.headers.get("content-type");
        const text = await real.clone().text();
        const form = await real.formData();
        encoded.push({ contentType, kind: form.get("kind"), file: form.get("file"), text });
        return { status: 201, body: ASSET };
      },
    ]);
    const client = staffClient(fake.fetch);

    // A Content-Type of the call's own would hide the boundary: the SDK drops it.
    await client.console.settings.assets.upload(
      { file: logoFile(), kind: "logo" },
      { headers: { "Content-Type": "application/json" } },
    );

    expect(fake.requests[0]?.headers).not.toHaveProperty("content-type");
    const [{ contentType, kind, file, text } = { contentType: null, kind: null, file: null, text: "" }] =
      encoded;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(contentType ?? "")?.[1];
    expect(boundary).toBeDefined();
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="kind"');
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="acme-logo.png"');
    expect(text.indexOf('name="kind"')).toBeLessThan(text.indexOf('name="file"'));
    expect(kind).toBe("logo");
    expect(file).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await /** @type {Blob} */ (file).arrayBuffer())]).toEqual([...PNG_BYTES]);
  });

  it("uses options.idempotencyKey, and sends the same form and key again after 503 [SDK-012 AC1]", async () => {
    vi.useFakeTimers();
    const fake = createFakeFetch([
      errorResponse(503, "SERVICE_UNAVAILABLE", { headers: { "retry-after": "1" } }),
      { status: 201, body: ASSET },
    ]);
    const client = staffClient(fake.fetch);
    const key = "upload-acme-logo-2026-10-22";

    const uploaded = client.console.settings.assets.upload(
      { file: logoFile(), kind: "logo" },
      { idempotencyKey: key },
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(uploaded).resolves.toEqual(ASSET);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((request) => request.headers["idempotency-key"])).toEqual([key, key]);
    const [first, second] = await Promise.all(fake.requests.map((request) => partsOf(request)));
    expect(second).toEqual(first);
    expect(first).toEqual([
      ["kind", "logo"],
      ["file", { name: "acme-logo.png", type: "image/png", bytes: [...PNG_BYTES] }],
    ]);
  });

  it("sends a new Idempotency-Key with every call that has none of its own [SDK-012 AC1]", async () => {
    const fake = createFakeFetch([
      { status: 201, body: ASSET },
      { status: 201, body: ASSET },
    ]);
    const client = staffClient(fake.fetch);

    await client.console.settings.assets.upload({ file: logoFile(), kind: "logo" });
    await client.console.settings.assets.upload({ file: logoFile(), kind: "logo" });

    const [first, second] = fake.requests.map((request) => request.headers["idempotency-key"]);
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
  });

  it.each([
    // The operation has no path parameter, so only the SDK's own check keeps an empty form from going out.
    ["without params", undefined, 'needs "file", the image as a Blob or File'],
    ["with empty params", {}, 'needs "file", the image as a Blob or File'],
    ["without a file", { kind: "logo" }, 'needs "file", the image as a Blob or File'],
    [
      "with a file name as the file",
      { file: "acme-logo.png", kind: "logo" },
      'needs "file", the image as a Blob or File',
    ],
    [
      "with bytes that are not a Blob",
      { file: PNG_BYTES, kind: "logo" },
      'needs "file", the image as a Blob or File',
    ],
    [
      "without a kind",
      { file: new Blob([PNG_BYTES]) },
      'needs "kind", what the image is for (such as "logo")',
    ],
    [
      "with a blank kind",
      { file: new Blob([PNG_BYTES]), kind: " " },
      'needs "kind", what the image is for (such as "logo")',
    ],
    [
      "with an empty fileName",
      { file: new Blob([PNG_BYTES]), kind: "logo", fileName: "" },
      ': "fileName", when given, must be a non-blank string',
    ],
    [
      "with a fileName that is not a string",
      { file: new Blob([PNG_BYTES]), kind: "logo", fileName: 42 },
      ': "fileName", when given, must be a non-blank string',
    ],
  ])(
    "refuses an upload %s with a TypeError before any request [SDK-012 AC1]",
    async (_what, params, message) => {
      const fake = createFakeFetch();
      const client = staffClient(fake.fetch);

      const error = await client.console.settings.assets
        .upload(/** @type {never} */ (params))
        .catch((/** @type {unknown} */ caught) => caught);

      expect(error).toBeInstanceOf(TypeError);
      expect(/** @type {TypeError} */ (error).message).toBe(
        `Velexis SDK: POST ${PATH}${message.startsWith(":") ? "" : " "}${message}`,
      );
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("refuses params and options that are not a plain object, as every method does [SDK-012 AC1]", async () => {
    const fake = createFakeFetch();
    const client = staffClient(fake.fetch);

    await expect(client.console.settings.assets.upload(/** @type {never} */ (logoFile()))).rejects.toThrow(
      new TypeError(`Velexis SDK: the params of POST ${PATH} must be an object`),
    );
    await expect(
      client.console.settings.assets.upload(
        { file: logoFile(), kind: "logo" },
        /** @type {never} */ (new Map()),
      ),
    ).rejects.toThrow(new TypeError("Velexis SDK: request option must be an object"));
    expect(fake.requests).toHaveLength(0);
  });

  it("does not change the caller's params [SDK-012 AC1]", async () => {
    const fake = createFakeFetch([{ status: 201, body: ASSET }]);
    const client = staffClient(fake.fetch);
    const file = logoFile();
    const params = { file, kind: /** @type {const} */ ("logo"), fileName: "Acme" };

    await client.console.settings.assets.upload(params);

    expect(params).toEqual({ file, kind: "logo", fileName: "Acme" });
    expect(Object.keys(params)).toEqual(["file", "kind", "fileName"]);
  });
});
