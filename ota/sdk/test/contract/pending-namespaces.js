// What the working OpenAPI document already has but the SDK does not yet (ota/sdk/README.md §6 point 5, OADR-0016
// point 4, task SDK-006). The parity test (parity.test.js) compares the `x-sdk-method` names of the document with the
// methods of a client instance and skips what an entry here covers; the contract project (client.contract.ts) reads the
// same list, so the per-method assertions of a pending method that the client does not have yet are skipped too, and
// those of a pending method that it already has are checked. A method of the frozen contract is skipped only while the
// client has no namespace of that name.
//
// An entry is either a whole namespace that no SDK task has written yet, or a single method of a namespace that is
// already implemented, added to the document by a spec task after its namespace (for example `storefront.listPages`,
// which OBE-091 added and SDK-012 wrote). Each names the SDK task that adds it, and that task removes the entry: the
// parity test fails on an entry whose methods the client already has all of, and on an entry that covers no method
// of the document.
//
// SDK-012 wrote the last pending methods (`console.settings.*`, `console.payments.*`, `storefront.listPages` and
// `storefront.getPage`) and removed their three entries (`console`, after SDK-011 had written its 32 contract methods,
// and the two storefront methods), so the list is empty and the client has every `x-sdk-method` of the document.
// SDK-013 makes the parity test refuse a non-empty list at the M4 exit.

/**
 * One pending namespace or method.
 * @typedef {object} PendingEntry
 * @property {string} entry a namespace of the client (`auth`) or one method of an implemented namespace
 *   (`storefront.listPages`), as its `x-sdk-method` names it
 * @property {string} task the SDK task that adds it and removes this entry
 * @property {string} [note] anything a reviewer should know, for example a second task
 */

/**
 * The pending entries, in the order of the client's namespaces. `@type {const}` keeps the names as literal types for
 * the contract project.
 * @satisfies {readonly PendingEntry[]}
 */
export const PENDING = Object.freeze(/** @type {const} */ ([]).map((entry) => Object.freeze(entry)));
