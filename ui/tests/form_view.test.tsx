/**
 * T-3103, API/01 §30 and §33: the form view of a space's type asks for the model's fields as the
 * view's settings choose them, hides a field under its condition, takes prefilled answers from the
 * address, says what is wrong before sending, and creates one entity through the space surface; a
 * public form is a public Endpoint that allows creating alone, and its page posts anonymously.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/spaces/FormView.tsx.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { LinkmlSlot } from "../src/pages/models/linkml";
import { FormSettingsEditor, FormSharePanel, FormView, formPublishRequest, PublicFormPage } from "../src/pages/spaces/FormView";
import type { FormSettings } from "../src/pages/spaces/formView";
import { expectNoViolations } from "./checks";
import { renderPage } from "./page_contract";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 300 ? "application/json" : "application/problem+json" },
  });

const SLOTS: LinkmlSlot[] = [
  { name: "name", kind: "Property", required: true, description: "What it is called" },
  { name: "category", kind: "Property", range: "Category" },
  { name: "capacity", kind: "Property", range: "integer" },
];
const ENUMS = { category: [{ value: "street" }, { value: "garage" }] };

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the form view", () => {
  it("creates one entity through the space surface from the shown, typed answers", async () => {
    const posted: { path: string; body: Record<string, unknown> }[] = [];
    renderPage(
      <FormView
        space="parking"
        type="ParkingSpot"
        slots={SLOTS}
        enums={ENUMS}
        settings={{ conditions: [{ attr: "capacity", when: { attr: "category", equals: "garage" } }] }}
        search={new URLSearchParams("name=Hlavná")}
      />,
      {
        path: "/projects/city/spaces/parking",
        answer: async (url, request) => {
          if (request.method !== "POST") return undefined;
          posted.push({ path: url.pathname, body: (await request.json()) as Record<string, unknown> });
          return new Response(null, { status: 201 });
        },
      },
    );
    const name = await screen.findByRole("textbox", { name: /^name/ });
    expect(name).toHaveValue("Hlavná");
    // The capacity waits for its condition.
    expect(screen.queryByRole("textbox", { name: /capacity/ })).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /category/ }), "garage");
    await userEvent.type(screen.getByRole("textbox", { name: /capacity/ }), "40");
    await expectNoViolations(name.closest("form") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: en.spaces.form.submit }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].path).toBe("/cs/parking/ngsi-ld/v1/entities");
    const { id, ...rest } = posted[0].body;
    expect(String(id)).toMatch(/^urn:ngsi-ld:ParkingSpot:[0-9a-f-]{36}$/);
    expect(rest).toEqual({
      type: "ParkingSpot",
      name: { type: "Property", value: "Hlavná" },
      category: { type: "Property", value: "garage" },
      capacity: { type: "Property", value: 40 },
    });
    expect(await screen.findByText(new RegExp(String(id)))).toBeInTheDocument();
  });

  it("says what is wrong before sending, and the gateway's refusal after", async () => {
    let posts = 0;
    renderPage(<FormView space="parking" type="ParkingSpot" slots={SLOTS} enums={ENUMS} search={new URLSearchParams()} />, {
      path: "/projects/city/spaces/parking",
      answer: async (_url, request) => {
        if (request.method !== "POST") return undefined;
        posts += 1;
        return json({ title: "Forbidden", status: 403, detail: "the policy does not grant createEntity" }, 403);
      },
    });
    await userEvent.type(await screen.findByRole("textbox", { name: /capacity/ }), "many");
    await userEvent.click(screen.getByRole("button", { name: en.spaces.form.submit }));
    expect(screen.getByRole("textbox", { name: /^name/ })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(en.spaces.form.problem.integer)).toBeInTheDocument();
    expect(screen.getByText(/2 answers need fixing/)).toBeInTheDocument();
    expect(posts).toBe(0);

    await userEvent.type(screen.getByRole("textbox", { name: /^name/ }), "Hlavná");
    await userEvent.clear(screen.getByRole("textbox", { name: /capacity/ }));
    await userEvent.click(screen.getByRole("button", { name: en.spaces.form.submit }));
    expect(await screen.findByText(/the policy does not grant createEntity/)).toBeInTheDocument();
    expect(posts).toBe(1);
  });
});

function Editing({ onSettings }: { onSettings: (next: FormSettings) => void }) {
  const [value, setValue] = useState<FormSettings>({});
  return (
    <FormSettingsEditor
      slots={SLOTS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onSettings(next);
      }}
    />
  );
}

describe("the form's settings", () => {
  it("choose, order and relabel the fields, and add a condition", async () => {
    const seen: FormSettings[] = [];
    renderPage(<Editing onSettings={(next) => seen.push(next)} />, { path: "/projects/city/spaces/parking", answer: async () => undefined });
    await userEvent.click(await screen.findByText(en.spaces.form.settings));
    await userEvent.click(screen.getByRole("checkbox", { name: "category" }));
    await userEvent.click(screen.getByRole("button", { name: "Move capacity up" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Label of capacity" }), "Places");
    expect(seen.at(-1)?.fields).toEqual([{ attr: "capacity", label: "Places" }, { attr: "name" }]);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: en.spaces.form.show }), "capacity");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: en.spaces.form.when }), "name");
    await userEvent.type(screen.getByRole("textbox", { name: en.spaces.form.equals }), "Garage");
    await userEvent.click(screen.getByRole("button", { name: en.spaces.form.addCondition }));
    expect(seen.at(-1)?.conditions).toEqual([{ attr: "capacity", when: { attr: "name", equals: "Garage" } }]);
    await expectNoViolations(screen.getByTestId("form-settings"));
  });
});

describe("a public form", () => {
  it("asks propose-endpoint for a public endpoint that allows creating its type alone", () => {
    expect(formPublishRequest("parking", "parking-form", "ParkingSpot", ["name", "capacity", "note"], ["name", "capacity"])).toEqual({
      contextSpace: "parking",
      name: "parking-form",
      audience: "public",
      entityTypes: ["ParkingSpot"],
      access: "create",
      hiddenAttributes: ["note"],
    });
  });

  it("proposes the Endpoint and its Policy as one Change and gives the /f link", async () => {
    const sent: { path: string; body: unknown; dryRun: boolean }[] = [];
    renderPage(<FormSharePanel project="city" space="parking" type="ParkingSpot" attributes={["name", "note"]} asked={["name"]} />, {
      path: "/projects/city/spaces/parking",
      answer: async (url, request) => {
        if (request.method !== "POST") return undefined;
        sent.push({ path: url.pathname, body: (await request.json()) as unknown, dryRun: url.searchParams.get("dryRun") === "All" });
        if (url.pathname.endsWith("/assistant/propose-endpoint")) {
          return json({
            lane: "red",
            slug: "f7m2qz4tv6xh3n5jb2ryd3wcfa",
            endpoint: { apiVersion: "joinedcontext.com/v1alpha1", kind: "Endpoint", metadata: { name: "parking-parkingspot-form" }, spec: {} },
            policies: [{ apiVersion: "joinedcontext.com/v1alpha1", kind: "Policy", metadata: { name: "parking-parkingspot-form-public" }, spec: {} }],
          });
        }
        return url.searchParams.get("dryRun") === "All"
          ? json({ valid: true })
          : json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "Change", metadata: { name: "chg-0000aa02", namespace: "city" }, status: { lane: "red", phase: "PendingApproval" } }, 202);
      },
    });
    const panel = await screen.findByTestId("form-share");
    await userEvent.click(within(panel).getByText(en.spaces.form.shareTitle));
    await userEvent.click(within(panel).getByRole("button", { name: en.spaces.form.publish }));
    await waitFor(() => expect(sent.filter((s) => s.path.endsWith("/import") && !s.dryRun)).toHaveLength(1));
    expect((sent[0].body as { access: string }).access).toBe("create");
    expect(await within(panel).findByTestId("form-share-link")).toHaveTextContent(`${window.location.origin}/f/f7m2qz4tv6xh3n5jb2ryd3wcfa`);
  });

  it("builds its fields from the published schema and posts anonymously through the Endpoint", async () => {
    const requests: Request[] = [];
    renderPage(<PublicFormPage slug="abc" search={new URLSearchParams("capacity=12")} />, {
      path: "/f/abc",
      answer: async (url, request) => {
        if (!url.pathname.startsWith("/api/endpoint/abc/")) return undefined;
        requests.push(request);
        if (url.pathname.endsWith("/schema/index.json")) return json({ models: [{ version: 2 }] });
        if (url.pathname.endsWith("/schema/v2/json-schema")) {
          return json({
            definitions: {
              ParkingSpot: {
                required: ["name", "id", "type"],
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  name: { type: ["string", "null"], description: "What it is called" },
                  capacity: { type: ["integer", "null"] },
                },
              },
            },
          });
        }
        if (request.method === "POST") return new Response(null, { status: 201 });
        return undefined;
      },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "ParkingSpot" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /capacity/ })).toHaveValue("12");
    await userEvent.type(screen.getByRole("textbox", { name: /^name/ }), "Hlavná");
    await expectNoViolations(screen.getByTestId("public-form"));
    await userEvent.click(screen.getByRole("button", { name: en.spaces.form.submit }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    const post = requests.find((r) => r.method === "POST") as Request;
    expect(new URL(post.url).pathname).toBe("/api/endpoint/abc/ngsi-ld/v1/entities");
    expect(post.credentials).toBe("omit");
    expect(await screen.findByText(/Created urn:ngsi-ld:ParkingSpot:/)).toBeInTheDocument();
  });

  it("says the form is not published when the Endpoint is gone", async () => {
    renderPage(<PublicFormPage slug="gone" search={new URLSearchParams()} />, {
      path: "/f/gone",
      answer: async (url) => (url.pathname.startsWith("/api/endpoint/gone/") ? json({ title: "Not Found" }, 404) : undefined),
    });
    expect(await screen.findByText(en.spaces.form.notPublished)).toBeInTheDocument();
  });
});
