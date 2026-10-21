// covers (T-2137, the module gate in gate_modules.test.ts): src/components/pickers/PersonPicker.tsx.
/**
 * T-4947: a person is picked from the realm's people the server lists to this caller, searched
 * on the server; someone not signed in yet is named by a full e-mail and by nothing else.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { PersonPicker } from "../src/components/pickers/PersonPicker";

const PEOPLE = [
  { id: "1", email: "Jana@Hel.fi", firstName: "Jana", lastName: "K", enabled: true, emailVerified: true, requiredActions: [] },
  { id: "2", email: "petra@hel.fi", firstName: "Petra", lastName: "N", enabled: true, emailVerified: true, requiredActions: [] },
  { id: "3", email: "gone@hel.fi", firstName: "Gone", lastName: "", enabled: false, emailVerified: true, requiredActions: [] },
];

function stub(readsPeople: boolean): string[] {
  const searched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL((input as Request).url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      if (url.pathname.endsWith("/permissions/me")) {
        return json({ project: "org", bootstrap: false, grants: readsPeople ? [{ rule: { kinds: ["Person"], verbs: ["read"] } }] : [] });
      }
      if (url.pathname === "/api/v1/organization/people") {
        const search = url.searchParams.get("search") ?? "";
        searched.push(search);
        return json({ items: PEOPLE.filter((p) => p.email.toLowerCase().includes(search.toLowerCase())), total: 3 });
      }
      return json({ items: [] });
    }),
  );
  return searched;
}

let chosen: string[] = [];
function Holder({ exclude }: { exclude?: string[] }) {
  const [value, setValue] = useState("");
  return (
    <PersonPicker
      label="Person"
      value={value}
      exclude={exclude}
      onChange={(email) => {
        chosen.push(email);
        setValue(email);
      }}
    />
  );
}

function show(exclude?: string[]) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <Holder exclude={exclude} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  chosen = [];
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the person picker (T-4947)", () => {
  it("lists the enabled people by name, leaves out the excluded, and saves the e-mail in lower case", async () => {
    stub(true);
    show(["petra@hel.fi"]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Person" }));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent ?? "")).toEqual([expect.stringContaining("Jana K")]);
    await user.click(options[0]);
    expect(chosen).toEqual(["jana@hel.fi"]);
  });

  it("searches on the server as the person types", async () => {
    const searched = stub(true);
    show();
    const user = userEvent.setup();
    await user.type(screen.getByRole("combobox", { name: "Person" }), "petra");
    await waitFor(() => expect(searched).toContain("petra"));
  });

  it("names someone not signed in yet only by a full e-mail", async () => {
    stub(false);
    show();
    const user = userEvent.setup();
    const box = screen.getByRole("combobox", { name: "Person" });
    await user.click(box);
    expect(await screen.findByText(en.picker.person.unlisted)).toBeInTheDocument();
    await user.type(box, "not an address{Enter}");
    expect(chosen).toEqual([]);
    await user.clear(box);
    await user.type(box, "New.Person@Hel.fi{Enter}");
    expect(chosen).toEqual(["new.person@hel.fi"]);
  });
});
