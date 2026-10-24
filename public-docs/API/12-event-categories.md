---
sidebar_position: 13
title: Event Categories
description: The one list of 15 main event categories every city's events carry in `category`, their labels in four languages, the Smart Data Models codes they map to, and the rule table that picks one from a source's own words.
---

# Event Categories

Every Event in every city carries one main category from the list below in its `category` attribute, so a person filters "sport" across Banská Bystrica, Helsinki, Praha and Barcelona with one query. This page is the vocabulary: the codes, their labels, the Smart Data Models values behind them and the rule table that maps a source's own words to a code. Model authors, pipeline authors and anyone who filters events read it. Changing the list is a change to this page first, then to `seeds/event-categories.json` in the deployment repository, which every pipeline and model reads (T-5363).

## 1. The list

The data holds the code; the Portal, the catalogue, the map and the assistant show the label in the reader's language. Each model that holds Events declares the codes as the enum `EventCategory` with these four labels, and a test fails when a model and `seeds/event-categories.json` disagree.

| # | Code | sk | cs | en | de | Smart Data Models `category` |
|---|---|---|---|---|---|---|
| 1 | `sport` | Šport | Sport | Sport | Sport | none (free value) |
| 2 | `outdoor-nature` | Príroda a turistika | Příroda a turistika | Outdoors and nature | Natur und Wandern | `outdoorActivities`, `excursion` |
| 3 | `film` | Film | Film | Film | Film | `spectacle` |
| 4 | `theatre-dance` | Divadlo a tanec | Divadlo a tanec | Theatre and dance | Theater und Tanz | `spectacle` |
| 5 | `music` | Hudba | Hudba | Music | Musik | `spectacle` |
| 6 | `festival-fair` | Festivaly a jarmoky | Festivaly a jarmarky | Festivals and fairs | Feste und Jahrmärkte | `spectacle` |
| 7 | `food-market` | Gastronómia a trhy | Gastronomie a trhy | Food and markets | Essen und Märkte | `gastronomy`, `shopping` |
| 8 | `exhibition-museum` | Výstavy a múzeá | Výstavy a muzea | Exhibitions and museums | Ausstellungen und Museen | `museum` |
| 9 | `history-heritage` | História a pamiatky | Historie a památky | History and heritage | Geschichte und Denkmäler | `history` |
| 10 | `faith-tradition` | Viera a tradície | Víra a tradice | Faith and traditions | Glaube und Brauchtum | `religiousWorship` |
| 11 | `education-talk` | Vzdelávanie a prednášky | Vzdělávání a přednášky | Education and talks | Bildung und Vorträge | none (free value) |
| 12 | `children-family` | Deti a rodina | Děti a rodina | Children and family | Kinder und Familie | none (free value) |
| 13 | `hobby-workshop` | Hobby a tvorivé dielne | Hobby a tvořivé dílny | Hobbies and workshops | Hobby und Workshops | none (free value) |
| 14 | `health-wellness` | Zdravie a wellness | Zdraví a wellness | Health and wellness | Gesundheit und Wellness | `wellness` |
| 15 | `community-civic` | Komunita a samospráva | Komunita a samospráva | Community and civic life | Gemeinschaft und Bürgerleben | none (free value) |

The model is Smart Data Models' `dataModel.TourismDestinations/Event`, the only official SDM Event. Its suggested `category` values (excursion, gastronomy, history, museum, outdoorActivities, parksAndGardens, religiousWorship, shopping, spectacle, wellness) lack sport, education and community life, and SDM allows free values, so the platform's 15 codes are the values; the last column names the SDM value each one corresponds to.

## 2. The attributes

| Attribute | Value | Example |
|---|---|---|
| `category` | A list of one code from section 1, as SDM's Event writes `category`. Absent when no rule names the event. | `["music"]` |
| `categorySource` | How the code was picked: `rule` (section 3). Present exactly when `category` is. | `rule` |
| `audience` | SDM's Event audience codes, set with `children-family`: `children` when the source's word or the name says children, else `family`. | `["children"]` |
| `eventCategory` | The source's own word, kept unchanged so a category can be traced back to it. | `hudba (koncert)` |

A filter is the standard NGSI-LD query, `q=category=="sport"`, on every Endpoint that serves Events; a list value matches when one of its members does.

## 3. The rule table

The pipeline picks the code once per run, when it writes the event, never per read. The first match wins, in this order:

1. The source's own word, without its audience part (`akcie pre deti`) and without the catch-all family `trhy, výstavy, veľtrhy`, whose `(ostatné)` member counts as a market.
2. The event's name.
3. The source's whole word, so `ostatné (akcie pre deti)` still gives `children-family`.
4. The kind of body whose calendar it is, for a body that announces one kind only (a theatre's plays, a museum's exhibitions), from the `org_type` column of the source inventory.

Inside each step the categories are tried in the order of the table below, so `hudba (tanečná zábava)` is music and `kino, pre deti` is film. A text no rule matches leaves `category` empty; the pipeline never writes a catch-all code such as `other`, and the empty events are counted per city.

