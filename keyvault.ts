import * as pulumi from "@pulumi/pulumi";
import * as keyvault from "@pulumi/azure-native/keyvault";
import * as authorization from "@pulumi/azure-native/authorization";
import * as resources from "@pulumi/azure-native/resources";

// A small Key Vault for secrets this stack generates (currently: the Grafana
// admin password), so credentials don't have to live in plaintext anywhere -
// not in the README, not in chat, not in a Slack message to the team.

export interface SecretsVaultArgs {
    resourceGroup: resources.ResourceGroup;
    // The Azure DevOps service connection's service principal objectId, once
    // it exists (`pulumi config set ciServicePrincipalObjectId <objectId>`).
    // Granted the same secrets+keys access as the deploying user, scoped to
    // just this vault, so the pipeline can decrypt stack secrets and read
    // the Grafana password without broader subscription access.
    ciServicePrincipalObjectId?: string;
    // The human owner's objectId (`pulumi config set ownerObjectId <objectId>`).
    //
    // Deliberately NOT derived from authorization.getClientConfigOutput()'s
    // current.objectId, which resolves to "whoever is running this Pulumi
    // program right now" - a human locally, or the CI service principal in
    // Azure DevOps. Using that dynamic value here caused a real incident:
    // when the CI service principal ran `pulumi up`, current.objectId
    // resolved to the CI SP's own id (identical to
    // ciServicePrincipalObjectId), so the declared access-policy array
    // collapsed to a single entry and Pulumi correctly removed the human
    // owner's policy as "no longer declared" - locking the owner out of
    // decrypting this very stack's secrets. Pinning both identities as
    // fixed config values makes the vault's access policy stable
    // regardless of who happens to run `pulumi up` last.
    ownerObjectId?: string;
}

export interface SecretsVaultResult {
    vault: keyvault.Vault;
}

export function createSecretsVault(args: SecretsVaultArgs): SecretsVaultResult {
    const { resourceGroup, ciServicePrincipalObjectId, ownerObjectId } = args;
    const current = authorization.getClientConfigOutput({});

    // "keys" permissions back the azurekeyvault:// Pulumi secrets provider
    // (envelope encryption via wrap/unwrap), used instead of a shared
    // PULUMI_CONFIG_PASSPHRASE.
    const permissions = {
        secrets: ["Get", "List", "Set", "Delete"],
        keys: ["Get", "Create", "List", "WrapKey", "UnwrapKey", "Encrypt", "Decrypt"],
    };

    // Fall back to current.objectId only so a brand-new stack's very first
    // `pulumi up` (before ownerObjectId has ever been set) doesn't lock its
    // own creator out. Set ownerObjectId explicitly immediately after that
    // first apply - see README.
    const ownerPolicy = {
        tenantId: current.tenantId,
        objectId: ownerObjectId ?? current.objectId,
        permissions,
    };

    const accessPolicies = [
        ownerPolicy,
        ...(ciServicePrincipalObjectId
            ? [{ tenantId: current.tenantId, objectId: ciServicePrincipalObjectId, permissions }]
            : []),
    ];

    const vault = new keyvault.Vault("guestbook-kv", {
        resourceGroupName: resourceGroup.name,
        location: resourceGroup.location,
        properties: {
            sku: { family: keyvault.SkuFamily.A, name: keyvault.SkuName.Standard },
            tenantId: current.tenantId,
            enableRbacAuthorization: false,
            accessPolicies,
        },
    });

    return { vault };
}

export function storeSecret(
    name: string,
    vault: keyvault.Vault,
    resourceGroup: resources.ResourceGroup,
    value: pulumi.Input<string>,
): keyvault.Secret {
    return new keyvault.Secret(
        name,
        {
            resourceGroupName: resourceGroup.name,
            vaultName: vault.name,
            secretName: name,
            properties: { value },
        },
        { dependsOn: [vault] },
    );
}
