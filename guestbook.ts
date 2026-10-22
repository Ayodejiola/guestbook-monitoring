import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

// Pulumi re-implementation of the upstream kubernetes-ts-guestbook example
// (https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook),
// extended with a redis_exporter sidecar on each Redis pod so Prometheus has
// a real "backend" metrics endpoint to scrape, not just cAdvisor stats.

export interface GuestbookArgs {
    provider: k8s.Provider;
    namespace: k8s.core.v1.Namespace;
}

export interface GuestbookResult {
    frontendService: k8s.core.v1.Service;
    redisLeaderMetricsService: k8s.core.v1.Service;
    redisReplicaMetricsService: k8s.core.v1.Service;
    labels: {
        frontend: Record<string, string>;
        redisLeader: Record<string, string>;
        redisReplica: Record<string, string>;
    };
}

export function createGuestbook(args: GuestbookArgs): GuestbookResult {
    const { provider, namespace } = args;
    const nsName = namespace.metadata.name;
    const resourceOpts = { provider };

    // ---- Redis leader ------------------------------------------------
    const redisLeaderLabels = { app: "redis", role: "leader", tier: "backend" };

    const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
        metadata: { namespace: nsName },
        spec: {
            selector: { matchLabels: redisLeaderLabels },
            replicas: 1,
            template: {
                metadata: { labels: redisLeaderLabels },
                spec: {
                    containers: [
                        {
                            name: "leader",
                            image: "redis:7.2-alpine",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            ports: [{ containerPort: 6379 }],
                        },
                        {
                            name: "metrics",
                            image: "oliver006/redis_exporter:v1.62.0-alpine",
                            resources: { requests: { cpu: "25m", memory: "32Mi" } },
                            ports: [{ name: "metrics", containerPort: 9121 }],
                        },
                    ],
                },
            },
        },
    }, resourceOpts);

    // gb-frontend:v5 has its Redis hostnames hardcoded - it does a DNS
    // lookup for Services literally named "redis-leader" and
    // "redis-follower", so these two app-facing Services need a pinned
    // `metadata.name` rather than Pulumi's default autonamed suffix.
    const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
        metadata: { name: "redis-leader", namespace: nsName, labels: redisLeaderLabels },
        spec: {
            selector: redisLeaderLabels,
            ports: [{ port: 6379, targetPort: 6379 }],
        },
    }, resourceOpts);

    const redisLeaderMetricsService = new k8s.core.v1.Service("redis-leader-metrics", {
        metadata: {
            namespace: nsName,
            labels: { ...redisLeaderLabels, "app.kubernetes.io/component": "metrics" },
        },
        spec: {
            selector: redisLeaderLabels,
            ports: [{ name: "metrics", port: 9121, targetPort: 9121 }],
        },
    }, resourceOpts);

    // ---- Redis replicas -----------------------------------------------
    const redisReplicaLabels = { app: "redis", role: "replica", tier: "backend" };

    const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
        metadata: { namespace: nsName },
        spec: {
            selector: { matchLabels: redisReplicaLabels },
            replicas: 2,
            template: {
                metadata: { labels: redisReplicaLabels },
                spec: {
                    containers: [
                        {
                            name: "replica",
                            image: "redis:7.2-alpine",
                            command: ["redis-server", "--replicaof", "redis-leader", "6379"],
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            ports: [{ containerPort: 6379 }],
                        },
                        {
                            name: "metrics",
                            image: "oliver006/redis_exporter:v1.62.0-alpine",
                            resources: { requests: { cpu: "25m", memory: "32Mi" } },
                            ports: [{ name: "metrics", containerPort: 9121 }],
                        },
                    ],
                },
            },
        },
    }, { ...resourceOpts, dependsOn: [redisLeaderService] });

    const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
        // The app looks this up as "redis-follower" (older terminology than
        // the "leader/replica" naming used elsewhere in this file for the
        // Pulumi resources/labels - the image predates the rename).
        metadata: { name: "redis-follower", namespace: nsName, labels: redisReplicaLabels },
        spec: {
            selector: redisReplicaLabels,
            ports: [{ port: 6379, targetPort: 6379 }],
        },
    }, resourceOpts);

    const redisReplicaMetricsService = new k8s.core.v1.Service("redis-replica-metrics", {
        metadata: {
            namespace: nsName,
            labels: { ...redisReplicaLabels, "app.kubernetes.io/component": "metrics" },
        },
        spec: {
            selector: redisReplicaLabels,
            ports: [{ name: "metrics", port: 9121, targetPort: 9121 }],
        },
    }, resourceOpts);

    // ---- Frontend -------------------------------------------------------
    const frontendLabels = { app: "guestbook", tier: "frontend" };

    const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
        metadata: { namespace: nsName },
        spec: {
            selector: { matchLabels: frontendLabels },
            replicas: 3,
            template: {
                metadata: { labels: frontendLabels },
                spec: {
                    containers: [
                        {
                            name: "php-redis",
                            image: "gcr.io/google-samples/gb-frontend:v5",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ containerPort: 80 }],
                        },
                    ],
                },
            },
        },
    }, { ...resourceOpts, dependsOn: [redisLeaderService, redisReplicaService] });

    const frontendService = new k8s.core.v1.Service("frontend", {
        metadata: { namespace: nsName, labels: frontendLabels },
        spec: {
            type: "LoadBalancer",
            selector: frontendLabels,
            ports: [{ port: 80, targetPort: 80 }],
        },
    }, resourceOpts);

    return {
        frontendService,
        redisLeaderMetricsService,
        redisReplicaMetricsService,
        labels: {
            frontend: frontendLabels,
            redisLeader: redisLeaderLabels,
            redisReplica: redisReplicaLabels,
        },
    };
}
