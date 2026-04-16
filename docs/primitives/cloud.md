# Cloud Primitives

Cloud primitives describe infrastructure, deployment, and runtime topology. The core does not extract any of these. They are produced entirely by plugins. The primitive definitions still live in core, though, because that is how plugins share vocabulary with each other and with the MCP server. I don't think core should have opinions about AWS Lambda vs ECS vs Kubernetes, but it does need to know what a "compute unit" is so plugins can all refer to the same concept.

The v1 vocabulary is shaped around AWS and Serverless-style deployments. The names are generic enough to extend, but the initial use case informed every property here.

---

## Nodes

### `ComputeUnit`

Any unit of code execution. Lambda functions, ECS tasks, container pods, Batch jobs, long-running processes: they all map to `ComputeUnit`.

| Property | Type | Notes |
|---|---|---|
| `name` | string | Resource name (function name, service name, etc.) |
| `hostingModel` | string | `serverless-function`, `container`, `managed-runtime`, `vm` |
| `invocationModel` | string | `event-driven`, `long-running`, `scheduled`, `batch`, `request` |
| `runtime` | string | e.g., `nodejs18.x`, `dotnet10`, `python3.12` |
| `memoryMB` | integer | |
| `timeoutSeconds` | integer | |
| `concurrency` | integer | |

---

### `DataStore`

Any persistent storage destination.

| Property | Type | Notes |
|---|---|---|
| `name` | string | |
| `accessPattern` | string | `key-value`, `document`, `relational`, `search`, `blob`, `stream` |
| `provider` | string | e.g., `dynamodb`, `postgres`, `elasticsearch`, `s3` |
| `region` | string | |
| `schemaUri` | string | Pointer to a schema definition, if any |

---

### `DataAccessLayer`

An ORM, query builder, or client library that mediates access between code and a `DataStore`. This node exists because "the code accesses DynamoDB" is less useful than "this symbol uses Mongoose to access MongoDB." The layer is the thing the code actually touches.

| Property | Type | Notes |
|---|---|---|
| `name` | string | e.g., `Mongoose`, `EntityFramework`, `Prisma` |
| `kind` | string | `orm`, `query-builder`, `client-sdk` |

---

### `MessageChannel`

A queue, topic, stream, or other asynchronous message conduit.

| Property | Type | Notes |
|---|---|---|
| `name` | string | |
| `kind` | string | `queue`, `topic`, `stream`, `event-bus` |
| `provider` | string | e.g., `sqs`, `sns`, `kinesis`, `eventbridge` |
| `ordering` | string | `fifo`, `best-effort`, `none` |
| `deliveryModel` | string | `at-least-once`, `at-most-once`, `exactly-once` |

---

### `EventSource`

A trigger that causes a `ComputeUnit` to execute. This is distinct from `MessageChannel`. The channel is the data carrier; the source is the binding between a trigger and a compute unit. An SQS queue is a `MessageChannel`. The SQS trigger on a Lambda is the `EventSource`.

| Property | Type | Notes |
|---|---|---|
| `kind` | string | `http`, `queue`, `stream`, `schedule`, `object-store`, `db-change` |
| `descriptor` | string | Kind-specific identifier (path, queue name, cron expression, etc.) |

---

### `HTTPEndpoint`

An HTTP route declared on the server side.

| Property | Type | Notes |
|---|---|---|
| `method` | string | `GET`, `POST`, etc. |
| `pathPattern` | string | Route pattern, e.g., `/api/users/:id` |
| `framework` | string | `express`, `fastify`, `aspnet`, `lambda-http`, etc. |

---

### `HTTPClient`

An HTTP call emitted from the client side. When possible, these are matched to `HTTPEndpoint` nodes to establish cross-service call edges.

| Property | Type | Notes |
|---|---|---|
| `method` | string | |
| `urlPattern` | string | Resolved URL or template with placeholders |
| `library` | string | `axios`, `fetch`, `httpclient`, etc. |

---

### `Ingress`

