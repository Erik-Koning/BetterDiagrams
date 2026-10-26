/**
 * icon-suggest.ts — which icons a box's own words point at.
 *
 * The icon picker was a list of names, and someone who had never thought
 * about what "layers" or "balance" look like left every box without one.
 * Reading the box's name and description for the words each built-in icon
 * stands for gives the inspector a short row of likely picks, and gives the
 * picker's search the same vocabulary: "postgres" finds the database glyph.
 *
 * Whole words only, so "address" doesn't suggest a database for "add". A
 * registry's own icons are suggested when their name is one of the words.
 */

/** The words each built-in icon stands for, beyond its own name. */
export const ICON_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  user: ["person", "customer", "admin", "actor", "member", "account", "profile", "owner", "patient", "visitor"],
  users: ["team", "people", "staff", "customers", "clients", "audience", "members", "community", "employees"],
  database: ["db", "postgres", "postgresql", "mysql", "sql", "sqlite", "mongo", "mongodb", "dynamo", "dynamodb", "redis", "store", "storage", "table", "data", "warehouse", "snowflake", "bigquery", "ledger", "records"],
  server: ["host", "vm", "instance", "ec2", "machine", "backend", "node", "origin"],
  layers: ["layer", "stack", "tier", "queue", "kafka", "rabbitmq", "sqs", "bus", "broker"],
  globe: ["web", "website", "internet", "browser", "http", "https", "cdn", "dns", "public", "site", "frontend", "storefront", "domain"],
  cloud: ["aws", "azure", "gcp", "saas", "hosted", "hosting"],
  window: ["app", "ui", "desktop", "portal", "page", "screen", "frontend", "spa"],
  mobile: ["phone", "ios", "android", "tablet"],
  lock: ["auth", "authentication", "login", "signin", "password", "secret", "secrets", "encrypt", "encryption", "vault", "iam", "sso", "oauth", "private"],
  gear: ["worker", "workers", "job", "jobs", "process", "processor", "config", "configuration", "settings", "engine", "batch", "daemon"],
  bolt: ["event", "events", "trigger", "lambda", "function", "functions", "serverless", "cache", "realtime", "stream"],
  doc: ["document", "documents", "docs", "file", "files", "report", "pdf", "spec", "policy", "contract", "page", "article", "content", "cms"],
  code: ["api", "sdk", "script", "repo", "repository", "library", "source", "rest", "graphql", "grpc"],
  mail: ["email", "emails", "smtp", "newsletter", "inbox", "message", "messages", "sms"],
  box: ["package", "product", "module", "component", "container", "microservice"],
  shield: ["firewall", "gateway", "waf", "protect", "protection", "compliance", "guard", "security", "proxy"],
  sparkle: ["ai", "ml", "llm", "model", "gpt", "claude", "recommend", "recommendations", "assistant", "copilot"],
  key: ["token", "tokens", "credential", "credentials", "license", "kms", "apikey", "keys"],
  chart: ["analytics", "metrics", "chart", "charts", "dashboard", "stats", "statistics", "bi", "insights", "kpi"],
  search: ["elastic", "elasticsearch", "index", "lookup", "find", "query", "opensearch", "algolia"],
  filter: ["rule", "rules", "validation", "moderation", "sort", "triage"],
  folder: ["directory", "archive", "bucket", "s3", "blob", "drive", "uploads"],
  sync: ["replicate", "replication", "etl", "pipeline", "import", "export", "backup", "migrate", "migration", "mirror"],
  cpu: ["compute", "gpu", "processor", "hardware", "device", "devices", "iot", "sensor", "edge"],
  terminal: ["cli", "shell", "console", "ssh", "devops", "ci", "cd", "build", "deploy"],
  balance: ["balancer", "loadbalancer", "lb", "legal", "finance", "accounting", "tax"],
  share: ["integration", "integrations", "webhook", "webhooks", "connect", "connector", "partner", "partners", "federation"],
  grid: ["spreadsheet", "catalog", "inventory", "matrix", "sheet", "sheets"],
  branch: ["git", "version", "versions", "workflow", "decision", "routing", "router", "fork"],
  clock: ["schedule", "scheduler", "cron", "timer", "delay", "timeout", "sla", "deadline"],
  calendar: ["booking", "bookings", "appointment", "appointments", "reservation", "reservations", "agenda", "dates"],
  bell: ["alert", "alerts", "notification", "notifications", "alarm", "pager", "notify", "reminder", "reminders"],
  card: ["payment", "payments", "billing", "stripe", "invoice", "invoices", "wallet", "charge", "charges", "subscription"],
  cart: ["shop", "order", "orders", "checkout", "ecommerce", "basket", "purchase", "sales"],
  activity: ["monitoring", "monitor", "health", "log", "logs", "logging", "observability", "telemetry", "trace", "tracing", "datadog"],
  eye: ["view", "viewer", "audit", "watch", "review", "preview", "visibility"],
  warning: ["error", "errors", "risk", "incident", "incidents", "fraud", "issue", "issues", "failure"],
  check: ["approval", "approve", "done", "verify", "verification", "test", "tests", "qa", "confirm", "success"],
  link: ["url", "urls", "reference", "references", "relation", "shortener"],
  image: ["photo", "photos", "media", "thumbnail", "thumbnails", "asset", "assets", "picture", "pictures"],
  video: ["videos", "camera", "streaming", "recording", "transcode"],
  pin: ["location", "locations", "map", "maps", "geo", "address", "place", "places", "gps", "store"],
  robot: ["bot", "bots", "chatbot", "automation", "agent", "agents", "assistant"],
  flask: ["lab", "experiment", "experiments", "research", "science", "beta", "sandbox"],
};

/** Lower-case whole words, with the common plural and joined forms. */
function wordsOf(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set(words);
  // "load balancer", "api key" — joined, as the table spells them.
  for (let i = 0; i + 1 < words.length; i++) out.add(words[i] + words[i + 1]);
  return out;
}

/**
 * Up to `limit` icon names the text points at, best first: the icons whose
 * words appear most often, ties in the order the registry lists them. Only
 * icons in `available` are suggested, and never "none".
 */
export function suggestIcons(text: string, available: readonly string[], limit = 4): string[] {
  const words = wordsOf(text);
  if (!words.size) return [];
  const scored = available
    .filter((name) => name !== "none")
    .map((name, order) => {
      const own = words.has(name.toLowerCase()) ? 2 : 0;
      const hits = (ICON_KEYWORDS[name] ?? []).filter((word) => words.has(word)).length;
      return { name, order, score: own + hits };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.name);
}

/** The words a picker's search should find an icon by. */
export function iconKeywords(name: string): string | undefined {
  return ICON_KEYWORDS[name]?.join(" ");
}
