import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys, unwrap } from "./client";
import { asManifests, localized } from "./manifest";
import { useTranslation } from "react-i18next";
import { offeredLocales, useBranding } from "../branding";

/** The projects the configuration repository holds, as `GET /api/v1/projects` lists them (PF-05). */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects")),
    select: (list) => list.items.map((item) => item.name),
  });
}

/**
 * The Organizations the person sees, when they see more than one, and the Organization of each
 * project they read (PF-124, ADR-N-058 section 2.7). The server lists only Organizations owning a
 * project the person reads. Same request as [`useProjects`].
 */
export function useOrganizations() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects")),
    select: (list) => ({
      organizations: list.organizations ?? [],
      ownerOf: new Map(list.items.map((item) => [item.name, item.organization])),
    }),
  });
}

/**
 * The sample projects among those the person may read (PF-109): real open data to look around in,
 * marked by the `joinedcontext.com/sample` label on their Project manifest. Same request as
 * [`useProjects`], so it costs nothing more.
 */
export function useSampleProjects() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects")),
    select: (list) => list.items.filter((item) => item.sample).map((item) => item.name),
  });
}

/**
 * The title a person reads for each project, in the page's language, the slug where its Project
 * manifest names none (T-4243). Same request as [`useProjects`].
 */
export function useProjectTitles(): (project: string) => string {
  const { i18n } = useTranslation();
  const titles = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => unwrap(await api.GET("/api/v1/projects")),
    select: (list) => new Map(list.items.map((item) => [item.name, item.title])),
  }).data;
  return (project) => localized(titles?.get(project), i18n.language, project);
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

/**
 * The languages a model's titles are written in (T-4829, DM-15): the Organization's `locales`,
 * else what the installation offers. Same query as `useOrgDomain`, so no second request.
 */
export function useOrgLocales(project: string): string[] {
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
  const locales = (first?.spec as { locales?: unknown } | undefined)?.locales;
  // One string, so the list keeps its identity while the answer stands still.
  const own = Array.isArray(locales)
    ? locales.filter((one): one is string => typeof one === "string" && /^[a-z]{2,3}$/.test(one)).join(",")
    : "";
  return useMemo(() => (own !== "" ? own.split(",") : offeredLocales(branding)), [own, branding]);
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

/** The project last worked in, whether or not the list of projects has come back (T-4165). */
export function lastProject(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_PROJECT) ?? undefined;
  } catch {
    return undefined;
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
  const last = lastProject();
  return last !== undefined && projects.includes(last) ? last : projects[0];
}
