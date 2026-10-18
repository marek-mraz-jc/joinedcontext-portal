---
sidebar_position: 9
title: National DCAT-AP Profiles
description: What DCAT-AP-SK 2.0.1 and DCAT-AP-CZ 2026-09-23 require of an Endpoint's catalogue record beyond DCAT-AP 3.0, each rule with its source, and how the conformance suite checks it.
---

# National DCAT-AP Profiles

Every Endpoint serves a DCAT-AP 3.0 record ([EP-27](../Requirements/endpoints.md)), and the open data portal publishes it to CKAN. A national catalogue asks for more: the Slovak catalogue data.slovensko.sk harvests records that meet DCAT-AP-SK, the Czech NKOD records that meet DCAT-AP-CZ. This page lists what each profile adds to DCAT-AP 3.0, with the official text for every row. A rule without a source is not on this page. T-4499 writes the records that meet these rules; until then the conformance suite reports what each record lacks.

## 1. Profiles and versions

| Profile | Version pinned | Based on | Official text | Machine-readable shapes |
|---|---|---|---|---|
| DCAT-AP | 3.0.0 | DCAT 3 | <https://semiceu.github.io/DCAT-AP/releases/3.0.0/> | SEMIC SHACL, vendored |
| DCAT-AP-SK | 2.0.1 | DCAT-AP 2.1.1 | <https://datova-kancelaria.github.io/dcat-ap-sk-2.0/> (repository `datova-kancelaria/dcat-ap-sk-2.0` at `ef7713876fdb4f319f0ae692e306b55d03b2410e`) | none published; DCAT-AP 2.1.1 SHACL plus our `sk-additions.shacl.ttl` |
| DCAT-AP-CZ | 2026-09-23 | DCAT-AP 3.0.0 | <https://ofn.gov.cz/dcat-ap-cz-otevřená-data/2026-09-23/> (open data), <https://ofn.gov.cz/dcat-ap-cz-hvd/2026-09-23/> (high-value datasets), <https://ofn.gov.cz/dcat-ap-cz-rozhraní-katalogů-dat/2026-09-23/> (catalogue interface) | OFN `shacl.ttl` per specification, vendored; plus our `cz-additions.shacl.ttl` for the cardinalities |

**Which Slovak version data.slovensko.sk validates against today.** DCAT-AP 2.1.1, through DCAT-AP-SK 2.0.1. The catalogue's SPARQL endpoint (`https://data.slovensko.sk/api/sparql`, queried 2026-10-17) answers:

```sparql
PREFIX dct: <http://purl.org/dc/terms/>
SELECT ?o (COUNT(DISTINCT ?s) AS ?n)
WHERE { ?s dct:conformsTo ?o FILTER(CONTAINS(STR(?o), "dcat")) }
GROUP BY ?o
```

One row: 13,646 resources declare `dct:conformsTo <https://joinup.ec.europa.eu/collection/semantic-interoperability-community-semic/solution/dcat-application-profile-data-portals-europe/release/211>`, the DCAT-AP 2.1.1 release. The same store already holds DCAT-AP 3 terms (`dcat:inSeries` on 6,203 resources, `r5r:applicableLegislation` on 500, `r5r:hvdCategory` on 325) and its own `dqv` quality measurements (the mandatory-attribute metric on 22,629 datasets). A record that meets DCAT-AP 3.0 and the SK additions below is therefore harvestable: the 3.0 terms it carries are already in the store.

**Which Czech version.** The OFN of 2026-09-23 is the newest. It replaced the single "Rozhraní katalogů otevřených dat" of 2024-05-28 with four specifications (catalogue interface, open data, HVD, data interfaces). Its published `shacl.ttl` files check value classes and datatypes but carry no `sh:minCount` except `hvdCategory`, so the mandatory rows of its tables are written as SHACL in `cz-additions.shacl.ttl`, each shape linking its row.

## 2. DCAT-AP-SK 2.0.1: what it adds

Each row is mandatory ("Povinná") in the Slovak text and optional or absent in DCAT-AP 3.0. The source column is the section anchor on <https://datova-kancelaria.github.io/dcat-ap-sk-2.0/>.

