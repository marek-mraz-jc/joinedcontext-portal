import { expect, vi } from "vitest";
import { digestOf } from "../src/api/drafts";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Every page checks a manifest before it proposes it (PF-57, T-0956), so a test's fetch stub
 * sees a `?dryRun=All` request before each proposal. This answers those checks green and records
 * them (`METHOD /path`), and hands every other request to the test's own stub unchanged, so what
 * a test asserts about its proposals still counts proposals only.
 */
export function answeringChecks(inner: Fetch): Fetch & { checks: string[] } {
  const checks: string[] = [];
  const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = typeof input === "string" || input instanceof URL ? null : input;
    const url = new URL(request ? request.url : String(input), window.location.origin);
    if (url.searchParams.get("dryRun") === "All") {
      checks.push(`${request?.method ?? init?.method ?? "GET"} ${url.pathname}`);
      // A verdict fresh for what was checked, so a form that holds a draft reads it green.
      let inputDigest: string | undefined;
      try {
        const body = (await (request ? request.clone().text() : Promise.resolve(String(init?.body ?? "")))) || "{}";
        const manifest = JSON.parse(body) as Record<string, unknown>;
        delete manifest.draft;
        inputDigest = digestOf(manifest);
      } catch {
        inputDigest = undefined;
      }
      const verdict = { ok: true, findings: [], checkedAt: new Date().toISOString(), inputDigest };
      return new Response(JSON.stringify({ valid: true, verdict }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return inner(input, init);
  });
  return Object.assign(wrapped, { checks });
}

/** The checks the current `fetch` stub answered, when it was wrapped by `answeringChecks`. */
export function checksSoFar(): string[] {
  return (globalThis.fetch as unknown as { checks?: string[] }).checks ?? [];
}

/**
 * A control the caller may not use (UI-44): refused, reachable, and carrying its reason.
 *
 * `PermissionGuard` and `Button`'s `disabledReason` make such a control `aria-disabled` rather
 * than `disabled`, because a hard-disabled button leaves the tab order and the reason written
 * for it can then never be read (T-1743). Every test that used to assert `toBeDisabled()` on a
 * guarded control asserts this instead.
 */
export function expectDenied(control: HTMLElement, reason?: string | RegExp): void {
  expect(control, "a denied control is aria-disabled, not disabled").toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(control, "and it keeps its place in the tab order").not.toBeDisabled();
  if (reason !== undefined) {
    expect(control).toHaveAccessibleDescription(reason);
  }
}
