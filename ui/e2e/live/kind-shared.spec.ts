/**
 * T-1551 — UI-44, PF-50, EP-15: a SharedSpaceReference, end to end on dev by a person.
 *
 * A reference is declared, not authored: the "Shared with this project" section of the Endpoints
 * page lists what the other projects of the organization opened to this one, and "Use in this
 * project" proposes the reference in one click, checked before it is proposed. The page names the
 * reference after its source, so the journey reads the name from the row it clicked. It is
 * approved, answers on its route, and is removed again; the page offers no edit of a reference, so
 * this journey has no change step until T-2570 gives it one. The assistant is asked for one; a
 * viewer finds Use closed with the verb it lacks (T-2569).
 *
 * The journey needs one endpoint on dev that another project shares with this one and that this
 * one does not reference yet; when there is none it says so rather than passing.
 */
import { expect } from "@playwright/test";
import { PROJECT, kindJourney } from "./kindJourney";

const USE = "Use in this project";

/** The reference name the page gives `source/endpoint`: `dns1123` of `sharing.tsx`. */
function referenceName(source: string, endpoint: string): string {
  return `${source}-${endpoint}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
}

kindJourney({
  task: "t1551",
  kind: "SharedSpaceReference",
  plural: "shared",
  page: `/projects/${PROJECT}/endpoints`,
  create: async (page) => {
    const section = page.getByRole("region", { name: "Shared with this project" });
    await expect(section).toBeVisible({ timeout: 30_000 });
    const offers = section.getByRole("button", { name: new RegExp(`^${USE}: `) });
    await expect(
      offers.first(),
      "another project shares an endpoint with this one that it does not reference yet",
    ).toBeVisible({ timeout: 30_000 });
    let use = offers.first();
    for (const offer of await offers.all()) {
      if (await offer.isEnabled()) {
        use = offer;
        break;
      }
    }
    const label = (await use.getAttribute("aria-label")) ?? "";
    const [source, endpoint] = label.slice(`${USE}: `.length).split("/");
    expect(source && endpoint, `"${label}" names a source and its endpoint`).toBeTruthy();
    await use.click();
    return referenceName(source, endpoint);
  },
  assistant: {
    ask: (name) => `Create a SharedSpaceReference called ${name}`,
    opened: (page) => page.getByRole("region", { name: "Shared with this project" }),
  },
  writeControls: /^(New|Edit|Remove|Delete|Propose|Use in this project)(\b|$)/i,
});