| Class | Property | Obligation | Value and vocabulary | Source |
|---|---|---|---|---|
| Catalog | `dct:publisher` | mandatory | IRI of the publisher | `#katalóg-poskytovateľ` |
| Catalog | `dcat:dataset` | mandatory | at least one dataset | `#katalóg-dataset` |
| Dataset | `dct:publisher` | mandatory | IRI of the publisher | `#dataset-poskytovateľ` |
| Dataset | `dcat:theme` | mandatory, one or more | at least one from the EU data-theme table `http://publications.europa.eu/resource/authority/data-theme` | `#dataset-téma` |
| Dataset | `dct:accrualPeriodicity` | mandatory, exactly one | EU frequency table `http://publications.europa.eu/resource/authority/frequency` | `#dataset-periodicita-aktualizácie` |
| Dataset | `dcat:keyword` | mandatory, one or more | language-tagged text | `#dataset-kľúčové-slová` |
| Dataset | `dcat:distribution` | mandatory unless the dataset is the umbrella of a series | a Distribution | `#dataset-distribúcia` |
| Dataset | `dct:spatial` | optional | NUTS-SK territorial units first, then EU continent and country tables | `#dataset-geografické-územia` |
| Dataset | `dct:type` | optional | `https://data.gov.sk/def/dataset-type/` | `#dataset-typ` |
| Distribution | `dcat:accessURL` | mandatory | URL | `#distribúcia-prístupové-url` |
| Distribution | `leg:termsOfUse` | mandatory, exactly one | a `leg:TermsOfUse` node, below | `#špecifikácia-podmienok-použitia` |
| Distribution (file) | `dcat:downloadURL`, `dct:format`, `dcat:mediaType` | mandatory for a file download | format from the EU file-type table, media type from the IANA register | `#distribúcia-stiahnutie-súboru`, `#distribúcia-formát-súboru`, `#distribúcia-media-type` |
| Distribution (service) | `dcat:accessService` | mandatory for a data service | a DataService with `dct:title` (mandatory) | `#distribúcia-služba`, `#dátová-služba-názov` |
| TermsOfUse | `leg:authorsWorkType`, `leg:originalDatabaseType`, `leg:databaseProtectedBySpecialRightsType`, `leg:personalDataContainmentType` | all mandatory | `https://data.gov.sk/def/authors-work-type/`, `https://data.gov.sk/def/original-database-type/`, `https://data.gov.sk/def/codelist/database-creator-special-rights-type/`, `https://data.gov.sk/def/personal-data-occurence-type/` | `#špecifikácia-podmienok-použitia` |

`leg:` is `https://data.gov.sk/def/ontology/legislation/`. The CKAN API section of the same text (`#ckan-api-názov` to `#ckan-api-distribúcia-názov`) maps these to CKAN fields; `license_link` (`#ckan-api-podmienky-pužitia`) is mandatory there.

**DCAT-AP 2.1.1 versus 3.0.** The base shapes reject two things our 3.0 records carry: `spdx:algorithm` other than SHA-1 (2.1.1 allows only SHA-1; our checksums are SHA-256) and `dcat:byteSize` that is not `xsd:decimal`. Both come from the older base, not from the Slovak text; T-4499 decides whether a Slovak record drops the checksum or carries both.

## 3. DCAT-AP-CZ 2026-09-23: what it adds

Each row has cardinality `[1..1]` or `[1..*]` in the Czech tables. The source column is the row's own IRI, which resolves to the row in the specification.

