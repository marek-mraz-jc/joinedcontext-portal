/**
 * T-2875: every record opens on click. A click anywhere on a row whose record has a link
 * (`RecordLink`, or a list's own link marked `data-row-link`) opens that link; a click on what
 * handles its own click (a button, a menu, another link, a portalled dialog) does not; Ctrl, Cmd,
 * Shift and the middle button open a new tab. Then each list of the Portal, mounted through its
 * route: a click on a plain cell of a row lands on that record's page or edit form, and a click
 * on the row's own action button leaves the list where it is.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { Table, TableBody, TableCell, TableRow } from "../src/components/ui/Table";
import { RecordLink } from "../src/components/RecordLink";
import { jsonResponse, list, renderRoute } from "./pageHarness";

function Portalled(): React.JSX.Element {
  return createPortal(<span>in a dialog</span>, document.body);
}

function Row({ opened, inner, linked = true }: { opened: () => void; inner: () => void; linked?: boolean }) {
  const [selected, setSelected] = useState(false);
  return (
    <Table caption="Records">
      <TableBody>
        <TableRow>
          <TableCell>
            {linked ? (
              <a
                data-row-link=""
                href="/projects/helsinki/pipelines/ingest/edit"
                onClick={(event) => {
                  event.preventDefault();
                  opened();
                }}
              >
                ingest
              </a>
            ) : (
              "ingest"
            )}
          </TableCell>
          <TableCell>Live</TableCell>
          <TableCell>
            <button type="button" onClick={inner}>
              Pause
            </button>
            <input
              type="checkbox"
              aria-label="Pick ingest"
              checked={selected}
              onChange={() => {
                setSelected(!selected);
              }}
            />
          </TableCell>
          <TableCell>
            <Portalled />
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("a table row with a record link", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the link on a click anywhere else in the row", async () => {
    const opened = vi.fn();
    render(<Row opened={opened} inner={vi.fn()} />);
    await userEvent.click(screen.getByText("Live"));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("leaves a button, a checkbox and the link itself to their own click", async () => {
    const opened = vi.fn();
    const inner = vi.fn();
    render(<Row opened={opened} inner={inner} />);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(inner).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("checkbox", { name: "Pick ingest" }));
    expect(screen.getByRole("checkbox", { name: "Pick ingest" })).toBeChecked();
    expect(opened).not.toHaveBeenCalled();
    // The link opens once, by itself, not a second time through the row.
    await userEvent.click(screen.getByRole("link", { name: "ingest" }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("ignores a click inside what the row renders through a portal", async () => {
    const opened = vi.fn();
    render(<Row opened={opened} inner={vi.fn()} />);
    await userEvent.click(screen.getByText("in a dialog"));
    expect(opened).not.toHaveBeenCalled();
  });

  it("hands a Ctrl click and a middle click to the link with the keys of a new tab", async () => {
    const keys: string[] = [];
    render(
      <Table caption="Records">
        <TableBody>
          <TableRow>
            <TableCell>
              <a
                data-row-link=""
                href="/projects/helsinki/pipelines/ingest/edit"
                onClick={(event) => {
                  event.preventDefault();
                  keys.push(`${event.ctrlKey ? "ctrl" : ""}${event.metaKey ? "+meta" : ""}`);
                }}
              >
                ingest
              </a>
            </TableCell>
            <TableCell>Live</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const user = userEvent.setup();
    await user.keyboard("{Control>}");
    await user.click(screen.getByText("Live"));
    await user.keyboard("{/Control}");
    fireEvent(screen.getByText("Live"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(keys).toEqual(["ctrl", "ctrl+meta"]);
  });

  it("does not open when the click ends a text selection", async () => {
    const opened = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Live" } as Selection);
    render(<Row opened={opened} inner={vi.fn()} />);
    await userEvent.click(screen.getByText("Live"));
    expect(opened).not.toHaveBeenCalled();
  });

  it("is an ordinary row when the record has no link", async () => {
    const before = window.location.pathname;
    render(<Row opened={vi.fn()} inner={vi.fn()} linked={false} />);
    await userEvent.click(screen.getByText("Live"));
    expect(window.location.pathname).toBe(before);
  });
});

describe("a record link", () => {
  it("opens a record's own page where it has one, else its edit form, and marks its row", async () => {
    const root = createRootRoute({
      component: () => (
        <>
          <RecordLink project="helsinki" plural="spaces" name="air" />
          <RecordLink project="helsinki" plural="pipelines" name="ingest">
            Ingest the feed
          </RecordLink>
        </>
      ),
    });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory() })} />);
    expect(await screen.findByRole("link", { name: "air" })).toHaveAttribute("href", "/projects/helsinki/spaces/air");
    const pipeline = screen.getByRole("link", { name: "Ingest the feed" });
    expect(pipeline).toHaveAttribute("href", "/projects/helsinki/pipelines/ingest/edit");
    expect(pipeline).toHaveAttribute("data-row-link");
  });
});

const manifest = (kind: string, name: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace: "helsinki" },
  spec,
  status: { phase: "Live" },
});

interface Listed {
  list: string;
  path: string;
  /** The API path that answers the list's items, and the answer. */
  api: string;
  body: unknown;
  /** The row's link text. */
  record: string;
  opens: string;
}

