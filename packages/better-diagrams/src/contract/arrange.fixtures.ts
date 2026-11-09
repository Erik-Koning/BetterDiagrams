/**
 * arrange.fixtures.ts — a gallery of diagrams to arrange, deliberately of every
 * shape: chains, trees, hubs, rings, meshes, data models, nested regions, and a
 * rough arrangement from an author who tried. The tests hold the auto-placer and
 * the linter to account on all of them, and rendering the gallery is how a change
 * to either gets looked at.
 *
 * Content only, the way a model writes it, except where a fixture is about
 * placement. Test data: nothing imports this but the tests.
 */
import { validateTemplate, type DiagramTemplate } from "./schema";

type Raw = Record<string, unknown>;
const n = (id: string, label: string, kind = "service", more: Raw = {}): Raw => ({ id, label, kind, ...more });
let edgeId = 0;
const e = (source: string, target: string, label = "", more: Raw = {}): Raw => ({
  id: `e${(edgeId += 1)}`,
  source,
  target,
  label,
  ...more,
});
const doc = (title: string, nodes: Raw[], edges: Raw[], more: Raw = {}): DiagramTemplate =>
  validateTemplate({ version: 1, meta: { title }, nodes, edges, ...more });

/** A long chain: it should come out long. */
function pipeline(): DiagramTemplate {
  return doc(
    "Data pipeline",
    [
      n("src", "Event sources", "external", { description: "Web, mobile, partners" }),
      n("ingest", "Ingest API", "service", { description: "Go / gRPC" }),
      n("bus", "Event bus", "queue", { description: "Kafka" }),
      n("clean", "Cleaner", "service", { description: "Flink job" }),
      n("enrich", "Enricher", "service", { description: "Joins reference data" }),
      n("lake", "Data lake", "database", { description: "Iceberg on S3" }),
      n("dash", "Dashboards", "client", { description: "Metabase" }),
    ],
    [
      e("src", "ingest", "events"),
      e("ingest", "bus", "publish"),
      e("bus", "clean", "consume"),
      e("clean", "enrich", "valid events"),
      e("enrich", "lake", "write"),
      e("lake", "dash", "query"),
    ],
  );
}

/** The everyday web application, with some lines that skip a rank. */
function webApp(): DiagramTemplate {
  return doc(
    "Web application",
    [
      n("browser", "Browser", "client", { description: "React SPA" }),
      n("cdn", "CDN", "external", { description: "Static assets" }),
      n("lb", "Load balancer", "service", { description: "NGINX" }),
      n("api", "API server", "service", { description: "Node.js / Express" }),
      n("auth", "Auth service", "service", { description: "OAuth 2 / OIDC" }),
      n("worker", "Background worker", "service", { description: "Sidekiq" }),
      n("queue", "Job queue", "queue", { description: "Redis Streams" }),
      n("db", "PostgreSQL", "database", { description: "Primary data store" }),
      n("cache", "Redis cache", "database", { description: "Sessions and queries" }),
      n("blob", "Object storage", "database", { description: "S3 uploads" }),
      n("mail", "Email provider", "external", { description: "SendGrid" }),
    ],
    [
      e("browser", "cdn", "assets", { style: "dotted" }),
      e("browser", "lb", "HTTPS", { tech: "JSON" }),
      e("lb", "api", "proxy"),
      e("api", "auth", "verify token"),
      e("api", "db", "read/write", { color: "amber", tech: "SQL" }),
      e("api", "cache", "lookup", { style: "dotted", color: "amber" }),
      e("api", "queue", "enqueue", { style: "dashed", color: "violet" }),
      e("queue", "worker", "consume", { style: "dashed", color: "violet" }),
      e("worker", "db", "update", { color: "amber" }),
      e("worker", "blob", "upload"),
      e("worker", "mail", "send", { style: "dashed" }),
      e("auth", "db", "users", { color: "amber" }),
    ],
  );
}

/** One gateway and everything behind it: it should not become a single tall column. */
function gatewayHub(): DiagramTemplate {
  const services = ["Users", "Orders", "Payments", "Catalog", "Search", "Reviews", "Shipping", "Inventory", "Promotions", "Notifications", "Analytics", "Support"];
  return doc(
    "API gateway",
    [
      n("gw", "API gateway", "service", { description: "Routing, auth, rate limits" }),
      ...services.map((s) => n(s.toLowerCase(), `${s} service`)),
    ],
    services.map((s) => e("gw", s.toLowerCase())),
  );
}

