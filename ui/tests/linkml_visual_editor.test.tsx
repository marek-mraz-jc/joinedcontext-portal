/** T-0218: authoring classes, slots and enums without leaving the document (DM-04…DM-06, DM-13, DM-16). */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";
import i18n, { SUPPORTED_LOCALES } from "../src/i18n";
import { expectNoRawKeys, expectNoViolations, expectTabOrder } from "./checks";
import { LinkmlVisualEditor } from "../src/pages/models/LinkmlVisualEditor";
import { diagnose, parseModel } from "../src/pages/models/linkml";

const SOURCE = `# the model the city publishes
id: https://banskabystrica.sk/models/air
name: air
prefixes:
  bb: https://banskabystrica.sk/terms/
  sdm: https://smartdatamodels.org/
classes:
  AirQualityObserved:
    class_uri: bb:AirQualityObserved
    slots:
      - pm10
slots:
  pm10:
    range: float
    slot_uri: bb:pm10
enums: {}
`;

/** The editor is controlled, so the test holds the one document both views would share. */
function Harness({ initial = SOURCE }: { initial?: string }) {
  const [source, setSource] = useState(initial);
  return (
    <>
      <LinkmlVisualEditor
        source={source}
        onChange={setSource}
        diagnostics={diagnose(source, ["sk", "en"])}
        locales={["sk", "en"]}
      />
      <textarea readOnly aria-label="source" value={source} />
    </>
  );
}

function renderEditor(initial?: string) {
  render(
    <I18nextProvider i18n={i18n}>
      <Harness initial={initial} />
    </I18nextProvider>,
  );
  return {
    source: () => (screen.getByLabelText("source") as HTMLTextAreaElement).value,
    user: userEvent.setup(),
  };
}

