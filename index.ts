import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { cluster, resourceGroup, kubeconfig } from "./cluster";
import { createGuestbook } from "./guestbook";
import { createMonitoring } from "./monitoring";
import { createSecretsVault, storeSecret } from "./keyvault";

const k8sProvider = new k8s.Provider("aks-k8s", {
    kubeconfig,
});

const guestbookNamespace = new k8s.core.v1.Namespace("guestbook", {
    metadata: { name: "guestbook" },
}, { provider: k8sProvider });

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
}, { provider: k8sProvider });

const guestbook = createGuestbook({
    provider: k8sProvider,
    namespace: guestbookNamespace,
});

const monitoring = createMonitoring({
    provider: k8sProvider,
    monitoringNamespace,
    guestbookNamespace,
    guestbook,
});

const secretsVault = createSecretsVault({ resourceGroup });
const grafanaPasswordSecret = storeSecret(
    "grafana-admin-password",
    secretsVault.vault,
    resourceGroup,
    monitoring.grafanaAdminPassword,
);

function loadBalancerAddress(svc: k8s.core.v1.Service): pulumi.Output<string> {
    return svc.status.apply(status => {
        const ingress = status?.loadBalancer?.ingress?.[0];
        return ingress?.ip ?? ingress?.hostname ?? "pending";
    });
}

export const resourceGroupName = resourceGroup.name;
export const clusterName = cluster.name;
export const kubeConfig = pulumi.secret(kubeconfig);

export const guestbookUrl = pulumi.interpolate`http://${loadBalancerAddress(guestbook.frontendService)}`;

export const grafanaUrl = pulumi.interpolate`http://${loadBalancerAddress(monitoring.grafanaService)}`;
export const grafanaAdminUser = "admin";
// The password itself is never printed to a README or committed anywhere -
// retrieve it from Key Vault (or, for local debugging, `pulumi stack output
// grafanaAdminPassword --show-secrets`).
export const grafanaAdminPassword = pulumi.secret(monitoring.grafanaAdminPassword);
export const keyVaultName = secretsVault.vault.name;
export const grafanaPasswordSecretName = grafanaPasswordSecret.name;
