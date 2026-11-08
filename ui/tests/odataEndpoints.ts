/**
 * The project's OData Endpoints set (src/api/odata.rs, T-6645) as a test stub: its rows built from
 * the stubbed plain lists the way the server builds them, so a page test that stubs
 * `GET /projects/{p}/endpoints` (and the shared lists) reads the same rows through the grid.
 *
 * It serves what the Endpoints grid asks: `$metadata`, the set with `$filter` (eq, ne, and, or,
 * not, contains/startswith/endswith, tolower), one `$orderby` key, `$top`, `$skip`, `$count`, and
 * `$allowed` (allowed unless the stub says otherwise). Anything else answers 501, as the server.
 */

type Get = (path: string) => Promise<Response | undefined> | Response | undefined;

interface Manifest {
  metadata: { name: string; namespace?: string; title?: unknown };
  spec?: Record<string, unknown>;
  status?: { phase?: string };
}

const PROPERTIES: [string, string, boolean][] = [
  ["id", "Edm.String", false],
  ["name", "Edm.String", false],
  ["title", "Edm.String", true],
  ["description", "Edm.String", true],
  ["contextSpace", "Edm.String", true],
  ["slug", "Edm.String", true],
  ["audience", "Edm.String", true],
  ["mcp", "Edm.Boolean", false],
  ["source", "Edm.String", true],
  ["kind", "Edm.String", false],
  ["reference", "Edm.String", true],
  ["phase", "Edm.String", true],
  ["representations", "Edm.String", true],
  ["calls7d", "Edm.Int64", true],
  ["search", "Edm.String", false],
];

/** The CSDL XML the server writes, with the filter functions it serves. */
export const ENDPOINTS_CSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:Reference Uri="https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Capabilities.V1.xml">
    <edmx:Include Namespace="Org.OData.Capabilities.V1" Alias="Capabilities"/>
  </edmx:Reference>
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="JoinedContext.Portal">
      <EntityType Name="EndpointRow">
        <Key><PropertyRef Name="id"/></Key>
${PROPERTIES.map(([name, type, nullable]) => `        <Property Name="${name}" Type="${type}"${nullable ? "" : ' Nullable="false"'}/>`).join("\n")}
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="endpointList" EntityType="JoinedContext.Portal.EndpointRow"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

type Row = Record<string, string | number | boolean | null>;

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const map = value as Record<string, unknown>;
    const first = map.en ?? Object.values(map)[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

function spaceOf(spec: Record<string, unknown>): string | null {
  const ref = spec.contextSpaceRef;
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && typeof (ref as { name?: unknown }).name === "string") return (ref as { name: string }).name;
  return null;
}

function endpointRow(m: Manifest, source: string, kind: "own" | "shared", reference: string | null): Row {
  const spec = m.spec ?? {};
  const reps = Array.isArray(spec.enabledRepresentations) ? (spec.enabledRepresentations as string[]).join(",") : null;
  return {
    id: kind === "own" ? m.metadata.name : `${source}/${m.metadata.name}`,
    name: m.metadata.name,
    title: text(m.metadata.title),
    description: null,
    contextSpace: spaceOf(spec),
    slug: typeof spec.slug === "string" ? spec.slug : null,
    audience: typeof spec.audience === "string" ? spec.audience : null,
    mcp: spec.mcp !== false,
    source,
    kind,
    reference,
    phase: m.status?.phase ?? null,
    representations: reps,
    calls7d: kind === "own" ? 0 : null,
  };
}

function admits(m: Manifest, project: string): boolean {
  const spec = m.spec ?? {};
  const audience = spec.audience ?? "project-list";
  if (audience === "public" || audience === "organization") return true;
  return audience === "project-list" && Array.isArray(spec.allowedProjects) && spec.allowedProjects.includes(project);
}

async function items(get: Get, path: string): Promise<Manifest[] | Response> {
  const answer = await get(path);
  if (!answer) return [];
  if (!answer.ok) return answer.status === 404 ? [] : answer;
  const body = (await answer.clone().json().catch(() => null)) as { items?: unknown } | null;
  return Array.isArray(body?.items) ? (body.items as Manifest[]) : [];
}