describe("LinkML visual editor", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("creates a class, and the YAML keeps the comment that was already there", async () => {
    const { source, user } = renderEditor();

    await user.type(screen.getByLabelText("New class"), "WeatherObserved");
    await user.click(screen.getByRole("button", { name: "Add class" }));

    expect(parseModel(source()).classes.map((klass) => klass.name)).toEqual([
      "AirQualityObserved",
      "WeatherObserved",
    ]);
    expect(source()).toContain("# the model the city publishes");
    expect(await screen.findByRole("button", { name: "WeatherObserved" })).toBeInTheDocument();
  });

  it("adds a slot to the open class and lists it with its range", async () => {
    const { source, user } = renderEditor();

    await user.type(screen.getByLabelText("New slot"), "pm25");
    const slots = screen.getByRole("table");
    await user.click(screen.getByRole("button", { name: "Add slot" }));

    const model = parseModel(source());
    expect(model.classes[0].slots).toEqual(["pm10", "pm25"]);
    expect(model.slots.find((slot) => slot.name === "pm25")?.range).toBe("string");
    expect(within(slots).getByRole("row", { name: /pm10/ })).toBeInTheDocument();
  });

  it("edits a slot's range, kind, unit and required flag through the document", async () => {
    const { source, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: "pm10" }));
    await user.selectOptions(screen.getByLabelText("Range"), "integer");
    await user.selectOptions(screen.getByLabelText("NGSI-LD kind"), "GeoProperty");
    // The unit is searched, not scrolled for (T-2809): the UCUM spelling finds µg/m³.
    await user.type(screen.getByRole("combobox", { name: "Unit" }), "ug/m3");
    await user.keyboard("{Enter}");
    await user.click(screen.getByLabelText("Required"));

    const slot = parseModel(source()).slots.find((candidate) => candidate.name === "pm10");
    expect(slot?.range).toBe("integer");
    expect(slot?.kind).toBe("GeoProperty");
    expect(slot?.required).toBe(true);
    expect(slot?.unit?.ucum_code).toBe("ug.m-3");
    // DM-06: the CEFACT common code travels with the unit, not only the UCUM symbol.
    expect(slot?.unit?.exact_mappings).toEqual(["ucefact:GQ", "qudt-unit:MicroGM-PER-M3"]);
    // DM-05: the kind is the annotation Model Tools reads, not a field of our own.
    expect(source()).toContain("ngsi_ld_kind: GeoProperty");
  });

  /**
   * T-1088, DM-13: the hierarchy the model declares is edited where it is read. The parent is a
   * choice among the model's own classes, so a typo cannot leave a dangling reference behind.
   */
  it("sets a class's parent and mixins, and a slot's profiles, through the document", async () => {
    const { source, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: "AirQualityObserved" }));
    // A class to specialise has to exist before it can be chosen.
    expect(screen.getByLabelText("The class it specialises")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("The class it specialises")).queryByRole("option", {
        name: "AirQualityObserved",
      }),
      "a class is never offered itself as its own parent",
    ).toBeNull();

    await user.type(screen.getByLabelText("Mixed in (comma separated)"), "AirQualityObserved");
    // Itself is refused, so the document is untouched and no mixins key appears.
    expect(source()).not.toContain("mixins:");

    await user.click(screen.getByRole("button", { name: "pm10" }));
    await user.type(screen.getByLabelText("Profiles (comma separated)"), "public");
    expect(
      parseModel(source()).slots.find((candidate) => candidate.name === "pm10")?.subsets,
    ).toEqual(["public"]);
  });

  it("refuses to mint a slot IRI under a namespace that belongs to someone else", async () => {
    const { source, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: "pm10" }));
    await user.clear(screen.getByLabelText("Slot IRI"));
    await user.type(screen.getByLabelText("Slot IRI"), "sdm:pm10");

    expect(await screen.findByRole("alert")).toHaveTextContent("smartdatamodels.org");
    // The refused term never reaches the document, and the field keeps what was typed so the
    // person can correct it rather than watch keystrokes disappear.
    expect(source()).not.toContain("sdm:pm10");
    expect(screen.getByLabelText("Slot IRI")).toHaveValue("sdm:pm10");
  });

  it("lets an upstream slot keep the upstream IRI it cites", async () => {
    const cited = SOURCE.replace(
      "    slot_uri: bb:pm10",
      "    slot_uri: sdm:pm10\n    annotations:\n      upstream_source: https://github.com/smart-data-models/dataModel.Environment@9f1c2b7",
    );
    const { source, user } = renderEditor(cited);

    await user.click(screen.getByRole("button", { name: "pm10" }));
    await user.clear(screen.getByLabelText("Slot IRI"));
    await user.type(screen.getByLabelText("Slot IRI"), "sdm:pm10");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(parseModel(source()).slots[0].slot_uri).toBe("sdm:pm10");
  });

  it("writes a title per configured locale, and warns while one is missing", async () => {
    const { source, user } = renderEditor();

    await user.type(screen.getByLabelText("Title (sk)"), "Kvalita ovzdušia");

    expect(parseModel(source()).classes[0].title).toEqual({ sk: "Kvalita ovzdušia" });
    const warning = await screen.findByText(/has no title in en/, { selector: "p" });
    expect(warning).toBeInTheDocument();
    // In the warning tone, and in a size the theme defines: `text-warning-fg` is a name the
    // theme has for `danger` and `primary` but not for `warning`, so Tailwind emitted nothing
    // and the diagnostic read as ordinary text (T-2422, UI-30).
    expect(warning.className).toContain("text-warning");
    expect(warning.className).toMatch(/\btext-(caption|body)\b/);
  });

  it("adds an enum and a value to it", async () => {
    const { source, user } = renderEditor();

    await user.type(screen.getByLabelText("New enum"), "QualityBand");
    await user.click(screen.getByRole("button", { name: "Add enum" }));

    await user.type(await screen.findByLabelText("New value of QualityBand"), "good");
    await user.click(screen.getByRole("button", { name: "Add value to QualityBand" }));

    const model = parseModel(source());
    expect(model.enums[0].name).toBe("QualityBand");
    expect(model.enums[0].permissible_values.map((value) => value.name)).toEqual(["good"]);
  });
});