| Class | Property | Cardinality | Value and vocabulary | Source |
|---|---|---|---|---|
| Dataset | `dct:title`, `dct:description` | [1..1] each | `rdf:langString` with a language tag | `https://ofn.gov.cz/dcat-ap-cz-otevřená-data#DatováSada.název`, `#DatováSada.popis` |
| Dataset | `dcat:keyword` | [1..*] | `rdf:langString` | `…#DatováSada.klíčovéSlovo` |
| Dataset | `dcat:theme` | [1..*] | EU data-theme table | `…#DatováSada.téma` |
| Dataset | `dct:accrualPeriodicity` | [1..1] | EU frequency table | `…#DatováSada.periodicitaAktualizace` |
| Dataset | `dct:publisher` | [1..1] | the publisher's IRI | `…#DatováSada.poskytovatel` |
| Dataset | `dct:spatial` | [1..*] | an element of RÚIAN (`https://linked.cuzk.cz/resource/ruian/`), or EU continent and country tables | `…#DatováSada.souvisejícíGeografickéÚzemí-PrvekZRúian` |
| Dataset, Distribution, DataService | `r5r:applicableLegislation` | [1..*] | ELI of the act; for open data `https://www.e-sbirka.cz/eli/cz/sb/1999/106/2025-08-19` | `…#DatováSada.příslušnýPrávníPředpis`, `#Distribuce.příslušnýPrávníPředpis`, `#DatováSlužba.příslušnýPrávníPředpis` |
| Distribution | `dcat:accessURL` | [1..1] | URL | `…#Distribuce.přístupovéUrl` |
| Distribution | `pu:specifikace` | [1..1] | a terms-of-use specification, below | `…#Distribuce.specifikacePodmínekUžití` |
| Distribution (file) | `dcat:downloadURL`, `dcat:mediaType`, `dct:format` | [1..1] each | IANA media type; EU file-type table | `…#Distribuce-SouborKeStažení.odkazNaStaženíSouboru`, `#Distribuce-SouborKeStažení.typMédia`, `#Distribuce-SouborKeStažení.formátSouboruKeStažení` |
| Distribution (service) | `dcat:accessService` | [1..1] | a DataService | `…#Distribuce-DatováSlužba.přístupováSlužba` |
| DataService | `dcat:endpointURL`, `dcat:endpointDescription`, `dct:title` | [1..1] each | URLs; text | `…#DatováSlužba.přístupovýBodSlužby`, `#DatováSlužba.popisPřístupovéhoBoduSlužby`, `#DatováSlužba.název` |
| Specifikace | `pu:autorské-dílo`, `pu:databáze-jako-autorské-dílo`, `pu:databáze-chráněná-zvláštními-právy`, `pu:osobní-údaje` | [1..1] each | licence or statement IRIs of the terms-of-use vocabulary | `…#SpecifikacePodmínekUžití.autorskéDílo`, `.originálníDatabáze`, `.zvláštníPrávoPořizovateleDatabáze`, `.osobníÚdaje` |
| Dataset, DataService (HVD) | `r5r:hvdCategory` | [1..*] | EU HVD category table | `https://ofn.gov.cz/dcat-ap-cz-hvd#DatováSada.kategorieHvd`, `#DatováSlužba.kategorieHvd` |
| DataService (HVD) | `dcat:contactPoint` | [1..1] | a `vcard:Kind` | `https://ofn.gov.cz/dcat-ap-cz-hvd#DatováSlužba.kontaktníBod` |
| Catalog | `dct:title`, `dct:description`, `dct:publisher`, `dcat:contactPoint`, `dcat:endpointURL` | [1..1] each | contact point a `vcard:Organization` with `vcard:fn` and `vcard:hasEmail` | `https://ofn.gov.cz/dcat-ap-cz-rozhraní-katalogů-dat#Katalog.název` to `#Katalog.přístupovýBodSlužby`, `#Organizace.email`, `#Organizace.jméno` |

`pu:` is `https://data.gov.cz/slovník/podmínky-užití/`, `r5r:` is `http://data.europa.eu/r5r/`. The HVD rows apply to a dataset listed under Implementing Regulation (EU) 2023/138; the catalogue rows to the catalogue a city's open data portal publishes, not to one Endpoint's record. A dataset series repeats the dataset rows (`…#SérieDatovýchSad.*`).

## 4. How the suite checks a record

The conformance repository vendors the shapes under `dcat/shapes/<profile>/<version>/`, byte for byte, each pinned by sha256 in `tests/ckan/profiles.py`; its README lists the source URL, version, digest and licence of every file. Updating a shape is a reviewed commit, never a fetch at test time. `tests/ckan/test_profiles.py` then:

