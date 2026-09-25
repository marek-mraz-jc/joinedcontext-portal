import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Navigate,
  notFound,
  Outlet,
  redirect,
  useChildMatches,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { preferredProject, useProjects } from "./api/projects";
import { BrandMark, Shell } from "./components/layout/Shell";
import { EmptyState, PageFailed } from "./components/ui";
import { ErrorPage, errorReference } from "./components/ErrorBoundary";
import { NotFoundState } from "./components/NotFoundState";
import { AllEndpointsPage } from "./routes/AllEndpointsPage";
import { LoginPage } from "./routes/LoginPage";
import { ResourceListPage } from "./routes/ResourceListPage";
import { FormRouteHost } from "./components/forms/FormRoute";
import type { FormTarget } from "./components/forms/FormRoute";
import { ActivityPage } from "./routes/ActivityPage";
import { ApprovalsPage } from "./routes/ApprovalsPage";
import { ApprovalDetailPage } from "./routes/ApprovalDetailPage";
import { ModelsPage } from "./pages/models/ModelsPage";
import { ModelsList } from "./pages/models/ModelsList";
import { ModelPage } from "./pages/models/ModelPage";
import { ExplorePage } from "./pages/explore/ExplorePage";
import { CkanPage } from "./pages/ckan/CkanPage";
import { ImportPage } from "./pages/import/ImportPage";
import { SpaceInside } from "./pages/spaces/SpaceInside";
import { AppPage } from "./pages/apps/AppPage";
import { GroupPage } from "./pages/access/GroupPage";
import { PersonPage } from "./pages/organization/People";
import { EndpointPage } from "./pages/endpoints/EndpointPage";
import { AssistantPage } from "./pages/assistant/AssistantPage";
import { HandOff } from "./assistant/HandOff";
import { hasPrefill } from "./assistant/state";
import { DraftElsewhere } from "./assistant/DraftElsewhere";
import { WorkspaceProvider } from "./components/layout/WorkspaceContext";
import { WorkspacesPage } from "./routes/WorkspacesPage";
import { ComparePage } from "./pages/workspaces/ComparePage";
import { BringBackPage } from "./pages/workspaces/BringBackPage";
import { TryItPage } from "./pages/workspaces/TryItPage";
import { Gallery } from "./pages/gallery/Gallery";
import { ORG_NAMESPACE } from "./api/manifest";
import { isOrganizationTab, OrganizationPage } from "./pages/organization/OrganizationPage";
import type { OrganizationTab } from "./pages/organization/OrganizationPage";
import { isProjectSettingsTab, ProjectSettingsPage } from "./pages/projectSettings/ProjectSettingsPage";
import type { ProjectSettingsTab } from "./pages/projectSettings/ProjectSettingsPage";
import type { AuthState } from "./auth/AuthProvider";

export interface RouterContext {
  auth: AuthState;
}

/** The page around anything the Portal shows with no project to hang a shell on. */
function Bare({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-bg font-sans text-fg">
      <header className="flex h-14 items-center border-b border-border bg-surface px-4">
        <BrandMark short />
      </header>
      <main id="main" className="flex flex-1 items-center justify-center p-6">{children}</main>
    </div>
  );
}

/**
 * What a route without a `$project` shows while the project list is on its way, when the read
 * fails, and when the repository holds none (PF-05).
 *
 * The three were two: a list that came back 403, or did not come back at all, is not a pending
 * list, so it fell through to "the repository holds no project" — the Portal telling somebody
 * whose token had expired that their organisation's work was gone. A failed read says what the
 * API said and offers the one thing that can help (UI-15).
 */