/** The rows the server answers for `project`, from the stubbed lists; a failed own list fails the read. */
export async function endpointRows(project: string, get: Get): Promise<Row[] | Response> {
  const own = await items(get, `/api/v1/projects/${project}/endpoints`);
  if (own instanceof Response) return own;
  const references = await items(get, `/api/v1/projects/${project}/shared`);
  const refs = references instanceof Response ? [] : references;
  const projects = await items(get, "/api/v1/projects");
  const others = (projects instanceof Response ? [] : projects)
    .map((p) => (p as unknown as { name?: string }).name)
    .filter((name): name is string => typeof name === "string" && name !== project);
  const rows: Row[] = own.map((m) => endpointRow(m, project, "own", null));
  const used = new Set<string>();
  for (const source of others) {
    const theirs = await items(get, `/api/v1/projects/${source}/endpoints`);
    for (const m of theirs instanceof Response ? [] : theirs) {
      if (!admits(m, project)) continue;
      const ref = refs.find((r) => {
        const spec = (r.spec ?? {}) as { endpointRef?: { project?: string; name?: string }; endpointSlug?: string };
        return spec.endpointRef
          ? spec.endpointRef.project === source && spec.endpointRef.name === m.metadata.name
          : Boolean(spec.endpointSlug) && spec.endpointSlug === m.spec?.slug;
      });
      if (ref) used.add(ref.metadata.name);
      rows.push(endpointRow(m, source, "shared", ref?.metadata.name ?? null));
    }
  }
  for (const r of refs) {
    if (used.has(r.metadata.name)) continue;
    const spec = (r.spec ?? {}) as { alias?: string; endpointSlug?: string };
    rows.push({
      ...Object.fromEntries(PROPERTIES.map(([name]) => [name, null])),
      id: `reference:${r.metadata.name}`,
      name: r.metadata.name,
      title: spec.alias ?? null,
      slug: spec.endpointSlug ?? null,
      mcp: false,
      kind: "gone",
      reference: r.metadata.name,
    });
  }
  // `search` is the name and the title in lower case, as the server writes it.
  return rows.map((row) => ({ ...row, search: [row.name, row.title].filter((v) => typeof v === "string").join("\n").toLowerCase() }));
}

/** A small `$filter` reader: enough for what the grid writes. */
function predicate(filter: string): (row: Row) => boolean {
  let at = 0;
  const skip = () => {
    while (filter[at] === " ") at++;
  };
  const word = () => {
    skip();
    const m = /^[A-Za-z0-9_]+/.exec(filter.slice(at));
    if (!m) throw new Error(`unread filter at ${at}: ${filter}`);
    at += m[0].length;
    return m[0];
  };
  type Val = (row: Row) => unknown;
  const value = (): Val => {
    skip();
    if (filter[at] === "'") {
      let out = "";
      at++;
      while (at < filter.length) {
        if (filter[at] === "'" && filter[at + 1] === "'") {
          out += "'";
          at += 2;
        } else if (filter[at] === "'") {
          at++;
          break;
        } else out += filter[at++];
      }
      return () => out;
    }
    const name = word();
    if (name === "true" || name === "false") return () => name === "true";
    if (name === "null") return () => null;
    if (/^-?\d+$/.test(name)) return () => Number(name);
    skip();
    if (filter[at] === "(") {
      at++;
      const args: Val[] = [value()];
      skip();
      while (filter[at] === ",") {
        at++;
        args.push(value());
        skip();
      }
      at++;
      const str = (v: unknown) => (typeof v === "string" ? v : null);
      if (name === "tolower") return (row) => str(args[0](row))?.toLowerCase() ?? null;
      if (name === "toupper") return (row) => str(args[0](row))?.toUpperCase() ?? null;
      const test = { contains: (a: string, b: string) => a.includes(b), startswith: (a: string, b: string) => a.startsWith(b), endswith: (a: string, b: string) => a.endsWith(b) }[name];
      if (!test) throw new Error(`unserved function ${name}`);
      return (row) => {
        const a = str(args[0](row));
        const b = str(args[1](row));
        return a !== null && b !== null && test(a, b);
      };
    }
    return (row) => row[name] ?? null;
  };
  const primary = (): Val => {
    skip();
    if (filter.startsWith("not ", at)) {
      at += 4;
      const inner = primary();
      return (row) => !inner(row);
    }
    if (filter[at] === "(") {
      at++;
      const inner = or();
      skip();
      at++;
      return inner;
    }
    const left = value();
    skip();
    const op = /^(eq|ne|gt|ge|lt|le|in) /.exec(filter.slice(at))?.[1];
    if (!op) return left;
    at += op.length + 1;
    if (op === "in") {
      skip();
      at++;
      const list: Val[] = [value()];
      skip();
      while (filter[at] === ",") {
        at++;
        list.push(value());
        skip();
      }
      at++;
      return (row) => list.some((v) => v(row) === left(row));
    }
    const right = value();
    return (row) => {
      const a = left(row) as never;
      const b = right(row) as never;
      if (op === "eq") return a === b;
      if (op === "ne") return a !== b;
      if (a === null || b === null) return false;
      return { gt: a > b, ge: a >= b, lt: a < b, le: a <= b }[op];
    };
  };
  const and = (): Val => {
    let left = primary();
    skip();
    while (filter.startsWith("and ", at)) {
      at += 4;
      const l = left;
      const r = primary();
      left = (row) => Boolean(l(row)) && Boolean(r(row));
      skip();
    }
    return left;
  };
  const or = (): Val => {
    let left = and();
    skip();
    while (filter.startsWith("or ", at)) {
      at += 3;
      const l = left;
      const r = and();
      left = (row) => Boolean(l(row)) || Boolean(r(row));
      skip();
    }
    return left;
  };
  const read = or();
  return (row) => Boolean(read(row));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "OData-Version": "4.0" } });

