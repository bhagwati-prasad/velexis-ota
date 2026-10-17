// Test support: TCP ports on the loopback interface.
import { createServer, type Server } from "node:net";

async function listen(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

/** A port that was free a moment ago: bound to port 0, then released. Nothing listens on it afterwards. */
export async function freePort(): Promise<number> {
  const server = await listen();
  const { port } = server.address() as { port: number };
  await close(server);
  return port;
}

/**
 * A dummy REDIS_URL on a loopback port where nothing listens (`freePort`): every connection attempt is refused at once.
 * The API connects its vx:invalidate subscriber at start-up and reads the platform caches (OBE-012). A dummy password
 * on the default port does not keep it away from a Redis without a password (CI's: ioredis only warns that the server
 * needs none), so tests that start the API without a Redis of their own use this, the same on every machine.
 */
export async function unreachableRedisUrl(): Promise<string> {
  return `redis://:dummy@127.0.0.1:${await freePort()}/0`;
}

/** A port held by a listening server until `release()`: binding it fails with EADDRINUSE. */
export async function occupiedPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = await listen();
  return { port: (server.address() as { port: number }).port, release: () => close(server) };
}
