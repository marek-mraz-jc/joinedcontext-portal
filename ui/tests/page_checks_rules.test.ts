import { afterEach, describe, expect, it } from "vitest";
import { edgeRetryMs, pageFindings } from "./pageChecks";

// T-4950: the rules that make a page explain itself, each with a page that passes and one that fails.
const findings = (check: string) =>
  pageFindings({ namespaces: [], layout: false }).filter((finding) => finding.startsWith(`${check}:`));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the walkers' boot check", () => {
  it("names a Portal that never drew the page instead of judging index.html's fallback", () => {
    document.body.innerHTML = `<div id="root"><main id="boot-failed" role="alert">
      <p lang="en"><strong>The Portal did not load.</strong> Load the page again.</p></main></div>`;
    expect(pageFindings({ namespaces: [], layout: false })).toEqual([
      "boot: the Portal did not load, The Portal did not load. Load the page again.",
    ]);
  });
});

describe("the walkers' wait on the edge's 429", () => {
  it("waits the seconds Retry-After names, plus one, at most a minute", () => {
    expect(edgeRetryMs("8")).toBe(9_000);
    expect(edgeRetryMs("0")).toBe(1_000);
    expect(edgeRetryMs("3600")).toBe(61_000);
  });

  it("waits a third of the edge's window on no or a garbled header", () => {
    for (const header of [undefined, "", "soon", "-5", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) expect(edgeRetryMs(header)).toBe(20_000);
  });
});

describe("the walkers' purpose-line check", () => {
  it("passes a title with the line that says what the page manages", () => {
    document.body.innerHTML = `<main><h1>Spaces</h1><p>Where the project keeps its context data.</p></main>`;
    expect(findings("purpose-line")).toEqual([]);
  });

  it("flags a title with nothing under it", () => {
    document.body.innerHTML = `<main><h1>Spaces</h1><table></table></main>`;
    expect(findings("purpose-line")).toEqual(['purpose-line: no line under "Spaces"']);
  });
});

describe("the walkers' empty-state check", () => {
  it("passes an empty list that links to its next step", () => {
    document.body.innerHTML = `<main><div data-empty-state><p>No spaces yet.</p>
      <a href="/projects/helsinki/spaces/new">Create the first space</a></div></main>`;
    expect(findings("empty-state-next-step")).toEqual([]);
  });

  it("flags an empty list that only says it is empty", () => {
    document.body.innerHTML = `<main><div data-empty-state><p>No spaces yet.</p></div></main>`;
    expect(findings("empty-state-next-step")).toEqual(["empty-state-next-step: No spaces yet."]);
  });
});

describe("the walkers' error-text check", () => {
  it("passes a refused field whose message says what to change", () => {
    document.body.innerHTML = `<main><form><label for="n">Name</label>
      <input id="n" aria-invalid="true" aria-describedby="n__error">
      <div id="n__error" role="alert"><ul><li>Use lowercase letters, digits and dashes, like air-quality.</li></ul></div>
      </form></main>`;
    expect(findings("error-text")).toEqual([]);
  });

  it("flags a refused field with a bare word or no message at all", () => {
    document.body.innerHTML = `<main><form><label for="n">Name</label>
      <input id="n" aria-invalid="true" aria-describedby="n__error"><div id="n__error" role="alert">Invalid</div>
      <label for="u">Address</label><input id="u" aria-invalid="true"></form></main>`;
    expect(findings("error-text")).toEqual([
      'error-text: Name: "Invalid" does not say what to change',
      "error-text: Address: marked invalid with no message",
    ]);
  });

  it("flags a form refusal that only says it failed and passes one that names the field", () => {
    document.body.innerHTML = `<main><form><p role="alert">Request failed</p></form>
      <form><p role="alert">The space name air is taken: choose another name.</p></form></main>`;
    expect(findings("error-text")).toEqual(['error-text: the form says only "Request failed"']);
  });
});
