// The approved deviations of the SDK from the frozen contract in docs/velexis-sdk/sdk/src/ (OADR-0016 point 4,
// ota/sdk/docs/types-and-builds.md §4 point 4, ota/sdk/docs/extensions.md §6, task SDK-006). Each entry names the ADR
// that approves it. The per-method assertions of methods.generated.ts compare the SDK with `ContractClient`: the
// contract with exactly the members of these entries replaced (`Omit` plus the approved signature). The assertions at
// the end pin each deviating type and prove that nothing else differs from the contract.
//
// Anything else that fails the contract test is an SDK bug, not a reason to add an entry here. A new entry needs an
// accepted ADR first.
import type * as Contract from "velexis-contract";

import type { Assignable, ContractMethodPath, Member, SdkResult } from "./client.contract.js";

/** The approved deviations, by name: the ADR, the methods it covers and what they resolve with instead. */
export interface ApprovedDeviations {
  /**
   * OADR-0006 (storefront cookie sessions and CSRF): in cookie mode the session lives in httpOnly cookies, so
   * `auth.signIn`, `auth.refresh` and `auth.changePassword` resolve with `AuthSessionInfo` (no token fields) instead of
   * `AuthSessionResult`; the SDK types them as the union. The parameters stay the contract's.
   */
  cookieModeAuthResult: {
    adr: "OADR-0006";
    methods: "auth.signIn" | "auth.refresh" | "auth.changePassword";
    result: Contract.Schemas["AuthSessionResult"] | Contract.Schemas["AuthSessionInfo"];
  };
}

type CookieModeAuthResult = ApprovedDeviations["cookieModeAuthResult"];

/** Every method that an approved deviation covers. */
export type DeviatingMethod = ApprovedDeviations[keyof ApprovedDeviations]["methods"];

/** The member names after `Prefix.` (`"auth.signIn"` → `"signIn"`). */
type After<Path, Prefix extends string> = Path extends `${Prefix}.${infer Rest}` ? Rest : never;

type CookieModeAuthMethod = After<CookieModeAuthResult["methods"], "auth">;

/** `AuthApi` with the cookie-mode result: the contract's parameters, the approved result. */
type DeviatedAuthApi = Omit<Contract.AuthApi, CookieModeAuthMethod> & {
  [Name in CookieModeAuthMethod]: (
    ...args: Parameters<Contract.AuthApi[Name]>
  ) => Promise<CookieModeAuthResult["result"]>;
};

/** The contract client with the approved deviations applied: what the SDK is compared with. */
export type ContractClient = Omit<Contract.VelexisClient, "auth"> & { readonly auth: DeviatedAuthApi };

/** Whether two types are identical (not merely assignable to each other). */
type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The contract methods whose type `ContractClient` changes. */
type ChangedMethod = {
  [Method in ContractMethodPath]: Identical<
    Member<ContractClient, Method>,
    Member<Contract.VelexisClient, Method>
  > extends true
    ? never
    : Method;
}[ContractMethodPath];

type AuthSessionResult = Contract.Schemas["AuthSessionResult"];
type AuthSessionInfo = Contract.Schemas["AuthSessionInfo"];

export type DeviationAssertions = [
  // `ContractClient` differs from the contract in exactly the methods the entries list, no more and no fewer.
  Assignable<DeviatingMethod, ChangedMethod>,
  Assignable<ChangedMethod, DeviatingMethod>,
  // OADR-0006: the deviating type is pinned to AuthSessionResult | AuthSessionInfo...
  Assignable<CookieModeAuthResult["result"], AuthSessionResult | AuthSessionInfo>,
  Assignable<AuthSessionResult | AuthSessionInfo, CookieModeAuthResult["result"]>,
  // ...it only widens what the contract's methods resolve with...
  Assignable<CookieModeAuthResult["result"], Awaited<ReturnType<Contract.AuthApi["signIn"]>>>,
  Assignable<CookieModeAuthResult["result"], Awaited<ReturnType<Contract.AuthApi["refresh"]>>>,
  Assignable<CookieModeAuthResult["result"], Awaited<ReturnType<Contract.AuthApi["changePassword"]>>>,
  // ...and the SDK resolves with all of it, not a part (methods.generated.ts checks the other direction). While
  // `auth` is pending (SDK-008) the methods stand in with the deviating type, so these hold by themselves.
  Assignable<SdkResult<"auth.signIn">, CookieModeAuthResult["result"]>,
  Assignable<SdkResult<"auth.refresh">, CookieModeAuthResult["result"]>,
  Assignable<SdkResult<"auth.changePassword">, CookieModeAuthResult["result"]>,
];