/** A strict hierarchy. */
function orgTree(): DiagramTemplate {
  const nodes = [n("ceo", "CEO", "person")];
  const edges: Raw[] = [];
  const add = (parent: string, id: string, label: string) => {
    nodes.push(n(id, label, "person"));
    edges.push(e(parent, id));
  };
  add("ceo", "cto", "CTO");
  add("ceo", "cfo", "CFO");
  add("ceo", "coo", "COO");
  for (const [id, label] of [["plat", "Platform"], ["prod", "Product eng"], ["data", "Data"]] as const) add("cto", id, label);
  for (const [id, label] of [["acct", "Accounting"], ["fpa", "FP&A"]] as const) add("cfo", id, label);
  for (const [id, label] of [["ops", "Operations"], ["supp", "Support"], ["hr", "People"]] as const) add("coo", id, label);
  for (const [id, label] of [["sre", "SRE"], ["infra", "Infrastructure"]] as const) add("plat", id, label);
  for (const [id, label] of [["web", "Web"], ["mobile", "Mobile"]] as const) add("prod", id, label);
  return doc("Organisation", nodes, edges);
}

/** A mesh, with no one direction to read it in. */
function mesh(): DiagramTemplate {
  return doc(
    "Service mesh",
    [
      n("a", "Identity"),
      n("b", "Billing"),
      n("c", "Accounts"),
      n("d", "Ledger"),
      n("f", "Fraud"),
      n("g", "Risk"),
      n("h", "Reports"),
      n("i", "Audit"),
    ],
    [
      e("a", "b"),
      e("a", "c"),
      e("b", "c"),
      e("b", "d"),
      e("c", "d"),
      e("c", "f"),
      e("d", "g"),
      e("f", "g"),
      e("f", "h"),
      e("g", "i"),
      e("h", "i"),
      e("i", "a"),
    ],
  );
}

/** A pure cycle: it should come out round. */
function ring(): DiagramTemplate {
  const ids = ["Plan", "Build", "Test", "Release", "Operate", "Learn"];
  return doc(
    "Delivery loop",
    ids.map((label) => n(label.toLowerCase(), label)),
    ids.map((label, i) => e(label.toLowerCase(), ids[(i + 1) % ids.length]!.toLowerCase())),
  );
}

/** Separate pieces with nothing joining them, and some loose notes. */
function islands(): DiagramTemplate {
  return doc(
    "Three systems",
    [
      n("w1", "Website"),
      n("w2", "CMS"),
      n("w3", "Content DB", "database"),
      n("m1", "Mobile app", "client"),
      n("m2", "Mobile API"),
      n("m3", "Push service"),
      n("m4", "Device registry", "database"),
      n("b1", "Nightly export"),
      n("b2", "Warehouse", "database"),
      n("t1", "Website and mobile share nothing today; a shared identity service is planned for next year.", "text"),
      n("x1", "Legacy FTP drop", "external"),
      n("x2", "Status page", "external"),
    ],
    [
      e("w1", "w2", "pages"),
      e("w2", "w3", "reads"),
      e("m1", "m2", "REST"),
      e("m2", "m3", "notify"),
      e("m2", "m4", "devices"),
      e("b1", "b2", "load"),
    ],
  );
}