const LISTS: Listed[] = [
  {
    list: "pipelines",
    path: "/projects/helsinki/pipelines",
    api: "/api/v1/projects/helsinki/pipelines",
    body: list([manifest("Pipeline", "ingest", { class: "resident" })]),
    record: "ingest",
    opens: "/projects/helsinki/pipelines/ingest/edit",
  },
  {
    list: "data sources",
    path: "/projects/helsinki/datasources",
    api: "/api/v1/projects/helsinki/datasources",
    body: list([manifest("DataSource", "feed", { type: "http", http: { url: "https://example.org/feed.json" } })]),
    record: "feed",
    opens: "/projects/helsinki/datasources/feed/edit",
  },
  {
    list: "subscriptions",
    path: "/projects/helsinki/subscriptions",
    api: "/api/v1/projects/helsinki/subscriptions",
    body: list([manifest("Subscription", "alerts", { contextSpaceRef: "air" })]),
    record: "alerts",
    opens: "/projects/helsinki/subscriptions/alerts/edit",
  },
  {
    list: "policies",
    path: "/projects/helsinki/policies",
    api: "/api/v1/projects/helsinki/policies",
    body: list([manifest("Policy", "readers", { contextSpaceRef: { kind: "ContextSpace", name: "air" } })]),
    record: "readers",
    opens: "/projects/helsinki/policies/readers/edit",
  },
  {
    list: "context source registrations",
    path: "/projects/helsinki/csrs",
    api: "/api/v1/projects/helsinki/csrs",
    body: list([manifest("ContextSourceRegistration", "weather", { contextSpaceRef: "air" })]),
    record: "weather",
    opens: "/projects/helsinki/csrs/weather/edit",
  },
  {
    list: "context spaces",
    path: "/projects/helsinki/spaces",
    api: "/api/v1/projects/helsinki/spaces",
    body: list([manifest("ContextSpace", "air")]),
    record: "air",
    opens: "/projects/helsinki/spaces/air",
  },
  {
    list: "endpoints",
    path: "/projects/helsinki/endpoints",
    api: "/api/v1/projects/helsinki/endpoints",
    body: list([manifest("Endpoint", "public-air", { contextSpaceRef: "air", audience: "public" })]),
    record: "public-air",
    opens: "/projects/helsinki/endpoints/public-air",
  },
  {
    list: "a kind without a page of its own",
    path: "/projects/helsinki/blueprints",
    api: "/api/v1/projects/helsinki/blueprints",
    body: list([manifest("Blueprint", "alerting")]),
    record: "alerting",
    opens: "/projects/helsinki/blueprints/alerting/edit",
  },
  {
    list: "approvals",
    path: "/projects/helsinki/approvals",
    api: "/api/v1/projects/helsinki/changes",
    body: list([
      {
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "ChangeProposal",
        metadata: { name: "chg-1a2b3c4d", namespace: "helsinki" },
        summary: { key: "change.summary.update", params: { kind: "Endpoint", name: "public-air", fields: 2 } },
        author: { name: "Marek Mráz", email: "marek@hel.fi" },
        createdAt: "2026-03-03T12:00:00Z",
        status: { lane: "yellow", phase: "PendingApproval", plan: { update: 1 } },
      },
    ]),
    record: "",
    opens: "/projects/helsinki/approvals/chg-1a2b3c4d",
  },
  {
    list: "people",
    path: "/organization/people",
    api: "/api/v1/organization/people",
    body: {
      items: [
        {
          id: "jana-id",
          email: "jana@hel.fi",
          firstName: "Jana",
          lastName: "Nováková",
          enabled: true,
          emailVerified: true,
          requiredActions: [],
          createdAt: "2026-09-01T08:00:00Z",
          lastSeen: null,
          locale: "sk",
          pendingDeletion: null,
        },
      ],
    },
    record: "Jana Nováková",
    opens: "/organization/people/jana-id",
  },
];

