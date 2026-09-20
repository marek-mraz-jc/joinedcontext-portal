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

  it("has no axe violation, with the button and without it", async () => {
    const withRetry = show(<PageFailed error={new Error("gone")} onRetry={() => {}} />);
    await expectNoAxeViolations(withRetry.container);
    withRetry.unmount();
    const without = show(<PageFailed error={new Error("gone")} />);
    await expectNoAxeViolations(without.container);
  });
});
