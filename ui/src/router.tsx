import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  Navigate,
  notFound,
  Outlet,
  redirect,
  useChildMatches,
  useRouterState,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useProjects } from "./api/projects";
import { BrandMark, Shell } from "./components/layout/Shell";
import { buttonClass, EmptyState, PageFailed } from "./components/ui";
import { AllEndpointsPage } from "./routes/AllEndpointsPage";
import { LoginPage } from "./routes/LoginPage";
import { ResourceListPage } from "./routes/ResourceListPage";
import { FormRouteHost } from "./components/forms/FormRoute";
import type { FormTarget } from "./components/forms/FormRoute";
import { ActivityPage } from "./routes/ActivityPage";
import { ApprovalsPage } from "./routes/ApprovalsPage";
import { ApprovalDetailPage } from "./routes/ApprovalDetailPage";
import { ModelsPage } from "./pages/models/ModelsPage";
import { ExplorePage } from "./pages/explore/ExplorePage";
import { CkanPage } from "./pages/ckan/CkanPage";
import { ImportPage } from "./pages/import/ImportPage";
import { SpaceInside } from "./pages/spaces/SpaceInside";
import { AppPage } from "./pages/apps/AppPage";
import { EndpointPage } from "./pages/endpoints/EndpointPage";
import { AssistantPage } from "./pages/assistant/AssistantPage";
import { HandOff } from "./assistant/HandOff";
import { WorkspaceProvider } from "./components/layout/WorkspaceContext";
import { WorkspacesPage } from "./routes/WorkspacesPage";
import { ComparePage } from "./pages/workspaces/ComparePage";
import { BringBackPage } from "./pages/workspaces/BringBackPage";
import { TryItPage } from "./pages/workspaces/TryItPage";
import { Gallery } from "./pages/gallery/Gallery";
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
  const { t } = useTranslation();
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <Bare>
      <EmptyState
        icon="search"
        title={t("app.notFound.title")}
        description={t("app.notFound.description", { path })}
        action={
          <Link to="/" className={buttonClass("primary", "md")}>
            {t("app.notFound.home")}
          </Link>
        }
      />
    </Bare>
  );
}

/** The shell around a page that belongs to no single project: it opens on the first one. */
function AnyProjectShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const projects = useProjects();
  const first = projects.data?.[0];
  if (!first) {
    return <NoProject projects={projects} />;
  }
  return <Shell project={first}>{children}</Shell>;
}

/** `/` goes to the first visible project's spaces; with no project there is nowhere to go. */
function IndexRedirect(): React.JSX.Element {
  const projects = useProjects();
  const first = projects.data?.[0];
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
  // `?workspace=` on any page reads and writes that copy (UI-61, CC-76).
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

const modelsRoute = createRoute({
  getParentRoute: () => protectedRoute,
  path: "/projects/$project/models",
  component: function ModelsRoute() {
    const { project } = modelsRoute.useParams();
    return (
      <Shell project={project}>
        <HandOff>
          <ModelsPage project={project} />
        </HandOff>
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
  validateSearch: (search: Record<string, unknown>): { edit?: string } => ({
    edit: typeof search.edit === "string" && search.edit !== "" ? search.edit : undefined,
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
    modelsRoute,
    exploreRoute,
    ckanRoute,
    importRoute,
    federationRoute,
    spaceCompleteRoute,
    assistantRoute,
    sharedRedirectRoute,
    workspacesRoute,
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
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createPortalRouter>;
  }
}