describe("every list opens its record on a click on the row", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const one of LISTS) {
    it(`${one.list}: a plain cell opens the record, the row's own button does not`, async () => {
      await renderRoute({
        path: `${one.path}?lang=en`,
        answer: (path, request) => (request.method === "GET" && path === one.api ? jsonResponse(one.body) : undefined),
      });
      const link = await waitFor(() => {
        const found = document.querySelector<HTMLAnchorElement>("a[data-row-link]");
        expect(found, `${one.list} renders a row link`).not.toBeNull();
        return found as HTMLAnchorElement;
      });
      if (one.record) {
        expect(link).toHaveTextContent(one.record);
      }
      const row = link.closest("tr") as HTMLTableRowElement;
      const button = within(row).queryAllByRole("button")[0];
      if (button) {
        await userEvent.click(button);
        await userEvent.keyboard("{Escape}");
        expect(window.location.pathname, "the row's button handled its own click").toBe(one.path);
      }
      const plain = Array.from(row.querySelectorAll("td")).find(
        (cell) => cell.querySelector("a, button, input, select, textarea, [role=button]") === null,
      );
      expect(plain, `${one.list} has a cell with nothing of its own to click`).toBeDefined();
      await userEvent.click(plain as HTMLTableCellElement);
      await waitFor(() => {
        expect(window.location.pathname).toBe(one.opens);
      });
    });
  }
});

const READER = { project: "helsinki", bootstrap: false, grants: [{ rule: { kinds: ["*"], verbs: ["read"] } }] };

describe("a person who may not change a record still opens it, read only", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const subscription = manifest("Subscription", "alerts", {
    contextSpaceRef: "air",
    notification: { endpoint: { uri: "https://alerts.example.org/hook" } },
  });
  const answer = (path: string, request: Request) => {
    if (request.method !== "GET") return undefined;
    if (path === "/api/v1/projects/helsinki/subscriptions") return jsonResponse(list([subscription]));
    if (path === "/api/v1/projects/helsinki/subscriptions/alerts") return jsonResponse(subscription);
    if (path === "/api/v1/projects/helsinki/blueprints") return jsonResponse(list([manifest("Blueprint", "alerting")]));
    if (path === "/api/v1/projects/helsinki/blueprints/alerting") return jsonResponse(manifest("Blueprint", "alerting"));
    return undefined;
  };

  it("a reader gets the filled form, closed, with the reason, and nothing to propose", async () => {
    await renderRoute({ path: "/projects/helsinki/subscriptions/alerts/edit?lang=en", answer, permissions: READER });
    expect(await screen.findByText(/Your role does not permit changing Subscription here/)).toBeInTheDocument();
    expect(screen.getAllByText("View alerts").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Propose change" })).toBeNull();
    const fields = await screen.findAllByRole("textbox");
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toBeDisabled();
    }
    expect(screen.queryByText(/This form cannot be opened/)).toBeNull();
  });

  it("a reader reads a kind without a form as its manifest, not an editor", async () => {
    await renderRoute({ path: "/projects/helsinki/blueprints/alerting/edit?lang=en", answer, permissions: READER });
    const text = await screen.findByRole("group", { name: "The manifest of alerting" });
    expect(text).toHaveTextContent("kind: Blueprint");
    expect(screen.queryByRole("button", { name: "Propose change" })).toBeNull();
  });

  it("a steward still gets the form to change", async () => {
    await renderRoute({ path: "/projects/helsinki/subscriptions/alerts/edit?lang=en", answer });
    expect((await screen.findAllByText("Edit alerts")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("button", { name: "Propose change" })).toBeInTheDocument();
    expect(screen.queryByText(/Your role does not permit changing/)).toBeNull();
  });
});