| Code | Word stems the rule matches (lower case, RE2) | Kinds of body whose calendar holds only this |
|---|---|---|
| `sport` | šport, sport, futbal, hokej, volejbal, nohejbal, basketbal, hádzan, tenis, kolky, karate, beh, maratón, turnaj, zápas, pohár, cyklo, korčuľ, plávan, lyžov, šach, atletik, fitnes, zumba, bowling, biliard, súťaž, hasič, krampuslauf, run |  |
| `outdoor-nature` | turistik, túra, výstup, výlet, príro, vychádzk, pochod, hike, nature, outdoor, jaskyň, splav, rastlín, stromy, záhrad |  |
| `film` | kino, film, premietan, projekci, cinema, movie | cinema |
| `theatre-dance` | divad, činohr, opera, balet, tanec, muzikál, predstaven, inscenác, bábk, repríza, premiér, kabaret, stand-?up, komédi, kúzel, zájazd, theat, dance, sľuk, lúčnic, színház | theatre, folk ensemble |
| `music` | hudb, hudob, koncert, music, spev, zbor, orchest, kapel, band, trio, kvartet, recitál, jazz, rock, disco, disko, párty, party, karaoke, dj, heligón, dychov, cimbal, organ, folklór, zábava, veselic, tančiare, ples, bál, vivaldi, zenekar |  |
| `festival-fair` | festival, fest, jarmo, hody, hodov, dni obce, dni mesta, slávnos, oslav, karneval, maškar, fašiang, majáles, dožink, vinobran, ohňostroj, vatr, silvest, lampión, halloween, strašidel, tekvič, mikuláš | festival |
| `food-market` | gastro, trh, jedl, ochutnávk, degust, vín, vinár, pivo, guláš, kapustnic, zabíjač, varen, pečen, burz, bazár, punč, kuchár, kuchyn, palacink, coffee, kávy, food, market, swap |  |
| `exhibition-museum` | výstav, vernisáž, finisáž, kurátor, galéri, múze, muze, expozíc, exhibit, museum, gallery, maľb, insit, sochár, ateliér, salón | museum, gallery |
| `history-heritage` | histor, pamiatk, hrad, kaštie, zámo, dejin, výroči, spomienk, piet, vencov, vojn, veterán, snp, remesl, kódex, prehliadk, baníc, patrón, minulos, dedičstv |  |
| `faith-tradition` | cirkev, omš, bohoslužb, kostol, púť, svät, modlitb, duchovn, poklon, pobožn, evanjel, reformač, farsk, farnos, biblick, advent, vianoc, vianoč, veľkonoč, dušičk, svetlono, koled, koľad, tradíci |  |
| `education-talk` | prednášk, seminár, konferenc, besed, workshop, kurz, vzdeláv, diskus, čítan, autorsk, knih, kniž, literár, poézi, poeti, básn, vedeck, ved, webinár, info dni, študent, talk, lecture, ai, haiku, poviedk, recenzi, kvíz | library, faculty, university |
| `children-family` | deti, detsk, pre najmenš, rozprávk, rodin, rodič, škôlk, mamičk, story time, kids, children, family |  |
| `hobby-workshop` | tvoriv, tvoren, tvoríme, dielni, ručné práce, ručných prác, háčkov, pleten, plsten, modrotlač, ikeban, vyrezáv, spoločensk[ýé]ch hier, stolov[áé] hr, chovateľ, fotograf, hobby, craft |  |
| `health-wellness` | zdrav, wellness, cvičen, pohyb, kvapka krvi, darovanie krvi, meditác, relax, somatick, masáž, medicín, jóg, joga, parkinson, ženské kruhy, open class |  |
| `community-civic` | komunit, stretnut, posedeni, zhromažd, fórum, forum, občian, dobrovoľn, brigád, spolok, klub, schôdz, ocenen, uvítan, jubil, prípitok, charit, zbierk, slobod, seniorov, susedia |  |

Measured on dev on 2026-10-22 over the 954 events of `slovensko-podujatia`: 739 remain after the notice filter, and the table gives 653 of them (88.4 %) a category. A hand read of 35 categorised events found 2 debatable codes.

### Source families

| Family | Words read | State |
|---|---|---|
| Slovak town, village and culture-house calendars (`seeds/bbsk-events`, 302 pipelines) | the calendar's category (`hudba (koncert)`, `Kino, Pre deti`, `cirkevný (ostatné)`), the name, the inventory's `org_type` | mapped |
| Helsinki Linked Events | YSO keywords | not yet mapped |
| Praha, Barcelona agenda feeds | the agenda's own categories | not yet mapped |

### Classification by a model

A decision model (TypeSafe Jev through the platform's OpenRouter key) may later classify the events the table leaves empty, only above a confidence threshold measured on a hand-labelled set of 400 events, writing `categorySource: jev`. It is held until the owner lifts the spend guard; the rule table stays the path for exact words and the fallback.

## Related

- [Architecture: Data Models](../Architecture/11-data-models.md), how a model's enum and labels reach every surface.
- [API/02 Endpoint Representations](02-endpoint-representations.md), the surfaces that show or filter `category`.
- [API/11 Mapping and Representation Contract](11-representation-contract.md), where an Endpoint names the members a format shows.
- [Requirements: Data Models](../Requirements/data-models.md), the model rules the Event models follow.
