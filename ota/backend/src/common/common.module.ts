import { Global, Module } from "@nestjs/common";
import { Clock } from "./clock";
import { IdGenerator } from "./ids";

/**
 * Cross-cutting providers of both processes. Global, so every module can inject `Clock` and `IdGenerator` without
 * importing this one; the API and the worker import it once, in their root modules.
 */
@Global()
@Module({
  providers: [Clock, IdGenerator],
  exports: [Clock, IdGenerator],
})
export class CommonModule {}
