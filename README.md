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
