import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button, Field, PermissionGuard, Textarea } from "../components/ui";
import type { JSX, ReactNode } from "react";
import { clsx } from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../api/client";
import { ConversationPanel } from "../pages/apps/ConversationPanel";
import { TERMINAL_STATES, useAgentRun } from "../pages/apps/useAgentRun";
import type { RunEvent } from "../pages/apps/useAgentRun";
import { ModelFileDrop } from "../pages/models/ModelFileDrop";
import { AppGenerator } from "../pages/apps/AppGenerator";
import { appDisplayName, useEndpointTitles } from "../pages/apps/appTitle";
import {
  DataBar,
  endpointsQuery,
  MAX_ENDPOINTS,
  rememberEndpoints,
  runEndpointNames,
  sameEndpoints,
  storedEndpoints,
} from "./EndpointPicker";
import {
  CapabilitiesControl,
  PRESET_PATHS,
  accessFor,
  rememberCapabilities,
  storedCapabilities,
} from "./Capabilities";
import type { Capabilities } from "./Capabilities";
import { Icon } from "../components/ui/icons";
import { pageOf } from "./pageOf";
import { ConversationList } from "./ConversationList";
import type { IconName } from "../components/ui/icons";
import {
  dismissNotice,
  isPortalRoute,
  navigatedSeq,
  noticeSnapshot,
  onAssistantChange,
  onAskRequest,
  formContext,
  onOpenRequest,
  pageContext,
  parseRun,
  rememberNavigated,
  rememberPrefill,
  rememberRun,
  runSnapshot,
  settleNotice,
  settlePrefill,
  trail,
} from "./state";

/**
 * The assistant, on the right of every page (UI-45, UI-51, UI-52, UI-53).
 *
 * Renders as a round bubble at the bottom right whenever the panel is closed. When open,
 * renders a 24 rem right-docked panel (full width on small viewports, full screen on toggle).
 * If no run is remembered, shows the empty state with the paths and a paperclip in the
 * composer that drafts a data model from a sample file. The composer is the last element of the
 * dock in both states and does not move: what is above it scrolls (T-2424).
 * When a run is remembered, connects the live conversation panel. Open, it sits beside the page,
 * floats over it, or fills the screen; the choice lasts for the tab.
 */
/** A stable array between renders: `useSyncExternalStore` compares by identity. */
let trailCache: string[] = [];
function trailSnapshot(): string[] {
  const next = trail();
  if (next.length !== trailCache.length || next.some((route, i) => route !== trailCache[i])) {
    trailCache = next;
  }
  return trailCache;
}

/**
 * The assistant's paths (ADR-N-032, AG-87): the icon each shows and the kind it ends by
 * proposing, which a role must be allowed to propose to take it. Finding data proposes nothing.
 */
const PATHS = [
  ["integrate-pipeline", "pipelines", "Pipeline"],
  ["upload-data", "import", "ContextSpace"],
  ["find-data", "search", null],
  ["share-data", "share", "Endpoint"],
  ["build-app", "apps", "App"],
  ["build-dashboard", "dashboards", "Dashboard"],
  ["create-data-model", "models", "DataModel"],
  ["define-kpi", "explore", "Pipeline"],
] as const satisfies readonly (readonly [string, IconName, string | null])[];

type PathId = (typeof PATHS)[number][0];

/**
 * The paths, as the empty assistant offers them (T-2692, UI-45).
 *
 * An empty-state affordance and nothing more: they stand while no conversation is open and are
 * gone the moment one starts (T-2464); "New conversation" brings them back. A path a role cannot
 * take stays and is disabled with its reason, which is `PermissionGuard`'s job through the shared
 * Button (T-1390, UI-44). A click starts the conversation on the path, with nothing typed: the
 * Portal asks the path's first question itself (AG-91).
 */
