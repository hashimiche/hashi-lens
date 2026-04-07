export type NonVaultFeatureScenarioKey =
    | 'boundary-ssh'
    | 'terraform-workspace'
    | 'terraform-token'
    | 'nomad-job'
    | 'consul-service'
    | 'obs-stack'

export type ObservabilityIncidentScenarioKey =
    | 'obs-datasource-down'
    | 'obs-dashboard-empty'

export type VaultFeatureScenarioKey =
    | 'jwt'
    | 'oidc'
    | 'ldap'
    | 'k8s'

interface ScenarioDefinition {
    productHalName: string
    title: string
    description: string
    helpTopic: string
    triggerPatterns: RegExp[]
    validationChecklist: string[]
    troubleshootingChecklist: string[]
}

interface IncidentDefinition {
    title: string
    description: string
    triggerPatterns: RegExp[]
    isolationChecklist: string[]
    recoveryChecklist: string[]
}

interface VaultFeatureDefinition {
    title: string
    description: string
    helpTopic: string
    featureToken: string
    authMount: string
    roleHint: string
    triggerPatterns: RegExp[]
}

export const NON_VAULT_FEATURE_SCENARIOS: Record<NonVaultFeatureScenarioKey, ScenarioDefinition> = {
    'boundary-ssh': {
        productHalName: 'boundary',
        title: 'Boundary SSH Session Flow',
        description: 'Configure and validate brokered SSH sessions with target reachability checks.',
        helpTopic: 'boundary ssh',
        triggerPatterns: [/\bssh\b|\bsession\b|\btarget\b|broker/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook/i],
        validationChecklist: [
            'Confirm target registration in the Boundary UI/API.',
            'Start one brokered session and verify successful connect/disconnect lifecycle.',
        ],
        troubleshootingChecklist: [
            'Separate auth failures from target reachability failures.',
            'Separate worker/controller path issues from user credential issues.',
        ],
    },
    'terraform-workspace': {
        productHalName: 'terraform',
        title: 'TFE Workspace Bootstrap',
        description: 'Set up workspace automation flow and validate plan/apply visibility.',
        helpTopic: 'terraform workspace',
        triggerPatterns: [/\bworkspace\b|\borganization\b|\bproject\b|\brun\b|\bbootstrap\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook/i],
        validationChecklist: [
            'Validate org/project/workspace creation path and one successful run.',
            'Confirm plan/apply logs and state history are visible in the UI.',
        ],
        troubleshootingChecklist: [
            'Isolate platform runtime issues from workspace/run pipeline issues.',
        ],
    },
    'terraform-token': {
        productHalName: 'terraform',
        title: 'TFE Token Flow',
        description: 'Configure token lifecycle and validate authenticated platform/API usage.',
        helpTopic: 'terraform token',
        triggerPatterns: [/\btoken\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook/i],
        validationChecklist: [
            'Validate token generation scope and one authenticated API/UI workflow.',
        ],
        troubleshootingChecklist: [
            'Separate token-scope issues from platform runtime issues.',
        ],
    },
    'nomad-job': {
        productHalName: 'nomad',
        title: 'Nomad Job Flow',
        description: 'Run and validate a full job/allocation lifecycle.',
        helpTopic: 'nomad',
        triggerPatterns: [/\bjob\b|\ballocation\b|\balloc\b|\bscheduler\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook/i],
        validationChecklist: [
            'Submit a small sample job and confirm allocation placement.',
            'Inspect allocation logs to verify full job lifecycle.',
        ],
        troubleshootingChecklist: [
            'Isolate scheduler placement failures from job spec and log issues.',
        ],
    },
    'consul-service': {
        productHalName: 'consul',
        title: 'Consul Service Catalog Flow',
        description: 'Register service(s), verify catalog visibility, and check discovery health.',
        helpTopic: 'consul',
        triggerPatterns: [/\bservice\b|\bcatalog\b|\bhealth check\b|\bdiscovery\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook/i],
        validationChecklist: [
            'Register at least one service and confirm catalog visibility.',
            'Verify health checks and discovery updates end-to-end.',
        ],
        troubleshootingChecklist: [
            'Isolate server reachability issues from catalog and health-check failures.',
        ],
    },
    'obs-stack': {
        productHalName: 'obs',
        title: 'Observability Stack Setup',
        description: 'Validate Grafana UI, Prometheus scrape health, and Loki ingestion.',
        helpTopic: 'obs',
        triggerPatterns: [/\bgrafana\b|\bprometheus\b|\bloki\b|\bdashboard\b|\bmetrics\b|\blogs\b|\bingestion\b|\bobservability\b|\bobs\b|\bstack\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook/i],
        validationChecklist: [
            'Confirm Grafana is reachable and at least one HAL dashboard loads.',
            'Verify Prometheus target health and that new samples are arriving.',
            'Verify Loki ingestion by running a recent log query in Grafana Explore.',
            'Validate one end-to-end path: product deploy event appears in logs and metrics.',
        ],
        troubleshootingChecklist: [
            'Layer 1 UI: Grafana reachable but empty/error panels.',
            'Layer 2 Metrics: Prometheus targets down or stale data.',
            'Layer 3 Logs: Loki datasource healthy but no streams, or query-range mismatch.',
        ],
    },
}

