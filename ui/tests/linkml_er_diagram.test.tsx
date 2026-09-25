/** T-2738: the model as an ER diagram, one line per relationship with its multiplicities (DM-13, DM-64, DM-65, UI-84). */
import { useState } from "react";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { LinkmlEditor } from "../src/pages/models/LinkmlEditor";
import { LinkmlGraphView } from "../src/pages/models/LinkmlGraphView";
import { graphData, parseModel } from "../src/pages/models/linkml";
import { expectNoRawKeys } from "./checks";
import { expectNoAxeViolations, inEveryLocale, renderPart } from "./page_contract";

/** Rozvoj's schools: every cardinality once, the source of each marked by its delete rule. */
const SCHOOLS = `id: https://rozvoj.sk/models/schools
name: schools
prefixes:
  rz: https://rozvoj.sk/terms/
default_prefix: rz
classes:
  School:
    slots: [principal, pupils]
  User:
    slots: [principalOf, school, courses]
  Course:
    slots: [students, grades]
  Grade:
    slots: [course]
slots:
  principal:
    range: User
    required: true
    inverse: principalOf
    annotations: { ngsi_ld_kind: Relationship, on_delete: restrict }
  principalOf:
    range: School
    inverse: principal
    annotations: { ngsi_ld_kind: Relationship }
  pupils:
    range: User
    multivalued: true
    inverse: school
    annotations: { ngsi_ld_kind: Relationship, on_delete: cascade }
  school:
    range: School
    required: true
    inverse: pupils
    annotations: { ngsi_ld_kind: Relationship }
  course:
    range: Course
    required: true
    inverse: grades
    annotations: { ngsi_ld_kind: Relationship, on_delete: cascade }
  grades:
    range: Grade
    multivalued: true
    inverse: course
    annotations: { ngsi_ld_kind: Relationship }
  students:
    range: User
    multivalued: true
    inverse: courses
    annotations: { ngsi_ld_kind: Relationship, on_delete: set-null }
  courses:
    range: Course
    multivalued: true
    inverse: students
    annotations: { ngsi_ld_kind: Relationship }
`;

const opening = (name: string, inverse: string, source: string, target: string) =>
  en.models.graph.openRelationship
    .replace("{name}", name)
    .replace("{inverse}", inverse)
    .replace("{source}", source)
    .replace("{target}", target);

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("the diagram's lines", () => {
  it("draws each pair as one line with the multiplicity at both ends", () => {
    const { edges } = graphData(parseModel(SCHOOLS));
    // No `range` line for an end: the pair is the one line.
    expect(edges.filter((edge) => edge.kind === "range")).toEqual([]);
    expect(
      edges.map((edge) => [edge.from, edge.label, edge.fromMultiplicity, edge.cardinality, edge.toMultiplicity, edge.inverse, edge.to]),
    ).toEqual([
      // One School has one principal, and a User is principal of at most one School.
      ["School", "principal", "0..1", "one-to-one", "1", "principalOf", "User"],
      // One School has many pupils; each pupil has exactly one School.
      ["School", "pupils", "1", "one-to-many", "*", "school", "User"],
      ["Course", "students", "*", "many-to-many", "*", "courses", "User"],
      // Many Grades share one Course, and a Grade has exactly one.
      ["Grade", "course", "*", "many-to-one", "1", "grades", "Course"],
    ]);
  });

  it("shows the multiplicities on the drawn line, and the field with its inverse", () => {
    renderPart(<LinkmlGraphView source={SCHOOLS} />);
    const line = screen.getByRole("button", { name: opening("pupils", "school", "School", "User") });
    const texts = [...line.querySelectorAll("text")].map((text) => text.textContent);
    expect(texts).toEqual(["pupils / school", "1", "*"]);
    expect(screen.getByText(en.models.graph.legendRelationship)).toBeInTheDocument();
  });

  it("draws a class related to itself as a loop", () => {
    const self = `name: org
classes:
  Unit:
    slots: [parent, children]
slots:
  parent:
    range: Unit
    inverse: children
    annotations: { ngsi_ld_kind: Relationship, on_delete: restrict }
  children:
    range: Unit
    multivalued: true
    inverse: parent
    annotations: { ngsi_ld_kind: Relationship }
`;
    renderPart(<LinkmlGraphView source={self} />);
    const loop = screen.getByRole("button", { name: opening("parent", "children", "Unit", "Unit") });
    expect(loop.querySelector("path")?.getAttribute("d")).toContain("C");
  });
});

