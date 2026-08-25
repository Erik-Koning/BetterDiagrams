/**
 * cloud.ts — the cloud provider component packs, as DATA.
 *
 * Each big cloud gets a curated set of first-class node kinds ("aws-lambda",
 * "azure-functions", "gcp-pubsub") with the one-line hints the system prompt
 * teaches an LLM with. This file is the single source of truth for WHICH
 * components exist and what the prompt says about them; the react registry
 * (react/cloud-kinds.ts) maps the same ids to colors, icons, and shapes.
 *
 * Zero dependencies, like everything in contract/ — safe for a backend or an
 * LLM pipeline. Kind ids are provider-prefixed so two clouds' same-named
 * services ("api-gateway") can never collide.
 */

export const CLOUD_PROVIDER_IDS = ["aws", "azure", "gcp"] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

/** Visual/semantic family — the react layer picks icon and silhouette by it. */
export type CloudComponentRole =
  | "compute"
  | "containers"
  | "storage"
  | "database"
  | "cache"
  | "queue"
  | "events"
  | "gateway"
  | "cdn"
  | "ai"
  | "security";

export interface CloudComponentDef {
  /** The node kind id a document stores — always provider-prefixed. */
  id: string;
  /** Display label, shown on the node's small-caps kind line. */
  label: string;
  /** One line for the system prompt: what the service is for. */
  hint: string;
  role: CloudComponentRole;
}

export const CLOUD_COMPONENTS: Record<CloudProviderId, CloudComponentDef[]> = {
  aws: [
    { id: "aws-lambda", label: "Lambda", hint: "serverless function", role: "compute" },
    { id: "aws-ec2", label: "EC2", hint: "virtual machine / instance", role: "compute" },
    { id: "aws-eks", label: "EKS", hint: "managed Kubernetes cluster", role: "containers" },
    { id: "aws-s3", label: "S3", hint: "object storage bucket", role: "storage" },
    { id: "aws-dynamodb", label: "DynamoDB", hint: "serverless NoSQL table", role: "database" },
    { id: "aws-rds", label: "RDS", hint: "managed relational database", role: "database" },
    { id: "aws-sqs", label: "SQS", hint: "message queue", role: "queue" },
    { id: "aws-sns", label: "SNS", hint: "pub/sub topic and fan-out", role: "events" },
    { id: "aws-api-gateway", label: "API Gateway", hint: "managed API front door", role: "gateway" },
    { id: "aws-cloudfront", label: "CloudFront", hint: "CDN / edge distribution", role: "cdn" },
    { id: "aws-bedrock", label: "Bedrock", hint: "hosted foundation models / LLM inference", role: "ai" },
  ],
  azure: [
    { id: "azure-functions", label: "Functions", hint: "serverless function", role: "compute" },
    { id: "azure-app-service", label: "App Service", hint: "managed web app / API hosting", role: "compute" },
    { id: "azure-vm", label: "Virtual Machine", hint: "virtual machine / instance", role: "compute" },
    { id: "azure-container-apps", label: "Container Apps", hint: "serverless container service", role: "containers" },
    { id: "azure-aks", label: "AKS", hint: "managed Kubernetes cluster", role: "containers" },
    { id: "azure-blob", label: "Blob Storage", hint: "object storage container", role: "storage" },
    { id: "azure-cosmos", label: "Cosmos DB", hint: "globally distributed NoSQL database", role: "database" },
    { id: "azure-sql", label: "Azure SQL", hint: "managed relational database", role: "database" },
    { id: "azure-redis", label: "Cache for Redis", hint: "managed in-memory cache", role: "cache" },
    { id: "azure-service-bus", label: "Service Bus", hint: "message queue / broker", role: "queue" },
    { id: "azure-event-grid", label: "Event Grid", hint: "event routing and fan-out", role: "events" },
    { id: "azure-event-hubs", label: "Event Hubs", hint: "high-throughput event streaming ingestion", role: "events" },
    { id: "azure-apim", label: "API Management", hint: "managed API front door", role: "gateway" },
    { id: "azure-front-door", label: "Front Door", hint: "CDN / global entry point", role: "cdn" },
    { id: "azure-openai", label: "Azure OpenAI", hint: "hosted foundation models / LLM inference", role: "ai" },
    { id: "azure-key-vault", label: "Key Vault", hint: "secrets, keys, and certificates", role: "security" },
  ],
  gcp: [
    { id: "gcp-cloud-run", label: "Cloud Run", hint: "serverless container service", role: "compute" },
    { id: "gcp-functions", label: "Cloud Functions", hint: "serverless function", role: "compute" },
    { id: "gcp-compute", label: "Compute Engine", hint: "virtual machine / instance", role: "compute" },
    { id: "gcp-gke", label: "GKE", hint: "managed Kubernetes cluster", role: "containers" },
    { id: "gcp-storage", label: "Cloud Storage", hint: "object storage bucket", role: "storage" },
    { id: "gcp-firestore", label: "Firestore", hint: "serverless NoSQL document database", role: "database" },
    { id: "gcp-cloud-sql", label: "Cloud SQL", hint: "managed relational database", role: "database" },
    { id: "gcp-spanner", label: "Spanner", hint: "globally consistent relational database", role: "database" },
    { id: "gcp-bigquery", label: "BigQuery", hint: "serverless data warehouse / analytics", role: "database" },
    { id: "gcp-memorystore", label: "Memorystore", hint: "managed in-memory cache (Redis)", role: "cache" },
    { id: "gcp-pubsub", label: "Pub/Sub", hint: "message queue / pub-sub topic", role: "queue" },
    { id: "gcp-api-gateway", label: "API Gateway", hint: "managed API front door", role: "gateway" },
    { id: "gcp-load-balancing", label: "Load Balancing", hint: "global L4/L7 load balancer entry point", role: "gateway" },
    { id: "gcp-cdn", label: "Cloud CDN", hint: "CDN / edge caching", role: "cdn" },
    { id: "gcp-vertex-ai", label: "Vertex AI", hint: "ML platform / model training and inference", role: "ai" },
  ],
};

