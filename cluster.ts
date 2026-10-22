import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerservice from "@pulumi/azure-native/containerservice";
import * as tls from "@pulumi/tls";

const config = new pulumi.Config();
const location = config.get("location") || "eastus";
const nodeCount = config.getNumber("nodeCount") || 2;
const nodeVmSize = config.get("nodeVmSize") || "Standard_B2s";
const kubernetesVersion = config.get("kubernetesVersion"); // leave undefined to use AKS default

export const resourceGroup = new resources.ResourceGroup("guestbook-rg", {
    location,
});

// SSH key for the Linux node pool (AKS requires one even though we manage
// nodes via the Azure control plane, not direct SSH).
const sshKey = new tls.PrivateKey("guestbook-aks-ssh", {
    algorithm: "RSA",
    rsaBits: 4096,
});

export const cluster = new containerservice.ManagedCluster("guestbook-aks", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    dnsPrefix: "guestbook",
    kubernetesVersion,
    identity: {
        type: containerservice.ResourceIdentityType.SystemAssigned,
    },
    agentPoolProfiles: [
        {
            name: "agentpool",
            mode: "System",
            count: nodeCount,
            vmSize: nodeVmSize,
            osType: "Linux",
            osDiskSizeGB: 30,
            type: "VirtualMachineScaleSets",
            maxPods: 110,
        },
    ],
    linuxProfile: {
        adminUsername: "azureuser",
        ssh: {
            publicKeys: [{ keyData: sshKey.publicKeyOpenssh }],
        },
    },
    networkProfile: {
        networkPlugin: "kubenet",
        loadBalancerSku: "standard",
    },
});

// Pull an admin kubeconfig for the cluster so the Pulumi Kubernetes provider
// can deploy workloads onto it in the same program.
const credentials = containerservice.listManagedClusterUserCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    resourceName: cluster.name,
});

export const kubeconfig = credentials.kubeconfigs.apply((kubeconfigs) =>
    Buffer.from(kubeconfigs[0].value, "base64").toString("utf8"),
);
