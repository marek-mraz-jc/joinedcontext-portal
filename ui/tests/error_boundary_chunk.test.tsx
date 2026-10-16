import { fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorBoundary,
  isChunkLoadError,
} from "../src/components/ErrorBoundary";

// T-4201: a chunk that did not load (a deploy, a dropped or rate-limited request) asks for a
// reload instead of saying the page crashed.
afterEach(() => {
  vi.restoreAllMocks();
});

function Thrower({ error }: { error: Error }): never {
  throw error;
}

describe("chunk load errors", () => {
  it("knows the browsers' words for a module that did not load", () => {
    expect(
      isChunkLoadError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://x/assets/a.js",
        ),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError("error loading dynamically imported module"),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError("Importing a module script failed.")),
    ).toBe(true);
    expect(
      isChunkLoadError(new Error("Unable to preload CSS for /assets/b.css")),
    ).toBe(true);
    expect(
      isChunkLoadError(
        Object.assign(new Error("x"), { name: "ChunkLoadError" }),
      ),
    ).toBe(true);
    expect(
      isChunkLoadError(new Error("Cannot read properties of undefined")),
    ).toBe(false);
    expect(
      isChunkLoadError("Failed to fetch dynamically imported module"),
    ).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it("offers a reload when a lazy page cannot be fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload,
    });
    const Page = lazy(() =>
      Promise.reject(
        new TypeError(
          "Failed to fetch dynamically imported module: /assets/p.js",
        ),
      ),
    );
    render(
      <ErrorBoundary fallback={() => "crashed"}>
        <Suspense fallback="loading">
          <Page />
        </Suspense>
      </ErrorBoundary>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Part of the Portal did not load",
    );
    expect(screen.queryByText("crashed")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Load the page again" }),
    );
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps the crash panel for any other error", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Thrower error={new Error("boom")} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This page stopped");
    expect(screen.getByTestId("error-reference")).toBeInTheDocument();
  });

  it("leaves a message in index.html for when the entry script never runs", () => {
    const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
    expect(html).toMatch(
      /<div id="root">\s*<main id="boot-failed" role="alert">/,
    );
    expect(html).toContain('lang="sk"');
    expect(html).toContain("animation: boot-failed-show 0s 8s forwards");
    // The CSP allows no inline script; the fallback must work without one.
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});
