// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/home/home.ts,
// the first-run steps and the role cards of the project home (T-3233, T-3235).
import { describe, expect, it } from "vitest";
import { cardsFor, draftPage, firstRunSteps, roleOf } from "../src/pages/home/home";
import type { Effective } from "../src/api/permissions";

const grants = (...verbs: string[]): Effective =>
  ({ project: "helsinki", grants: [{ rule: { kinds: ["Pipeline"], verbs } }] }) as unknown as Effective;

describe("the first-run steps (T-3233)", () => {
  it("tick themselves from what the project holds, never from a click", () => {
    const empty = firstRunSteps("helsinki", { spaces: [], datasources: 0, pipelinePhases: [], endpoints: 0 });
    expect(empty.map((step) => step.done)).toEqual([false, false, false, false, false]);
    expect(empty.map((step) => step.to)).toEqual([
      "/projects/helsinki/spaces/new",
      "/projects/helsinki/datasources/new",
      "/projects/helsinki/pipelines",
      "/projects/helsinki/spaces",
      "/projects/helsinki/endpoints/new",
    ]);
    const half = firstRunSteps("helsinki", { spaces: ["air"], datasources: 1, pipelinePhases: ["deploying", "error"], endpoints: 0 });
    expect(half.map((step) => step.done)).toEqual([true, true, false, false, false]);
    expect(half[3].to).toBe("/projects/helsinki/spaces/air");
    const all = firstRunSteps("helsinki", { spaces: ["air", "bikes"], datasources: 2, pipelinePhases: ["live"], endpoints: 1, spaceWithData: "bikes" });
    expect(all.every((step) => step.done)).toBe(true);
    expect(all[3].to).toBe("/projects/helsinki/spaces/bikes");
  });
});

describe("the role and its cards (T-3235)", () => {
  it("reads the role from what the grants let the person do", () => {
    expect(roleOf(undefined)).toBeUndefined();
    expect(roleOf(grants("read"))).toBe("viewer");
    expect(roleOf(grants("read", "propose"))).toBe("editor");
    expect(roleOf(grants("propose", "approve"))).toBe("steward");
    expect(roleOf({ bootstrap: true, grants: [] } as unknown as Effective)).toBe("steward");
  });

  it("shows each role what it acts on, one click away, and no card that would say zero", () => {
    expect(cardsFor("helsinki", "steward", { approvalsWaiting: 2, failingPipelines: 0, invitesPending: 1 })).toEqual([
      { key: "approvals", count: 2, to: "/projects/helsinki/approvals" },
      { key: "invites", count: 1, to: "/organization/people" },
    ]);
    expect(cardsFor("helsinki", "editor", { drafts: { count: 3, to: "/x" }, failingPipelines: 1 }).map((card) => card.key)).toEqual(["drafts", "failing"]);
    expect(cardsFor("helsinki", "viewer", { spaceWithData: "air", dashboards: ["overview"] })).toEqual([
      { key: "data", count: 1, to: "/projects/helsinki/spaces/air" },
      { key: "dashboards", count: 1, to: "/projects/helsinki/dashboards/overview" },
    ]);
    expect(cardsFor("helsinki", "viewer", {})).toEqual([]);
  });

  it("resumes a draft on its kind's page, and names no page for a kind without one", () => {
    expect(draftPage("helsinki", "Pipeline", "air feed")).toBe("/projects/helsinki/pipelines?draft=air%20feed");
    expect(draftPage("helsinki", "Role", "x")).toBeUndefined();
  });
});