function NoProject({
  projects,
}: {
  projects: Pick<ReturnType<typeof useProjects>, "isPending" | "isError" | "error" | "refetch">;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (projects.isPending) {
    return (
      <Bare>
        <p role="status" className="text-body text-fg-muted">
          {t("projects.loading")}
        </p>
      </Bare>
    );
  }
  if (projects.isError) {
    return (
      <Bare>
        <div className="w-full max-w-lg">
          <PageFailed
            error={projects.error}
            onRetry={() => {
              void projects.refetch();
            }}
          />
        </div>
      </Bare>
    );
  }
  return (
    <Bare>
      <EmptyState
        icon="spaces"
        title={t("projects.empty.title")}
        description={t("projects.empty.description")}
      />
    </Bare>
  );
}

/**
 * An address the Portal has no page for (UI-15).
 *
 * Without this the router falls back to its own built-in "Not Found" — two untranslated words
 * on a white page, outside the Portal's chrome, with no way back — which is what a mistyped or
 * an outdated link led to.
 */
function NotFound(): React.JSX.Element {
  return (
    <Bare>
      <NotFoundState />
    </Bare>
  );
}

/** The shell around a page that belongs to no single project: it opens on the one last worked in (T-2753). */
function AnyProjectShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const projects = useProjects();
  const first = preferredProject(projects.data);
  if (!first) {
    return <NoProject projects={projects} />;
  }
  return <Shell project={first}>{children}</Shell>;
}

/** `/` goes to the spaces of the project last worked in, else the first visible one (T-2753). */
function IndexRedirect(): React.JSX.Element {
  const projects = useProjects();
  const first = preferredProject(projects.data);
  if (!first) {
    return <NoProject projects={projects} />;
  }
  return <Navigate to="/projects/$project/$plural" params={{ project: first, plural: "spaces" }} />;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/** Everything below this route needs a live session (CC-42, defence in depth). */
const protectedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "protected",
  beforeLoad: ({ context, location }) => {
    if (context.auth.status === "anonymous") {
      throw redirect({ to: "/login", search: { redirect_to: location.href } });
    }
  },
  // `?workspace=` on any page reads and writes that copy (UI-61, CC-76): declared here, so every
  // page below carries it in its search type and a link into a copy needs no cast (T-1488).
  validateSearch: (search: Record<string, unknown>): { workspace?: string } => ({
    workspace:
      typeof search.workspace === "string" && search.workspace !== "" ? search.workspace : undefined,
  }),
  component: function ProtectedRoute() {
    return (
      <WorkspaceProvider>
        <Outlet />
      </WorkspaceProvider>
    );
  },
});

const workspacesRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/workspaces",
  component: function WorkspacesRoute() {
    const { project } = workspacesRoute.useParams();
    return (
      <Shell project={project}>
        <WorkspacesPage project={project} />
      </Shell>
    );
  },
});

/** The "Work on a copy" dialog over the list, so the address a "new" link takes works (T-2749). */
const workspacesNewRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/workspaces/new",
  component: function WorkspacesNewRoute() {
    const { project } = workspacesNewRoute.useParams();
    return (
      <Shell project={project}>
        <WorkspacesPage project={project} creating />
      </Shell>
    );
  },
});

const workspaceCompareRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/workspaces/$name/compare",
  component: function WorkspaceCompareRoute() {
    const { project, name } = workspaceCompareRoute.useParams();
    return (
      <Shell project={project}>
        <ComparePage project={project} name={name} />
      </Shell>
    );
  },
});

const workspaceTryItRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/workspaces/$name/try-it",
  component: function WorkspaceTryItRoute() {
    const { project, name } = workspaceTryItRoute.useParams();
    return (
      <Shell project={project}>
        <TryItPage project={project} name={name} />
      </Shell>
    );
  },
});

const workspaceBringBackRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/workspaces/$name/bring-back",
  component: function WorkspaceBringBackRoute() {
    const { project, name } = workspaceBringBackRoute.useParams();
    return (
      <Shell project={project}>
        <BringBackPage project={project} name={name} />
      </Shell>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/",
  component: IndexRedirect,
});

const activityRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/activity",
  component: function ActivityRoute() {
    const { project } = activityRoute.useParams();
    return (
      <Shell project={project}>
        <ActivityPage project={project} />
      </Shell>
    );
  },
});

const approvalsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/approvals",
  component: function ApprovalsRoute() {
    const { project } = approvalsRoute.useParams();
    return (
      <Shell project={project}>
        <ApprovalsPage project={project} />
      </Shell>
    );
  },
});

const approvalDetailRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/approvals/$id",
  component: function ApprovalDetailRoute() {
    const { project, id } = approvalDetailRoute.useParams();
    return (
      <Shell project={project}>
        <ApprovalDetailPage project={project} id={id} />
      </Shell>
    );
  },
});

/** The federation playground is gone (UI-28): an old link lands on the project home. */
const playgroundRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/playground",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