const PROVIDER_LABEL: Record<CloudProviderId, string> = {
  aws: "AWS",
  azure: "Azure",
  gcp: "GCP",
};

const isCloudProviderId = (value: string): value is CloudProviderId =>
  (CLOUD_PROVIDER_IDS as readonly string[]).includes(value);

/** Every kind id the given providers contribute, in pack order. */
export function cloudKindIds(providers: readonly string[]): string[] {
  return providers
    .filter(isCloudProviderId)
    .flatMap((provider) => CLOUD_COMPONENTS[provider].map((component) => component.id));
}

/** One component, carrying the provider it came from — the row a picker renders. */
export interface CloudResource extends CloudComponentDef {
  provider: CloudProviderId;
}

/**
 * The given providers' components as flat rows, in pack order. This is the
 * menu behind "which resources should the schema teach?" — the caller shows
 * them, and hands the chosen ids back as `components` below.
 */
export function cloudResources(providers: readonly string[]): CloudResource[] {
  return providers
    .filter(isCloudProviderId)
    .flatMap((provider) => CLOUD_COMPONENTS[provider].map((component) => ({ ...component, provider })));
}

/** How much of each pack a prompt should teach. */
export interface CloudSectionOptions {
  /**
   * Restrict every section to these kind ids — the "which resources" half of
   * a scope. Absent = the provider's whole pack. A provider left with nothing
   * gets no section at all, so an empty selection can never smuggle a cloud
   * back in through its heading.
   */
  components?: readonly string[];
}

/**
 * Every cloud kind id, all providers. Part of `validateTemplate`'s base
 * vocabulary — a document that uses aws-lambda survives validation in a
 * backend or a host that never touches the react registry.
 */
export const ALL_CLOUD_KIND_IDS: readonly string[] = cloudKindIds(CLOUD_PROVIDER_IDS);

/**
 * The prompt appendix for the selected clouds — appended AFTER the base
 * system prompt, one section per provider. Teaches the model the component
 * ids and when to prefer them over the generic kinds. Empty selection ⇒ "".
 *
 * `opts.components` narrows each section to a chosen subset, so a prompt can
 * teach "Azure, but only App Service, Blob, and Postgres" without inventing a
 * second source of truth for what those services are.
 */
export function buildCloudPromptSections(
  providers: readonly string[],
  opts: CloudSectionOptions = {},
): string {
  const wanted = opts.components ? new Set(opts.components) : null;
  const sections = providers.filter(isCloudProviderId).flatMap((provider) => {
    const label = PROVIDER_LABEL[provider];
    const components = wanted
      ? CLOUD_COMPONENTS[provider].filter((component) => wanted.has(component.id))
      : CLOUD_COMPONENTS[provider];
    if (!components.length) return [];
    const lines = components
      .map((component) => `  ${component.id} — ${component.label} (${component.hint})`)
      .join("\n");
    return (
      `### ${label} components\n` +
      `Available node kinds for ${label}-hosted architectures:\n${lines}\n` +
      `- Prefer these ${provider}-* kinds over generic service/database/queue for components hosted on ${label}.\n` +
      `- When the diagram spans providers, pair them with a zone whose providers include "${provider}" or set the node's "providers":["${provider}"].`
    );
  });
  return sections.join("\n");
}
