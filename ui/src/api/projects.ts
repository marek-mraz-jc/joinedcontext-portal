import { useQuery } from "@tanstack/react-query";
import { api, queryKeys, unwrap } from "./client";
import { asManifests } from "./manifest";
import { useBranding } from "../branding";

/** The projects the configuration repository holds, as `GET /api/v1/projects` lists them (PF-05). */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects")),
    select: (list) => list.items.map((item) => item.name),
  });
}

/**
 * The organization's domain, in the order the API itself resolves it (`api::assistant::org_domain`):
 * the `Organization` manifest of the repository, then the installation's branding, then the
 * project name. A model minted under a fabricated `<project>.sk` names IRIs nobody owns (T-0794).
 */
export function useOrgDomain(project: string): string {
  const branding = useBranding();
  const organizations = useQuery({
    queryKey: queryKeys.list(project, "organizations"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "organizations" } },
        }),
      ),
  });
  const first = asManifests(organizations.data?.items ?? [])[0];
  const domain = (first?.spec as { domain?: string } | undefined)?.domain;
  return domain || branding.orgDomain || project;
}

/** Where the last project a person worked in is remembered, in this browser only (T-2753). */
const LAST_PROJECT = "jc.lastProject";

/**
 * Remember the project a page was drawn for, so a page that belongs to no project (the
 * organization's tabs, every endpoint, `/`) opens on it instead of on the first project in the
 * list. Storage that is blocked or full costs the preference, never the page.
 */
export function rememberProject(project: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT, project);
  } catch {
    // A private window or a blocked store: the first project is the fallback.
  }
}

/**
 * The project a page that belongs to none opens on: the one last worked in while the person may
 * still read it, else the first they may read (T-2753).
 */
export function preferredProject(projects: readonly string[] | undefined): string | undefined {
  if (!projects || projects.length === 0) {
    return undefined;
  }
  let last: string | null = null;
  try {
    last = window.localStorage.getItem(LAST_PROJECT);
  } catch {
    last = null;
  }
  return last !== null && projects.includes(last) ? last : projects[0];
}
