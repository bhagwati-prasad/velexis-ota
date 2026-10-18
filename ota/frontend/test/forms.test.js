// lib/forms.js (ota/frontend/README.md §5.2, §8): serialisation, the API's `fieldErrors` mapped onto fields with
// `aria-invalid` and `aria-describedby`, an error summary that receives focus and links to the fields, and the busy
// state of a submit.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearFieldErrors,
  fieldNamesFor,
  isSubmitting,
  pointerSegments,
  serialize,
  setSubmitting,
  showFieldErrors,
  withSubmitState,
} from "../src/lib/forms.js";

/**
 * The test form, freshly rendered: a sign-up-like form with labels, a hint, a radio group, a hidden code, a checkbox
 * group, a disabled field and a submit button.
 */
function renderForm() {
  document.body.innerHTML = `
  <form id="form" novalidate>
    <label for="email">E-mail</label>
    <input id="email" name="email" type="email" aria-describedby="email-hint" />
    <p id="email-hint">We send the confirmation here.</p>
    <label for="first">First name</label>
    <input id="first" name="travelers.0.firstName" />
    <label for="depart">Departure</label>
    <input id="depart" name="depart" type="date" data-error-path="/departureDate /query/departureDate" />
    <fieldset>
      <legend>Cabin</legend>
      <input type="radio" name="cabin" value="ECONOMY" checked /> <input type="radio" name="cabin" value="BUSINESS" />
    </fieldset>
    <input type="hidden" name="from" value="PAR" />
    <input name="stops" type="checkbox" value="0" checked /><input name="stops" type="checkbox" value="1" checked />
    <input name="note" value="kept" disabled />
    <button type="submit" data-busy-label="Searching…">Search flights</button>
  </form>`;
  return /** @type {HTMLFormElement} */ (document.getElementById("form"));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("serialize", () => {
  it("[OFE-002 AC1] returns the successful controls, repeated names as arrays", () => {
    const form = renderForm();
    /** @type {HTMLInputElement} */ (form.elements.namedItem("email")).value = "ada@example.com";

    expect(serialize(form)).toEqual({
      email: "ada@example.com",
      "travelers.0.firstName": "",
      depart: "",
      cabin: "ECONOMY",
      from: "PAR",
      stops: ["0", "1"],
    });
  });

  it("[OFE-002 AC1] never lets a control name reach the object's prototype", () => {
    document.body.innerHTML = '<form id="form"><input name="__proto__" value="x" /></form>';
    const values = serialize(/** @type {HTMLFormElement} */ (document.getElementById("form")));

    expect(Object.hasOwn(values, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
  });
});

describe("field errors", () => {
  it("[OFE-002 AC1] reads JSON pointers into control names", () => {
    expect(pointerSegments("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(fieldNamesFor("/travelers/0/firstName")).toEqual(["travelers.0.firstName"]);
    expect(fieldNamesFor("/query/departureDate")).toEqual(["query.departureDate", "departureDate"]);
    expect(fieldNamesFor("/query/include/1")).toEqual(["query.include.1", "include"]);
    expect(fieldNamesFor("")).toEqual([]);
  });

  it("[OFE-002 AC1] maps fieldErrors to aria-invalid and aria-describedby and focuses the error summary", () => {
    const form = renderForm();
    const email = /** @type {HTMLInputElement} */ (document.getElementById("email"));
    const first = /** @type {HTMLInputElement} */ (document.getElementById("first"));

    const summary = showFieldErrors(form, [
      { path: "/email", code: "format", message: "must match format email" },
      { path: "/travelers/0/firstName", code: "required" },
    ]);

    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe("email-hint email-error");
    expect(document.getElementById("email-error")?.textContent).toBe("Enter a value in the right format");
    expect(first.getAttribute("aria-invalid")).toBe("true");
    expect(first.getAttribute("aria-describedby")).toBe("first-error");
    expect(document.getElementById("first-error")?.textContent).toBe("Fill in this field");
    // The message sits right after its field.
    expect(email.nextElementSibling?.id).toBe("email-error");

    expect(summary).not.toBeNull();
    expect(document.activeElement).toBe(summary);
    expect(form.firstElementChild).toBe(summary);
    expect(summary?.getAttribute("tabindex")).toBe("-1");
    expect(summary?.querySelector("h2")?.textContent).toBe("There are 2 problems");
    expect(summary?.getAttribute("aria-labelledby")).toBe(summary?.querySelector("h2")?.id);
    const links = Array.from(summary?.querySelectorAll("a") ?? []);
    expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
      ["#email", "Enter a value in the right format"],
      ["#first", "Fill in this field"],
    ]);

    links[1]?.click();
    expect(document.activeElement).toBe(first);
  });

  it("[OFE-002 AC1] uses data-error-path, parameter names and groups, and lists unmatched errors in the summary", () => {
    const form = renderForm();

    const summary = showFieldErrors(form, [
      { path: "/query/departureDate", code: "format" },
      { path: "/cabin", code: "enum" },
      { path: "/from", code: "pattern" },
      { path: "/unknownField", code: "additionalProperties" },
      { path: "/email", code: "minLength" },
      { path: "/email", code: "pattern" },
      { path: "/card/number", code: "luhn", message: "4111111111111111 failed" },
    ]);

    expect(document.getElementById("depart")?.getAttribute("aria-invalid")).toBe("true");
    const radios = Array.from(form.querySelectorAll('input[name="cabin"]'));
    expect(radios.map((radio) => radio.getAttribute("aria-invalid"))).toEqual(["true", "true"]);
    // A group's message goes at the end of its fieldset, linked from every radio.
    const groupMessage = /** @type {HTMLElement} */ (form.querySelector("fieldset")?.lastElementChild);
    expect(groupMessage.textContent).toBe("Choose one of the options");
    expect(radios.every((radio) => radio.getAttribute("aria-describedby") === groupMessage.id)).toBe(true);
    // The hidden IATA code cannot show an error: its message and the unknown field's are summary entries without a link.
    const entries = Array.from(summary?.querySelectorAll("li") ?? []).map((item) => [
      item.querySelector("a") !== null,
      item.textContent,
    ]);
    expect(entries).toEqual([
      [true, "Enter a value in the right format"],
      [true, "Choose one of the options"],
      [false, "Enter a value in the right format"],
      [false, "This field is not allowed"],
      [true, "This is too short"],
      [false, "Check the card number"],
    ]);
    // One message per field, and never the rejected value.
    expect(form.querySelectorAll("#email-error")).toHaveLength(1);
    expect(form.textContent).not.toContain("4111");
    expect(summary?.querySelector("h2")?.textContent).toBe("There are 6 problems");
  });

  it("[OFE-002 AC1] clears what it added and reuses the page's own summary element", () => {
    const form = renderForm();
    const own = document.createElement("div");
    own.setAttribute("data-error-summary", "");
    own.hidden = true;
    form.prepend(own);

    const summary = showFieldErrors(form, [{ path: "/email", code: "required" }], { focus: false });
    expect(summary).toBe(own);
    expect(own.hidden).toBe(false);
    expect(document.activeElement).not.toBe(own);

    clearFieldErrors(form);
    const email = /** @type {HTMLInputElement} */ (document.getElementById("email"));
    expect(email.hasAttribute("aria-invalid")).toBe(false);
    expect(email.getAttribute("aria-describedby")).toBe("email-hint");
    expect(form.querySelector("[data-field-error]")).toBeNull();
    expect(own.hidden).toBe(true);
    expect(own.childElementCount).toBe(0);
    expect(form.querySelector("[data-error-summary]")).toBe(own);
  });

  it("[OFE-002 AC1] replaces earlier errors and shows nothing for an empty list", () => {
    const form = renderForm();
    showFieldErrors(form, [{ path: "/email", code: "required" }]);
    showFieldErrors(form, [{ path: "/travelers/0/firstName", code: "required" }]);

    expect(document.getElementById("email")?.hasAttribute("aria-invalid")).toBe(false);
    expect(form.querySelectorAll("[data-error-summary]")).toHaveLength(1);
    expect(form.querySelector("[data-error-summary] h2")?.textContent).toBe("There is 1 problem");

    expect(showFieldErrors(form, [])).toBeNull();
    expect(form.querySelector("[data-error-summary]")).toBeNull();
  });

  it("[OFE-002 AC1] places messages after a wrapping label, with ids of their own, and clears only what it added", () => {
    document.body.innerHTML = `
    <form id="form">
      <label><input id="terms" type="checkbox" name="acceptTerms" /> I accept the terms</label>
      <p id="terms-error">The page's own element with the id a message would take.</p>
      <label for="promo">Promo code</label>
      <input id="promo" name="promo" aria-invalid="true" aria-describedby="promo-hint" />
      <p id="promo-hint">Checked by the page itself.</p>
    </form>
    <label for="phone">Phone</label>
    <input id="phone" name="phone" form="form" />`;
    const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
    const terms = /** @type {HTMLInputElement} */ (document.getElementById("terms"));
    const label = /** @type {HTMLLabelElement} */ (terms.closest("label"));
    const phone = /** @type {HTMLInputElement} */ (document.getElementById("phone"));
    const promo = /** @type {HTMLInputElement} */ (document.getElementById("promo"));

    showFieldErrors(form, [
      { path: "/acceptTerms", code: "required" },
      { path: "/phone", code: "PHONE_INVALID" },
    ]);

    // After the label, not inside it: the message is neither part of the field's name nor between box and text.
    const termsMessage = /** @type {HTMLElement} */ (label.nextElementSibling);
    expect(termsMessage.textContent).toBe("Fill in this field");
    expect(label.textContent).not.toContain("Fill in this field");
    expect(termsMessage.id).not.toBe("terms-error");
    expect(document.querySelectorAll(`[id="${termsMessage.id}"]`)).toHaveLength(1);
    expect(terms.getAttribute("aria-describedby")).toBe(termsMessage.id);
    // A control outside the form element that belongs to it through form="…".
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    expect(phone.nextElementSibling?.textContent).toBe("Enter a valid phone number");

    clearFieldErrors(form);
    expect(document.querySelector("[data-field-error]")).toBeNull();
    expect(terms.hasAttribute("aria-invalid")).toBe(false);
    expect(terms.hasAttribute("aria-describedby")).toBe(false);
    expect(phone.hasAttribute("aria-invalid")).toBe(false);
    expect(phone.hasAttribute("aria-describedby")).toBe(false);
    // What the page set itself is left alone.
    expect(promo.getAttribute("aria-invalid")).toBe("true");
    expect(promo.getAttribute("aria-describedby")).toBe("promo-hint");
    expect(document.getElementById("terms-error")?.textContent).toContain("The page's own element");
  });
});

describe("submit state", () => {
  it("[OFE-002 AC1] marks the form busy, keeps the button focusable and restores its label", async () => {
    const form = renderForm();
    const button = /** @type {HTMLButtonElement} */ (form.querySelector("button"));
    /** @type {(value: string) => void} */
    let finish = () => {};
    const task = vi.fn(() => new Promise((resolve) => (finish = resolve)));

    const running = withSubmitState(form, task);
    expect(isSubmitting(form)).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Searching…");

    // A second submit while the first runs does nothing.
    expect(await withSubmitState(form, task)).toBeUndefined();
    expect(task).toHaveBeenCalledTimes(1);

    finish("done");
    expect(await running).toBe("done");
    expect(isSubmitting(form)).toBe(false);
    expect(form.hasAttribute("aria-busy")).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.textContent).toBe("Search flights");
  });

  it("[OFE-002 AC1] restores the form when the task fails and labels input buttons too", async () => {
    document.body.innerHTML =
      '<form id="form"><input type="submit" value="Pay" data-busy-label /></form><button form="form">Go</button>';
    const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
    const input = /** @type {HTMLInputElement} */ (form.querySelector("input"));
    const outside = /** @type {HTMLButtonElement} */ (document.querySelector("button"));

    setSubmitting(form, true);
    expect(input.value).toBe("Please wait…");
    expect(outside.getAttribute("aria-disabled")).toBe("true");
    expect(outside.textContent).toBe("Go");
    setSubmitting(form, false);
    expect(input.value).toBe("Pay");

    await expect(
      withSubmitState(form, () => {
        throw new Error("declined");
      }),
    ).rejects.toThrow("declined");
    expect(isSubmitting(form)).toBe(false);
    expect(input.value).toBe("Pay");
  });
});
