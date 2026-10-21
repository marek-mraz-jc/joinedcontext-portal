import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAdministers } from "../../api/permissions";
import { navLinkClass } from "../../components/layout/Shell";
import { Icon } from "../../components/ui";

/**
 * Administration's sections, grouped as an administrator looks for them (T-4831, owner
 * 2026-10-20): who has access, what the projects publish, what the installation runs, and the
 * organization's own settings. Every section has its own address, `/organization/{tab}`.
 */
export const ORGANIZATION_GROUPS = [
  { id: "access", tabs: ["people", "members", "roles", "groups", "service-accounts"] },
  {
    id: "projects",
    tabs: ["projects", "applications", "endpoints", "mcp-servers", "models", "blueprints", "agentprofiles"],
  },
  { id: "platform", tabs: ["brokers", "environments", "dataspaceparticipants", "health"] },
  { id: "settings", tabs: ["settings", "setup"] },
] as const;

export type OrganizationTab = (typeof ORGANIZATION_GROUPS)[number]["tabs"][number];

/**
 * The sections of `/organization/{tab}`, in the order of the side navigation's groups
 * (Architecture/09 §14.1, T-4831). Here, beside the groups, so the router knows a tab without
 * loading the Organization page itself.
 */
export const ORGANIZATION_TABS: readonly OrganizationTab[] = ORGANIZATION_GROUPS.flatMap((group) => group.tabs);

export function isOrganizationTab(value: string): value is OrganizationTab {
  return (ORGANIZATION_TABS as readonly string[]).includes(value);
}

/**
 * The sidebar of Administration (T-4831): a way back to the project the person came from, then
 * one list per group. It replaces the project navigation, so the switcher no longer suggests the
 * page belongs to a project. Somebody who does not administer the organization sees the way back
 * only: the sections are no links to them, and their pages refuse them anyway.
 */
export function AdminNav({
  project,
  active,
  onNavigate,
}: {
  /** The project the way back opens. */
  project: string;
  /** The section in hand; none on a person's or a group's own page. */
  active?: OrganizationTab;
  onNavigate: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { administers } = useAdministers();
  return (
    <>
      <Link
        to="/projects/$project/home"
        params={{ project }}
        onClick={onNavigate}
        className="focus-ring flex items-center gap-2 rounded-md px-2.5 py-1.5 text-body text-fg-muted hover:bg-surface-subtle hover:text-fg"
      >
        <Icon name="chevronLeft" className="size-4" />
        <span>{t("organization.nav.back")}</span>
      </Link>
      {administers
        ? ORGANIZATION_GROUPS.map((group) => (
            <div key={group.id} className="flex flex-col gap-1">
              <h2
                id={`admin-nav-${group.id}`}
                className="px-2.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"
              >
                {t(`organization.group.${group.id}`)}
              </h2>
              <ul aria-labelledby={`admin-nav-${group.id}`} className="flex flex-col gap-0.5">
                {group.tabs.map((tab) => (
                  <li key={tab}>
                    <Link
                      to="/organization/$tab"
                      params={{ tab }}
                      onClick={onNavigate}
                      aria-current={tab === active ? "page" : undefined}
                      className={navLinkClass(tab === active)}
                    >
                      <span className="truncate">{t(`organization.tab.${tab}`)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
    </>
  );
}
