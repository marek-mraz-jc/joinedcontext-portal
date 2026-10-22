---
sidebar_position: 12
title: Mapping and Representation Contract
description: One versioned, open contract for every mapping and representation an Endpoint carries; named outputs per format, strict semantic members, ignored non-semantic metaslots, and a new attribute kind that degrades one slot instead of an Organization's every surface.
---

# Mapping and Representation Contract

Every surface of an Endpoint (OData, the LinkML schema surface, OGC API Features, GeoJSON, CSV, SensorThings, iCalendar, feeds and the widget presentation) reads its shape from a mapping: a LinkML model, a view mapping IR, or a `spec.representations.<format>` member. This page states the rules every such contract follows, so a Portal, a gateway and a broker released on different days agree, and a change in NGSI-LD or LinkML closes no Organization's surfaces (T-5207). The surfaces themselves are specified in [API/02](02-endpoint-representations.md); the change promise to consumers is [API/10](10-api-change-policy.md).

## 1. Versions

- **EP-152** [A] — Every mapping and representation contract MUST carry a `version` member (an integer, `1` when absent for the contracts that predate this rule): `spec.representations.<format>` and each of its outputs, the view mapping IR (`version: 2`, DM-52), and the broker's own mapping of a surface. A member added with a new meaning, a member removed, or a default changed takes the next version; adding an optional member whose absence keeps today's answer does not.
- **EP-153** [A] — A reader MUST read the version it implements strictly, and MUST NOT serve a newer version as if it were its own. For a representation of an Endpoint, a newer version than the broker reads (the Portal released first) MUST be served from the members the broker does read, over the output's preset, with a log warning; it MUST NOT fail the whole surface with `500`. The view mapping IR is the exception: an IR of another version is refused when the view is loaded (`400` naming both versions), because a partial inversion of a query widens or narrows what a caller reads.
- **EP-154** [A] — Vocabulary namespaces MUST be versioned. The OData vocabulary `Antares.NgsiLd` states `Core.SchemaVersion`; a term removed or retyped goes to a new namespace (`Antares.NgsiLd.V2`) served beside the old one for the 90 days of [API/10](10-api-change-policy.md). The OData service of a view MUST publish `Core.SchemaVersion` on its schema as `{LinkML schema version}.m{mapping version}` (`2.1.0.m1`, `0` without a schema version) and MUST answer `$schemaversion` for that value and for `*`. The broker's mapping version is bumped in the change that alters how a slot shapes, types or reads.

## 2. Open where it is safe, strict where it matters

- **EP-155** [S][A] — A reader MUST ignore only a listed set of non-semantic members: provenance and generator stamps (`@type`, `from_schema`, `imported_from`, `source_file*`, `generation_date`, `metamodel_version`, `domain_of`, `owner`), mappings to other vocabularies (`exact_mappings` and the other SKOS mappings outside a unit), and editorial text (`notes`, `comments`, `examples`, `todos`, `see_also`, `aliases`, `keywords`, `title` and `rank` where the element does not read them). The list lives in one place per reader (`linkml_model::NON_SEMANTIC` in the broker) and is extended only by a reviewed change. A generator's merged `linkml:types` copy and a class's induced `attributes` (each one a slot the class or an ancestor lists) MUST load; a bool or number annotation MUST read as its string. Real `gen-linkml` JSON and YAML output MUST load; a fixture of each runs in CI.
- **EP-156** [S][A] — Every other unknown member MUST be refused, naming the member: a LinkML metaslot that changes meaning (`any_of`, `mixins`, an own `types` entry, a class-local attribute), an unknown view mapping IR member (a typo such as `ofset` is refused with the slot index, never read as `0`), and an unknown member of a representation output. Anything that widens access (a rule, a filter, a role, a scope) MUST stay strict at every version.
- **EP-157** [A][H] — A typo in a semantic member MUST be refused when the Endpoint is saved (the gateway's check at propose, `422` with the member's path and name), never discovered at serve time. The broker's serve-time strictness is the second line: a contract that passed the save check fails at serve time only through a release-order defect, and then answers per rule EP-153.

## 3. A new attribute kind degrades one slot

- **EP-158** [A] — A slot whose `ngsi_ld_kind` names a kind outside the eight of NGSI-LD 1.9 (`Property`, `Relationship`, `GeoProperty`, `LanguageProperty`, `VocabProperty`, `ListProperty`, `ListRelationship`, `JsonProperty`) MUST load. Every surface MUST serve that slot alone as an untyped value with its kind stated, never filtered, sorted or written through: OData `Edm.Untyped` with `Core.Computed` and `NgsiLd.Kind`, OGC a property of any JSON value that is not queryable or sortable, the LinkML JSON Schema an unconstrained property with `x-ngsi-ld-kind`, and the `@context` no type coercion. The rest of the schema and every other surface of the Organization keep serving. A kind value that is no kind name (empty, lower case, with a space) stays a malformed schema.