/** Regions with members, and lines that cross between them. */
function zonesCloud(): DiagramTemplate {
  return doc(
    "Hybrid deployment",
    [
      n("user", "Customers", "person", { description: "Web and mobile" }),
      n("edge", "Edge proxy", "service", { zoneId: "cloud" }),
      n("app", "App servers", "service", { zoneId: "cloud", description: "Kubernetes" }),
      n("jobs", "Batch jobs", "service", { zoneId: "cloud" }),
      n("rds", "Managed SQL", "database", { zoneId: "cloud" }),
      n("mq", "Message queue", "queue", { zoneId: "cloud" }),
      n("core", "Core banking", "service", { zoneId: "dc", description: "Mainframe" }),
      n("hsm", "HSM cluster", "service", { zoneId: "dc" }),
      n("ledger", "Ledger DB", "database", { zoneId: "dc" }),
      n("kyc", "KYC provider", "external", { zoneId: "saas" }),
      n("sms", "SMS gateway", "external", { zoneId: "saas" }),
    ],
    [
      e("user", "edge", "HTTPS"),
      e("edge", "app", "route"),
      e("app", "rds", "SQL", { color: "amber" }),
      e("app", "mq", "publish", { style: "dashed", color: "violet" }),
      e("mq", "jobs", "consume", { style: "dashed", color: "violet" }),
      e("jobs", "rds", "write", { color: "amber" }),
      e("app", "core", "VPN", { tech: "mTLS" }),
      e("core", "hsm", "sign"),
      e("core", "ledger", "post", { color: "amber" }),
      e("app", "kyc", "verify"),
      e("jobs", "sms", "notify", { style: "dashed" }),
    ],
    {
      zones: [
        { id: "cloud", label: "Cloud region", shape: "rounded", provider: "aws", x: 0, y: 0, w: 400, h: 300 },
        { id: "dc", label: "Data centre", shape: "rounded", x: 100, y: 100, w: 400, h: 300 },
        { id: "saas", label: "Third parties", shape: "rounded", x: 200, y: 200, w: 300, h: 200 },
      ],
    },
  );
}

/** Groups in groups. */
function nestedGroups(): DiagramTemplate {
  return doc(
    "Network tiers",
    [
      n("internet", "Internet", "external"),
      n("vpc", "Production VPC", "group"),
      n("pub", "Public subnet", "group", { parentId: "vpc" }),
      n("priv", "Private subnet", "group", { parentId: "vpc" }),
      n("data", "Data subnet", "group", { parentId: "vpc" }),
      n("alb", "Load balancer", "service", { parentId: "pub" }),
      n("nat", "NAT gateway", "service", { parentId: "pub" }),
      n("web", "Web tier", "service", { parentId: "priv" }),
      n("svc", "Service tier", "service", { parentId: "priv" }),
      n("sql", "Primary DB", "database", { parentId: "data" }),
      n("replica", "Read replica", "database", { parentId: "data" }),
      n("ops", "Ops bastion", "service"),
    ],
    [
      e("internet", "alb", "443"),
      e("alb", "web", "HTTP"),
      e("web", "svc", "gRPC"),
      e("svc", "sql", "SQL", { color: "amber" }),
      e("svc", "replica", "reads", { color: "amber", style: "dotted" }),
      e("sql", "replica", "replicate", { style: "dashed" }),
      e("svc", "nat", "egress", { style: "dotted" }),
      e("ops", "svc", "SSH", { style: "dotted" }),
    ],
  );
}

/** A flow chart: branches, a loop back, and a place where the paths rejoin. */
function flowchart(): DiagramTemplate {
  return doc(
    "Sign in",
    [
      n("start", "Start", "terminator"),
      n("enter", "Enter credentials", "io"),
      n("valid", "Valid?", "decision"),
      n("mfa", "MFA enabled?", "decision"),
      n("code", "Ask for code", "io"),
      n("ok", "Code correct?", "decision"),
      n("lock", "Lock after 5 tries", "service"),
      n("session", "Create session", "service"),
      n("end", "Signed in", "terminator"),
    ],
    [
      e("start", "enter"),
      e("enter", "valid"),
      e("valid", "mfa", "yes"),
      e("valid", "lock", "no"),
      e("lock", "enter", "retry"),
      e("mfa", "code", "yes"),
      e("mfa", "session", "no"),
      e("code", "ok"),
      e("ok", "session", "yes"),
      e("ok", "lock", "no"),
      e("session", "end"),
    ],
  );
}

const col = (id: string, name: string, type: string, key?: string): Raw => ({ id, name, type, ...(key ? { key } : {}) });
const fk = (source: string, target: string, startField: string, endField: string, more: Raw = {}): Raw =>
  e(source, target, "", { startField, endField, startLabel: "*", endLabel: "1", relation: "reference", style: "dashed", ...more });

