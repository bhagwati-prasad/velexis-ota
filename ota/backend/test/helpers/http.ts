// Test support: one HTTP exchange on a new connection (no keep-alive pool), so a test never reuses a socket of a
// server that an earlier test closed, and methods such as HEAD can be sent as they are.
import { request } from "node:http";

export interface Exchange {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  /** The body parsed as JSON. */
  json(): unknown;
}

export async function exchange(port: number, path: string, method = "GET"): Promise<Exchange> {
  return new Promise((resolveExchange, rejectExchange) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", rejectExchange);
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolveExchange({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          json: () => JSON.parse(body) as unknown,
        });
      });
    });
    req.on("error", rejectExchange);
    req.end();
  });
}
