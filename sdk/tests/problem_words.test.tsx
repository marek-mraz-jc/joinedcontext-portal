// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProblemError } from "../src/sdk/client";
import { Problem } from "../src/sdk/shell";
import { SDK_WORDS } from "../src/sdk/words";

afterEach(cleanup);

// T-4200: a problem whose title is a code reaches a visitor as a sentence, never as the code.
describe("Problem", () => {
  it("says a broker's ResourceNotFound as a sentence and drops its English detail", () => {
    render(<Problem error={new ProblemError(404, { type: "https://uri.etsi.org/ngsi-ld/errors/ResourceNotFound", title: "ResourceNotFound", detail: "the resource does not exist" })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(SDK_WORDS.en["problem.notFound"]);
    expect(alert.textContent).not.toContain("ResourceNotFound");
  });

  it("says a bare HTTP status as a sentence by status", () => {
    render(<Problem error={new ProblemError(403, {})} />);
    expect(screen.getByRole("alert").textContent).toBe(SDK_WORDS.en["problem.denied"]);
    cleanup();
    render(<Problem error={new ProblemError(502, "<html>bad gateway</html>")} />);
    expect(screen.getByRole("alert").textContent).toBe(SDK_WORDS.en["problem.failed"]);
  });

  it("keeps a title that already is a sentence, and its detail", () => {
    render(<Problem error={new ProblemError(409, { title: "Already changed", detail: "Someone saved this entity a moment ago." })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Already changed");
    expect(alert.textContent).toContain("Someone saved this entity a moment ago.");
  });

  it("has the three sentences in every language", () => {
    for (const words of Object.values(SDK_WORDS)) {
      for (const key of ["problem.notFound", "problem.denied", "problem.failed"] as const) expect(words[key]).toMatch(/\s/);
    }
  });
});
