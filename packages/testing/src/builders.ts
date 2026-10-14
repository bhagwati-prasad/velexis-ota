// defineBuilder (X-015): small typed factories for test rows and payloads. A builder returns a fresh object from its
// defaults, with a sequence number for unique values, and shallow overrides per call:
//
//   const buildPlan = defineBuilder<PlanRow>((n) => ({ code: `plan_${n}`, name: `Plan ${n}`, monthly_price: "10.00" }));
//   buildPlan();                          // { code: "plan_1", ... }
//   buildPlan({ name: "Starter" });       // { code: "plan_2", name: "Starter", ... }
//   buildPlan.many(3);                    // plan_3, plan_4, plan_5
//
// Builders only build values. Inserting them (plain SQL as the right role, ADR-0004) is the test's job.

/** The defaults of a builder: a value (copied on every build) or a function of the sequence number. */
export type BuilderDefaults<T> = T | ((sequence: number) => T);

/** Overrides of one build: some properties, or a function of the sequence number that returns them. */
export type BuilderOverrides<T> = Partial<T> | ((sequence: number) => Partial<T>);

export interface Builder<T> {
  /** Builds one value: the defaults for the next sequence number, then `overrides` on top (shallow). */
  (overrides?: BuilderOverrides<T>): T;
  /** Builds `count` values, each with its own sequence number. */
  many(count: number, overrides?: BuilderOverrides<T>): T[];
  /** The sequence number the next build gets (starts at 1). */
  readonly next: number;
  /** Starts the sequence again at 1, for example in `beforeEach`. */
  reset(): void;
}

/**
 * Defines a builder for `T`. Every build gets the next sequence number (1, 2, 3, …), passed to function defaults
 * and function overrides, so ids, e-mails and codes stay unique within a test file. Object defaults are deep-copied
 * with `structuredClone` on every build, so changing a built value never changes the next one.
 */
export function defineBuilder<T extends object>(defaults: BuilderDefaults<T>): Builder<T> {
  let sequence = 1;
  const base = (n: number): T =>
    typeof defaults === "function" ? (defaults as (sequence: number) => T)(n) : structuredClone(defaults);

  const build = (overrides?: BuilderOverrides<T>): T => {
    const n = sequence;
    sequence += 1;
    const extra = typeof overrides === "function" ? overrides(n) : overrides;
    return { ...base(n), ...extra };
  };

  const many = (count: number, overrides?: BuilderOverrides<T>): T[] => {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("Builder.many: count must be an integer, 0 or more");
    }
    return Array.from({ length: count }, () => build(overrides));
  };

  return Object.defineProperties(build, {
    many: { value: many, enumerable: true },
    next: { get: () => sequence, enumerable: true },
    reset: {
      value: () => {
        sequence = 1;
      },
      enumerable: true,
    },
  }) as Builder<T>;
}