/** Every endpoint of every project in one table (EP-08, EP-44). */
const allEndpointsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/endpoints",
  component: function AllEndpointsRoute() {
    return (
      <AnyProjectShell>
        <AllEndpointsPage />
      </AnyProjectShell>
    );
  },
});

/**
 * Project → Access is folded into Project settings (T-2606, Architecture/09 §14.3): a saved link,
 * a chat message or an older assistant answer lands on Members with its query string, so a
 * `?grant=` hand-off still opens its form.
 */
const accessRedirectRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/access",
  beforeLoad: ({ params, location }) => {
    throw redirect({
      href: `/projects/${encodeURIComponent(params.project)}/settings/members${location.searchStr}`,
      replace: true,
    });
  },
});

/** Project settings opens on General. */
const projectSettingsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/settings",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/projects/$project/settings/$tab", params: { project: params.project, tab: "general" } });
  },
});

/** The kind a tab of Project settings creates and edits through its routed form (T-2474). */
const SETTINGS_FORMS: Partial<Record<ProjectSettingsTab, string>> = {
  members: "rolebindings",
  roles: "roles",
  "service-accounts": "serviceaccounts",
};

function ProjectSettingsView({
  project,
  tab,
  form,
}: {
  project: string;
  tab: string;
  form: FormTarget | null;
}): React.JSX.Element {
  if (!isProjectSettingsTab(tab)) {
    return <NotFound />;
  }
  return (
    <Shell project={project}>
      <HandOff>
        <FormRouteHost
          project={project}
          plural={SETTINGS_FORMS[tab] ?? tab}
          base={`/projects/${encodeURIComponent(project)}/settings/${tab}`}
          form={form}
        >
          <ProjectSettingsPage project={project} tab={tab} />
        </FormRouteHost>
      </HandOff>
    </Shell>
  );
}

/** Project settings, one tab per address (T-2606, UI-76). */
const projectSettingsTabRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/settings/$tab",
  component: function ProjectSettingsTabRoute() {
    const { project, tab } = projectSettingsTabRoute.useParams();
    return <ProjectSettingsView project={project} tab={tab} form={null} />;
  },
});

/** A tab's form as a page of its own: `…/new`, `…/{name}/edit` (T-2474, UI-27). */
const projectSettingsFormRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/settings/$tab/$",
  component: function ProjectSettingsFormRoute() {
    const { project, tab, _splat: rest = "" } = projectSettingsFormRoute.useParams();
    // The splat matches an empty rest too, and the router may pick it for the tab's own address.
    const form = formOfRest(rest);
    return rest === "" || form !== null ? (
      <ProjectSettingsView project={project} tab={tab} form={form} />
    ) : (
      <NotFound />
    );
  },
});

/** `/organization` opens on its first tab (Architecture/09 §14.1). */
const organizationRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/organization",
  beforeLoad: () => {
    throw redirect({ to: "/organization/$tab", params: { tab: "settings" } });
  },
});

/** The kind a tab of the Organization page creates and edits through its routed form (T-2474). */
const ORGANIZATION_FORMS: Partial<Record<OrganizationTab, string>> = {
  members: "rolebindings",
  roles: "roles",
  groups: "groups",
  "service-accounts": "serviceaccounts",
};

function OrganizationView({ tab, form }: { tab: string; form: FormTarget | null }): React.JSX.Element {
  const projects = useProjects();
  if (!isOrganizationTab(tab)) {
    return <NotFound />;
  }
  const first = preferredProject(projects.data);
  if (!first) {
    return <NoProject projects={projects} />;
  }
  return (
    <Shell project={first}>
      <HandOff>
        <FormRouteHost
          project={ORG_NAMESPACE}
          plural={ORGANIZATION_FORMS[tab] ?? tab}
          base={`/organization/${tab}`}
          form={form}
        >
          <OrganizationPage tab={tab} anchor={first} />
        </FormRouteHost>
      </HandOff>
    </Shell>
  );
}

/** The Organization page, one tab per address (T-2605, UI-75): outside any project. */
const organizationTabRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/organization/$tab",
  component: function OrganizationTabRoute() {
    const { tab } = organizationTabRoute.useParams();
    return <OrganizationView tab={tab} form={null} />;
  },
});

