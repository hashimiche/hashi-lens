import { ProductDescriptor } from './types.js'

export const obsProduct: ProductDescriptor = {
    id: 'obs',
    displayName: 'Observability',
    halName: 'obs',
    halStatusName: 'Observability',
    aliases: ['observability', 'obs', 'grafana', 'prometheus', 'loki'],
    smokeTestLabel: 'dashboards, metrics ingestion, and logs',
    runningSteps: [
        'Open Grafana and verify dashboards load correctly.',
        'Confirm Prometheus targets are healthy and scraping data.',
        'Check Loki ingestion by querying for a recent log stream in Grafana.',
    ],
    scenarioPlaybook: [
        'Deploy/status: call `get_hal_status` (product=`obs`) before troubleshooting dashboard gaps.',
        'Validation: verify all three layers (Grafana UI, Prometheus scrape targets, Loki log ingestion).',
        'Troubleshooting: separate data-source connectivity problems from dashboard/query issues.',
    ],
    docs: [],
}