- fails when a vendored file is not its pinned digest;
- holds each fixture record (`tests/ckan/fixtures/catalog-*.jsonld`, the gateway's records for a public, an organization and a restricted Endpoint) to DCAT-AP 3.0.0: a violation fails;
- reports every DCAT-AP-SK and DCAT-AP-CZ violation into `evidence/dcat-profiles.md` and fails when that committed report is not a fresh run. The national profiles turn into a gate when T-4499 lands.

A third national profile is one more folder of shapes and one more entry in `PROFILES`; nothing else changes.

## 5. Choosing a profile

An Organization names the national profiles its records are served in, in `Organization.spec.dcatProfiles`: a list of `dcat-ap-sk` and `dcat-ap-cz`, empty by default. DCAT-AP 3.0 is always served and stays the default representation.

- **One rendering per profile.** The record of an Endpoint and the catalogue feed take `?profile=<id>`: `dcat-ap` (the default), or a profile the Organization lists. A profile it does not list, or one this build was compiled without, answers 404. Every profile renders the same core record (title, description, publisher, themes, licence, distributions) and only adds or retypes what section 2 or 3 asks for, so the core values never differ between profiles.
- **The Slovak record has no checksum.** The DCAT-AP 2.1.1 base accepts only SHA-1 in `spdx:algorithm`, and every checksum node must carry it. SHA-1 is broken, and `spdx:checksum` is optional in 2.1.1, so a `dcat-ap-sk` record omits it and types `dcat:byteSize` as `xsd:decimal`. The DCAT-AP 3.0 record keeps its SHA-256 checksums (EP-68).
- **SK and CZ in one record is not offered.** The two bases disagree on `dcat:byteSize` and on the checksum, so no single record meets both; an Organization listing both serves two renderings.
- **Inputs.** The national terms-of-use node (`leg:TermsOfUse`, `pu:Specifikace`) is derived from `spec.catalog.license`, except its personal-data statement; `dct:spatial`, `dct:accrualPeriodicity`, `dcat:keyword`, `r5r:applicableLegislation` and the publisher come from `spec.catalog` as today. A property a profile requires and the Endpoint does not declare is left out, never invented, and the conformance suite names it.

- **The personal-data statement.** No licence says whether a dataset holds personal data, so the Endpoint states it in `spec.catalog.personalData`: `contains` or `does-not-contain`. Unset, the property is left out and the conformance suite names it. The code lists, read on 2026-10-18:

  | `personalData` | DCAT-AP-SK `leg:personalDataContainmentType` | DCAT-AP-CZ `pu:osobní-údaje` |
  |---|---|---|
  | `contains` | `https://data.gov.sk/def/personal-data-occurence-type/1`, "Obsahuje osobné údaje" | `https://data.gov.cz/podmínky-užití/obsahuje-osobní-údaje/` |
  | `does-not-contain` | `https://data.gov.sk/def/personal-data-occurence-type/2`, "Neobsahuje osobné údaje" | `https://data.gov.cz/podmínky-užití/neobsahuje-osobní-údaje/` |

  The Slovak labels are the code list `https://data.gov.sk/set/codelist/personal-data-occurence-type` as `https://data.slovensko.sk/codelists?keys[]=https://data.gov.sk/set/codelist/personal-data-occurence-type` serves it. The Czech IRIs are the individuals of `dcat-ap-cz-podmínky-užití/2025-08-12/model.owl.ttl` in `datagov-cz/otevrene-formalni-normy` (commit `fa3cb6a`). The Slovak list has a third code, `/3` "Môže obsahovať osobné údaje (nie je špecifikované)", which the national catalogue refuses on input (`slovak-egov/nkod-portal`, `DistributionLicenceInput.cs` at `71b5ea98`); the Czech list has no such value, so neither profile offers it.

Decided (worker-2, T-4499, owner may override): a profile is a query parameter, not content negotiation by `Accept-Profile`, because a harvester is configured with one URL. The other options were one URL per profile, or the profile as an `Accept-Profile` header.

## 6. Safe and reusable records

These rules hold for every profile, so a record meeting a national catalogue never says more than the Endpoint's public description:

- **Only public metadata.** A record carries no internal id, no person's e-mail and no name of a private space or project; a restricted Endpoint's record names what the anonymous caller may know and no more (EP-27).
- **Publisher and contact point are the Organization's.** The Organization enters them; they are a desk, never a person read from Keycloak.
- **Licences only from the EU licence table** (`http://publications.europa.eu/resource/authority/licence`), and the national terms-of-use node (`leg:TermsOfUse`, `pu:Specifikace`) is derived from that licence, never typed separately (EP-78).
- **Profiles are data.** The shapes and the mapping table are the profile; the code that writes a record reads them and holds no profile-specific branch.

## 7. Requirements

- **EP-27** [H][P][A] — the Endpoint's DCAT-AP 3.0 record ([Requirements/endpoints](../Requirements/endpoints.md)).
- **EP-46** [P][A] — the schema artifacts the record lists.
- **EP-68** [P][A] — every artifact a `dcat:distribution` with checksum and `dcterms:conformsTo`.
- **EP-78** [H][P][A] — the licence the record and the CKAN dataset carry.

## Related

- [API/02-endpoint-representations](02-endpoint-representations.md) — the record itself and every representation an Endpoint serves.
- [Architecture/21-open-data-catalogue](../Architecture/21-open-data-catalogue.md) — the catalogue the record is published to.
- [Requirements/endpoints](../Requirements/endpoints.md) — EP-27, EP-46, EP-68, EP-78.