/** Tall boxes joined row to row. */
function dataModel(): DiagramTemplate {
  return doc(
    "Shop data model",
    [
      n("customer", "customer", "table", { fields: [col("id", "id", "uuid", "pk"), col("email", "email", "text"), col("name", "name", "text"), col("created", "created_at", "timestamp")] }),
      n("address", "address", "table", { fields: [col("id", "id", "uuid", "pk"), col("customer_id", "customer_id", "uuid", "fk"), col("line1", "line1", "text"), col("city", "city", "text")] }),
      n("order", "order", "table", { fields: [col("id", "id", "uuid", "pk"), col("customer_id", "customer_id", "uuid", "fk"), col("address_id", "address_id", "uuid", "fk"), col("status", "status", "text"), col("total", "total", "numeric")] }),
      n("line", "order_line", "table", { fields: [col("id", "id", "uuid", "pk"), col("order_id", "order_id", "uuid", "fk"), col("product_id", "product_id", "uuid", "fk"), col("qty", "qty", "int")] }),
      n("product", "product", "table", { fields: [col("id", "id", "uuid", "pk"), col("sku", "sku", "text"), col("name", "name", "text"), col("category_id", "category_id", "uuid", "fk"), col("price", "price", "numeric")] }),
      n("category", "category", "table", { fields: [col("id", "id", "uuid", "pk"), col("name", "name", "text"), col("parent_id", "parent_id", "uuid", "fk")] }),
      n("payment", "payment", "table", { fields: [col("id", "id", "uuid", "pk"), col("order_id", "order_id", "uuid", "fk"), col("amount", "amount", "numeric"), col("provider", "provider", "text")] }),
      n("shipment", "shipment", "table", { fields: [col("id", "id", "uuid", "pk"), col("order_id", "order_id", "uuid", "fk"), col("carrier", "carrier", "text")] }),
    ],
    [
      fk("address", "customer", "customer_id", "id"),
      fk("order", "customer", "customer_id", "id"),
      fk("order", "address", "address_id", "id"),
      fk("line", "order", "order_id", "id"),
      fk("line", "product", "product_id", "id"),
      fk("product", "category", "category_id", "id"),
      fk("payment", "order", "order_id", "id"),
      fk("shipment", "order", "order_id", "id"),
    ],
  );
}

/** Dense many-to-many: most of the job is keeping the crossings down. */
function bipartite(): DiagramTemplate {
  const clients = ["Web", "iOS", "Android", "Partner API", "Admin"];
  const services = ["Accounts", "Billing", "Catalog", "Search", "Media", "Events"];
  const links: Array<[number, number]> = [
    [0, 0], [0, 2], [0, 3], [0, 4],
    [1, 0], [1, 1], [1, 2],
    [2, 0], [2, 1], [2, 2],
    [3, 1], [3, 5],
    [4, 0], [4, 1], [4, 5],
  ];
  return doc(
    "Clients and services",
    [
      ...clients.map((c, i) => n(`c${i}`, c, "client")),
      ...services.map((s, i) => n(`s${i}`, s, "service")),
    ],
    links.map(([a, b]) => e(`c${a}`, `s${b}`)),
  );
}

/** A work plan. */
function taskPlan(): DiagramTemplate {
  const t = (id: string, label: string, points: number, who: string[]) =>
    n(id, label, "task", { storyPoints: points, assignees: who, description: "" });
  return doc(
    "Launch plan",
    [
      t("spec", "Write the spec", 3, ["Ana"]),
      t("design", "Design review", 2, ["Ravi"]),
      t("api", "Build API", 8, ["Ana", "Lee"]),
      t("ui", "Build UI", 5, ["Mei"]),
      t("qa", "QA pass", 3, ["Lee"]),
      t("docs", "Write docs", 2, ["Ravi"]),
      n("launch", "Launch", "milestone"),
    ],
    [
      e("spec", "design"),
      e("design", "api"),
      e("design", "ui"),
      e("api", "qa"),
      e("ui", "qa"),
      e("qa", "launch"),
      e("docs", "launch"),
    ],
  );
}

