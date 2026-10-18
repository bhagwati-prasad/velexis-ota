// The test application of test/support/create-test-app.ts on this file's own database clone and Redis database
// (@velexis/testing): the pipeline the integration tests of every endpoint build on (OBE-010). The readiness probe
// proves the application uses the clone and the Redis database it was given; a pending operation answers 501 in the
// envelope the document describes.
import {
  createTestDatabase,
  expectResponseToMatch,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeHeaders } from "../../helpers/api-env";
import { createTestApp, type TestApp } from "../../support/create-test-app";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  api = await createTestApp({ database: db, redis });
});

afterAll(async () => {
  await api.close();
  await redis.close();
  await db.drop();
});

describe("createTestApp on a test database and Redis", () => {
  it("boots the API module on the file's database clone and Redis database", async () => {
    const res = await request(api.server).get("/health/ready");

    expect(api.config.DATABASE_URL).toBe(db.urlFor("ota"));
    expect(api.config.REDIS_URL).toBe(redis.url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { postgres: "ok", redis: "ok" } });
  });

  it("answers a pending operation with 501 NOT_IMPLEMENTED and its milestone", async () => {
    const res = await request(api.server)
      .get("/v1/flight-searches/srch_01J9ZQ4V6W8X0Y2Z4A6B8C0D2E")
      .set(edgeHeaders());

    expect(res.status).toBe(501);
    expect(res.body.error).toMatchObject({
      code: "NOT_IMPLEMENTED",
      requestId: res.headers["x-request-id"],
      details: { milestone: "M2", operationId: "getFlightSearch" },
    });
  });

  it("answers an unknown route with 404 NOT_FOUND in the error envelope of the document", async () => {
    const res = await request(api.server).get("/v1/unknown");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND", requestId: res.headers["x-request-id"] });
    // The envelope is the document's ErrorResponse, as on any operation that documents a 404.
    expectResponseToMatch("getBooking", { status: res.status, body: res.body });
  });
});
