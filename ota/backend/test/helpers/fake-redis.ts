// Test support: a minimal Redis server on the loopback interface, enough for ioredis to connect and PING. It answers
// PING with PONG, INFO with a server that has finished loading (ioredis' ready check) and every other command with
// OK. Tests use it where the shared Redis cannot be stopped and started, for example to prove that a client recovers
// after an outage. It speaks RESP2 requests only (arrays of bulk strings, as ioredis sends them).
import { createServer, type Server, type Socket } from "node:net";

export interface FakeRedis {
  readonly port: number;
  /** The command names received so far, upper-case, in order. */
  commands(): readonly string[];
  /** Stops listening and drops every client connection, as a Redis that goes away would. Safe to call twice. */
  close(): Promise<void>;
}

interface ParsedCommand {
  readonly args: readonly string[];
  /** Bytes of the buffer that the command used. */
  readonly length: number;
}

const ARRAY = 0x2a; // "*"
const BULK_STRING = 0x24; // "$"

/** One complete RESP array of bulk strings at the start of `buffer`, or `undefined` when more bytes are needed. */
function parseCommand(buffer: Buffer): ParsedCommand | undefined {
  const lineEnd = (from: number): number => buffer.indexOf("\r\n", from, "latin1");
  if (buffer[0] !== ARRAY) {
    return undefined;
  }
  let end = lineEnd(1);
  if (end === -1) {
    return undefined;
  }
  const count = Number(buffer.toString("latin1", 1, end));
  let offset = end + 2;
  const args: string[] = [];
  for (let index = 0; index < count; index += 1) {
    end = lineEnd(offset);
    if (end === -1 || buffer[offset] !== BULK_STRING) {
      return undefined;
    }
    const size = Number(buffer.toString("latin1", offset + 1, end));
    const start = end + 2;
    if (buffer.length < start + size + 2) {
      return undefined;
    }
    args.push(buffer.toString("utf8", start, start + size));
    offset = start + size + 2;
  }
  return { args, length: offset };
}

function reply(command: string): string {
  if (command === "PING") {
    return "+PONG\r\n";
  }
  if (command === "INFO") {
    const info = "# Server\r\nredis_version:7.4.0\r\nloading:0\r\n";
    return `$${Buffer.byteLength(info)}\r\n${info}\r\n`;
  }
  return "+OK\r\n";
}

/** Starts a fake Redis on `127.0.0.1:port`. */
export async function fakeRedis(port: number): Promise<FakeRedis> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let command = parseCommand(pending);
      while (command !== undefined) {
        pending = pending.subarray(command.length);
        const name = (command.args[0] ?? "").toUpperCase();
        received.push(name);
        socket.write(reply(name));
        command = parseCommand(pending);
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  let closing: Promise<void> | undefined;
  return {
    port,
    commands: () => [...received],
    close() {
      closing ??= new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      return closing;
    },
  };
}