## 4. Named outputs per format

- **EP-159** [A][H] — `spec.representations.<format>` (feed, ical, ogc, geojson, csv, sta, odata, widget) MUST be a list of named outputs. Each output carries `name` (a DNS-1123 label, unique on the Endpoint, part of the URL), `title` and `description` per language, `version`, `sources` (one or more model classes, from one LinkML model or from several; each `{type, preset}` or `{type, mapping}`, where `mapping` maps a role to an attribute path or to a list of paths of which the first with a value wins), an optional `filter` object (`q`, `scopeQ`, `georel`, `geometry`, `coordinates`, `geoproperty`) that only narrows the view, sent as `(filter);(caller's q)`, while the Policy still decides per entity, and optional `lang`, `sort` and `limit`. An unknown member refuses that output, never the whole view. At most 20 outputs per format and Endpoint; a duplicate name or a 21st output is refused when the Endpoint is saved. With no list a format serves one output per type as today, except feed and iCal, which serve nothing until an output is listed (EP-150, EP-151).

The roles a source maps, per format:

| Format | Roles of one source | URL of an output |
|---|---|---|
| feed | title and updated (required), summary, content, link, published, author, category, image; presets `event`, `article`, `generic`; `sort` `updated` or `published`, `limit` 1..200 (50) | `/feed/v1/{name}/{atom.xml\|rss.xml\|feed.json}` (EP-150) |
| ical | the RFC 5545 fields of API/02 §8b (SUMMARY, DTSTART, DTEND or DURATION, LOCATION, GEO, URL, ORGANIZER, CATEGORIES, STATUS); `timezone` (default `Europe/Bratislava`); `sort` `start` or `-start` | `/ical/v1/{name}.ics`; `/ical/v1/events.ics` stays an alias of the first iCal output, deprecated |
| ogc, geojson | the geometry (`location`, `observationSpace`, `operationSpace` or a model GeoProperty), the time instant or interval, the served properties | OGC `collections/{name}`; GeoJSON `/geojson/v1/{name}` |
| csv | columns in order with labels; one CSV per type, or a union with a `type` column | `/csv/v1/{name}.csv` |
| sta | the attributes that become Datastreams | `/sta/v1.1/` with the output's Things |
| widget | columns, order, width, formats, units, enum labels, sort, map popup (T-5196) | the dataset page |

The gateway checks every role against the model when the Endpoint is saved: a slot the model does not have, a slot of the wrong range (a geometry role on a non-GeoProperty, a time role on a non-date slot) or a filter that does not parse is refused and named. The Portal edits outputs with the chain of the widget columns: the Endpoint's config first, then the data model, then `field-order.json` (T-5196). The dataset page lists every feed and iCal output by its title under "Odoberať" (grouped Kalendár and Novinky), and the DCAT distribution and the `<link rel="alternate">` repeat once per output.

Example, two outputs of one Endpoint over two event classes and two geometries:

```yaml
spec:
  representations:
    ical:
      - name: sport
        version: 1
        title: {sk: Športové podujatia, en: Sports events}
        sources:
          - type: SportEvent
            preset: sdm-event
          - type: Event
            preset: sdm-event
        filter: {q: 'eventCategory=="šport"'}
    ogc:
      - name: venues
        version: 1
        title: {sk: Miesta konania, en: Venues}
        sources:
          - type: Event
            mapping: {geometry: location, instant: startDate}
      - name: catchment
        version: 1
        title: {sk: Spádové územie, en: Catchment area}
        sources:
          - type: Event
            mapping: {geometry: operationSpace}
```

## 5. One IR version across the platform

- **EP-160** [A] — The view mapping IR version MUST be one constant per repository (broker `antares_ops::mapping::IR_VERSION`, gateway `context_gateway::view_mapping::IR_VERSION`, Model Tools `compile_mapping_ir.IR_VERSION`), and a test MUST fail when they disagree: the gateway's test reads the broker's and Model Tools' constants at the revisions the platform pins. The additive-member policy of section 1 applies to version 2; a member that changes how a query inverts takes version 3, released broker first, then gateway, then Model Tools.

## Related

- [API/02 Endpoint Representations](02-endpoint-representations.md)
- [API/10 Public API Change Policy](10-api-change-policy.md)
- [Requirements: Endpoints & Parity](../Requirements/endpoints.md)
- [Requirements: Data Models](../Requirements/data-models.md) (DM-52)