describe("what a press opens", () => {
  it("opens the class by its box and the relationship by its line, by pointer and by keyboard", async () => {
    const user = userEvent.setup();
    const onOpenClass = vi.fn();
    const onOpenRelationship = vi.fn();
    renderPart(<LinkmlGraphView source={SCHOOLS} onOpenClass={onOpenClass} onOpenRelationship={onOpenRelationship} />);

    await user.click(screen.getByRole("button", { name: en.models.graph.openClass.replace("{name}", "Grade") }));
    expect(onOpenClass).toHaveBeenCalledExactlyOnceWith("Grade");

    await user.click(screen.getByRole("button", { name: opening("course", "grades", "Grade", "Course") }));
    expect(onOpenRelationship).toHaveBeenLastCalledWith("Grade");

    screen.getByRole("button", { name: opening("students", "courses", "Course", "User") }).focus();
    await user.keyboard("{Enter}");
    expect(onOpenRelationship).toHaveBeenLastCalledWith("Course");
    await user.keyboard(" ");
    expect(onOpenRelationship).toHaveBeenCalledTimes(3);
  });

  it("offers Add relationship on the model's own classes only, and edits nothing itself", async () => {
    const user = userEvent.setup();
    const onAddRelationship = vi.fn();
    const people = `name: people
classes:
  Person:
    slots: []
`;
    const importing = `name: x
imports: [people]
classes:
  School:
    slots: []
`;
    renderPart(<LinkmlGraphView source={importing} imports={{ people }} onAddRelationship={onAddRelationship} />);
    expect(screen.queryByRole("button", { name: en.models.graph.addRelationship.replace("{name}", "Person") })).toBeNull();

    screen.getByRole("button", { name: en.models.graph.addRelationship.replace("{name}", "School") }).focus();
    await user.keyboard("{Enter}");
    expect(onAddRelationship).toHaveBeenCalledExactlyOnceWith("School");
  });

  it("opens the Add relationship form of the structure view from a box", async () => {
    const user = userEvent.setup();
    function Editor() {
      const [source, setSource] = useState(SCHOOLS);
      return <LinkmlEditor source={source} onChange={setSource} initialView="graph" />;
    }
    renderPart(<Editor />);
    await user.click(screen.getByRole("button", { name: en.models.graph.addRelationship.replace("{name}", "Course") }));
    expect(screen.getByRole("form", { name: "Add a relationship from Course" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Course", level: 2 })).toBeInTheDocument();
  });
});

describe("reading it without the picture", () => {
  it("lists every relationship in a table beside the drawing", () => {
    renderPart(<LinkmlGraphView source={SCHOOLS} />);
    const table = screen.getByRole("table", { name: en.models.graph.table });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => row.textContent);
    expect(rows).toEqual([
      "One School has one UserSchool.principalUser.principalOfSchool 0..1 — 1 User",
      "One School has many User entitiesSchool.pupilsUser.schoolSchool 1 — * User",
      "Many Course entities have many User entitiesCourse.studentsUser.coursesCourse * — * User",
      "Many Grade entities share one CourseGrade.courseCourse.gradesGrade * — 1 Course",
    ]);
  });

  it("zooms in, out and back to fit, and says the level", async () => {
    const user = userEvent.setup();
    const { container } = renderPart(<LinkmlGraphView source={SCHOOLS} />);
    const svg = container.querySelector("svg[role='group']") as SVGSVGElement;
    const width = () => Number(svg.getAttribute("width"));
    const natural = width();

    await user.click(screen.getByRole("button", { name: en.models.graph.zoomIn }));
    expect(width()).toBeCloseTo(natural * 1.25);
    expect(screen.getByText("Zoom 125 %")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.models.graph.zoomOut }));
    await user.click(screen.getByRole("button", { name: en.models.graph.zoomOut }));
    expect(width()).toBeCloseTo(natural / 1.25);
    // The frame has no width in a DOM without layout, so fit falls back to the natural size.
    await user.click(screen.getByRole("button", { name: en.models.graph.fit }));
    expect(width()).toBeCloseTo(natural);
  });

  it("draws names that arrive as markup as text", () => {
    const hostile = SCHOOLS.replaceAll("pupils", '"<img src=x onerror=alert(1)>"');
    const { container } = renderPart(<LinkmlGraphView source={hostile} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: opening("<img src=x onerror=alert(1)>", "school", "School", "User") })).toBeInTheDocument();
  });

  it("reads in every locale with no raw key and no axe violation", async () => {
    await inEveryLocale(async () => {
      const { container, unmount } = renderPart(<LinkmlGraphView source={SCHOOLS} onAddRelationship={() => undefined} />);
      expectNoRawKeys(container);
      await expectNoAxeViolations(container);
      unmount();
    });
  });
});
