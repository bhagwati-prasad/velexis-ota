// Test support for nestjs-pino. Outside a request, every PinoLogger of a process writes to one process-wide logger:
// the logger of the first LoggerModule that created a PinoLogger. A process runs one Nest application on the VM, so
// that is its own logger; a test file that starts several applications (and so several loggers and sinks) calls
// this before starting the one whose out-of-request lines it asserts, so they reach that application's logger.
import { __resetOutOfContextForTests } from "nestjs-pino/PinoLogger";

export function useNextApplicationLoggerOutsideRequests(): void {
  __resetOutOfContextForTests();
}