function Paths({
  project,
  disabled,
  capabilities,
  onPick,
}: {
  project: string;
  disabled: boolean;
  /** A path the chosen capabilities leave out is disabled with why (AG-92). */
  capabilities: Capabilities | null;
  onPick: (path: PathId) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <ul data-testid="assistant-paths" className="flex flex-col gap-2">
      {PATHS.map(([path, icon, kind]) => {
        // The shared Button, not a hand-made one: `PermissionGuard` hands it the reason through
        // `disabledReason`, which only that control knows what to do with.
        const left = capabilities !== null && !PRESET_PATHS[capabilities.preset].includes(path);
        const button = (
          <Button
            size="sm"
            disabled={disabled || left}
            disabledReason={
              left
                ? t("assistant.capabilities.pathLeft", {
                    preset: t(`assistant.capabilities.presets.${capabilities.preset}.title`),
                  })
                : undefined
            }
            data-path={path}
            // The name is the title and its line, read with a pause between them; the
            // description stays free for the reason a role may not take the path.
            aria-labelledby={`assistant-path-${path} assistant-path-${path}-line`}
            onClick={() => {
              onPick(path);
            }}
            className="h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-md bg-surface-subtle p-2 text-left"
          >
            <Icon name={icon} className="mt-0.5 size-4 shrink-0" />
            <span className="flex flex-col">
              <span id={`assistant-path-${path}`} className="text-body font-medium">
                {t(`assistant.paths.${path}.title`)}
              </span>
              <span id={`assistant-path-${path}-line`} className="text-caption text-fg-muted">
                {t(`assistant.paths.${path}.line`)}
              </span>
            </span>
          </Button>
        );
        return (
          <li key={path}>
            {kind ? (
              <PermissionGuard project={project} kind={kind} verb="propose">
                {button}
              </PermissionGuard>
            ) : (
              button
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AssistantDock({ project }: { project: string }): JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const raw = useSyncExternalStore(onAssistantChange, runSnapshot);
  const run = useMemo(() => parseRun(raw), [raw]);
  const activeProject = run?.project ?? project;
  const navigated = useSyncExternalStore(onAssistantChange, noticeSnapshot);
  // The pages the assistant opened, so the person walks back without losing the conversation.
  const opened = useSyncExternalStore(onAssistantChange, trailSnapshot);
  // The notice goes once the person moves on from the page it names.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    settleNotice(pathname);
    settlePrefill(pathname);
  }, [navigated, pathname]);
  const [open, setOpen] = useState(() => Boolean(parseRun(runSnapshot())));
  // Opened by the person (the bubble, Ctrl/Cmd+K), the panel lands on its text box, ready to
  // type; opened because a run was remembered, it leaves the focus where it was (T-2719).
  const focusBox = useRef(false);
  useEffect(() => {
    if (open && focusBox.current) {
      focusBox.current = false;
      document.querySelector<HTMLElement>("#assistant-empty-composer, #run-message")?.focus();
    }
  });
  // Ctrl/Cmd+K from any page opens the assistant and a second press closes it. The shortcut only
  // moves the focus: nothing is sent and no conversation starts by it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      setOpen((was) => {
        focusBox.current = !was;
        return !was;
      });
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  // The endpoints the data bar offers are read while the page is idle, so opening does not wait.
  const queryClient = useQueryClient();
  useEffect(() => {
    const read = () => {
      void queryClient.prefetchQuery(endpointsQuery(project));
    };
    const handle = window.setTimeout(read, 1000);
    return () => {
      window.clearTimeout(handle);
    };
  }, [project, queryClient]);
  const [building, setBuilding] = useState(false);
  const [layout, setLayout] = useState<Layout>(storedLayout);
  useEffect(() => {
    try {
      sessionStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // No storage (a private window): the layout lasts until the next page.
    }
  }, [layout]);
  const full = layout === "full";
  const wide = useSyncExternalStore(onWideChange, isWide, () => false);
  const [listOpen, setListOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  // A run remembered after mount (the run page, the Assistant page, a started conversation)
  // opens the panel; closing forgets the run and leaves the bubble.
  const runId = run?.runId ?? null;
  const [shownRun, setShownRun] = useState(runId);
  // A change made in a running conversation's data bar waits for its next message (AG-75).
  const [pendingEndpoints, setPendingEndpoints] = useState<string[] | null>(null);
  if (runId !== shownRun) {
    setShownRun(runId);
    setPendingEndpoints(null);
    if (runId !== null) {
      setOpen(true);
    }
  }

  const [composerMessage, setComposerMessage] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  // The endpoints the next conversation may query (AG-75), remembered per project for the tab.
  const [chosenEndpoints, setChosenEndpoints] = useState<string[]>(() => storedEndpoints(project));
  const [endpointsOf, setEndpointsOf] = useState(activeProject);
  if (endpointsOf !== activeProject) {
    setEndpointsOf(activeProject);
    setChosenEndpoints(storedEndpoints(activeProject));
  }
  const chooseEndpoints = (names: string[]) => {
    setChosenEndpoints(names);
    rememberEndpoints(activeProject, names);
  };
  // What the assistant may do (AG-92, T-2718), remembered per project like the endpoints.
  const [capabilities, setCapabilities] = useState<Capabilities | null>(() => storedCapabilities(project));
  const [capabilitiesOf, setCapabilitiesOf] = useState(activeProject);
  if (capabilitiesOf !== activeProject) {
    setCapabilitiesOf(activeProject);
    setCapabilities(storedCapabilities(activeProject));
  }
  const chooseCapabilities = (chosen: Capabilities) => {
    setCapabilities(chosen);
    rememberCapabilities(activeProject, chosen);
  };

  const { run: record, events, streaming, answer, send, cancel } = useAgentRun(
    activeProject,
    run?.runId ?? null,
  );

  useEffect(() => {
    return onOpenRequest((intent) => {
      setOpen(true);
      setBuilding(intent === "build");
    });
  }, []);

  // A question written by a form's own action (T-1611): it lands in the composer and the person
  // sends it. The dock never asks on the person's behalf (AG-73).
  useEffect(() => {
    return onAskRequest((question) => {
      setComposerMessage(question);
      setBuilding(false);
    });
  }, []);

  useEffect(() => {
    if (!full) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLayout("side");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [full]);

  useEffect(() => {
    if (runId === null) {
      return;
    }
    const followed = navigatedSeq(runId);
    const next = events.filter((event) => event.kind === "navigate" && event.seq > followed).at(-1);
    if (!next) {
      return;
    }
    rememberNavigated(runId, next.seq);
    const route = routeOf(next);
    if (route === null) {
      return;
    }
    const draft = next.payload.draft as { kind?: string; name?: string } | undefined;
    const targetRoute =
      draft?.name && typeof draft.name === "string"
        ? `${route}${route.includes("?") ? "&" : "?"}draft=${encodeURIComponent(draft.name)}`
        : route;
    rememberPrefill(route, prefillOf(next));
    // An `href` is parsed into the path and the search: a query inside `to` reaches the address
    // bar but not the router's search, so a page already open is not remounted for it (T-0770).
    void navigate({ href: targetRoute });
  }, [events, navigate, runId]);

  const startConversation = async (promptText: string, path?: PathId) => {
    setStartError(null);
    setIsStarting(true);
    try {
      const created = await unwrap(
        await api.POST("/api/v1/projects/{project}/assistant/conversations", {
          params: { path: { project: activeProject } },
          // `endpointNames` is AG-75, `formContext` is T-1611.
          body: {
            message: promptText,
            endpointNames: chosenEndpoints,
            access: accessFor(capabilities, chosenEndpoints),
            formContext: formContext(),
            pageContext: pageContext(activeProject),
            path,
          },
        }),
      );
      rememberRun({ project: activeProject, runId: created.id });
      setComposerMessage("");
    } catch (err) {
      const detail =
        err instanceof ApiError
          ? (err.problem?.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err);
      setStartError(detail);
    } finally {
      setIsStarting(false);
    }
  };

  const over = record.data ? TERMINAL_STATES.includes(record.data.status) : false;
  const endpointTitles = useEndpointTitles(activeProject);
  // A run that builds an application says which one, by its title, never by its id.
  const buildingApp = record.data?.appName
    ? appDisplayName({
        title: record.data.title,
        appName: record.data.appName,
        endpointTitle: endpointTitles.get(record.data.endpointName),
      })
    : "";
  // Leaves this conversation for an empty one, whatever state its run is in: a run that hung
  // or died used to hold the dock, and the owner had no way back to a working chat (T-2463).
  // A run that is still going is stopped rather than left reading an inbox nobody writes to.
  const newConversation = (): void => {
    if (run && !over) {
      cancel.mutate(run.runId);
    }
    setStartError(null);
    rememberRun(null);
  };
  // The newest question the person asked, asked again in a fresh conversation (T-2462).
  const lastQuestion = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === "message" &&
        event.payload.sentBy !== "agent" &&
        typeof event.payload.text === "string",
    )
    ?.payload.text as string | undefined;
  const retry =
    lastQuestion !== undefined && lastQuestion.trim() !== ""
      ? () => {
          newConversation();
          void startConversation(lastQuestion);
        }
      : undefined;
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const isBusy = Boolean(run && !over && lastEvent && lastEvent.kind === "message");

  // The header's icon buttons: the shared ghost Button, square, quiet until hovered or pressed.
  const iconButton = "w-8 px-0 text-fg-muted hover:text-fg aria-pressed:bg-primary-soft aria-pressed:text-primary-soft-fg";

  const attach = (
    <ModelFileDrop
      icon
      project={activeProject}
      onPopulate={(source) => {
        rememberPrefill(`/projects/${activeProject}/models`, { source });
        void navigate({ to: "/projects/$project/models", params: { project: activeProject } });
      }}
    />
  );

  // What the running conversation queries: the newest `endpoints` event, else the run record.
  const lastEndpointsEvent = [...events].reverse().find((event) => event.kind === "endpoints");
  const runEndpoints = lastEndpointsEvent
    ? runEndpointNames(
        (Array.isArray(lastEndpointsEvent.payload.names) ? lastEndpointsEvent.payload.names : []).map(
          (name: unknown) => ({ name }),
        ),
      )
    : runEndpointNames((record.data as { endpoints?: unknown } | undefined)?.endpoints);
  // Once the run queries what the bar shows, the change has landed.
  if (pendingEndpoints !== null && sameEndpoints(pendingEndpoints, runEndpoints)) {
    setPendingEndpoints(null);
  }
  const liveEndpoints = pendingEndpoints ?? runEndpoints;
  const addEndpoint = (name: string) => {
    if (!liveEndpoints.includes(name) && liveEndpoints.length < MAX_ENDPOINTS) {
      setPendingEndpoints([...liveEndpoints, name]);
    }
  };
  const liveBar = run ? (
    <div className="flex flex-wrap items-start gap-1">
      <DataBar project={run.project} selected={liveEndpoints} onChange={setPendingEndpoints} />
      {record.data?.kind === "conversation" ? (
        <CapabilitiesControl
          project={run.project}
          endpoints={liveEndpoints}
          value={capabilities}
          onChange={chooseCapabilities}
        />
      ) : null}
    </div>
  ) : null;

  if (!open) {
    return (
      // Hand-made on purpose: a 56 px round floating button, which the shared Button's fixed
      // heights would fight class by class. No `aria-controls`: the panel it opens is not in the
      // page while it is closed, and a relationship to nothing leads nowhere.
      <button
        type="button"
        aria-expanded={false}
        aria-label={t("assistant.open")}
        title={t("assistant.open")}
        aria-keyshortcuts="Control+K Meta+K"
        onClick={() => {
          focusBox.current = true;
          setOpen(true);
        }}
        className="focus-ring fixed bottom-4 right-4 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-fg shadow-3 hover:bg-primary-hover"
      >
        <Icon name="chat" className="size-6" />
        {isBusy ? (
          <span
            data-testid="assistant-busy"
            className="absolute right-1 top-1 size-3 rounded-full bg-danger ring-2 ring-surface"
          />
        ) : null}
      </button>
    );
  }

  const conversation = building ? (
        <div
          id="run-chat"
          data-testid="assistant-build"
          className="flex min-h-48 w-full flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-surface p-3"
        >
          <Button
            size="sm"
            onClick={() => {
              setBuilding(false);
            }}
            className="self-start"
          >
            {t("assistant.backToChat")}
          </Button>
          <AppGenerator
            project={activeProject}
            onStarted={(runId) => {
              setBuilding(false);
              rememberRun({ project: activeProject, runId });
            }}
          />
        </div>
      ) : !run ? (
        <>
          <div
            id="run-chat"
            data-testid="assistant-empty"
            className="flex min-h-48 w-full flex-1 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-surface p-3"
          >
            <p className="text-body text-fg-muted">{t("assistant.empty.lead")}</p>
            <Paths
              project={activeProject}
              disabled={isStarting}
              capabilities={capabilities}
              onPick={(path) => {
                void startConversation("", path);
              }}
            />
          </div>

          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = composerMessage.trim();
              if (text && !isStarting) {
                void startConversation(text);
              }
            }}
          >
            <div className="flex flex-wrap items-start gap-1">
              <DataBar
                project={activeProject}
                selected={chosenEndpoints}
                onChange={chooseEndpoints}
                opens="down"
              />
              <CapabilitiesControl
                project={activeProject}
                endpoints={chosenEndpoints}
                value={capabilities}
                onChange={chooseCapabilities}
              />
            </div>
            {/* The failure is the composer's own error: tied to the box the person is still in,
                which goes invalid, and announced (UI-44, T-1749). What was typed stays. */}
            <Field
              id="assistant-empty-composer"
              label={t("assistant.empty.composer")}
              errors={startError ? [`${t("assistant.empty.failed")} ${startError}`] : undefined}
            >
              <Textarea
                id="assistant-empty-composer"
                rows={3}
                value={composerMessage}
                onChange={(event) => {
                  setComposerMessage(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    const text = composerMessage.trim();
                    if (text && !isStarting) {
                      void startConversation(text);
                    }
                  }
                }}
                className="resize-none"
              />
            </Field>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                {attach}
              </div>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={composerMessage.trim() === ""}
                loading={isStarting}
              >
                {t("assistant.empty.send")}
              </Button>
            </div>
          </form>
        </>
      ) : (
        <div
          id="run-chat"
          className="min-h-48 w-full flex-1 rounded-lg border border-border bg-surface [&>section]:h-full [&>section]:min-h-0"
        >
          <ConversationPanel
            project={run.project}
            events={events}
            streaming={streaming}
            answering={answer.isPending}
            sending={send.isPending}
            live={!over}
            building={Boolean(record.data?.appName)}
            onAnswer={(questionId, answers) => {
              answer.mutate({ questionId, answers });
            }}
            // `mutateAsync`, so the panel knows whether the message left: it empties the box on
            // success and keeps every word of it, with the reason, when the send failed (T-1761).
            // Each message of a conversation says the page it was sent from: "and this one?" is
            // about where the person is now (T-2763). An application run takes no page.
            onSend={(text) =>
              send.mutateAsync({
                text,
                pageContext: record.data?.kind === "conversation" ? pageContext(activeProject) : undefined,
                // What the person switched on or off travels with each message (AG-92).
                access: record.data?.kind === "conversation" ? accessFor(capabilities, liveEndpoints) : undefined,
                ...(pendingEndpoints !== null && !sameEndpoints(pendingEndpoints, runEndpoints)
                  ? { endpointNames: pendingEndpoints }
                  : {}),
              })
            }
            onCancel={() => cancel.mutate()}
            onRetry={retry}
            onNewConversation={newConversation}
            attach={attach}
            above={full && wide ? undefined : liveBar}
            onUseEndpoint={addEndpoint}
            // A link in an answer opens its page in place; from full screen, beside it, so the
            // person sees the page and keeps the conversation (T-2773).
            onOpenLink={(href) => {
              if (full) {
                setLayout("side");
              }
              void navigate({ href });
            }}
            usedEndpoints={liveEndpoints}
          />
        </div>
      );

  return (
    <aside
      aria-label={t("agentRun.conversation.title")}
      data-layout={layout}
      className={
        full
          ? "fixed inset-x-0 bottom-0 top-14 z-40 flex flex-col gap-2 bg-surface p-3"
          : layout === "float"
            ? clsx(
                // Computed from the viewport: 40 rem tall or the screen less the gaps, and the
                // screen's width less the two 1 rem gaps, capped below.
                "fixed bottom-4 right-4 z-40 flex h-[min(40rem,calc(100vh-5rem))] w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-3",
                // The app builder is a form: it gets the room a form needs.
                building ? "max-w-176" : "max-w-104",
              )
            : clsx(
                // Below md there is no room for a column beside the page: the panel covers the
                // screen under the header, as on full screen. In the row it squeezed the page to
                // no width, and the page's positioned controls painted through it (T-2854).
                "fixed inset-x-0 bottom-0 top-14 z-40 flex flex-col gap-2 bg-surface p-3",
                // Computed: the viewport's height less the 14 header it sticks under.
                "md:sticky md:inset-auto md:top-14 md:z-auto md:h-[calc(100vh-3.5rem)] md:shrink-0 md:border-l md:border-border",
                building ? "md:w-160" : "md:w-96",
              )
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* No `shrink-0`: in de, cs and sk the title is long enough to push the app name and the
              buttons out of the panel; it wraps instead (Button.tsx says why). */}
          <h2 className="text-body font-semibold">{t("assistant.title")}</h2>
          {run && buildingApp ? (
            <span data-testid="assistant-app" title={record.data?.appName} className="truncate text-caption text-fg-muted">
              {buildingApp}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {run ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("assistant.newConversation")}
              title={t("assistant.newConversation")}
              onClick={newConversation}
              className={iconButton}
              icon={<Icon name="plus" className="size-4" />}
            />
          ) : null}
          {run && !over ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("assistant.cancel")}
              title={t("assistant.cancel")}
              loading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
              className={iconButton}
              icon={<Icon name="stop" className="size-4" />}
            />
          ) : null}
          {LAYOUTS.map(({ value, icon, label }) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={layout === value}
              aria-label={t(label)}
              title={t(label)}
              onClick={() => {
                setLayout(value);
              }}
              className={iconButton}
              icon={<Icon name={icon} className="size-4" />}
            />
          ))}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls="run-chat"
            aria-label={t("assistant.hide")}
            title={t("assistant.hide")}
            onClick={() => {
              setOpen(false);
            }}
            className={iconButton}
            icon={<Icon name="minimize" className="size-4" />}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("assistant.close")}
            title={t("assistant.close")}
            onClick={() => {
              rememberRun(null);
              setOpen(false);
            }}
            className={iconButton}
            icon={<Icon name="close" className="size-4" />}
          />
        </div>
      </div>

      {navigated !== null && isPortalRoute(navigated) ? (
        <Alert
          tone="info"
          actions={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                dismissNotice();
              }}
            >
              {t("assistant.dismiss")}
            </Button>
          }
        >
          {t("assistant.navigated", { page: pageOf(navigated, t) })}
        </Alert>
      ) : null}

      {opened.length > 1 ? (
        <nav
          aria-label={t("assistant.trail")}
          data-testid="assistant-trail"
          className="flex w-full flex-wrap items-center gap-2 px-1 text-caption text-fg-muted"
        >
          {opened.map((route) => (
            <Button
              key={route}
              variant="ghost"
              size="xs"
              onClick={() => {
                void navigate({ href: route });
              }}
              className="text-fg-muted"
            >
              {pageOf(route, t)}
            </Button>
          ))}
        </nav>
      ) : null}

      {/* Full screen (T-2773, UI-84): the conversations on the left, the conversation in one
          column of a readable width, its data and capabilities on the right. From 1024 px; below
          it the conversation is the screen. At 2560 px the sides widen, the column does not.
          The same tree in every layout, `contents` where it is not full screen, so switching
          keeps the conversation and every word typed into it. */}
      <div data-testid={full ? "assistant-full" : undefined} className={full ? "flex min-h-0 flex-1 gap-4" : "contents"}>
          {full && wide ? (
            <Side
              id="assistant-conversations"
              open={listOpen}
              onToggle={setListOpen}
              show={t("assistant.full.showList")}
              hide={t("assistant.full.hideList")}
              edge="left"
              className="w-64 2xl:w-80"
            >
              <ConversationList
                project={activeProject}
                current={run?.runId ?? null}
                onOpen={(runId) => {
                  setBuilding(false);
                  rememberRun({ project: activeProject, runId });
                }}
              />
            </Side>
          ) : null}
          <div
            data-testid={full ? "assistant-column" : undefined}
            className={full ? "mx-auto flex min-h-0 w-full max-w-4xl min-w-0 flex-1 flex-col gap-2" : "contents"}
          >
            {conversation}
          </div>
          {full && wide && run && !building ? (
            <Side
              id="assistant-data"
              open={panelOpen}
              onToggle={setPanelOpen}
              show={t("assistant.full.showData")}
              hide={t("assistant.full.hideData")}
              edge="right"
              className="w-80 2xl:w-112"
            >
              <section aria-label={t("assistant.full.data")} className="flex flex-col gap-2">
                <h3 className="text-caption font-semibold text-fg-muted">{t("assistant.full.data")}</h3>
                {liveBar}
              </section>
            </Side>
          ) : null}
      </div>

    </aside>
  );
}

