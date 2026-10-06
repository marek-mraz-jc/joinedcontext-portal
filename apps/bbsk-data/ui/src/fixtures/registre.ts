/**
 * What the public endpoint of `bbsk-registre` answers, as the pipelines nemocnice,
 * socialne-sluzby and organizacie write it (T-2783): names as LanguageProperty, positions as
 * GeoProperty where the register publishes one (social services have none), a missing value missing.
 */
const URN = (type: string, id: string) => `urn:ngsi-ld:${type}:bbsk.sk:bbsk-registre:${id}`;
const point = (lon: number, lat: number) => ({ type: "GeoProperty", value: { type: "Point", coordinates: [lon, lat] } });
const name = (sk: string) => ({ type: "LanguageProperty", languageMap: { sk } });
const value = (v: unknown) => ({ type: "Property", value: v });

export const HOSPITALS = [
  {
    id: URN("Hospital", "fnspfdr"),
    type: "Hospital",
    name: name("Fakultná nemocnica s poliklinikou F. D. Roosevelta"),
    hospitalKind: value("general"),
    operatorName: value("Fakultná nemocnica s poliklinikou F. D. Roosevelta Banská Bystrica"),
    medicalSpecialties: value(["chirurgia", "interná medicína", "pediatria"]),
    address: value("Námestie L. Svobodu 1, Banská Bystrica"),
    location: point(19.1386, 48.7432),
  },
  {
    id: URN("Hospital", "nemocnica-zvolen"),
    type: "Hospital",
    name: name("Nemocnica Zvolen"),
    hospitalKind: value("general"),
    address: value("Kuzmányho nábrežie 28, Zvolen"),
    location: point(19.13, 48.575),
  },
];

export const SOCIAL = [
  {
    id: URN("SocialService", "dss-tisovec"),
    type: "SocialService",
    name: name("Domov sociálnych služieb Tisovec"),
    serviceKind: value("domov sociálnych služieb"),
    serviceForm: value("residentialYearRound"),
    targetGroup: value("dospelí s ťažkým zdravotným postihnutím"),
    capacity: value(48),
    providerKind: value("regionFounded"),
    address: value("Jesenského 869, Tisovec"),
    districtName: value("Rimavská Sobota"),
    url: value("https://www.dsstisovec.sk/"),
  },
  {
    id: URN("SocialService", "terenna-sluzba"),
    type: "SocialService",
    name: name("Terénna opatrovateľská služba"),
    serviceForm: value("field"),
    districtName: value("Lučenec"),
    url: value("javascript:alert(1)"),
  },
];

export const ORGANIZATIONS = [
  {
    id: URN("PublicOrganization", "stredoslovenske-muzeum"),
    type: "PublicOrganization",
    name: name("Stredoslovenské múzeum"),
    organizationCategory: value("culture"),
    address: value("Námestie SNP 4, Banská Bystrica"),
    location: point(19.1455, 48.7362),
  },
  {
    id: URN("PublicOrganization", "spojena-skola-detva"),
    type: "PublicOrganization",
    name: name("Spojená škola Detva"),
    organizationCategory: value("school"),
    address: value("Štúrova 848, Detva"),
  },
];

/** The rows of one type, as `GET …/entities?type=…` answers them. */
export function answer(type: string | null): unknown[] {
  if (type === "Hospital") return HOSPITALS;
  if (type === "SocialService") return SOCIAL;
  if (type === "PublicOrganization") return ORGANIZATIONS;
  return [];
}
