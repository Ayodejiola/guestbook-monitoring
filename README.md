# Guestbook + Monitoring (Pulumi, AKS, Prometheus, Grafana)

This project extends the [Pulumi Kubernetes Guestbook example](https://github.com/pulumi/examples/blob/master/kubernetes-ts-guestbook/README.md)
with a Prometheus + Grafana monitoring stack, all defined and deployed with Pulumi
(TypeScript). It also provisions the AKS cluster itself with Pulumi, so the whole
thing - infra, app, and observability - comes up from a single `pulumi up`.

## What gets deployed

| Layer | Resource | Notes |
|---|---|---|
| Infra | AKS cluster (`cluster.ts`) | 2-node `Standard_B2s` pool, `azure-native` provider |
| App | Guestbook (`guestbook.ts`) | Redis leader + 2 replicas + 3-replica PHP frontend, in the `guestbook` namespace. Reimplementation of the upstream example. |
| App | `redis_exporter` sidecars | One per Redis pod, exposing real Redis metrics on port `9121` |
| Monitoring | kube-prometheus-stack (`monitoring.ts`) | Helm chart install of Prometheus, Grafana, Alertmanager (disabled), kube-state-metrics, node-exporter, in the `monitoring` namespace |
| Monitoring | 2x `ServiceMonitor` | Point Prometheus at the Redis leader/replica metrics endpoints |
| Monitoring | Grafana dashboard | `dashboard.json`, auto-imported via a labeled ConfigMap + Grafana's dashboard sidecar |
| Secrets | Azure Key Vault (`keyvault.ts`) | Holds the generated Grafana admin password - nothing sensitive is printed in this README, committed to git, or needed in chat |

### Design decisions / how metrics are exposed

The assignment allows "simple metrics, such as the number of requests or resource
usage," via ServiceMonitors or annotations. This implementation covers both halves
of the stack differently, on purpose:

- **Backend (Redis):** each Redis pod runs an `oliver006/redis_exporter` sidecar,
  with its own Service + `ServiceMonitor`. Prometheus scrapes real Redis metrics:
  commands processed/sec, connected clients, memory, etc. This is the literal
  "ServiceMonitor scraping a backend service" the assignment describes.
- **Frontend (PHP/Guestbook):** the upstream `gb-frontend` image has no metrics
  endpoint of its own, so instrumenting "number of requests" would mean forking
  the app image, which is out of scope for a monitoring exercise. Instead, the
  frontend's **resource usage** (CPU, memory) is observed via the kubelet/cAdvisor
  metrics that kube-prometheus-stack already scrapes for every pod in the cluster,
  out of the box, no extra config needed. This satisfies the assignment's own
  "resource usage" example and is shown in the dashboard.

## Architecture

```
GitHub (source of truth)                  Azure DevOps                      Azure
┌──────────────────────┐   PR / push   ┌───────────────────┐   pulumi up   ┌──────────────────────────────┐
│ Ayodejiola/           │──────────────▶│ guestbook-monitoring│  (gated,    │ guestbook-rgf48916b4 (RG)    │
│ guestbook-monitoring  │               │ pipeline:           │   manual    │  └─ AKS: guestbook-aksbcbd201e│
│  main / feature / fix │               │  - Validate         │  approval)  │      ├─ ns guestbook          │
│  / ci / docs branches │               │  - DevSecOps        │─────────────▶│      │   frontend (x3) ──LB──▶ http://74.151.141.67
└──────────────────────┘               │  - Deploy (approval)│             │      │   redis-leader/replica + redis_exporter sidecars
                                         └───────────────────┘             │      └─ ns monitoring
                                                                             │          kube-prometheus-stack (Prometheus, Grafana) ──LB──▶ http://20.72.180.150
                                                                             │
                                         guestbook-cicd-rg (RG)              │
                                          ├─ Storage account: Pulumi state   │
                                          │   (azblob:// backend)            │
                                          └─ guestbook-kv (Key Vault):       │
                                              Pulumi secrets-provider key +  │
                                              Grafana admin password         │
```

Request flow: a browser hits the frontend LoadBalancer → PHP frontend (`gb-frontend:v5`) →
`redis-leader` for writes / `redis-leader` or `redis-replica` for reads. Each Redis pod's
`redis_exporter` sidecar, plus the kubelet/cAdvisor metrics every pod already exposes, are
scraped by Prometheus (via `ServiceMonitor`s and the cluster-wide kubelet job
respectively) and rendered in the auto-provisioned Grafana dashboard.

Deployment flow: a change lands on a `feature`/`fix`/`ci`/`docs` branch → PR into `main` →
Azure Pipelines runs `Validate` (build/lint/`pulumi preview`/Helm template) and
`DevSecOps` (secret/dependency/container scans + SBOM) on every PR and push → merging to
`main` makes the `Deploy` stage eligible to run, but it stays paused behind a real Azure
DevOps Environment approval check until a human approves it - `pulumi up` is never
triggered by a push alone.

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/) (tested with v3.271.0)
- [Node.js](https://nodejs.org/) 18+ (tested with v24.20.0)
- An Azure subscription + [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), logged in (`az login`)
- `kubectl` and `helm` (helm isn't strictly required to deploy - Pulumi's Helm provider
  handles that - but it's useful for troubleshooting)

## State backend and secrets

Pulumi state lives in **Azure Blob Storage**, not the local filesystem, so both a
human running `pulumi up` from their laptop and an Azure Pipelines agent see the
same state. Stack secrets (currently just the Grafana admin password at the
Pulumi-state level - the actual value lives in Key Vault, see below) are encrypted
with an **Azure Key Vault key** via envelope encryption, not a shared passphrase.

This was deliberately bootstrapped *outside* Pulumi, with plain `az` CLI commands,
to sidestep the chicken-and-egg problem of using Pulumi to create the bucket Pulumi
itself needs in order to run:

```bash
az group create --name guestbook-cicd-rg --location eastus
az storage account create --name <globally-unique-name> --resource-group guestbook-cicd-rg \
  --location eastus --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access false
az storage container create --name pulumi-state --account-name <name> --auth-mode login
```

Then, once logged into that backend (`pulumi login azblob://pulumi-state` with
`AZURE_STORAGE_ACCOUNT`/`AZURE_STORAGE_KEY` set - the key comes from
`az storage account keys list`, never committed anywhere), the stack's secrets
provider was switched from a local passphrase to the Key Vault key created in
`keyvault.ts`:

```bash
az keyvault key create --vault-name <vault> --name pulumi-secrets --protection software --kty RSA --size 2048
pulumi stack change-secrets-provider "azurekeyvault://<vault>.vault.azure.net/keys/pulumi-secrets"
```

Anyone running `pulumi` commands against this stack (including CI) needs:
1. `AZURE_STORAGE_ACCOUNT` + `AZURE_STORAGE_KEY` env vars (or RBAC `Storage Blob
   Data Contributor` on the storage account, as an alternative to a shared key)
   to read/write state.
2. Azure AD access to the Key Vault key's `encrypt`/`decrypt`/`wrapKey`/`unwrapKey`
   permissions (granted via that vault's access policy in `keyvault.ts` - see the
   `ciServicePrincipalObjectId` config value for granting a CI identity access) to
   decrypt secrets.
3. Normal Azure RBAC to actually create/read the deployed resources.

## Deploy

Every `pulumi` command below needs `AZURE_STORAGE_ACCOUNT`/`AZURE_STORAGE_KEY` set
in that shell (fetch the key once per session with `az storage account keys list`
and export both - Pulumi doesn't persist them for you):

```bash
export AZURE_STORAGE_ACCOUNT=<your storage account name>
export AZURE_STORAGE_KEY=$(az storage account keys list --account-name "$AZURE_STORAGE_ACCOUNT" \
  --resource-group guestbook-cicd-rg --query "[0].value" -o tsv)

npm install
pulumi login "azblob://pulumi-state"
pulumi stack select dev                # or: pulumi stack init dev, for a brand-new stack
pulumi config set azure-native:location eastus   # or your preferred region
pulumi up
```

This single command:

1. Creates a resource group and an AKS cluster via `azure-native`.
2. Pulls an admin kubeconfig from the newly created cluster and uses it to
   configure the Pulumi Kubernetes provider, in the same program (no manual
   `az aks get-credentials` step required for the deploy itself).
3. Deploys the Guestbook app into the `guestbook` namespace.
4. Installs kube-prometheus-stack (Prometheus + Grafana) into the `monitoring`
   namespace via Helm, configured to discover `ServiceMonitor`s across all
   namespaces.
5. Creates `ServiceMonitor`s for the Redis leader/replica metrics endpoints.
6. Loads a pre-built "Guestbook Overview" Grafana dashboard automatically.
7. Outputs the Guestbook URL, Grafana URL, and Grafana admin credentials.

A full deploy from scratch (new AKS cluster included) takes roughly 10-12 minutes.

## Outputs / access

```bash
pulumi stack output guestbookUrl
pulumi stack output grafanaUrl
pulumi stack output grafanaAdminUser
pulumi stack output keyVaultName
```

The Grafana admin password is **not** printed by `pulumi stack output` in plaintext
and is not in this README or git history. It's generated by `@pulumi/random`,
stored as an encrypted Pulumi secret, and also written to an Azure Key Vault
(`keyVaultName` above) as the secret `grafana-admin-password`. Retrieve it with
either:

```bash
# From Key Vault (requires access to the subscription this was deployed into)
az keyvault secret show --vault-name $(pulumi stack output keyVaultName) \
  --name grafana-admin-password --query value -o tsv

# Or directly from Pulumi state
pulumi stack output grafanaAdminPassword --show-secrets
```

### This deployment's live values (as of 2026-10-22)

| | |
|---|---|
| Guestbook URL | http://74.151.141.67 |
| Grafana URL | http://20.72.180.150 |
| Grafana admin user | `admin` |
| Grafana admin password | stored in Key Vault `guestbook-kv3f27af8e`, secret `grafana-admin-password` |
| Resource group | `guestbook-rgf48916b4` |
| AKS cluster | `guestbook-aksbcbd201e` (region: `eastus`) |

Both LoadBalancers are public with no IP allowlist, since this is a throwaway
demo cluster; don't reuse this cluster for anything beyond this exercise.
**This cluster is left running for review** - when you're done, destroy it to
stop Azure billing (see below).

To pull a local kubeconfig for `kubectl`/`helm` troubleshooting:

```bash
az aks get-credentials --resource-group $(pulumi stack output resourceGroupName) \
  --name $(pulumi stack output clusterName)
```

## Verifying Guestbook metrics are being scraped

1. **Check Prometheus has discovered the Redis targets:**

   ```bash
   kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
   ```

   Open http://localhost:9090/targets - you should see 3 `UP` targets under the
   `serviceMonitor/guestbook/redis-leader-servicemonitor-*` and
   `.../redis-replica-servicemonitor-*` jobs (one leader pod + two replica pods).

2. **Query real metric data:**

   At http://localhost:9090/graph, run:
   - `redis_connected_clients{namespace="guestbook"}` - Redis-reported client counts
   - `rate(redis_commands_processed_total{namespace="guestbook"}[5m])` - command throughput
   - `sum(container_cpu_usage_seconds_total{namespace="guestbook"}) by (pod)` - per-pod
     CPU usage for every Guestbook pod, frontend included, via the built-in
     kubelet/cAdvisor scrape targets (no extra config - confirms "resource usage"
     metrics for the frontend)

3. **View it in Grafana:**

   ```bash
   kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
   ```

   Log into http://localhost:3000 with the admin credentials above, open
   **Dashboards → Guestbook Overview**. It should show live panels for Redis
   command rate, connected clients, and per-pod CPU/memory for both the frontend
   and Redis tiers.

   (Both Grafana and Prometheus are also reachable directly via their public
   LoadBalancer IPs above, without port-forwarding.)

## Project layout

```
Pulumi.yaml          # Pulumi project definition
index.ts             # Entry point: wires cluster -> guestbook -> monitoring, exports outputs
cluster.ts           # AKS cluster + resource group (azure-native)
guestbook.ts         # Redis leader/replica + frontend Deployments/Services, with redis_exporter sidecars
monitoring.ts        # kube-prometheus-stack Helm release + ServiceMonitors + dashboard ConfigMap
keyvault.ts           # Azure Key Vault for the Grafana admin password
dashboard.json        # Grafana dashboard definition, auto-imported at deploy time
```

## GitHub branch and pull-request workflow

- `main` - stable, reviewed. Protected: no force-push, no deletion, PRs required
  (via GitHub branch protection).
- `feature/<name>` - new capability branches.
- `fix/<name>` - bug fixes.
- `docs/<name>` - documentation-only changes.
- `ci/<name>` - pipeline/DevSecOps work.

Secret scanning + push protection and Dependabot security updates are enabled on
the repository. Commits are small and scoped to one logical change each; every
commit message states what was verified (commands run, actual results), not just
what was intended.

## Azure DevOps pipeline

Organization: `https://dev.azure.com/ayo2corra`, project `guestbook-monitoring`.
Pipeline definition: [`azure-pipelines.yml`](azure-pipelines.yml).

**Verified live and working** (checked directly against the Azure DevOps API, not
assumed):
- GitHub service connection `guestbook-monitoring-github` (`isReady: true`),
  used for repository checkout.
- Variable group `guestbook-monitoring-state`, holding `AZURE_STORAGE_ACCOUNT`
  and a secret `AZURE_STORAGE_KEY`, authorized for pipeline use.
- Environment `guestbook-dev` with a configured **Approval** check (`type:
  Approval`, `minRequiredApprovers: 1`) - the `Deploy` stage genuinely cannot run
  unapproved; this isn't just a YAML comment saying so.
- The `Validate` (build/lint/format/Helm template) and `DevSecOps`
  (secrets/dependencies/containers/SBOM) stage logic has been run locally with
  the exact same commands the pipeline uses - see "Security findings" below for
  real results.

**Not yet connected** - documented rather than silently skipped:
1. **Azure RM service connection** (`guestbook-monitoring-azurerm`), needed by
   the `PulumiPreview` and `Deploy` jobs to authenticate to Azure. Creating its
   service principal requires an IAM role assignment, which this environment's
   operating rules require a human to perform directly rather than an agent.
   Exact command (scoped to only the two resource groups this project touches,
   not the whole subscription):

   ```bash
   SUB_ID=$(az account show --query id -o tsv)
   az ad sp create-for-rbac --name "guestbook-monitoring-ado" --role Contributor \
     --scopes "/subscriptions/$SUB_ID/resourceGroups/guestbook-rgf48916b4" \
              "/subscriptions/$SUB_ID/resourceGroups/guestbook-cicd-rg"
   ```

   Then create the service connection from the JSON output (`appId`, `password`,
   `tenant`):

   ```bash
   az devops service-endpoint azurerm create --organization https://dev.azure.com/ayo2corra \
     --project guestbook-monitoring --name guestbook-monitoring-azurerm \
     --azure-rm-service-principal-id <appId> --azure-rm-subscription-id <subId> \
     --azure-rm-subscription-name "<subscription name>" --azure-rm-tenant-id <tenant>
   ```

   (Also run `pulumi config set ciServicePrincipalObjectId <sp objectId>` and
   `pulumi up` once, so `keyvault.ts` grants that identity Key Vault access too.)

2. **The Azure Pipeline resource's GitHub trigger/webhook.** `az pipelines create`
   against a PAT-based GitHub service connection fails server-side with *"Could
   not create service hooks subscription. The repository does not reference a
   service connection"* - a known rough edge when the connection wasn't created
   via Azure DevOps's own GitHub OAuth/App consent flow. The fix is the standard,
   one-time, ~30-second manual step Microsoft designs for this exact case:
   **Azure DevOps → Pipelines → New pipeline → GitHub → authorize → select
   `Ayodejiola/guestbook-monitoring` → it auto-detects `azure-pipelines.yml`.**
   This also finishes wiring the GitHub webhook so pushes/PRs trigger runs
   automatically, which a script-created connection cannot reliably do.

Until both of the above are done, the pipeline is **prepared but not yet
executing in Azure DevOps**. Everything it would run has been run and verified
locally (results below), but there is no Azure Pipelines run history to link to
yet.

## Security findings

Real results from running the DevSecOps stage's tools locally (same versions/
commands the pipeline uses):

| Check | Tool | Result |
|---|---|---|
| Secret detection | gitleaks v8.21.2 | **Clean** - 6 commits scanned, 0 leaks (covers the full rewritten git history) |
| Dependency scan | `npm audit --audit-level=high` | **Clean** - 0 vulnerabilities |
| Container scan | Trivy v0.76.1, `redis:7.2-alpine` | **Clean** - 0 vulnerabilities |
| Container scan | Trivy v0.76.1, `oliver006/redis_exporter` | **Fixed** - `v1.62.0-alpine` had 6 HIGH Go-stdlib CVEs (DoS-class, in `net/http`/`crypto/tls`/`net/url`); bumped to `v1.95.0-alpine`, re-scanned clean, deployed and verified running |
| Container scan | Trivy v0.76.1, `gcr.io/google-samples/gb-frontend:v5` | **Accepted exception** - several HIGH CVEs in Debian base packages (`openssl`, `ncurses`); this is an unmaintained Google example image with no newer tag published upstream. Not silently ignored: tracked here as a known, unresolved limitation of using the assignment's specified example image |
| SBOM | `@cyclonedx/cyclonedx-npm` | Generated successfully (not committed - it's a build artifact, regenerate via the pipeline or `npx @cyclonedx/cyclonedx-npm`) |
| IaC static scan (Checkov/tfsec) | - | **Not applicable** - these parse Terraform/ARM/CloudFormation/Helm-values files; this project's infrastructure is a Pulumi TypeScript program. Equivalent coverage: `tsc --noEmit`, ESLint, and `pulumi preview` (all run, all clean) |
| SAST | - | **Not run** - no dedicated SAST tool is wired in yet; the codebase is infrastructure-definition code (no business logic, no user input handling), which somewhat limits SAST's applicability here, but this is recorded as a gap, not a pass |

## Troubleshooting guide / investigated deployment incidents

Three incidents occurred while building this and are documented here with real
root causes and verification, not reconstructed after the fact.

### 1. Helm release naming collision → node-exporter port conflict

- **Symptoms/impact:** `pulumi up` timed out installing `kube-prometheus-stack`
  after renaming the Helm release (adding an explicit `name:`), with Helm
  reporting `context deadline exceeded`.
- **Evidence/root cause:** `kubectl get pods -n monitoring` showed **two** full
  kube-prometheus-stack installs running simultaneously - the old auto-named
  release (`kube-prometheus-stack-7e067ea6`, still `deployed`) and the new one
  (`kube-prometheus-stack`, `failed`). Both ship a `prometheus-node-exporter`
  `DaemonSet` that binds `hostPort: 9100` on every node; with two releases
  present, the second release's node-exporter pods stayed `Pending` (port
  already bound by the first release's pods on the same 2-node pool), so Helm's
  "wait for pods ready" check never succeeded within the timeout.
- **Root cause category:** resource ownership / naming - changing a Pulumi
  `Release`'s `name` triggers a create-before-delete replace, and the "before"
  half of that briefly left two Helm releases claiming the same host ports.
- **Corrective change:** `helm uninstall` both the failed and the stale old
  release to clear the port conflict, then `pulumi refresh` (see incident 2) and
  a clean `pulumi up`.
- **Validation:** `helm list -n monitoring` showed one release in `deployed`
  state; `kubectl get pods -n monitoring` showed exactly one
  `prometheus-node-exporter` pod per node, both `Running`.
- **Remaining limitation:** Pulumi's Helm `Release` resource doesn't itself
  guard against this class of collision; it's a property of the chart
  (hostPort-binding DaemonSets) combined with a rename-triggered replace. No
  code change was made to prevent a recurrence beyond always giving the release
  an explicit `name` up front (now the case in `monitoring.ts`).

### 2. Pulumi state desynchronization after a manual `helm uninstall`

- **Symptoms/impact:** the next `pulumi up` after incident 1's manual
  `helm uninstall` failed immediately with `"kube-prometheus-stack" has no
  deployed releases`.
- **Evidence/root cause:** Pulumi's state still recorded the `Release` resource
  as existing (from the prior failed-but-partially-applied update) and
  attempted a Helm *upgrade* against it; since the release had just been deleted
  out-of-band via `helm uninstall`, Helm had nothing to upgrade.
- **Corrective change:** `pulumi stack export` (full state backup, saved outside
  the repo directory before touching anything) → `pulumi refresh --yes` to
  reconcile Pulumi's state with the cluster's actual reality (this removed the 2
  stale/conflicting resource entries Pulumi could no longer find) → `pulumi
  preview` to confirm the resulting plan was exactly "create 1 Helm release,
  nothing else" before applying.
- **Validation:** `pulumi up` then completed cleanly (`1 created`, 19
  unchanged); live cluster state matched Pulumi's state afterward (`pulumi
  preview` → `22 unchanged`).
- **Rollback/recovery procedure used:** the state backup taken before `refresh`
  was never needed (refresh succeeded cleanly), but was retained until the
  cluster was independently verified healthy.
- **Preventive control:** none added beyond documenting the correct recovery
  sequence here; the underlying lesson is "don't `helm uninstall` a
  Pulumi-managed release out of band without immediately following with
  `pulumi refresh` before the next `pulumi up`."

### 3. Guestbook Submit button did nothing (Redis Service DNS-name mismatch)

- **Symptoms/impact:** the deployed guestbook's Submit button produced no
  visible error and silently failed to save entries.
- **Evidence/root cause:** `curl`-ing the frontend's `guestbook.php?cmd=set`
  endpoint directly returned a PHP fatal error:
  `getaddrinfo failed: Name or service not known [tcp://redis-leader:6379]`
  (write path) and `[tcp://redis-follower:6379]` (read path). The `gb-frontend:v5`
  image has these two Redis hostnames hardcoded via DNS lookup. Without an
  explicit `metadata.name`, Pulumi had autonamed the actual Services
  `redis-leader-849ccbfc` and `redis-replica-de4806ae` - neither matched what
  the app was looking up.
- **Root cause category:** naming (Kubernetes Service DNS name mismatch, not a
  namespace/port/ingress issue).
- **Corrective change:** pinned `metadata.name: "redis-leader"` and
  `metadata.name: "redis-follower"` explicitly on the two app-facing Services in
  `guestbook.ts` (the `-metrics` Services used by Prometheus were unaffected and
  left autonamed).
- **Validation:** `pulumi preview` showed exactly a 2-resource replace (just
  those Services); after `pulumi up`, direct `curl` calls to
  `cmd=set&key=messages&value=...` followed by `cmd=get` round-tripped the
  value correctly, confirmed via `kubectl get endpoints -n guestbook
  redis-leader redis-follower` showing populated endpoints.
- **Preventive control:** none beyond the fix itself; this class of issue (an
  external image's hardcoded hostname expectations) can't be caught by `pulumi
  preview` or type-checking - it would need a post-deploy smoke test (e.g. an
  automated `cmd=set`/`cmd=get` round-trip) to catch automatically. Not
  currently in the pipeline; listed under "Known limitations" below.

## Rollback and recovery

- **Application/infra rollback:** `git revert` the offending commit on `main`,
  then either wait for an approved `Deploy` run or run `pulumi up` manually
  against the resulting (reverted) program. Pulumi's plan-then-apply model means
  `pulumi preview` always shows exactly what a rollback would change before it
  happens.
- **Pulumi state recovery:** keep a `pulumi stack export` backup before any
  manual (non-Pulumi) change to a Pulumi-managed resource; if state and reality
  diverge, use `pulumi refresh` to reconcile (never `pulumi state delete`/`pulumi
  import` as a first resort - see incident 2).
- **Stuck/failed Helm release:** `helm list -n <namespace>` to find its real
  status; if `failed` and blocking a Pulumi `Release` resource, `helm uninstall`
  it, then `pulumi refresh` before the next `pulumi up` (see incident 2).
- **Full environment teardown:** `pulumi destroy` (see below) - removes the AKS
  cluster and its resource group entirely. The `guestbook-cicd-rg` resource
  group (Pulumi state storage + nothing else) is intentionally separate and
  outside the Pulumi program itself, so a `pulumi destroy` cannot accidentally
  delete the state backend it needs to run.

## Known limitations, required permissions, and outstanding issues

- Azure RM service connection and the Azure Pipeline's GitHub trigger are not
  yet connected (see "Azure DevOps pipeline" above) - both require one manual,
  human action each (an IAM role assignment, and a one-time OAuth consent
  click), documented with exact steps.
- No automated post-deploy smoke test exists yet (e.g., an automated
  `cmd=set`/`cmd=get` round-trip against the live guestbook). Incident 3 was
  only caught by manual testing. Recommended next step: add one as a
  `DevSecOps`- or `Deploy`-stage step.
- No SAST tool is wired in; noted as a gap, not silently passed.
- `gcr.io/google-samples/gb-frontend:v5` carries known HIGH-severity CVEs in its
  Debian base image with no newer upstream tag available - accepted exception,
  not a false "clean" result (see "Security findings").
- The `az ad sp create-for-rbac`/RBAC role-assignment commands in this README
  require Owner/User Access Administrator-equivalent rights on the subscription
  to run - whoever executes them needs that, separate from the rights needed to
  run `pulumi up` itself (Contributor on the two resource groups is sufficient
  for the latter).
- Both the Guestbook and Grafana LoadBalancers are public with no IP allowlist -
  acceptable for this review/demo context, not a production-appropriate
  configuration.

## Tear down

```bash
pulumi destroy
```

This removes the AKS cluster and resource group along with everything deployed
onto it, stopping Azure billing.

## Stretch goal status

Done: a custom Grafana dashboard ("Guestbook Overview") is created and
auto-provisioned by Pulumi (no manual Grafana click-ops), with panels for Redis
request rate, connected clients, and per-pod resource usage across the Guestbook
app.
