// What the working OpenAPI document had but the SDK did not yet, while the document grew ahead of the SDK until the M4
// exit (ota/sdk/README.md §6 point 5, OADR-0016 point 4, tasks SDK-006 to SDK-013). An entry was either a whole
// namespace that no SDK task had written yet, or a single method of a namespace that was already implemented, added to
// the document by a spec task after its namespace (for example `storefront.listPages`, which OBE-091 added and SDK-012
// wrote), and named the SDK task that added it. SDK-012 wrote the last pending methods (`console.settings.*`,
// `console.payments.*`, `storefront.listPages` and `storefront.getPage`) and removed the last entries.
//
// The list is closed since SDK-013, the M4 exit: the client has every `x-sdk-method` of the document (128 methods), and
// the change that adds an operation with an `x-sdk-method` to the document writes its SDK method too
// (ota/docs/api-changes.md §1). The parity test (parity.test.js) refuses any entry here, however well-formed, and
// compares the document with the client as if the list were empty, so no entry can excuse a missing method. The
// contract project (client.contract.ts) still reads the names as literal types, and contract.test.js proves its rules
// on a scratch copy of this file with an entry; that copy never reaches the parity test.

/**
 * One pending namespace or method, as the list held them until SDK-013.
 * @typedef {object} PendingEntry
 * @property {string} entry a namespace of the client (`auth`) or one method of an implemented namespace
 *   (`storefront.listPages`), as its `x-sdk-method` names it
 * @property {string} task the SDK task that adds it and removes this entry
 * @property {string} [note] anything a reviewer should know, for example a second task
 */

/**
 * The pending entries: none, and the parity test fails on any. `@type {const}` keeps the names as literal types for
 * the contract project.
 * @satisfies {readonly PendingEntry[]}
 */
export const PENDING = Object.freeze(/** @type {const} */ ([]).map((entry) => Object.freeze(entry)));