An entry point into the system: API Gateway, a load balancer, a reverse proxy, a CDN. Ingress nodes sit in front of compute and route requests to it.

| Property | Type | Notes |
|---|---|---|
| `name` | string | e.g., `api-gateway`, `alb-main`, `nginx-prod` |
| `kind` | string | `api-gateway`, `load-balancer`, `reverse-proxy`, `cdn` |

---

### `Proxy`

A proxy sitting in the network path. Could be a sidecar in a service mesh, a reverse proxy in front of a service, or a forward proxy for outbound traffic.

| Property | Type | Notes |
|---|---|---|
| `name` | string | |
| `kind` | string | `sidecar`, `reverse`, `forward` |

---

### `NetworkRoute`

A directed network path between two resources. Used to describe how requests actually travel through the system topology.

| Property | Type | Notes |
|---|---|---|
| `source` | string | Originating resource |
| `target` | string | Destination resource |
| `protocol` | string | `http`, `https`, `grpc`, `tcp` |

---

### `DeploymentManifest`

A deployment configuration file: a `serverless.yml`, a CloudFormation template, a Copilot manifest, a Helm chart. This node ties infrastructure definition to the code it deploys.

| Property | Type | Notes |
|---|---|---|
| `path` | string | Path within the manifests repo |
| `kind` | string | `serverless-yml`, `copilot-manifest`, `k8s`, `helm`, `cloudformation` |

---

### `BuildPipeline`

A CI/CD pipeline that builds or deploys code.

| Property | Type | Notes |
|---|---|---|
| `name` | string | |
| `provider` | string | `github-actions`, `azure-pipelines`, `codebuild`, `serverless-deploy` |

---

### `SyncTarget`

A target environment that a deployment manifest deploys to.

| Property | Type | Notes |
|---|---|---|
| `clusterOrStack` | string | Target environment identifier |

---

### `Credential`

An IAM role, IAM user, or service account. Credentials are what compute units assume in order to be granted permissions.

| Property | Type | Notes |
|---|---|---|
| `name` | string | Role, user, or service account name |
| `kind` | string | `iam-role`, `iam-user`, `service-account` |

---

### `IAMPermission`

A single permission statement. Each `allow` or `deny` on a specific action and resource glob becomes its own node, linked back to the `Credential` that grants it.

| Property | Type | Notes |
|---|---|---|
| `action` | string | e.g., `dynamodb:PutItem` |
| `resourceGlob` | string | |
| `effect` | string | `allow`, `deny` |

---

## Edges

| Edge | From | To | Notes |
|---|---|---|---|
| `IMPLEMENTED_BY` | ComputeUnit | Symbol (function) | Maps infra to code |
| `TRIGGERED_BY` | ComputeUnit | EventSource | |
| `CARRIES` | EventSource | MessageChannel | For queue/stream-sourced events |
| `EXPOSES` | ComputeUnit | HTTPEndpoint | |
| `CALLS_ENDPOINT` | HTTPClient | HTTPEndpoint | Cross-service matching |
| `ACCESSES` | ComputeUnit | DataStore | Via `DataAccessLayer` if present |
| `USES` | Symbol | DataAccessLayer | |
| `WRAPS` | DataAccessLayer | DataStore | |
| `PUBLISHES_TO` | ComputeUnit | MessageChannel | |
| `CONSUMES_FROM` | ComputeUnit | MessageChannel | |
| `ROUTES_TO` | Ingress | ComputeUnit | |
| `PROTECTED_BY` | HTTPEndpoint | Ingress | |
| `DEPLOYED_BY` | ComputeUnit | DeploymentManifest | |
| `BUILT_BY` | DeploymentManifest | BuildPipeline | |
| `SYNCED_TO` | DeploymentManifest | SyncTarget | |
| `ASSUMES` | ComputeUnit | Credential | |
| `GRANTS` | Credential | IAMPermission | |
| `APPLIES_TO` | IAMPermission | DataStore, MessageChannel, etc. | |
