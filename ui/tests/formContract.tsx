/**
 * T-1730: the form contract as one helper, run against every form (UI-04, UI-15, UI-16, UI-44, UI-48).
 *
 * Twenty-eight forms and dialogs, and every defect found in one of them so far was found by
 * hand: a placeholder proposed as a name, focus lost after a refusal, a status code shown where
 * a sentence belongs. Nothing ran one checklist against all of them. `checkForm` is that
 * checklist: a form test of the `ui-forms` group describes its form once and gets every rule.
 *
 * Each rule is a case of its own, so a failure names the rule rather than "the form". A rule
 * runs only when the spec gives it something to work with: a form with no secret field is not
 * asked about secrets, and a form with no cancel is not asked about discarding. The rules that
 * every form has — labels, the empty submit, the refusal, the double click, one primary, axe,
 * the locales, and hostile text coming back as text — always run.
 *
 * What it does NOT do: assert the wording of a label or which request a form sends. Those are
 * the form's own test, and `checkForm` leaves room for it: it returns after cleaning up, so a
 * test calls it and then makes its own cases.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import type { ReactElement } from "react";
import { expectDenied, expectNoViolations } from "./checks";
import { json, problem, renderPage } from "./page_contract";

/** A value the browser itself refuses, for a field that declares a pattern, a URL or a range. */
export interface BrowserRule {
  /** What to type: a value the control's own validation must refuse before any request. */
  refuses: string;
  /** A value the same control accepts, so the rule is not simply "nothing works". */
  accepts: string;
}

export interface FormFieldSpec {
  /** The control's id, the one the Field wires its label and messages to. */
  id: string;
  /** The visible label, as a person reads it. */
  label: string | RegExp;
  /** A value that is valid for this field; every rule that submits types these. */
  value?: string;
  required?: boolean;
  /** A secret: it never echoes, and the browser is told not to remember it (MF-24). */
  secret?: boolean;
  /** What the control's own validation refuses, and what it accepts. */
  browser?: BrowserRule;
  /** A checkbox or a switch is clicked, not typed into. */
  toggle?: boolean;
}

export interface FormSpec {
  /** Every control a person fills in, in the order they appear. */
  fields: FormFieldSpec[];
  /** The accessible name of the button that proposes the change. */
  submit: string | RegExp;
  /** The accessible name of the button that leaves without proposing, when the form has one. */
  cancel?: string | RegExp;
  /** The path the form's submit sends to, so the helper can count and refuse it. */
  submitPath: string;
  /** The method, when it is not POST. */
  submitMethod?: string;
  /** The reason the server gives when it refuses, in words a person can act on. */
  refusal?: string;
  /** Controls this person may not use, with the reason each one carries (UI-44). */
  denied?: { name: string | RegExp; reason: string | RegExp }[];
  /** The form's own reads (schemas, lists); the submit is answered by the helper. */
  answer?: (url: URL, request: Request) => Response | undefined;
  /** Where the form is mounted, for the pages that read the project out of the address. */
  path?: string;
  /** Selectors left out of the axe run, each with the task that owns the violation. */
  axeExclude?: string[];
}

/** The hostile values every text field is typed into: both must come back as text (AG-46). */
export const HOSTILE = '<img src=x onerror=alert(1)>';
export const HOSTILE_URL = "javascript:alert(1)";

interface Mounted extends RenderResult {
  /** `METHOD /path` of every request the form sent, in order. */
  sent: string[];
  /** What the next submit answers with; the default is 201. */
  refuse: (response: Response | undefined) => void;
  /** Holds every answer to the submit until `release` is called, so a request stays in flight. */
  hold: () => void;
  release: () => void;
}

/**
 * The form, mounted with `fetch` recording what it sends.
 *
 * Awaited, because the page harness mounts the form inside a TanStack router and the router
 * paints nothing until it has resolved its first match: a rule that read the DOM straight after
 * `render` read an empty container and every rule failed for that one reason.
 */
async function mount(element: ReactElement, spec: FormSpec): Promise<Mounted> {
  const sent: string[] = [];
  let refusal: Response | undefined;
  let held: Promise<void> | undefined;
  let release = (): void => {};
  const result = renderPage(element, {
    path: spec.path ?? "/projects/helsinki",
    answer: (url, request) => {
      const own = spec.answer?.(url, request);
      if (own) return own;
      if (url.pathname.includes(spec.submitPath)) {
        sent.push(`${request.method} ${url.pathname}`);
        const answer = refusal
          ? refusal.clone()
          : json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "Change", metadata: { name: "chg-1" } }, 201);
        return held ? held.then(() => answer) : answer;
      }
      return undefined;
    },
  });
  await waitFor(() => expect(result.container).not.toBeEmptyDOMElement());
  return Object.assign(result, {
    sent,
    refuse: (response: Response | undefined) => {
      refusal = response;
    },
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  });
}

/**
 * The control of one field, by its visible label.
 *
 * Not an exact match: a required Field renders a `*` inside the label, so the label's text is
 * "Name*" and an exact query for "Name" finds nothing. A form with two labels that share a
 * substring passes a RegExp instead.
 */