/** Wide enough for the conversations and the data beside the full-screen conversation. */
const WIDE = "(min-width: 64rem)";

function onWideChange(changed: () => void): () => void {
  const query = typeof window.matchMedia === "function" ? window.matchMedia(WIDE) : null;
  query?.addEventListener("change", changed);
  return () => query?.removeEventListener("change", changed);
}

function isWide(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(WIDE).matches;
}

/**
 * A side of the full-screen assistant that folds away to a button, so the conversation can take
 * the width when the person wants it (T-2773).
 */
function Side({
  id,
  open,
  onToggle,
  show,
  hide,
  edge,
  className,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  show: string;
  hide: string;
  edge: "left" | "right";
  className: string;
  children: ReactNode;
}): JSX.Element {
  const toggle = (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      aria-label={open ? hide : show}
      title={open ? hide : show}
      onClick={() => {
        onToggle(!open);
      }}
      className="w-8 shrink-0 self-start px-0 text-fg-muted hover:text-fg"
      icon={<Icon name={open === (edge === "left") ? "chevronLeft" : "chevronRight"} className="size-4" />}
    />
  );
  return (
    <div className={clsx("flex min-h-0 shrink-0 gap-1", edge === "right" && "flex-row-reverse", open && className)}>
      {toggle}
      {open ? (
        <div id={id} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Beside the page, floating over it, or the whole screen; the bubble is the fourth, closed state. */
type Layout = "side" | "float" | "full";

const LAYOUT_KEY = "jc.assistant.layout";

const LAYOUTS: { value: Layout; icon: IconName; label: string }[] = [
  { value: "side", icon: "sidebar", label: "assistant.sideView" },
  { value: "float", icon: "float", label: "assistant.floatView" },
  { value: "full", icon: "expand", label: "assistant.fullScreen" },
];

function storedLayout(): Layout {
  try {
    const stored = sessionStorage.getItem(LAYOUT_KEY);
    return stored === "float" || stored === "full" ? stored : "side";
  } catch {
    return "side";
  }
}

function routeOf(event: RunEvent): string | null {
  const route = event.payload.route;
  return isPortalRoute(route) ? route : null;
}

function prefillOf(event: RunEvent): Record<string, unknown> {
  const prefill = event.payload.prefill;
  return typeof prefill === "object" && prefill !== null && !Array.isArray(prefill)
    ? (prefill as Record<string, unknown>)
    : {};
}
