// Personal data in the model editor (T-4667, DM-120, DM-121): the annotations an operation writes,
// the refusals, the check that keeps a model unsaved until a personal class says why and how long,
// and the fields the editor shows.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { parse } from "yaml";
import i18n from "../src/i18n";
import { diagnose, parseModel } from "../src/pages/models/linkml";
import { applyOperations } from "../src/pages/models/operations";
import type { Operation } from "../src/pages/models/operations";
import { LinkmlVisualEditor } from "../src/pages/models/LinkmlVisualEditor";

const TRIPS = `id: https://example.org/trips
name: trips
prefixes:
  ex: https://example.org/
classes:
  BikeTrip:
    class_uri: ex:BikeTrip
    slots: [rider, startedAt]
slots:
  rider:
    slot_uri: ex:rider
    range: string
  startedAt:
    slot_uri: ex:startedAt
    range: datetime
`;

const apply = (source: string, ...operations: Operation[]) => applyOperations(source, operations);
const errors = (source: string) =>
  diagnose(source).filter((d) => d.severity === "error").map((d) => d.message);

const personal = (target: "class" | "slot", name: string, field: string, value: string | boolean, locale?: string) =>
  ({ op: "setPersonal", target, name, field, value, locale }) as Operation;

describe("personal-data annotations", () => {
  it("writes the class and slot annotations of DM-120 and reads them back", () => {
    const { source, refused } = apply(
      TRIPS,
      personal("slot", "rider", "personalData", true),
      personal("slot", "rider", "ingest", "keyedHash"),
      personal("class", "BikeTrip", "legalBasis", "public-task"),
      personal("class", "BikeTrip", "purpose", "Planning the bike network", "en"),
      personal("class", "BikeTrip", "purpose", "Plánovanie siete cyklotrás", "sk"),
      personal("class", "BikeTrip", "maxRetention", "P90D"),
      personal("class", "BikeTrip", "dataSubjectRef", "rider"),
    );
    expect(refused).toEqual([]);
    const doc = parse(source);
    expect(doc.slots.rider.annotations).toEqual({ personalData: true, ingest: "keyedHash" });
    expect(doc.classes.BikeTrip.annotations).toEqual({
      legalBasis: "public-task",
      purpose: { en: "Planning the bike network", sk: "Plánovanie siete cyklotrás" },
      maxRetention: "P90D",
      dataSubjectRef: "rider",
    });
    const model = parseModel(source);
    expect(model.classes[0]?.personal?.maxRetention).toBe("P90D");
    expect(model.slots.find((s) => s.name === "rider")?.ingest).toBe("keyedHash");
    expect(errors(source)).toEqual([]);
  });

  it("removes an annotation set empty, false or to the default keep", () => {
    const set = apply(
      TRIPS,
      personal("slot", "rider", "personalData", true),
      personal("slot", "rider", "ingest", "drop"),
    ).source;
    const cleared = apply(
      set,
      personal("slot", "rider", "ingest", "keep"),
      personal("slot", "rider", "personalData", false),
    ).source;
    expect(parse(cleared).slots.rider.annotations).toBeUndefined();
  });

  it("refuses a value the platform does not read, and nothing of the list lands", () => {
    for (const [operation, reason] of [
      [personal("class", "BikeTrip", "legalBasis", "because"), "is not one of consent"],
      [personal("class", "BikeTrip", "maxRetention", "90 days"), "is not an ISO 8601 duration"],
      [personal("class", "BikeTrip", "dataSubjectRef", "nobody"), "is not a slot of class"],
      [personal("slot", "rider", "ingest", "encrypt"), "is not one of keep"],
      [personal("slot", "rider", "legalBasis", "consent"), "a slot carries no 'legalBasis'"],
      [personal("class", "BikeTrip", "purpose", "no language"), "written per language"],
      [personal("class", "Ghost", "personalData", true), "unknown class"],
    ] as const) {
      const { source, refused } = apply(TRIPS, personal("slot", "rider", "personalData", true), operation);
      expect(refused[0]?.reason, reason).toContain(reason);
      expect(source).toBe(TRIPS);
    }
  });

  it("keeps a purpose written as one string as English when another language is added", () => {
    const plain = TRIPS.replace("    slots: [rider, startedAt]", "    slots: [rider, startedAt]\n    annotations:\n      purpose: Planning");
    const { source } = apply(plain, personal("class", "BikeTrip", "purpose", "Plánovanie", "sk"));
    expect(parse(source).classes.BikeTrip.annotations.purpose).toEqual({ en: "Planning", sk: "Plánovanie" });
  });
});

describe("a class that holds personal data does not save without its reasons (DM-120)", () => {
  it("names what is missing when a slot of the class is personal", () => {
    const source = apply(TRIPS, personal("slot", "rider", "personalData", true)).source;
    expect(errors(source)).toEqual([
      "class 'BikeTrip' holds personal data and needs legalBasis, purpose, maxRetention (DM-120)",
    ]);
  });

  it("asks the same of a class marked personal itself, and refuses written-in values it cannot read", () => {
    const marked = TRIPS.replace(
      "    slots: [rider, startedAt]",
      "    slots: [rider, startedAt]\n    annotations:\n      personalData: true\n      legalBasis: whim\n      purpose: x\n      maxRetention: forever\n      dataSubjectRef: ghost",
    ).replace("    range: string", "    range: string\n    annotations:\n      ingest: encrypt");
    expect(errors(marked)).toEqual([
      "class 'BikeTrip' legalBasis 'whim' is not one of consent, contract, legal-obligation, vital-interest, public-task, legitimate-interest (DM-120)",
      "class 'BikeTrip' maxRetention 'forever' is not an ISO 8601 duration such as P90D (DM-120)",
      "class 'BikeTrip' dataSubjectRef 'ghost' is not a slot of the class (DM-120)",
      "slot 'rider' ingest 'encrypt' is not one of keep, drop, keyedHash (DM-121)",
    ]);
  });

  it("asks nothing of a model without personal data", () => {
    expect(errors(TRIPS)).toEqual([]);
  });
});

describe("the editor's personal-data fields", () => {
  const mount = (source: string) => {
    let latest = source;
    const view = render(
      <I18nextProvider i18n={i18n}>
        <LinkmlVisualEditor source={source} onChange={(next) => (latest = next)} locales={["en", "sk"]} />
      </I18nextProvider>,
    );
    return { view, latest: () => latest };
  };

  it("shows the class's legal basis, retention and purpose only once it holds personal data", () => {
    const { view, latest } = mount(TRIPS);
    expect(screen.queryByLabelText(/Legal basis/)).toBeNull();
    fireEvent.click(screen.getByLabelText("This class holds personal data"));
    expect(parse(latest()).classes.BikeTrip.annotations).toEqual({ personalData: true });

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <LinkmlVisualEditor source={latest()} onChange={() => undefined} locales={["en", "sk"]} />
      </I18nextProvider>,
    );
    expect(screen.getByLabelText(/Legal basis/)).toBeTruthy();
    expect(screen.getByLabelText(/Kept at most/)).toBeTruthy();
    expect(screen.getByLabelText("Purpose (sk)")).toBeTruthy();
    expect(screen.getByLabelText(/Data subject/)).toBeTruthy();
  });
});
