/**
 * Comments on an entity with @mentions, and the person's notifications (T-3106, API/01 §34): the
 * panel lists, posts and removes only one's own; a mention the API did not notify is said; the
 * header's menu counts the unread and marks one read when it is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { toRichRow } from "@joinedcontext/sdk";
import i18n from "../src/i18n";
import { CommentsPanel, NotificationsMenu } from "../src/pages/spaces/Comments";
import { RowDialog, RowExtra } from "../src/pages/spaces/DataViews";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const URN = "urn:ngsi-ld:AirQualityObserved:hel.fi:air:1";

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );

function wrap(children: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>,
  );
}

const comment = (id: number, mine: boolean, text: string) => ({
  id,
  urn: URN,
  author: mine ? "sami" : "anna",
  authorName: mine ? "Sami" : "Anna",
  text,
  mentions: [],
  createdAt: "2026-10-06T19:20:00Z",
  mine,
});

/** The requests the page sent to paths ending in `tail`, in order. */
function sentTo(fetchMock: ReturnType<typeof vi.fn>, tail: string): Request[] {
  return fetchMock.mock.calls.map((call) => call[0] as Request).filter((request) => new URL(request.url).pathname.endsWith(tail));
}

describe("comments on an entity", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the comments, posts one with its mentions and says who was not notified", async () => {
    let listed = [comment(1, false, "pm10 jumped")];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.method === "POST") {
        listed = [...listed, comment(2, true, "@anna@hel.fi @nobody@x.org seen")];
        return json({ ...listed[1], unknownMentions: ["nobody@x.org"] }, 201);
      }
      return json(listed);
    });
    vi.stubGlobal("fetch", fetchMock);
    wrap(<CommentsPanel project="helsinki" space="air" urn={URN} />);

    const list = await screen.findByRole("list", { name: "Comments" });
    expect(within(list).getByText("pm10 jumped")).toBeInTheDocument();
    // Another person's comment cannot be removed from here.
    expect(within(list).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(new URL(sentTo(fetchMock, "/spaces/air/comments")[0].url).searchParams.get("urn")).toBe(URN);

    await userEvent.type(screen.getByLabelText("Add a comment"), "@anna@hel.fi @nobody@x.org seen");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Not notified, because they may not read this space: @nobody@x.org")).toBeInTheDocument();
    const posted = sentTo(fetchMock, "/spaces/air/comments").find((request) => request.method === "POST");
    expect(await posted?.json()).toEqual({ urn: URN, text: "@anna@hel.fi @nobody@x.org seen" });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getByLabelText("Add a comment")).toHaveValue("");
  });

  it("removes one's own comment and says a refusal in the API's words", async () => {
    let refuse = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.method === "DELETE") {
        return refuse ? json({ title: "Not Found", status: 404, detail: "no comment 3 of yours here" }, 404) : json(null, 204);
      }
      return json([comment(3, true, "mine")]);
    });
    vi.stubGlobal("fetch", fetchMock);
    wrap(<CommentsPanel project="helsinki" space="air" urn={URN} />);
    const remove = await screen.findByRole("button", { name: /Remove your comment of/ });
    await userEvent.click(remove);
    await waitFor(() => expect(sentTo(fetchMock, "/spaces/air/comments/3").map((r) => r.method)).toEqual(["DELETE"]));
    refuse = true;
    await userEvent.click(remove);
    expect(await screen.findByRole("alert")).toHaveTextContent("no comment 3 of yours here");
  });

  it("does not post an empty comment", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json([])));
    wrap(<CommentsPanel project="helsinki" space="air" urn={URN} />);
    expect(await screen.findByText("No comments yet.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add a comment"), "   ");
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  });

  it("is what every view's row adds under the attributes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json([])));
    const row = toRichRow({ id: URN, type: "AirQualityObserved", name: { type: "Property", value: "Station 1" } }, "en");
    wrap(
      <RowExtra.Provider value={(open) => <CommentsPanel project="helsinki" space="air" urn={open.id} />}>
        <RowDialog row={row} onClose={() => {}} />
      </RowExtra.Provider>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Station 1" });
    expect(within(dialog).getByRole("heading", { name: "Comments" })).toBeInTheDocument();
  });
});

describe("notifications", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    navigate.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts the unread on the button, lists them, and marks one read when it is opened", async () => {
    const item = {
      id: 5,
      project: "helsinki",
      space: "air",
      urn: URN,
      commentId: 1,
      author: "anna",
      authorName: "Anna",
      excerpt: "@sami look at pm10",
      createdAt: "2026-10-06T19:20:00Z",
      read: false,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = input as Request;
      return request.method === "POST" ? json(null, 204) : json({ items: [item], unread: 1 });
    });
    vi.stubGlobal("fetch", fetchMock);
    wrap(<NotificationsMenu />);
    const button = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    await userEvent.click(button);
    const entry = await screen.findByRole("menuitem", { name: /Anna mentioned you in air/ });
    await userEvent.click(entry);
    await waitFor(() => expect(sentTo(fetchMock, "/notifications/5/read").map((r) => r.method)).toEqual(["POST"]));
    expect(navigate).toHaveBeenCalledWith({ href: "/projects/helsinki/spaces/air" });
  });

  it("says when there is nothing new", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ items: [], unread: 0 })));
    wrap(<NotificationsMenu />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("Nothing new.")).toBeInTheDocument();
  });
});
