import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Button, Field, PermissionGuard, Textarea } from "../components/ui";
import type { JSX } from "react";
import { clsx } from "clsx";
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
  MAX_ENDPOINTS,
  rememberEndpoints,
  runEndpointNames,
  sameEndpoints,
  storedEndpoints,
} from "./EndpointPicker";
import { Icon } from "../components/ui/icons";
import { pageOf } from "./pageOf";
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
 * If no run is remembered, shows the empty state with example prompts and a paperclip in the
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

/** What the assistant can be asked, and the kind each prompt would propose. */
const EXAMPLES = [
  ["find", null],
  ["share", "Endpoint"],
  ["build", "Dashboard"],
] as const;

/**
 * The example prompts, and the entry to the app builder beside them.
 *
 * An empty-state affordance and nothing more: they stand while no conversation is open and are
 * gone the moment the first question is sent (T-2464, the owner reversing T-2423). Inside a
 * conversation the builder and the prompts are one click away under "New conversation". A prompt
 * a role cannot carry out stays and is disabled with its reason, which is `PermissionGuard`'s job
 * through the shared Button (T-1390, UI-44).
 */
function Examples({
  project,
  disabled,
  onPick,
  onGenerate,
}: {
  project: string;
  disabled: boolean;
  onPick: (text: string) => void;
  onGenerate: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid="assistant-examples"
      className="flex flex-col gap-2"
    >
      <Button
        size="sm"
        disabled={disabled}
        onClick={onGenerate}
        className="h-auto justify-start gap-2 rounded-md bg-primary-soft p-2 text-left text-body font-medium text-primary-soft-fg"
      >
        <Icon name="apps" className="size-4" />
        {t("apps.generate.title")}
      </Button>
      {EXAMPLES.map(([example, kind]) => {
        const exampleText = t(`assistant.empty.examples.${example}`);
        // The shared Button, not a hand-made one: `PermissionGuard` hands it the reason through
        // `disabledReason`, which only that control knows what to do with.
        const button = (
          <Button
            key={exampleText}
            size="sm"
            disabled={disabled}
            onClick={() => {
              onPick(exampleText);
            }}
            className="h-auto justify-start whitespace-normal rounded-md bg-surface-subtle p-2 text-left text-caption"
          >
            {exampleText}
          </Button>
        );
        return kind ? (
          <PermissionGuard key={exampleText} project={project} kind={kind} verb="propose">
            {button}
          </PermissionGuard>
        ) : (
          button
        );
      })}
    </div>
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

  const startConversation = async (promptText: string) => {
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
            formContext: formContext(),
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
    <DataBar project={run.project} selected={liveEndpoints} onChange={setPendingEndpoints} />
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
        onClick={() => {
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
                // Computed: the viewport's height less the 14 header it sticks under.
                "flex w-full shrink-0 flex-col gap-2 border-l border-border bg-surface p-3 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)]",
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

      {building ? (
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
            <Examples
              project={activeProject}
              disabled={isStarting}
              onPick={(text) => {
                void startConversation(text);
              }}
              onGenerate={() => {
                setBuilding(true);
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
            <DataBar
              project={activeProject}
              selected={chosenEndpoints}
              onChange={chooseEndpoints}
              opens="down"
            />
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
            onSend={(text) =>
              send.mutateAsync(
                pendingEndpoints !== null && !sameEndpoints(pendingEndpoints, runEndpoints)
                  ? { text, endpointNames: pendingEndpoints }
                  : text,
              )
            }
            onCancel={() => cancel.mutate()}
            onRetry={retry}
            onNewConversation={newConversation}
            attach={attach}
            above={liveBar}
            onUseEndpoint={addEndpoint}
            usedEndpoints={liveEndpoints}
          />
        </div>
      )}

    </aside>
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
