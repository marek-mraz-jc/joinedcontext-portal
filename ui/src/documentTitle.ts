/**
 * The one writer of `document.title` (UI-15).
 *
 * Two things want to name the tab: the installation, which is its name, and the page, which is
 * where in the installation one is. They arrive at different moments — `applyBranding` runs
 * again whenever `/api/v1/branding` answers, a `PageHeader` mounts on every route — so whichever
 * ran last used to win, and a refetched branding left every tab reading "joinedcontext". Both
 * write here instead, and the title is composed from whatever is currently known.
 */

/** What the page is, from the page down to the thing it is inside: `["Access", "helsinki"]`. */
let page: string[] = [];
/** The installation's name, which ends every title and is the whole of it before a page names itself. */
let instance = "";

function write(doc: Document): void {
  const title = [...page, instance].filter((part) => part.length > 0).join(" · ");
  if (title.length > 0) {
    doc.title = title;
  }
}

/** Called by `applyBranding` when the installation's name is known or changes. */
export function setInstanceName(name: string, doc: Document = document): void {
  instance = name;
  write(doc);
}

/** Called by `PageHeader` on every page: the page's own name first, then what it sits in. */
export function setPageTitle(parts: (string | undefined)[], doc: Document = document): void {
  page = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  write(doc);
}

/** For tests: forget both, so one case cannot read the title another one left. */
export function resetDocumentTitle(): void {
  page = [];
  instance = "";
}