/**
 * The answer to an OData request of the Endpoints set, from `get` (the test's own stub); `null`
 * when `url` is no OData path, so the caller answers it as before.
 */
export async function odataEndpoints(url: string, get: Get): Promise<Response | null> {
  const parsed = new URL(url, "http://localhost");
  const match = /^\/api\/v1\/projects\/([^/]+)\/odata\/(.*)$/.exec(parsed.pathname);
  if (!match) return null;
  const [, project, rest] = match;
  if (rest === "$metadata") return new Response(ENDPOINTS_CSDL, { status: 200, headers: { "Content-Type": "application/xml" } });
  const rows = await endpointRows(decodeURIComponent(project), get);
  if (rows instanceof Response) return rows;
  if (rest === "endpointList/$allowed") return json({ allowed: true, reason: null, notFound: false });
  if (rest !== "endpointList") return json({ error: { code: "NotImplemented", message: `${rest} is not served by this stub` } }, 501);
  const q = parsed.searchParams;
  const filter = q.get("$filter");
  let kept = filter ? rows.filter(predicate(filter)) : rows;
  const order = q.get("$orderby");
  if (order) {
    const [name, dir] = order.split(" ");
    kept = [...kept].sort((a, b) => {
      const x = a[name] ?? "";
      const y = b[name] ?? "";
      const ord = x < y ? -1 : x > y ? 1 : 0;
      return dir === "desc" ? -ord : ord;
    });
  }
  const skip = Number(q.get("$skip") ?? 0);
  const top = Number(q.get("$top") ?? 1000);
  return json({
    "@odata.context": `/api/v1/projects/${project}/odata/$metadata#endpointList`,
    ...(q.get("$count") === "true" ? { "@odata.count": kept.length } : {}),
    value: kept.slice(skip, skip + top),
  });
}

/**
 * `fetch` with the Endpoints OData set answered from `inner`'s plain lists: every page test stubs
 * those lists, and the grid reads the set (T-6645). A test that stubs the set itself answers it
 * before this: an `/odata/` answer of its own that is not a plain list wins.
 */
export function withODataEndpoints(inner: typeof fetch): typeof fetch {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/\/api\/v1\/projects\/[^/]+\/odata\//.test(new URL(url, "http://localhost").pathname)) {
      // Asked as the page asks them: a Request on the page's own origin, which every stub reads.
      const base = typeof window === "undefined" ? "http://localhost" : window.location.origin;
      const request = input instanceof Request ? input : new Request(new URL(url, base), init);
      // A stub may throw on a path it does not know, before any promise: that is "not stubbed".
      const own = await (async () => inner(request))().catch(() => undefined);
      if (own && (own.status !== 200 || !(await isPlainList(own)))) {
        if (own.status !== 404) return own;
      }
      const odata = await odataEndpoints(url, (path) => (async () => inner(new Request(new URL(path, base))))().catch(() => undefined));
      if (odata) return odata;
    }
    return inner(input, init);
  }) as typeof fetch;
  // The stub itself with only its calls answered here: a test still reads `fetch.mock.calls` and
  // sets `mockResolvedValueOnce` on the global it stubbed.
  return new Proxy(inner, { apply: (_target, _this, args: Parameters<typeof fetch>) => wrapped(...args) });
}

/** Whether an answer is a stub's catch-all (`{kind: List, items: []}`, or no body), not an OData answer. */
async function isPlainList(answer: Response): Promise<boolean> {
  const type = answer.headers.get("Content-Type") ?? "";
  if (type.includes("xml")) return false;
  const body = (await answer.clone().json().catch(() => null)) as { value?: unknown; allowed?: unknown } | null;
  return !body || (!Array.isArray(body.value) && body.allowed === undefined);
}