/** Big enough to make a mess: forty boxes across four groups. */
function largeSystem(): DiagramTemplate {
  const nodes: Raw[] = [
    n("users", "End users", "person"),
    n("partners", "Partners", "external"),
    n("edge", "Edge", "group"),
    n("cdn", "CDN", "service", { parentId: "edge" }),
    n("waf", "WAF", "service", { parentId: "edge" }),
    n("gw", "API gateway", "service", { parentId: "edge" }),
    n("core", "Core services", "group"),
    ...["Accounts", "Orders", "Pricing", "Catalog", "Cart", "Checkout", "Payments", "Fulfilment"].map((s) =>
      n(s.toLowerCase(), s, "service", { parentId: "core" }),
    ),
    n("data", "Data stores", "group"),
    ...["Accounts DB", "Orders DB", "Catalog DB", "Search index", "Session cache", "Ledger"].map((s, i) =>
      n(`d${i}`, s, "database", { parentId: "data" }),
    ),
    n("async", "Async", "group"),
    n("events", "Event bus", "queue", { parentId: "async" }),
    ...["Mailer", "Indexer", "Fraud scoring", "Exports"].map((s) => n(s.split(" ")[0]!.toLowerCase(), s, "service", { parentId: "async" })),
    n("ext-pay", "Payment network", "external"),
    n("ext-mail", "Email provider", "external"),
    n("ext-bi", "BI warehouse", "external"),
  ];
  const edges: Raw[] = [
    e("users", "cdn", "HTTPS"),
    e("cdn", "waf"),
    e("waf", "gw"),
    e("partners", "gw", "API key"),
    e("gw", "accounts"),
    e("gw", "orders"),
    e("gw", "catalog"),
    e("gw", "cart"),
    e("gw", "checkout"),
    e("checkout", "cart"),
    e("checkout", "pricing"),
    e("checkout", "payments"),
    e("checkout", "orders"),
    e("orders", "fulfilment"),
    e("cart", "pricing"),
    e("accounts", "d0", "", { color: "amber" }),
    e("orders", "d1", "", { color: "amber" }),
    e("catalog", "d2", "", { color: "amber" }),
    e("catalog", "d3", "", { color: "amber", style: "dotted" }),
    e("cart", "d4", "", { color: "amber", style: "dotted" }),
    e("payments", "d5", "", { color: "amber" }),
    e("payments", "ext-pay", "settle"),
    e("orders", "events", "published", { style: "dashed", color: "violet" }),
    e("payments", "events", "", { style: "dashed", color: "violet" }),
    e("events", "mailer", "", { style: "dashed", color: "violet" }),
    e("events", "indexer", "", { style: "dashed", color: "violet" }),
    e("events", "fraud", "", { style: "dashed", color: "violet" }),
    e("events", "exports", "", { style: "dashed", color: "violet" }),
    e("mailer", "ext-mail", "send"),
    e("indexer", "d3", "", { color: "amber" }),
    e("fraud", "payments", "hold", { style: "dashed" }),
    e("exports", "ext-bi", "nightly"),
  ];
  return doc("Commerce platform", nodes, edges);
}

/**
 * An author who tried: a sensible arrangement that reads top to bottom, with the
 * mistakes a model actually makes. Polish should keep it and clear the mistakes.
 */
function roughlyPlaced(): DiagramTemplate {
  const at = (x: number, y: number, w = 170, h = 76) => ({ x, y, w, h });
  return doc(
    "Author's arrangement",
    [
      n("client", "Mobile client", "client", at(420, 40)),
      n("api", "Public API", "service", at(428, 190)),
      n("users", "User service", "service", at(120, 345)),
      n("orders", "Order service", "service", at(418, 352)),
      n("stock", "Stock service", "service", at(722, 340)),
      n("udb", "User DB", "database", at(126, 520)),
      n("odb", "Order DB", "database", at(410, 505)),
      n("sdb", "Stock DB", "database", at(560, 530)),
      n("note", "Everything below the API runs in one cluster.", "text", at(40, 40, 300, 60)),
    ],
    [
      e("client", "api", "HTTPS"),
      e("api", "users", "gRPC"),
      e("api", "orders", "gRPC"),
      e("api", "stock", "gRPC"),
      e("users", "udb", "SQL"),
      e("orders", "odb", "SQL"),
      e("stock", "sdb", "SQL"),
      e("orders", "stock", "reserve"),
      e("client", "odb", "offline sync", { style: "dashed" }),
    ],
  );
}

export const ARRANGE_FIXTURES: Record<string, () => DiagramTemplate> = {
  pipeline,
  webApp,
  gatewayHub,
  orgTree,
  mesh,
  ring,
  islands,
  zonesCloud,
  nestedGroups,
  flowchart,
  dataModel,
  bipartite,
  taskPlan,
  largeSystem,
  roughlyPlaced,
};
