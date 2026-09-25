import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useMatchRoute, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { AssistantDock } from "../../assistant/AssistantDock";
import { useAuth } from "../../auth/AuthProvider";
import { rememberProject, useProjects } from "../../api/projects";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys, unwrap } from "../../api/client";
import { approvalStanding } from "../../api/approval";
import { useAdministers, usePermissions } from "../../api/permissions";
import { logoUrl, useBranding } from "../../branding";
import {
  Alert,
  Button,
  buttonClass,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  safeHref,
} from "../ui";
import type { IconName } from "../ui";
import { NAV_SECTIONS, sameSection } from "./navigation";
import { ErrorBoundary } from "../ErrorBoundary";
import { NewProjectButton } from "./NewProject";
import { WorkspaceBar } from "./WorkspaceBar";

const NAV_LINK =
  "focus-ring-inset flex items-center gap-2.5 rounded-md px-2.5 py-2 text-body text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg";
const NAV_LINK_ACTIVE = "bg-primary-soft font-semibold text-primary-soft-fg hover:bg-primary-soft hover:text-primary-soft-fg";

/** Switches between the projects the repository holds; the active one is listed whatever the API says. */
function ProjectSelector({ active }: { active: string }) {
  const { t } = useTranslation();
  const known = useProjects().data ?? [];
  const projects = known.includes(active) ? known : [active, ...known];
  // The page in hand, so the switch keeps it: a person comparing two projects' endpoints stays
  // in Endpoints instead of walking back from Spaces every time (T-2425, UI-05).
  const here = useRouterState({ select: (state) => sameSection(state.location.pathname) });
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="secondary"
          size="lg"
          aria-label={t("nav.projects")}
          className="w-full justify-start gap-2.5 px-2.5 text-left"
        >
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-caption font-bold uppercase text-primary-fg">
            {active.slice(0, 2)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-semibold text-fg">{active}</span>
          </span>
          <Icon name="chevronDown" className="size-4 text-fg-subtle" />
        </Button>
      </MenuTrigger>
      {/* The trigger's own width, which Radix measures and publishes: a computed size, not one
          the spacing scale could name. */}
      <MenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
        <MenuLabel>{t("nav.projects")}</MenuLabel>
        {projects.map((project) => (
          <MenuItem key={project} asChild>
            <Link
              to="/projects/$project/$plural"
              params={{ project, plural: here.plural }}
              aria-current={project === active ? "true" : undefined}
            >
              {project === active ? <Icon name="check" className="size-4" /> : <span className="size-4" />}
              {project}
            </Link>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { identity, signOut } = useAuth();
  if (!identity) {
    return null;
  }
  const display = identity.name ?? identity.username;
  const initial = display.trim().charAt(0).toUpperCase();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={t("auth.signedInAs", { name: display })}
          className="gap-2 px-1.5"
        >
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary-soft text-caption font-bold text-primary-soft-fg">
            {initial}
          </span>
          <span className="hidden max-w-40 truncate text-body font-medium text-fg sm:block">
            {display}
          </span>
          <Icon name="chevronDown" className="hidden size-4 text-fg-subtle sm:block" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-52">
        <MenuLabel>
          <span className="block truncate text-body font-medium text-fg">{display}</span>
          {identity.name ? <span className="block truncate font-mono">{identity.username}</span> : null}
        </MenuLabel>
        <MenuSeparator />
        <MenuItem
          onSelect={() => {
            void signOut();
          }}
        >
          <Icon name="logout" className="size-4" />
          {t("auth.signOut")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * The signed-in person at the bottom of the sidebar, with sign-out beside them (UI-83).
 */
function ProfileBlock(): JSX.Element | null {
  const { t } = useTranslation();
  const { identity, signOut } = useAuth();
  if (!identity) {
    return null;
  }
  const display = identity.name ?? identity.username;
  return (
    <section
      aria-label={t("nav.profile")}
      className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3"
    >
      <div className="flex items-center gap-2 px-2 pb-1">
        <span
          aria-hidden="true"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-bold text-primary-soft-fg"
        >
          {display.trim().charAt(0).toUpperCase()}
        </span>
        {/* A name and a username are the person's own words, never a string to translate. */}
        <span className="min-w-0" translate="no">
          <span className="block truncate text-body font-medium text-fg">{display}</span>
          {identity.name ? (
            <span className="block truncate font-mono text-caption text-fg-muted">{identity.username}</span>
          ) : null}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void signOut();
        }}
        className="justify-start gap-2 px-2"
      >
        <NavLabel icon="logout" label={t("auth.signOut")} />
      </Button>
    </section>
  );
}

/** The instance name and its logo, which is what every page is titled with (UI-30). */
export function BrandMark({ short = false }: { short?: boolean }): JSX.Element {
  const branding = useBranding();
  const logo = logoUrl(branding);
  const name = short ? (branding.shortName ?? branding.instanceName) : branding.instanceName;
  return (
    <span className="inline-flex items-center gap-2.5">
      {logo ? (
        <img src={logo} alt="" aria-hidden="true" className="h-7 w-auto max-w-32 object-contain" />
      ) : (
        <span
          aria-hidden="true"
          className="inline-flex size-7 items-center justify-center rounded-md bg-primary text-caption font-bold text-primary-fg"
        >
          {name.trim().charAt(0).toUpperCase()}
        </span>
      )}
      <span className="font-heading font-semibold tracking-tight">{name}</span>
    </span>
  );
}

function navLinkClass(active: boolean): string {
  return clsx(NAV_LINK, active && NAV_LINK_ACTIVE);
}

function NavLabel({ icon, label }: { icon: IconName; label: string }) {
  return (
    <>
      <Icon name={icon} className="size-4.5" />
      <span className="truncate">{label}</span>
    </>
  );
}

/**
 * The changes waiting for this person's approval (T-1391): pending, not their own unless they
 * administer the kind, on a kind they may approve. The same list and key as the Approvals page,
 * polled every 30 s; a list the API refuses counts as none.
 */
function usePendingApprovals(project: string): number {
  const { identity } = useAuth();
  const permissions = usePermissions(project);
  const list = useQuery({
    queryKey: queryKeys.changes(project),
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/changes", { params: { path: { project } } })),
    refetchInterval: 30_000,
  });
  return (list.data?.items ?? []).filter(
    (change) =>
      change.status.phase === "PendingApproval" &&
      approvalStanding(permissions, identity?.email ?? undefined, change).block === null,
  ).length;
}

function PendingBadge({ project }: { project: string }) {
  const { t } = useTranslation();
  const count = usePendingApprovals(project);
  if (count === 0) return null;
  return (
    <span
      className="ml-auto rounded-full bg-danger px-1.5 text-caption font-semibold text-danger-fg"
      title={t("nav.approvalsPending", { count })}
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t("nav.approvalsPending", { count })}</span>
    </span>
  );
}

/**
 * What one page that threw leaves behind, inside the chrome rather than instead of it (T-2426).
 *
 * Not `PageFailed` from `components/ui`, which is the answer to a request that failed and offers
 * the retry that repeats it: this one is a render error, so it also carries the reference tying
 * it to the console line and the way to a page that still works.
 *
 * The router renders the shell and the page as one component, so before this an error anywhere
 * in a page replaced the header, the sidebar and the project switcher with a panel — and the
 * person had the browser's Back button and nothing else. The chrome stays; this sits where the
 * page was, says what happened, and offers the two things that help: draw this page again, or
 * go to the project's start. What threw is on the console and nowhere near the DOM (PF-50).
 */
function PageStopped({
  project,
  reference,
  retry,
}: {
  project: string;
  reference: string;
  retry: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Alert
      tone="danger"
      title={t("app.error.crashTitle")}
      actions={
        <>
          <Button variant="primary" size="sm" onClick={retry}>
            {t("app.error.retry")}
          </Button>
          <Link
            to="/projects/$project/$plural"
            params={{ project, plural: NAV_SECTIONS[0].plural }}
            className={buttonClass("secondary", "sm")}
          >
            {t("app.error.crashHome")}
          </Link>
        </>
      }
    >
      <p>{t("app.error.crashBody")}</p>
      <p className="mt-2 text-caption">
        {t("app.error.crashReference")}{" "}
        <code data-testid="error-reference" className="font-mono">
          {reference}
        </code>
      </p>
    </Alert>
  );
}

export function Shell({
  project,
  children,
}: {
  project: string;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  const branding = useBranding();
  const matchRoute = useMatchRoute();
  // The organization's tabs, every endpoint and `/` open on this project next (T-2753).
  useEffect(() => {
    rememberProject(project);
  }, [project]);
  // Which page is in hand, so a panel left by a page that threw is cleared by walking away
  // from it (T-2426).
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The sidebar is a drawer on a phone; a navigation closes it.
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // At phone width the navigation is a sheet over the page, and the scrim that closes it is
  // `aria-hidden` and pointer-only by design — a second control in the tab order named "close
  // the menu" beside the toggle that opened it would be a duplicate. Escape is the way out for
  // the keyboard, and the focus goes back to the toggle that opened it (UI-15).
  useEffect(() => {
    if (!navOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [navOpen]);

  // Approvals has its own routes, so the generic `$plural` match never fires for it.
  const approvalDetail = matchRoute({ to: "/projects/$project/approvals/$id" });
  const onApprovals = Boolean(approvalDetail || matchRoute({ to: "/projects/$project/approvals" }));
  // A copy's own pages (compare, bring back, try it) had no trail at all (T-2760): they sit under
  // Copies.
  const copyDetail =
    matchRoute({ to: "/projects/$project/workspaces/$name/compare" }) ||
    matchRoute({ to: "/projects/$project/workspaces/$name/bring-back" }) ||
    matchRoute({ to: "/projects/$project/workspaces/$name/try-it" });
  const detail = approvalDetail
    ? { to: "/projects/$project/approvals" as const, name: approvalDetail.id }
    : copyDetail
      ? { to: "/projects/$project/workspaces" as const, name: copyDetail.name }
      : null;
  const onAssistant = Boolean(
    matchRoute({ to: "/projects/$project/assistant", params: { project } }),
  );

  const allEndpointsActive = Boolean(matchRoute({ to: "/endpoints" }));
  const organizationActive = Boolean(matchRoute({ to: "/organization/$tab", fuzzy: true }));
  const { administers } = useAdministers();
  const modelsActive = Boolean(matchRoute({ to: "/projects/$project/models", params: { project } }));
  const exploreActive = Boolean(matchRoute({ to: "/projects/$project/explore", params: { project } }));
  const ckanActive = Boolean(matchRoute({ to: "/projects/$project/ckan", params: { project } }));
  const catalogueActive = Boolean(matchRoute({ to: "/catalogue", fuzzy: true }));
  const importActive = Boolean(matchRoute({ to: "/projects/$project/import", params: { project } }));

  // Project settings is one entry over six tab addresses (T-2606).
  const onSettings = Boolean(
    matchRoute({ to: "/projects/$project/settings/$tab", params: { project }, fuzzy: true }),
  );

  const activeSection = NAV_SECTIONS.find((section) =>
    section.plural === "approvals"
      ? onApprovals
      : section.plural === "workspaces" && copyDetail
        ? true
      : section.plural === "assistant"
        ? onAssistant
        : section.plural === "settings"
          ? onSettings
          : Boolean(
            matchRoute({
              to: "/projects/$project/$plural",
              params: { project, plural: section.plural },
            }),
          ),
  );

  return (
    <div className="flex min-h-screen flex-col bg-bg font-sans text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg"
      >
        {t("nav.skipToContent")}
      </a>

      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-4">
        <Button
          ref={menuButton}
          variant="ghost"
          size="sm"
          className="md:hidden"
          aria-label={t("nav.menu")}
          // An icon-only control says what it is to a pointer as well as to a screen reader
          // (T-1731): the glyph alone is a guess for everybody.
          title={t("nav.menu")}
          aria-expanded={navOpen}
          aria-controls="portal-sidebar"
          onClick={() => setNavOpen((open) => !open)}
          icon={<Icon name={navOpen ? "close" : "menu"} className="size-5" />}
        />
        <Link
          to="/projects/$project/$plural"
          params={{ project, plural: "spaces" }}
          className="focus-ring rounded-md text-body text-fg"
        >
          <BrandMark short />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          {/* Administration is one entry, for organization administrators only, and its page
              holds every organization-wide power as tabs, the whole-project export and import
              included (UI-75, UI-87, owner 2026-09-25). */}
          {administers ? (
            <Link
              to="/organization/$tab"
              params={{ tab: "settings" }}
              aria-label={t("nav.organization")}
              aria-current={organizationActive ? "page" : undefined}
              className={buttonClass("ghost", "sm")}
            >
              <Icon name="access" className="size-4" />
              <span aria-hidden="true" className="hidden sm:inline">
                {t("nav.organization")}
              </span>
            </Link>
          ) : null}
          <LanguageSwitcher />
          <UserMenu />
        </div>
      </header>

      <div className="flex flex-1">
        {navOpen ? (
          <div
            aria-hidden="true"
            onClick={closeNav}
            className="fixed inset-0 top-14 z-30 bg-overlay md:hidden"
          />
        ) : null}
        <nav
          id="portal-sidebar"
          aria-label={t("nav.main")}
          className={clsx(
            "z-40 w-sidebar shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface p-3",
            // The viewport minus the 14 (3.5rem) header: a computed height, so it stays inline.
            "md:sticky md:top-14 md:flex md:h-[calc(100vh-3.5rem)]",
            navOpen ? "fixed bottom-0 left-0 top-14 flex shadow-3" : "hidden",
          )}
        >
          <div className="flex flex-col gap-2">
            <ProjectSelector active={project} />
            {/* Opening a project is a setting of the organization, so the control is always
                here, disabled with the reason when this caller may not (UI-44, PF-65). */}
            <NewProjectButton project={project} />
          </div>
          <ul className="flex flex-col gap-0.5">
            {NAV_SECTIONS.map((section) => {
              const isActive = section === activeSection;
              const body = <NavLabel icon={section.icon} label={t(section.labelKey)} />;
              return (
                <li key={section.plural}>
                  {/* Approvals and Assistant have routes of their own; linking them through the generic
                      template would resolve to that route anyway, with a router warning. */}
                  {section.plural === "approvals" ? (
                    <Link
                      to="/projects/$project/approvals"
                      params={{ project }}
                      onClick={closeNav}
                      aria-current={isActive ? "page" : undefined}
                      className={navLinkClass(isActive)}
                    >
                      {body}
                      <PendingBadge project={project} />
                    </Link>
                  ) : section.plural === "assistant" ? (
                    <Link
                      to="/projects/$project/assistant"
                      params={{ project }}
                      onClick={closeNav}
                      aria-current={isActive ? "page" : undefined}
                      className={navLinkClass(isActive)}
                    >
                      {body}
                    </Link>
                  ) : (
                    <Link
                      to="/projects/$project/$plural"
                      params={{ project, plural: section.plural }}
                      onClick={closeNav}
                      aria-current={isActive ? "page" : undefined}
                      className={navLinkClass(isActive)}
                    >
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          {/* Not sections of the resource API: every endpoint across projects, the model editor
              that writes LinkML into the repository, the explorer and the CKAN view hang below
              the list. */}
          <ul className="flex flex-col gap-0.5 border-t border-border pt-3">
            <li>
              <Link
                to="/endpoints"
                onClick={closeNav}
                aria-current={allEndpointsActive ? "page" : undefined}
                className={navLinkClass(allEndpointsActive)}
              >
                <NavLabel icon="globe" label={t("nav.allEndpoints")} />
              </Link>
            </li>
            <li>
              <Link
                to="/projects/$project/models"
                params={{ project }}
                onClick={closeNav}
                aria-current={modelsActive ? "page" : undefined}
                className={navLinkClass(modelsActive)}
              >
                <NavLabel icon="models" label={t("nav.models")} />
              </Link>
            </li>
            <li>
              <Link
                to="/projects/$project/explore"
                params={{ project }}
                onClick={closeNav}
                aria-current={exploreActive ? "page" : undefined}
                className={navLinkClass(exploreActive)}
              >
                <NavLabel icon="explore" label={t("nav.explore")} />
              </Link>
            </li>
            <li>
              <Link
                to="/projects/$project/ckan"
                params={{ project }}
                onClick={closeNav}
                aria-current={ckanActive ? "page" : undefined}
                className={navLinkClass(ckanActive)}
              >
                <NavLabel icon="ckan" label={t("nav.ckan")} />
              </Link>
            </li>
            <li>
              <Link
                to="/catalogue"
                onClick={closeNav}
                aria-current={catalogueActive ? "page" : undefined}
                className={navLinkClass(catalogueActive)}
              >
                <NavLabel icon="search" label={t("nav.catalogue")} />
              </Link>
            </li>
            <li>
              <Link
                to="/projects/$project/import"
                params={{ project }}
                onClick={closeNav}
                aria-current={importActive ? "page" : undefined}
                className={navLinkClass(importActive)}
              >
                <NavLabel icon="import" label={t("nav.import")} />
              </Link>
            </li>
          </ul>
          {/* The signed-in person at the bottom (UI-83). The organization is one button in the
              header, and its page holds every part of it as tabs (owner, 2026-09-24). */}
          <ProfileBlock />
        </nav>
        <main id="main" className="min-w-0 flex-1">
          {/* `pb-24` keeps room under the page for the assistant's floating button (56 px at
              16 px from the corner): it sat on the last column of a table at 1440 with nothing
              below it to scroll to (T-2760). */}
          <div className="mx-auto flex max-w-content flex-col gap-section px-4 pb-24 pt-5 sm:px-gutter sm:pt-6">
            <nav aria-label={t("nav.breadcrumb")} className="text-caption text-fg-muted">
              <ol className="flex flex-wrap items-center gap-1">
                <li>
                  <Link
                    to="/projects/$project/$plural"
                    params={{ project, plural: "spaces" }}
                    className="focus-ring rounded-sm hover:text-fg hover:underline"
                  >
                    {project}
                  </Link>
                </li>
                {activeSection ? (
                  <li className="flex items-center gap-1">
                    <Icon name="chevronRight" className="size-3.5 text-fg-subtle" />
                    {detail ? (
                      <>
                        <Link
                          to={detail.to}
                          params={{ project }}
                          className="focus-ring rounded-sm hover:text-fg hover:underline"
                        >
                          {t(activeSection.labelKey)}
                        </Link>
                        <Icon name="chevronRight" className="size-3.5 text-fg-subtle" />
                        <span aria-current="page" className="font-mono font-medium text-fg">
                          {detail.name}
                        </span>
                      </>
                    ) : (
                      <span aria-current="page" className="font-medium text-fg">
                        {t(activeSection.labelKey)}
                      </span>
                    )}
                  </li>
                ) : null}
              </ol>
            </nav>
            <WorkspaceBar project={project} />
            {/* The page, and the panel that takes its place when it throws. `resetKey` is the
                path, so walking away from a failed page with the sidebar that is still there
                shows the next page rather than the panel again (T-2426). */}
            <ErrorBoundary
              resetKey={pathname}
              fallback={(reference, retry) => (
                <PageStopped project={project} reference={reference} retry={retry} />
              )}
            >
              {children}
            </ErrorBoundary>
          </div>
        </main>
        {/* The assistant is on the right of every page a run is remembered: a column beside
            the page, or a bubble at the bottom right when hidden (UI-45). */}
        <AssistantDock project={project} />
      </div>

      {branding.organisation || branding.contactEmail ? (
        <footer className="border-t border-border bg-surface px-4 py-3 text-caption text-fg-muted sm:px-gutter">
          {branding.organisation ? <span>{branding.organisation}</span> : null}
          {branding.organisation && branding.contactEmail ? (
            <span aria-hidden="true"> · </span>
          ) : null}
          {branding.contactEmail ? (
            <a
              href={safeHref(`mailto:${branding.contactEmail}`)}
              className="focus-ring rounded-sm underline hover:text-fg hover:no-underline"
            >
              {branding.contactEmail}
            </a>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}
