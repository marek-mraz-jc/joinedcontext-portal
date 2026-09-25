/**
 * UI-15, UI-16, UI-44 (T-2137): what a page shows while it waits, and when it could not be read.
 *
 * Both states used to be written by hand on every page and written smaller each time — a bare
 * "Loading…" on blank white, and a red line carrying one generic sentence, so "you may not read
 * this project" and "the store is away" read identically and neither offered anything to press.
 * These two components are the rule instead: the wait is announced once in the page's own words,
 * and a failure says what the API said plus the one thing worth doing about it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { ApiError } from "../src/api/client";
import { PageFailed, PageLoading } from "../src/components/ui/PageState";
import { expectNoAxeViolations, inEveryLocale } from "./page_contract";

const show = (element: React.ReactElement) =>
  render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);

describe("the page's waiting state", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("announces the wait once, in the page's own words", () => {
    const { container } = show(<PageLoading label="Reading the endpoints" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Reading the endpoints");
    // The bars stand for the content and say nothing themselves.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(1);
  });

  it("draws as many bars as the page asked for", () => {
    const { container } = show(<PageLoading label="Reading" lines={4} />);
    // One bar for the heading, then the page's own.
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(5);
    const single = render(
      <I18nextProvider i18n={i18n}>
        <PageLoading label="Reading" lines={1} />
      </I18nextProvider>,
    );
    expect(single.container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it("has no axe violation", async () => {
    const { container } = show(<PageLoading label="Reading the endpoints" />);
    await expectNoAxeViolations(container);
  });
});

describe("the page's failed state", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("says what the API said, not a sentence of its own", () => {
    show(
      <PageFailed
        error={
          new ApiError(403, "Forbidden", {
            type: "about:blank",
            status: 403,
            title: "Forbidden",
            detail: "You may not read the project banskabystrica.",
          })
        }
      />,
    );
    expect(screen.getByText("You may not read the project banskabystrica.")).toBeInTheDocument();
    expect(screen.queryByText(en.app.error.generic)).not.toBeInTheDocument();
  });

  it("falls back to one plain sentence when the failure carries none", () => {
    show(<PageFailed error={new TypeError("Failed to fetch")} />);
    expect(screen.getByText(en.app.error.generic)).toBeInTheDocument();
    // Never the raw exception: "TypeError: Failed to fetch" is a line for a log, not for a page.
    expect(screen.queryByText(/TypeError/)).not.toBeInTheDocument();
  });

  it("prefers the page's own sentence where the page knows better", () => {
    show(
      <PageFailed error={new ApiError(404, "Not found", {
        type: "about:blank",
        status: 404,
        title: "Not found",
        detail: "no such run",
      })}>
        This run has expired and its workspace is gone.
      </PageFailed>,
    );
    expect(screen.getByText("This run has expired and its workspace is gone.")).toBeInTheDocument();
    expect(screen.queryByText("no such run")).not.toBeInTheDocument();
  });

  it("offers Retry only where asking again can help, and presses it", async () => {
    const retry = vi.fn();
    const { unmount } = show(<PageFailed error={new Error("gone")} onRetry={retry} />);
    const button = screen.getByRole("button", { name: en.app.error.retry });
    await userEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
    unmount();

    // A 404 or a refusal will not change, so the page offers nothing to press rather than a
    // button that does nothing.
    show(<PageFailed error={new ApiError(404, "Not found", {
          type: "about:blank",
          status: 404,
          title: "Not found",
          detail: "no such space",
        })} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // T-2834: the pages passed `onRetry` for every failure, so a 404 offered a Retry that could
  // only answer 404 again. The rule lives here now, for every caller.
  it("drops a page's Retry for a failure that answers the same the second time", () => {
    const retry = vi.fn();
    for (const status of [400, 403, 404, 409, 422]) {
      const problem = { type: "about:blank", status, title: "No", detail: `answered ${status}` };
      const { unmount } = show(<PageFailed error={new ApiError(status, "No", problem)} onRetry={retry} />);
      expect(screen.getByText(`answered ${status}`)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: en.app.error.retry }), String(status)).toBeNull();
      unmount();
    }
    const problem = { type: "about:blank", status: 503, title: "Away", detail: "the store is away" };
    show(<PageFailed error={new ApiError(503, "Away", problem)} onRetry={retry} />);
    expect(screen.getByRole("button", { name: en.app.error.retry })).toBeInTheDocument();
  });

  it("says Retry in every locale the Portal ships", async () => {
    const retry = vi.fn();
    await inEveryLocale(async (locale) => {
      const view = render(
        <I18nextProvider i18n={i18n}>
          <PageFailed error={new Error("gone")} onRetry={retry} />
        </I18nextProvider>,
      );
      const label = i18n.t("app.error.retry");
      expect(label, locale).not.toMatch(/^app\./);
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
      view.unmount();
    });
  });

  const problem = (status: number, detail: string) => ({ type: "about:blank", status, title: "x", detail });

  it("T-2747: a refusal says who gives access", () => {
    show(<PageFailed error={new ApiError(403, "Forbidden", problem(403, "You may not read the project helsinki."))} />);
    expect(screen.getByText("You may not read the project helsinki.")).toBeInTheDocument();
    expect(screen.getByText(en.app.error.forbiddenHint)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("T-2747: a missing object offers the page's way back to its list", () => {
    show(
      <PageFailed
        error={new ApiError(404, "Not found", problem(404, "There is no endpoint bikes."))}
        back={<a href="/projects/helsinki/endpoints">Back to the endpoints</a>}
      />,
    );
    expect(screen.getByRole("link", { name: "Back to the endpoints" })).toHaveAttribute("href", "/projects/helsinki/endpoints");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("T-2747: a server failure offers Retry and its reference, never the stack", async () => {
    const retry = vi.fn();
    show(
      <PageFailed
        error={new ApiError(502, "Bad Gateway", problem(502, "The configuration store did not answer."), "3f2c1a9e6b1d4c3e")}
        onRetry={retry}
      />,
    );
    expect(screen.getByText("The configuration store did not answer.")).toBeInTheDocument();
    expect(screen.getByText("3f2c1a9e6b1d4c3e")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.app.error.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("T-2747: a lost connection says so and offers Retry", () => {
    show(<PageFailed error={new TypeError("Failed to fetch")} onRetry={vi.fn()} />);
    expect(screen.getByText(en.app.error.generic)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.app.error.retry })).toBeInTheDocument();
  });

  it("T-2747: an ended session says to sign in again rather than showing an empty page", () => {
    show(<PageFailed error={new ApiError(401, "Unauthorized", problem(401, "unauthenticated"))} onRetry={vi.fn()} />);
    expect(screen.getByText(en.app.error.session)).toBeInTheDocument();
    expect(screen.queryByText("unauthenticated")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("T-2747: every kind reads in every locale the Portal ships", async () => {
    await inEveryLocale(async (locale) => {
      for (const key of ["app.error.session", "app.error.forbiddenHint", "app.error.reference"]) {
        expect(i18n.t(key), `${locale} ${key}`).not.toMatch(/^app\./);
      }
    });
  });

  it("has no axe violation, with the button and without it", async () => {
    const withRetry = show(<PageFailed error={new Error("gone")} onRetry={() => {}} />);
    await expectNoAxeViolations(withRetry.container);
    withRetry.unmount();
    const without = show(<PageFailed error={new Error("gone")} />);
    await expectNoAxeViolations(without.container);
  });
});