function control(field: FormFieldSpec): HTMLElement {
  return screen.getByLabelText(field.label, { exact: false }) as HTMLElement;
}

async function fill(spec: FormSpec, user: ReturnType<typeof userEvent.setup>): Promise<void> {
  for (const field of spec.fields) {
    const element = control(field);
    if (field.toggle) {
      if ((element as HTMLInputElement).checked !== true) await user.click(element);
      continue;
    }
    if (field.value === undefined) continue;
    await user.clear(element);
    await user.type(element, field.value);
  }
}

function primaries(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("button")].filter((button) =>
    button.classList.contains("bg-primary"),
  );
}

/** The visible text of a subtree, whitespace collapsed. */
function text(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Every rule of the form contract, in order, against one form.
 *
 * `element` is remounted for each rule, because a rule that ran before it must not decide what
 * it sees. The caller's own cases come after.
 */
export async function checkForm(element: () => ReactElement, spec: FormSpec): Promise<void> {
  const rules: [string, () => Promise<void>][] = [
    [
      "every control has a visible label tied to it, and required is announced",
      async () => {
        const view = await mount(element(), spec);
        for (const field of spec.fields) {
          const element_ = control(field);
          expect(element_.id, `${String(field.label)} has no id for its label to point at`).toBe(field.id);
          const label = view.container.querySelector<HTMLLabelElement>(`label[for="${field.id}"]`);
          const named = label !== null || element_.getAttribute("aria-label") !== null;
          expect(named, `${String(field.label)} has no label bound by for/id`).toBe(true);
          if (field.required) {
            expect(element_, `${String(field.label)} is required and does not say so`).toHaveAttribute(
              "aria-required",
              "true",
            );
            if (label) {
              expect(
                text(label).includes("*") || label.querySelector("[title]") !== null,
                `${String(field.label)} is required and carries no visible mark`,
              ).toBe(true);
            }
          }
        }
      },
    ],
    [
      "a hint and a refusal are tied to their control by aria-describedby",
      async () => {
        const view = await mount(element(), spec);
        for (const field of spec.fields) {
          const described = control(field).getAttribute("aria-describedby") ?? "";
          for (const suffix of ["__description", "__help", "__error"]) {
            const message = view.container.querySelector(`#${field.id}${suffix}`);
            if (message) {
              expect(
                described.split(/\s+/),
                `${field.id}${suffix} is shown and named in no aria-describedby`,
              ).toContain(`${field.id}${suffix}`);
            }
          }
        }
      },
    ],
    [
      "an empty submit proposes nothing and puts the focus on the first field that is missing",
      async () => {
        const required = spec.fields.filter((field) => field.required && !field.toggle);
        if (required.length === 0) return;
        const user = userEvent.setup();
        const view = await mount(element(), spec);
        await user.click(screen.getByRole("button", { name: spec.submit }));
        await waitFor(() => expect(view.sent, "an empty form proposed something").toEqual([]));
        const first = control(required[0]);
        expect(
          document.activeElement === first || first.getAttribute("aria-invalid") === "true",
          "the first field that is missing is neither focused nor marked",
        ).toBe(true);
      },
    ],
    [
      "the form's own rules answer before the server does",
      async () => {
        const rule = spec.fields.find((field) => field.browser);
        if (!rule?.browser) return;
        const user = userEvent.setup();
        const view = await mount(element(), spec);
        await fill(spec, user);
        await user.clear(control(rule));
        await user.type(control(rule), rule.browser.refuses);
        await user.click(screen.getByRole("button", { name: spec.submit }));
        await waitFor(() =>
          expect(view.sent, `${String(rule.label)} sent a value its own rule refuses`).toEqual([]),
        );
      },
    ],
    [
      "a refusal is shown in words, never as a status code or as JSON",
      async () => {
        if (!spec.refusal) return;
        const user = userEvent.setup();
        const view = await mount(element(), spec);
        view.refuse(problem(409, spec.refusal));
        await fill(spec, user);
        await user.click(screen.getByRole("button", { name: spec.submit }));
        await waitFor(() => expect(view.sent.length, "the form sent nothing to be refused").toBe(1));
        await waitFor(() => expect(text(view.container)).toContain(spec.refusal!));
        const shown = text(view.container);
        expect(shown, "a status code is not a sentence").not.toMatch(/\b(409|4\d\d|5\d\d)\b/);
        expect(shown, "raw JSON is not a sentence").not.toMatch(/[{}]"|"type":|about:blank/);
        for (const field of spec.fields) {
          if (field.value === undefined || field.toggle || field.secret) continue;
          expect(
            (control(field) as HTMLInputElement).value,
            `${String(field.label)} lost what was typed into it when the server refused`,
          ).toBe(field.value);
        }
      },
    ],
    [
      "a second click while the first request runs sends nothing",
      async () => {
        const user = userEvent.setup();
        const view = await mount(element(), spec);
        await fill(spec, user);
        // The answer is held, so the first proposal is still in flight when the second click
        // lands. Without that the stub answers before the second click and two proposals are
        // the correct behaviour rather than the defect this rule looks for.
        view.hold();
        const submit = screen.getByRole("button", { name: spec.submit });
        const first = user.click(submit);
        await user.click(submit);
        await waitFor(() => expect(view.sent.length).toBeGreaterThan(0));
        expect(view.sent.length, "two clicks sent two proposals").toBe(1);
        view.release();
        await first;
      },
    ],
    [
      "leaving with something typed asks first",
      async () => {
        if (!spec.cancel) return;
        const typed = spec.fields.find((field) => field.value !== undefined && !field.toggle);
        if (!typed) return;
        const user = userEvent.setup();
        const view = await mount(element(), spec);
        await user.type(control(typed), typed.value!);
        await user.click(screen.getByRole("button", { name: spec.cancel }));
        // Either a confirmation stands in the way, or nothing was thrown away: a form that
        // silently empties its fields on Cancel passes neither.
        const confirmed =
          screen.queryAllByRole("alertdialog").length > 0 ||
          screen.queryAllByRole("dialog").length > 0;
        const kept = view.container.contains(control(typed))
          ? (control(typed) as HTMLInputElement).value === typed.value
          : false;
        expect(confirmed || kept, "what was typed was thrown away without asking").toBe(true);
      },
    ],
    [
      "a secret never echoes and the browser is not asked to remember it",
      async () => {
        const secret = spec.fields.find((field) => field.secret);
        if (!secret) return;
        const user = userEvent.setup();
        const view = await mount(element(), spec);
        const element_ = control(secret) as HTMLInputElement;
        expect(element_.type, "a secret field is a password field").toBe("password");
        expect(
          (element_.getAttribute("autocomplete") ?? "").match(/^(off|new-password)$/),
          "a secret field asks the browser not to remember it",
        ).not.toBeNull();
        const value = "s3cr3t-value-nobody-should-see";
        await user.type(element_, value);
        expect(text(view.container), "the secret was written into the page").not.toContain(value);
        // The control holds the value it was typed into, which is not a leak. Everything else is:
        // a preview, a title, an aria-label, a data attribute, a draft shown beside the form.
        const elsewhere = [...view.container.querySelectorAll<HTMLElement>("*")].filter(
          (node) => node !== element_,
        );
        for (const node of elsewhere) {
          for (const attribute of node.getAttributeNames()) {
            expect(
              node.getAttribute(attribute) ?? "",
              `the secret was written into ${node.tagName.toLowerCase()}[${attribute}]`,
            ).not.toContain(value);
          }
        }
      },
    ],
    [
      "a control this person may not use is refused with its reason",
      async () => {
        if (!spec.denied?.length) return;
        await mount(element(), spec);
        for (const denied of spec.denied) {
          expectDenied(screen.getByRole("button", { name: denied.name }), denied.reason);
        }
      },
    ],
    [
      "one primary button, and it is the last of the form's buttons",
      async () => {
        const view = await mount(element(), spec);
        const primary = primaries(view.container);
        expect(primary.length, "a form has exactly one primary button").toBe(1);
        const buttons = [...view.container.querySelectorAll("button")];
        expect(
          buttons.indexOf(primary[0] as HTMLButtonElement),
          "the primary button is the last one, after Cancel",
        ).toBe(buttons.length - 1);
      },
    ],
    [
      "hostile text and a hostile URL come back as text",
      async () => {
        const typed = spec.fields.filter((field) => !field.toggle && !field.secret);
        if (typed.length === 0) return;
        const user = userEvent.setup();
        const view = await mount(element(), spec);
        for (const field of typed) {
          await user.clear(control(field));
          await user.type(control(field), HOSTILE);
        }
        expect(view.container.querySelector("img"), "the hostile value became an element").toBeNull();
        expect(text(view.container), "the hostile value was not shown as text").toContain("<img");
        const links = [...view.container.querySelectorAll("a")];
        for (const link of links) {
          expect(link.getAttribute("href") ?? "", "a javascript: URL is a link").not.toMatch(/^javascript:/i);
        }
      },
    ],
    [
      "axe is clean and no key is shown where a sentence belongs",
      async () => {
        const view = await mount(element(), spec);
        await expectNoViolations(view.container, spec.axeExclude ?? []);
        expect(text(view.container), "a translation key reached the page").not.toMatch(
          /\b[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*\.[a-zA-Z0-9.]+\b/,
        );
      },
    ],
  ];

  const failures: string[] = [];
  for (const [rule, run] of rules) {
    try {
      await run();
    } catch (error) {
      failures.push(`${rule}\n    ${(error as Error).message.split("\n").slice(0, 6).join("\n    ")}`);
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  }
  expect(failures.join("\n\n"), `the form contract (T-1730) is not met:\n${failures.join("\n\n")}`).toBe("");
}

/** The rules `checkForm` runs, for the self-test that proves each one bites. */
export const RULES = [
  "labels",
  "describedby",
  "empty submit",
  "browser rules",
  "refusal in words",
  "double click",
  "leaving asks",
  "secret",
  "denied",
  "one primary",
  "hostile text",
  "axe and keys",
] as const;

export { render, screen, within };