/**
 * The UI contract of the structure view (T-1772, UI-04, UI-15, UI-16, UI-44, UI-48).
 *
 * The three flags of a slot were hand-made `<input type="checkbox">` inside a bare `<label>`,
 * the class list was a hand-made `<button>` and the parent a hand-made `<select>`; each is now
 * the shared control, which is what gives them one focus ring, one disabled state and a name a
 * pointer can hit. These tests hold that: axe over the class and the slot open, every control
 * reachable in DOM order, and the four locales on the labels.
 */
describe("the LinkML visual editor against the UI contract", () => {
  /** The editor alone, over the one document it edits: no test widget beside it for axe to read. */
  function Alone({ initial }: { initial: string }) {
    const [source, setSource] = useState(initial);
    return (
      <LinkmlVisualEditor
        source={source}
        onChange={setSource}
        diagnostics={diagnose(source, ["sk", "en"])}
        locales={["sk", "en"]}
      />
    );
  }

  function renderAlone(initial = SOURCE) {
    const view = render(
      <I18nextProvider i18n={i18n}>
        <Alone initial={initial} />
      </I18nextProvider>,
    );
    return { container: view.container, user: userEvent.setup() };
  }

  it("has no axe violation with a class open and with a slot open", async () => {
    await i18n.changeLanguage("en");
    const { container, user } = renderAlone();

    await expectNoViolations(container);

    await user.click(screen.getByRole("button", { name: "pm10" }));
    await screen.findByLabelText("Slot IRI");
    await expectNoViolations(container);
  });

  it("ticks a flag of a slot by its own words, and says which flag it is", async () => {
    await i18n.changeLanguage("en");
    const { user } = renderAlone();
    await user.click(screen.getByRole("button", { name: "pm10" }));

    // The label wraps the box, so the words beside it are the control's name and its hit area.
    const required = screen.getByRole("checkbox", { name: "Required" });
    expect(required).not.toBeChecked();
    await user.click(screen.getByText("Required"));
    expect(required).toBeChecked();

    expect(screen.getByRole("checkbox", { name: "Multivalued" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Deprecated/ })).toBeInTheDocument();
  });

  it("reaches every control of the open slot by keyboard in the order it is read", async () => {
    await i18n.changeLanguage("en");
    const { user } = renderAlone();
    await user.click(screen.getByRole("button", { name: "pm10" }));

    const panel = screen.getByLabelText("Slot IRI").closest("section, div[class*=flex-col]");
    expect(panel).not.toBeNull();
    await expectTabOrder(user, panel as HTMLElement);
  });

  it("offers the parent class as a choice, not as free text a typo breaks", async () => {
    await i18n.changeLanguage("en");
    const { user } = renderAlone(
      SOURCE.replace(
        "slots:\n  pm10:",
        "  Station:\n    class_uri: bb:Station\n    slots: []\nslots:\n  pm10:",
      ),
    );
    await user.click(screen.getByRole("button", { name: "AirQualityObserved" }));

    const parent = screen.getByLabelText("The class it specialises");
    expect(parent.tagName).toBe("SELECT");
    expect(within(parent).getByRole("option", { name: "Station" })).toBeInTheDocument();
  });

  it.each(SUPPORTED_LOCALES)("labels the slot's flags in %s", async (locale) => {
    await i18n.changeLanguage(locale);
    const { container, user } = renderAlone();
    await user.click(screen.getByRole("button", { name: "pm10" }));

    for (const key of ["models.required", "models.multivalued", "models.deprecatedKeep"]) {
      expect(
        screen.getByRole("checkbox", { name: i18n.t(key) }),
        `${key} has a ${locale} label`,
      ).toBeInTheDocument();
    }
    expectNoRawKeys(container);
  });
});
