import { describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import { schoolOf, sorted, tenth, toCsv, totals } from "./coverage";
import { SCHOOLS } from "./fixtures/skoly";

const schools = SCHOOLS.map((entity) => schoolOf(toRichRow(entity), "sk"));
const byId = (suffix: string) => schools.find((one) => one.id.endsWith(suffix))!;

describe("a school's ratios", () => {
  it("come only from the counts the school published", () => {
    expect(byId("zs-moyzesova").pupilsPerTeacher).toBeCloseTo(12.8);
    expect(byId("zs-moyzesova").budgetPerPupil).toBe(5000);
    expect(byId("sos-bez-udajov")).toMatchObject({ pupils: null, teachers: null, pupilsPerTeacher: null, budgetPerPupil: null });
  });

  it("are never a division by zero", () => {
    const empty = schoolOf(toRichRow({ id: "urn:ngsi-ld:School:x:y:z", type: "School", pupilCount: { type: "Property", value: 0 }, teachingStaff: { type: "Property", value: 0 } }), "sk");
    expect(empty.pupilsPerTeacher).toBeNull();
    expect(empty.budgetPerPupil).toBeNull();
  });
});

describe("the city's totals", () => {
  it("take the city ratio as all pupils over all teachers, and count what is incomplete", () => {
    const sum = totals(schools);
    const both = schools.filter((one) => one.pupils !== null && one.teachers !== null);
    const expected = both.reduce((a, one) => a + one.pupils!, 0) / both.reduce((a, one) => a + one.teachers!, 0);
    expect(sum.pupilsPerTeacher).toBeCloseTo(expected);
    expect(sum.schools).toBe(12);
    expect(sum.incomplete).toBe(1);
  });
});

describe("the city's tenth", () => {
  it("is the value the highest or lowest tenth starts at, and nothing for fewer than ten schools", () => {
    const ratios = schools.map((one) => one.pupilsPerTeacher);
    const high = tenth(ratios, "high")!;
    // Eleven schools publish both counts: a tenth of them is two (ceil(11 / 10)).
    expect(ratios.filter((r) => r !== null && r >= high)).toHaveLength(2);
    const budgets = schools.map((one) => one.budgetPerPupil);
    const low = tenth(budgets, "low")!;
    expect(budgets.filter((b) => b !== null && b <= low)).toHaveLength(2);
    // Exactly ten known values: a tenth is one.
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(tenth(ten, "high")).toBe(10);
    expect(tenth(ten, "low")).toBe(1);
    expect(tenth(ratios.slice(0, 9), "high")).toBeNull();
  });
});

describe("sorting", () => {
  it("puts a missing value last whichever the direction", () => {
    expect(sorted(schools, "pupils", true).at(-1)?.id).toMatch(/sos-bez-udajov/);
    expect(sorted(schools, "pupils", false).at(-1)?.id).toMatch(/sos-bez-udajov/);
    expect(sorted(schools, "pupils", false)[0].pupils).toBe(690);
  });
});

describe("the CSV", () => {
  it("quotes what needs quoting and never lets a cell run as a formula", () => {
    const csv = toCsv([byId("zs-vzorec"), byId("sos-bez-udajov")], ["Škola", "Adresa", "a", "b", "c", "d", "e", "f", "g"]);
    const [header, formula, missing] = csv.trimEnd().split("\r\n");
    expect(header).toBe("Škola,Adresa,a,b,c,d,e,f,g");
    expect(formula.startsWith(`"'=HYPERLINK(""http://example.org""), Námestie 1"`)).toBe(true);
    expect(missing).toBe("Stredná odborná škola, Tajovského 30,Tajovského 30, Banská Bystrica,,,,,,,".replace("Stredná odborná škola, Tajovského 30", '"Stredná odborná škola, Tajovského 30"').replace("Tajovského 30, Banská Bystrica", '"Tajovského 30, Banská Bystrica"'));
  });
});
