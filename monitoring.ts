import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { GuestbookResult } from "./guestbook";

export interface MonitoringArgs {
    provider: k8s.Provider;
    monitoringNamespace: k8s.core.v1.Namespace;
    guestbookNamespace: k8s.core.v1.Namespace;
    guestbook: GuestbookResult;
}

export interface MonitoringResult {
    grafanaService: k8s.core.v1.Service;
    grafanaAdminPassword: pulumi.Output<string>;
}

export function createMonitoring(args: MonitoringArgs): MonitoringResult {
    const { provider, monitoringNamespace, guestbookNamespace, guestbook } = args;
    const monitoringNs = monitoringNamespace.metadata.name;
    const guestbookNs = guestbookNamespace.metadata.name;

    const grafanaAdminPassword = new random.RandomPassword("grafana-admin-password", {
        length: 20,
        special: false,
    });

    const dashboardJson = fs.readFileSync(path.join(__dirname, "dashboard.json"), "utf8");

    // Pre-load the custom guestbook dashboard as a ConfigMap. Grafana's
    // sidecar (enabled below) watches for ConfigMaps labeled
    // `grafana_dashboard: "1"` across all namespaces and imports them
    // automatically - no manual click-ops required after `pulumi up`.
    const dashboardConfigMap = new k8s.core.v1.ConfigMap(
        "guestbook-dashboard",
        {
            metadata: {
                namespace: monitoringNs,
                labels: { grafana_dashboard: "1" },
            },
            data: {
                "guestbook-overview.json": dashboardJson,
            },
        },
        { provider },
    );

    const kubePrometheusStack = new k8s.helm.v3.Release(
        "kube-prometheus-stack",
        {
            name: "kube-prometheus-stack",
            chart: "kube-prometheus-stack",
            repositoryOpts: {
                repo: "https://prometheus-community.github.io/helm-charts",
            },
            namespace: monitoringNs,
            // Keep the install lean: this exercise only needs Prometheus +
            // Grafana wired to the Guestbook app, not long-term alerting infra.
            values: {
                grafana: {
                    adminPassword: grafanaAdminPassword.result,
                    service: {
                        type: "LoadBalancer",
                    },
                    sidecar: {
                        dashboards: {
                            enabled: true,
                            searchNamespace: "ALL",
                            label: "grafana_dashboard",
                        },
                    },
                },
                prometheus: {
                    prometheusSpec: {
                        // Default kube-prometheus-stack only picks up
                        // ServiceMonitors carrying its own release labels and
                        // only in its own namespace. Our Guestbook
                        // ServiceMonitors live in the "guestbook" namespace, so
                        // widen both selectors to discover them.
                        serviceMonitorSelectorNilUsesHelmValues: false,
                        serviceMonitorNamespaceSelector: {},
                        podMonitorSelectorNilUsesHelmValues: false,
                        podMonitorNamespaceSelector: {},
                        retention: "6h",
                    },
                },
                alertmanager: {
                    enabled: false,
                },
            },
        },
        { provider, dependsOn: [dashboardConfigMap] },
    );

    // ---- ServiceMonitors for the Guestbook backend (Redis) --------------
    // Prometheus Operator CRDs ship with the Helm chart above, so these
    // must come after the release installs.
    const monitorOpts = { provider, dependsOn: [kubePrometheusStack] };

    new k8s.apiextensions.CustomResource(
        "redis-leader-servicemonitor",
        {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { namespace: guestbookNs, labels: { release: "kube-prometheus-stack" } },
            spec: {
                selector: { matchLabels: guestbook.labels.redisLeader },
                namespaceSelector: { matchNames: [guestbookNs] },
                endpoints: [{ port: "metrics", interval: "15s" }],
            },
        },
        monitorOpts,
    );

    new k8s.apiextensions.CustomResource(
        "redis-replica-servicemonitor",
        {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { namespace: guestbookNs, labels: { release: "kube-prometheus-stack" } },
            spec: {
                selector: { matchLabels: guestbook.labels.redisReplica },
                namespaceSelector: { matchNames: [guestbookNs] },
                endpoints: [{ port: "metrics", interval: "15s" }],
            },
        },
        monitorOpts,
    );

    // The frontend has no application metrics endpoint of its own (the
    // upstream gb-frontend image doesn't expose one), so its "resource
    // usage" is observed via the kube-prometheus-stack's built-in
    // kubelet/cAdvisor scrape targets, which cover every pod in the
    // cluster out of the box - see the "Guestbook frontend" panels in the
    // provisioned dashboard and the README verification steps.

    // Read back the Service the Helm release created (rather than declaring
    // a new one) so we can output its LoadBalancer address.
    const grafanaService = k8s.core.v1.Service.get(
        "kube-prometheus-stack-grafana",
        pulumi.interpolate`${monitoringNs}/kube-prometheus-stack-grafana`,
        { provider, dependsOn: [kubePrometheusStack] },
    );

    return { grafanaService, grafanaAdminPassword: grafanaAdminPassword.result };
}