/** A tab's form as a page of its own: `…/new`, `…/{name}/edit` (T-2474, UI-27). */
const organizationFormRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/organization/$tab/$",
  component: function OrganizationFormRoute() {
    const { tab, _splat: rest = "" } = organizationFormRoute.useParams();
    const group = tab === "groups" ? groupOfRest(rest) : null;
    if (group !== null) {
      return <OrganizationGroupView name={group} />;
    }
    const person = tab === "people" ? groupOfRest(rest) : null;
    if (person !== null) {
      return <OrganizationPersonView id={person} />;
    }
    const form = formOfRest(rest);
    return rest === "" || form !== null ? <OrganizationView tab={tab} form={form} /> : <NotFound />;
  },
});

/** `groups/{name}`: one group's page (PF-95); `new` stays the new-group form. */
function groupOfRest(rest: string): string | null {
  const [first, second] = rest.split("/");
  return first && first !== "new" && second === undefined ? decodeURIComponent(first) : null;
}

/** A group's page in the Organization's shell (PF-95, T-2685). */
function OrganizationGroupView({ name }: { name: string }): React.JSX.Element {
  const projects = useProjects();
  const first = preferredProject(projects.data);
  if (!first) {
    return <NoProject projects={projects} />;
  }
  return (
    <Shell project={first}>
      <GroupPage name={name} />
    </Shell>
  );
}

/** A person's page in the Organization's shell (PF-93, T-2684); `new` stays the new-person form. */
function OrganizationPersonView({ id }: { id: string }): React.JSX.Element {
  const projects = useProjects();
  const first = preferredProject(projects.data);
  if (!first) {
    return <NoProject projects={projects} />;
  }
  return (
    <Shell project={first}>
      <PersonPage id={id} />
    </Shell>
  );
}

/** `new` or `{name}/edit` after a tab's address; anything else names no form. */
function formOfRest(rest: string): FormTarget | null {
  const [first, second, third] = rest.split("/");
  if (first === "new" && second === undefined) return { mode: "new" };
  if (first && second === "edit" && third === undefined) return { mode: "edit", name: decodeURIComponent(first) };
  return null;
}

/**
 * The Data models page (T-2765): the list of the project's models, or the editor when the address
 * asks for one — `?edit=<name>` (AG-77), `?draft=<name>` (AG-61), `?new=blank|file|sdm` with an
 * optional `&space=` — or when a file or the assistant handed the page a draft to open.
 */
const modelsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/models",
  validateSearch: (
    search: Record<string, unknown>,
  ): { edit?: string; draft?: string; new?: "blank" | "file" | "sdm"; space?: string } => ({
    edit: typeof search.edit === "string" && search.edit !== "" ? search.edit : undefined,
    draft: typeof search.draft === "string" && search.draft !== "" ? search.draft : undefined,
    new: search.new === "blank" || search.new === "file" || search.new === "sdm" ? search.new : undefined,
    space: typeof search.space === "string" && search.space !== "" ? search.space : undefined,
  }),
  component: function ModelsRoute() {
    const { project } = modelsRoute.useParams();
    const search = modelsRoute.useSearch();
    const editing =
      search.edit !== undefined ||
      search.draft !== undefined ||
      search.new !== undefined ||
      hasPrefill(`/projects/${project}/models`);
    return (
      <Shell project={project}>
        <HandOff>
          <DraftElsewhere project={project} page="models" />
          {editing ? (
            <ModelsPage key={`${search.edit ?? ""}-${search.new ?? ""}`} project={project} />
          ) : (
            <ModelsList project={project} />
          )}
        </HandOff>
      </Shell>
    );
  },
});

/** One model's own page: its diagram, form, YAML, users, history and Mappings (T-2765). */
const modelRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/models/$name",
  component: function ModelRoute() {
    const { project, name } = modelRoute.useParams();
    return (
      <Shell project={project}>
        <ModelPage project={project} name={name} />
      </Shell>
    );
  },
});

const exploreRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/explore",
  // The assistant opens the explorer on what it found (UI-46): a space and an endpoint by name,
  // and one entity of them by id (T-1017), so "show me this one" opens the row already selected
  // instead of the list the person then searches by hand. `type` and `q` open the grid already
  // narrowed by the question that was asked (UI-64, UI-67, T-1437).
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    space?: string;
    endpoint?: string;
    entityId?: string;
    type?: string;
    q?: string;
  } => ({
    space: typeof search.space === "string" ? search.space : undefined,
    endpoint: typeof search.endpoint === "string" ? search.endpoint : undefined,
    entityId: typeof search.entityId === "string" ? search.entityId : undefined,
    type: typeof search.type === "string" ? search.type : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  component: function ExploreRoute() {
    const { project } = exploreRoute.useParams();
    const { space, endpoint, entityId, type, q } = exploreRoute.useSearch();
    return (
      <Shell project={project}>
        {/*
          The page reads the space and the endpoint only as it mounts, so a second hand-off to
          a card of the same page needs the mount HandOff gives it (T-0793, UI-46).
        */}
        <HandOff>
          <ExplorePage
            project={project}
            initialSpace={space}
            initialEndpoint={endpoint}
            initialEntityId={entityId}
            initialType={type}
            initialQ={q}
          />
        </HandOff>
      </Shell>
    );
  },
});

const ckanRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/ckan",
  component: function CkanRoute() {
    const { project } = ckanRoute.useParams();
    return (
      <Shell project={project}>
        <CkanPage project={project} />
      </Shell>
    );
  },
});

/** Reading a bundle another instance exported into this project (MF-20…MF-24, T-0217). */
const importRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/import",
  component: function ImportRoute() {
    const { project } = importRoute.useParams();
    return (
      <Shell project={project}>
        <ImportPage project={project} />
      </Shell>
    );
  },
});

/** The Federation page is gone (UI-28): an old link lands on the project's context spaces. */
const federationRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/federation",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$project/$plural",
      params: { project: params.project, plural: "spaces" },
    });
  },
});

import { SpaceComplete } from "./pages/spaces/SpaceComplete";

/** Space Complete route (static, so `/spaces/complete` is never read as a space called "complete"). */
const spaceCompleteRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/spaces/complete",
  component: function SpaceCompleteRoute() {
    const { project } = spaceCompleteRoute.useParams();
    return (
      <Shell project={project}>
        <HandOff>
          <SpaceComplete project={project} />
        </HandOff>
      </Shell>
    );
  },
});

/** The assistant workbench (UI-54). */
const assistantRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/assistant",
  component: function AssistantRoute() {
    const { project } = assistantRoute.useParams();
    return (
      <Shell project={project}>
        <AssistantPage project={project} />
      </Shell>
    );
  },
});

// The shared references had a page of their own; they live in the Endpoints page's
// "Shared with this project" section now. The old URL still lands there, so a bookmark and the
// assistant's `navigate` are not broken (T-0706, EP-15).
const sharedRedirectRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/shared",
  component: function SharedRedirectRoute() {
    const { project } = sharedRedirectRoute.useParams();
    return (
      <Navigate
        replace
        to="/projects/$project/$plural"
        params={{ project, plural: "endpoints" }}
        hash="shared-with-project"
      />
    );
  },
});

/** A resource's own page, for the kinds that have one (UI-01, T-2281, AP-68). */
const DETAIL_PAGES = new Set(["spaces", "endpoints", "apps"]);

/**
 * One section of a project: its list, one of its forms as a page of its own (T-2474, UI-27), or
 * one resource's page. The list and its forms are one mounted page whichever the address names,
 * so leaving a form returns to the list as it was left, with the Change a proposal opened.
 */
const sectionRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/$plural",
  // `?edit=<name>` opens the kind's own editor on that resource (T-2281): the assistant's hand-off
  // and older links; the endpoint's settings page links the edit address itself.
  // `?draft=<name>` opens the kind's form on that draft (AG-61, AG-73).
  validateSearch: (search: Record<string, unknown>): { edit?: string; draft?: string } => ({
    edit: typeof search.edit === "string" && search.edit !== "" ? search.edit : undefined,
    draft: typeof search.draft === "string" && search.draft !== "" ? search.draft : undefined,
  }),
  component: function SectionRoute() {
    const { project, plural } = sectionRoute.useParams();
    const { edit } = sectionRoute.useSearch();
    const child = useChildMatches({
      select: (matches) => {
        const first = matches[0];
        return first
          ? { routeId: first.routeId as string, name: (first.params as { name?: string }).name }
          : null;
      },
    });
    if (child?.routeId === sectionDetailRoute.id && child.name !== undefined) {
      return <DetailPage project={project} plural={plural} name={child.name} />;
    }
    const form: FormTarget | null =
      child?.routeId === sectionNewRoute.id
        ? { mode: "new" }
        : child?.routeId === sectionEditRoute.id && child.name !== undefined
          ? { mode: "edit", name: child.name }
          : null;
    return (
      <Shell project={project}>
        <HandOff>
          <DraftElsewhere project={project} page={plural} />
          <FormRouteHost project={project} plural={plural} form={form}>
            <ResourceListPage
              project={project}
              plural={plural}
              edit={form?.mode === "edit" ? form.name : edit}
            />
          </FormRouteHost>
        </HandOff>
      </Shell>
    );
  },
});

