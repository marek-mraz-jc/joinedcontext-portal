/**
 * A list field's example fills the list's item, never the list itself (T-2257; UI-02).
 *
 * The live journey measured this on dev on 2026-09-19: two array fields of the data source form
 * answered "Invalid type" because a list example was written at the array while the control a
 * person types into is the array's *item*. Since T-2882 a form carries one example at most; the
 * Group form's is on a list item (a member's address), so it is the case this file keeps.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): the cases in this file drive
// src/components/forms/widgets/index.ts, src/schemas/forms/index.ts through the page they belong to; each was confirmed by
// making the module throw and watching this file go red.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { SchemaForm } from "../src/components/forms/SchemaForm";
import { arrange, index, paths } from "../src/components/forms/uischema";
import { portalThemeWidgets } from "../src/components/forms/theme";
import { portalWidgets } from "../src/components/forms/widgets";
import { shippedForms } from "../src/schemas/forms";
import { groupSchema } from "../src/schemas/kinds";
import type { JsonSchema } from "../src/components/forms/types";

/** The arrangement a dialog would hand the form for one kind and schema. */
function arranged(kind: string, schema: JsonSchema) {
  const manifest = index([...shippedForms]).forms[kind];
  expect(manifest, `${kind} ships an arrangement`).toBeDefined();
  return arrange(manifest, {
    locale: "en",
    properties: paths(schema),
    required: schema.required,
    widgets: [...Object.keys(portalThemeWidgets), ...Object.keys(portalWidgets)],
    examples: { project: "air", orgDomain: "city.example" },
  });
}

describe("a list field's example", () => {
  it("fills the first item, not the list itself", async () => {
    const user = userEvent.setup();
    const schema = groupSchema((key: string) => key);
    const { uiSchema, problems } = arranged("Group", schema);
    expect(problems).toEqual([]);

    render(
      <I18nextProvider i18n={i18n}>
        <SchemaForm
          schema={schema}
          uiSchema={uiSchema}
          formData={{ name: "project-leads", members: [{ user: "" }] }}
          submitLabel="Check"
          onSubmit={() => {}}
        />
      </I18nextProvider>,
    );

    const offers = screen.getAllByRole("button", { name: en.form.useExample });
    expect(offers, "the form offers one example").toHaveLength(1);
    await user.click(offers[0]);

    const values = screen.getAllByRole("textbox").map((field) => (field as HTMLInputElement).value);
    expect(
      values.some((value) => /^name\.surname@city\.example$/.test(value)),
      `the member's address holds the example: ${JSON.stringify(values)}`,
    ).toBe(true);
    expect(
      values.some((value) => value.startsWith("[") || value.includes("object Object")),
      `no field holds the list itself: ${JSON.stringify(values)}`,
    ).toBe(false);
  });
});