export const OBS_INCIDENT_SCENARIOS: Record<ObservabilityIncidentScenarioKey, IncidentDefinition> = {
    'obs-datasource-down': {
        title: 'Observability Datasource Down',
        description: 'Grafana datasource connectivity checks and layered recovery sequence.',
        triggerPatterns: [
            /datasource|data source|prometheus|loki|grafana/i,
            /down|unreachable|refused|timeout|cannot connect|can't connect|connection|healthy false|not healthy/i,
        ],
        isolationChecklist: [
            'Verify Grafana service is reachable first.',
            'Verify Prometheus datasource connectivity and target freshness.',
            'Verify Loki datasource connectivity and query execution.',
        ],
        recoveryChecklist: [
            'If obs runtime is unhealthy, recover lifecycle baseline with HAL deploy/status.',
        ],
    },
    'obs-dashboard-empty': {
        title: 'Observability Dashboard Empty',
        description: 'Panel/query validation and data freshness verification path.',
        triggerPatterns: [
            /dashboard|panel|grafana|metrics|logs|explore/i,
            /empty|no data|blank|missing|not showing|zero results|no streams/i,
        ],
        isolationChecklist: [
            'Validate dashboard datasource mapping in Grafana.',
            'Check query time range and query selector correctness.',
            'Confirm Prometheus has fresh samples and Loki has recent streams.',
        ],
        recoveryChecklist: [
            'Validate one end-to-end signal: recent deploy event appears in both logs and metrics.',
        ],
    },
}

export const VAULT_FEATURE_SCENARIOS: Record<VaultFeatureScenarioKey, VaultFeatureDefinition> = {
    jwt: {
        title: 'Vault JWT Scenario',
        description: 'Capabilities, setup, and verification for Vault JWT auth flow.',
        helpTopic: 'vault jwt',
        featureToken: 'jwt',
        authMount: 'jwt',
        roleHint: 'cicd-role',
        triggerPatterns: [/\bjwt\b/i],
    },
    oidc: {
        title: 'Vault OIDC Scenario',
        description: 'Capabilities, setup, and verification for Vault OIDC auth flow.',
        helpTopic: 'vault oidc',
        featureToken: 'oidc',
        authMount: 'oidc',
        roleHint: 'oidc-role',
        triggerPatterns: [/\boidc\b/i],
    },
    ldap: {
        title: 'Vault LDAP Scenario',
        description: 'Capabilities, setup, and verification for Vault LDAP auth flow.',
        helpTopic: 'vault ldap',
        featureToken: 'ldap',
        authMount: 'ldap',
        roleHint: 'ldap-role',
        triggerPatterns: [/\bldap\b/i],
    },
    k8s: {
        title: 'Vault Kubernetes Scenario',
        description: 'Capabilities, setup, and verification for Vault Kubernetes auth flow.',
        helpTopic: 'vault k8s',
        featureToken: 'k8s',
        authMount: 'kubernetes',
        roleHint: 'k8s-role',
        triggerPatterns: [/\bk8s\b|\bkubernetes\b/i],
    },
}

export function detectNonVaultFeatureScenarioIntent(
    query: string,
    productHalName: string
): NonVaultFeatureScenarioKey | null {
    const candidates = Object.entries(NON_VAULT_FEATURE_SCENARIOS) as Array<[NonVaultFeatureScenarioKey, ScenarioDefinition]>
    for (const [key, scenario] of candidates) {
        if (scenario.productHalName !== productHalName) continue
        const matched = scenario.triggerPatterns.every((pattern) => pattern.test(query.toLowerCase()))
        if (matched) return key
    }
    return null
}

export function detectObservabilityIncidentScenarioIntent(
    query: string
): ObservabilityIncidentScenarioKey | null {
    const candidates = Object.entries(OBS_INCIDENT_SCENARIOS) as Array<[ObservabilityIncidentScenarioKey, IncidentDefinition]>
    for (const [key, scenario] of candidates) {
        const matched = scenario.triggerPatterns.every((pattern) => pattern.test(query.toLowerCase()))
        if (matched) return key
    }
    return null
}

export function detectVaultFeatureScenarioIntent(query: string): VaultFeatureScenarioKey | null {
    const lower = query.toLowerCase()
    const asksConfigFlow = /configure|configuration|enable|setup|set up|deploy|how do i|how to|capabilities|outputs/.test(lower)
    if (!asksConfigFlow && !/hal\s+vault/.test(lower)) {
        return null
    }

    const candidates = Object.entries(VAULT_FEATURE_SCENARIOS) as Array<[VaultFeatureScenarioKey, VaultFeatureDefinition]>
    for (const [key, scenario] of candidates) {
        const matched = scenario.triggerPatterns.every((pattern) => pattern.test(lower))
        if (matched) {
            return key
        }
    }

    return null
}