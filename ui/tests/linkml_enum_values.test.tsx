/**
 * T-2706, UI-86: the editor writes what the grid shows for an enum value (its title and its
 * description), removes a value, and gives each enum its own box for a new value.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { LinkmlVisualEditor } from "../src/pages/models/LinkmlVisualEditor";
import { parseModel } from "../src/pages/models/linkml";
import { applyOperations } from "../src/pages/models/operations";

const SOURCE = `# alerts
id: https://hel.fi/models/alerts
name: alerts
classes: {}
slots: {}
enums:
  AlertCategory:
    permissible_values:
      traffic:
        title: Traffic
      weather: {}
      health:
  Severity:
    permissible_values:
      low: {}
`;

const values = (source: string, name = "AlertCategory") =>
  parseModel(source).enums.find((entry) => entry.name === name)?.permissible_values ?? [];

describe("enum value operations", () => {
  it("writes a title per language, keeping a plain-string title as the English one", () => {
    const { source, refused } = applyOperations(SOURCE, [
      { op: "setEnumValue", enum: "AlertCategory", value: "traffic", field: "title", locale: "sk", text: "Doprava" },
      { op: "setEnumValue", enum: "AlertCategory", value: "health", field: "title", locale: "en", text: "Health" },
      { op: "setEnumValue", enum: "AlertCategory", value: "weather", field: "description", text: "Storms, ice" },
    ]);
    expect(refused).toEqual([]);
    expect(values(source)).toEqual([
      { name: "traffic", title: { en: "Traffic", sk: "Doprava" } },
      { name: "weather", description: "Storms, ice" },
      { name: "health", title: { en: "Health" } },
    ]);
    // The comment and the other enum survive the edit.
    expect(source.startsWith("# alerts\n")).toBe(true);
    expect(values(source, "Severity").map((value) => value.name)).toEqual(["low"]);
  });

  it("removes a title or a description when its text is emptied", () => {
    const { source } = applyOperations(SOURCE, [
      { op: "setEnumValue", enum: "AlertCategory", value: "traffic", field: "title", locale: "en", text: "" },
    ]);
    expect(values(source)[0]).toEqual({ name: "traffic" });
    expect(source).not.toContain("title");
  });

  it("removes a value and leaves the others", () => {
    const { source, refused } = applyOperations(SOURCE, [{ op: "removeEnumValue", enum: "AlertCategory", value: "weather" }]);
    expect(refused).toEqual([]);
    expect(values(source).map((value) => value.name)).toEqual(["traffic", "health"]);
  });

  it("refuses a value or an enum the model does not have, and a title without a language", () => {
    const refusedOf = (operation: Parameters<typeof applyOperations>[1][number]) =>
      applyOperations(SOURCE, [operation]).refused.map((one) => one.reason);
    expect(refusedOf({ op: "removeEnumValue", enum: "AlertCategory", value: "fire" })).toEqual([
      "enum 'AlertCategory' has no value 'fire'",
    ]);
    expect(refusedOf({ op: "setEnumValue", enum: "Nope", value: "x", field: "description", text: "y" })).toEqual([
      "unknown enum 'Nope'",
    ]);
    expect(refusedOf({ op: "setEnumValue", enum: "AlertCategory", value: "traffic", field: "title", text: "T" })).toEqual([
      "a title needs the language it is written in",
    ]);
  });
});

function Harness() {
  const [source, setSource] = useState(SOURCE);
  return (
    <>
      <LinkmlVisualEditor source={source} onChange={setSource} locales={["sk", "en"]} />
      <textarea readOnly aria-label="source" value={source} />
    </>
  );
}

describe("the editor's enums", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    render(
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>,
    );
  });

  const boxOf = (name: string) =>
    screen.getByLabelText(en.models.newEnumValue.replace("{name}", name)) as HTMLInputElement;

  it("gives each enum its own box for a new value", async () => {
    await userEvent.type(boxOf("AlertCategory"), "fire");
    expect(boxOf("AlertCategory").value).toBe("fire");
    expect(boxOf("Severity").value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: en.models.addValue.replace("{name}", "AlertCategory") }));
    expect(values((screen.getByLabelText("source") as HTMLTextAreaElement).value).map((v) => v.name)).toContain("fire");
    expect(boxOf("AlertCategory").value).toBe("");
  });

  it("edits a value's title and removes a value", async () => {
    await userEvent.click(screen.getByText("weather"));
    const title = document.getElementById("enum-AlertCategory-weather-title-sk") as HTMLInputElement;
    await userEvent.type(title, "Počasie");
    const source = () => (screen.getByLabelText("source") as HTMLTextAreaElement).value;
    expect(values(source())[1].title).toEqual({ sk: "Počasie" });
    await userEvent.click(screen.getByRole("button", { name: en.models.removeEnumValue.replace("{value}", "weather") }));
    expect(values(source()).map((value) => value.name)).toEqual(["traffic", "health"]);
  });
});