function DetailPage({
  project,
  plural,
  name,
}: {
  project: string;
  plural: string;
  name: string;
}): React.JSX.Element {
  return (
    <Shell project={project}>
      {plural === "spaces" ? (
        <SpaceInside project={project} name={name} />
      ) : plural === "endpoints" ? (
        <EndpointPage project={project} name={name} />
      ) : (
        <AppPage project={project} name={name} />
      )}
    </Shell>
  );
}

/** Rendered by the section: the children only name which of its views the address asks for. */
function Nothing(): null {
  return null;
}

const sectionIndexRoute = createRoute({
  getParentRoute: () => sectionRoute,
  path: "/",
  component: Nothing,
});

/** A kind's create form, at `/projects/{project}/{plural}/new` (T-2474). */
const sectionNewRoute = createRoute({
  getParentRoute: () => sectionRoute,
  path: "new",
  component: Nothing,
});

/** One resource's edit form, at `/projects/{project}/{plural}/{name}/edit` (T-2474). */
const sectionEditRoute = createRoute({
  getParentRoute: () => sectionRoute,
  path: "$name/edit",
  component: Nothing,
});

/**
 * What one Context Space holds, one endpoint's settings, an application and its runs; `new` is
 * the create form above, so a resource called `new` has only its edit address.
 */
const sectionDetailRoute = createRoute({
  getParentRoute: () => sectionRoute,
  path: "$name",
  beforeLoad: ({ params }) => {
    // The Portal's own "no such page", the one an address that matches nothing gets, and not
    // the section's page around it.
    if (!DETAIL_PAGES.has(params.plural)) {
      throw notFound({ routeId: rootRoute.id });
    }
  },
  component: Nothing,
});

/**
 * The component gallery (T-1729), development only: no session, no project, no API. The route is
 * built only when `import.meta.env.DEV`, which a production build replaces with `false` — the
 * branch goes, the import with it, and `gallery_axe.test.tsx` holds that nothing else imports
 * the module.
 */
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/__gallery",
        component: Gallery,
      }),
    ]
  : [];

export const routeTree = rootRoute.addChildren([
  loginRoute,
  ...devRoutes,
  protectedRoute.addChildren([
    indexRoute,
    activityRoute,
    approvalsRoute,
    approvalDetailRoute,
    playgroundRoute,
    allEndpointsRoute,
    organizationRoute,
    organizationTabRoute,
    organizationFormRoute,
    accessRedirectRoute,
    projectSettingsRoute,
    projectSettingsTabRoute,
    projectSettingsFormRoute,
    modelsRoute,
    modelRoute,
    exploreRoute,
    ckanRoute,
    importRoute,
    federationRoute,
    spaceCompleteRoute,
    assistantRoute,
    sharedRedirectRoute,
    workspacesRoute,
    workspacesNewRoute,
    workspaceTryItRoute,
    workspaceCompareRoute,
    workspaceBringBackRoute,
    sectionRoute.addChildren([
      sectionIndexRoute,
      sectionNewRoute,
      sectionEditRoute,
      sectionDetailRoute,
    ]),
  ]),
]);

export function createPortalRouter() {
  return createRouter({
    routeTree,
    context: { auth: undefined as unknown as AuthState },
    defaultPreload: false,
    defaultNotFoundComponent: NotFound,
    // What throws before a page is drawn — a loader, a `beforeLoad` — cannot be caught inside
    // the shell, because there is no shell yet. It gets the same words as the boundary at the
    // root rather than the router's own "Something went wrong!" (T-2426, UI-44).
    defaultErrorComponent: function RouteFailed() {
      return <ErrorPage reference={errorReference()} />;
    },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createPortalRouter>;
  }
}
