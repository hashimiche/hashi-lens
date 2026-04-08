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
    supportChecks?: Array<{
        label: string
        pattern: RegExp
        positiveMessage: string
        negativeMessage: string
        queryPattern?: RegExp
    }>
    validationChecklist: string[]
    troubleshootingChecklist: string[]
}

interface IncidentDefinition {
    title: string
    description: string
    triggerPatterns: RegExp[]
    supportChecks?: Array<{
        label: string
        pattern: RegExp
        positiveMessage: string
        negativeMessage: string
        queryPattern?: RegExp
    }>
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
    postEnableOutcomes?: string[]
    supportChecks?: Array<{
        label: string
        pattern: RegExp
        positiveMessage: string
        negativeMessage: string
        queryPattern?: RegExp
    }>
}

export const NON_VAULT_FEATURE_SCENARIOS: Record<NonVaultFeatureScenarioKey, ScenarioDefinition> = {
    'boundary-ssh': {
        productHalName: 'boundary',
        title: 'Boundary SSH Session Flow',
        description: 'Configure and validate brokered SSH sessions with target reachability checks.',
        helpTopic: 'boundary ssh',
        triggerPatterns: [/\bssh\b|\bsession\b|\btarget\b|broker/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook|possible|can i|support|supported|available|test/i],
        supportChecks: [
            {
                label: 'Boundary SSH workflow',
                pattern: /\bssh\b|\bsession\b|\btarget\b|broker/i,
                positiveMessage: 'Current HAL help output includes SSH/session workflow references for Boundary.',
                negativeMessage: 'SSH/session workflow is not explicit in current HAL help output; verify with `hal boundary ssh --help` for this build.',
                queryPattern: /\bssh\b|\bsession\b|\btarget\b|broker/i,
            },
        ],
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
        triggerPatterns: [/\bworkspace\b|\borganization\b|\bproject\b|\brun\b|\bbootstrap\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook|possible|can i|support|supported|available|test/i],
        supportChecks: [
            {
                label: 'Workspace bootstrap flow',
                pattern: /workspace|project|organization|run/i,
                positiveMessage: 'Current HAL help output includes workspace bootstrap/run workflow references.',
                negativeMessage: 'Workspace bootstrap flow is not explicit in current HAL help output; verify with `hal terraform workspace --help` for this build.',
                queryPattern: /workspace|project|organization|run/i,
            },
        ],
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
        triggerPatterns: [/\btoken\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook|possible|can i|support|supported|available|test/i],
        supportChecks: [
            {
                label: 'Token management flow',
                pattern: /token/i,
                positiveMessage: 'Current HAL help output includes token lifecycle/management references.',
                negativeMessage: 'Token lifecycle controls are not explicit in current HAL help output; verify with `hal terraform token --help` for this build.',
                queryPattern: /token/i,
            },
        ],
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
        triggerPatterns: [/\bjob\b|\ballocation\b|\balloc\b|\bscheduler\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook|possible|can i|support|supported|available|test/i],
        supportChecks: [
            {
                label: 'Nomad job/allocation flow',
                pattern: /job|allocation|alloc|scheduler/i,
                positiveMessage: 'Current HAL help output includes job/allocation workflow references.',
                negativeMessage: 'Job/allocation flow is not explicit in current HAL help output; verify with `hal nomad --help` for this build.',
                queryPattern: /job|allocation|alloc|scheduler/i,
            },
        ],
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
        triggerPatterns: [/\bservice\b|\bcatalog\b|\bhealth check\b|\bdiscovery\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook|possible|can i|support|supported|available|test/i],
        supportChecks: [
            {
                label: 'Service catalog/discovery flow',
                pattern: /service|catalog|health|discovery/i,
                positiveMessage: 'Current HAL help output includes service catalog/discovery references.',
                negativeMessage: 'Service catalog/discovery flow is not explicit in current HAL help output; verify with `hal consul --help` for this build.',
                queryPattern: /service|catalog|health|discovery/i,
            },
        ],
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
        triggerPatterns: [/\bgrafana\b|\bprometheus\b|\bloki\b|\bdashboard\b|\bmetrics\b|\blogs\b|\bingestion\b|\bobservability\b|\bobs\b|\bstack\b/i, /configure|configuration|setup|set up|how do i|how to|capabilities|outputs|workflow|runbook|possible|can i|support|supported|available|test/i],
        supportChecks: [
            {
                label: 'Grafana support',
                pattern: /grafana/i,
                positiveMessage: 'Current HAL help output includes Grafana-related observability references.',
                negativeMessage: 'Grafana-specific observability controls are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /grafana/i,
            },
            {
                label: 'Prometheus support',
                pattern: /prometheus|metrics/i,
                positiveMessage: 'Current HAL help output includes Prometheus/metrics references.',
                negativeMessage: 'Prometheus-specific controls are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /prometheus|metrics/i,
            },
            {
                label: 'Loki support',
                pattern: /loki|logs?/i,
                positiveMessage: 'Current HAL help output includes Loki/log ingestion references.',
                negativeMessage: 'Loki/log controls are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /loki|logs?/i,
            },
        ],
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
            /datasource|data source|prometheus|loki|grafana\s+datasource/i,
            /down|unreachable|refused|timeout|cannot connect|can't connect|connection|healthy false|not healthy|supported|support|possible|can i|available/i,
        ],
        supportChecks: [
            {
                label: 'Grafana datasource diagnostics',
                pattern: /grafana|datasource|data source/i,
                positiveMessage: 'Current HAL help output includes Grafana/datasource observability references used for datasource-down diagnostics.',
                negativeMessage: 'Grafana datasource diagnostics are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /grafana|datasource|data source/i,
            },
            {
                label: 'Prometheus datasource diagnostics',
                pattern: /prometheus|metrics/i,
                positiveMessage: 'Current HAL help output includes Prometheus/metrics references used for datasource connectivity checks.',
                negativeMessage: 'Prometheus datasource diagnostics are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /prometheus|metrics/i,
            },
            {
                label: 'Loki datasource diagnostics',
                pattern: /loki|logs?/i,
                positiveMessage: 'Current HAL help output includes Loki/log references used for datasource connectivity checks.',
                negativeMessage: 'Loki datasource diagnostics are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /loki|logs?/i,
            },
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
            /empty|no data|blank|missing|not showing|zero results|no streams|supported|support|possible|can i|available/i,
        ],
        supportChecks: [
            {
                label: 'Dashboard/panel diagnostics',
                pattern: /dashboard|panel|grafana|explore/i,
                positiveMessage: 'Current HAL help output includes dashboard/panel observability references for empty-dashboard triage.',
                negativeMessage: 'Dashboard/panel diagnostics are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /dashboard|panel|grafana|explore/i,
            },
            {
                label: 'Metrics data-path diagnostics',
                pattern: /prometheus|metrics/i,
                positiveMessage: 'Current HAL help output includes metrics/Prometheus references for no-data isolation.',
                negativeMessage: 'Metrics diagnostics are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /prometheus|metrics/i,
            },
            {
                label: 'Logs data-path diagnostics',
                pattern: /loki|logs?|streams/i,
                positiveMessage: 'Current HAL help output includes logs/Loki references for empty-log-stream isolation.',
                negativeMessage: 'Logs diagnostics are not explicit in current HAL help output; verify with `hal obs --help` for this build.',
                queryPattern: /loki|logs?|streams/i,
            },
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
        supportChecks: [
            {
                label: 'GitLab flow',
                pattern: /gitlab/i,
                positiveMessage: 'Current HAL help mentions GitLab flow integration for JWT/OIDC enablement.',
                negativeMessage: 'GitLab flow is not explicitly listed in current HAL help output; verify your HAL version/build before relying on it.',
                queryPattern: /gitlab/i,
            },
        ],
        postEnableOutcomes: [
            'Vault JWT auth method is enabled and reachable at auth/jwt/.',
            'HAL local CI setup is ready: GitLab instance is provisioned for JWT/OIDC flows.',
            'A demo GitLab repository/workflow path is available for role/bound-claims testing.',
            'You can immediately validate with role/config reads and a test JWT login flow.',
        ],
    },
    oidc: {
        title: 'Vault OIDC Scenario',
        description: 'Capabilities, setup, and verification for Vault OIDC auth flow.',
        helpTopic: 'vault oidc',
        featureToken: 'oidc',
        authMount: 'oidc',
        roleHint: 'oidc-role',
        triggerPatterns: [/\boidc\b/i],
        supportChecks: [
            {
                label: 'Identity provider integration',
                pattern: /identity provider|idp|issuer|oidc/i,
                positiveMessage: 'Current HAL help lists identity-provider/OIDC integration controls.',
                negativeMessage: 'Identity-provider controls are not explicit in current HAL help output; verify with your HAL build/help output.',
                queryPattern: /identity provider|idp|issuer|oidc/i,
            },
        ],
    },
    ldap: {
        title: 'Vault LDAP Scenario',
        description: 'Capabilities, setup, and verification for Vault LDAP auth flow.',
        helpTopic: 'vault ldap',
        featureToken: 'ldap',
        authMount: 'ldap',
        roleHint: 'ldap-role',
        triggerPatterns: [/\bldap\b/i],
        supportChecks: [
            {
                label: 'LDAP user/group mappings',
                pattern: /group|user|ldap/i,
                positiveMessage: 'Current HAL help lists LDAP user/group mapping controls.',
                negativeMessage: 'LDAP user/group controls are not explicit in current HAL help output; verify with your HAL build/help output.',
                queryPattern: /ldap|group|user/i,
            },
        ],
    },
    k8s: {
        title: 'Vault Kubernetes Scenario',
        description: 'Capabilities, setup, and verification for Vault Kubernetes auth flow.',
        helpTopic: 'vault k8s',
        featureToken: 'k8s',
        authMount: 'kubernetes',
        roleHint: 'k8s-role',
        triggerPatterns: [/\bk8s\b|\bkubernetes\b|\bcsi\b|\bvso\b|vault\s+secret(s)?\s+operator|secret(s)?\s+operator/i],
        supportChecks: [
            {
                label: 'VSO/Secrets Operator support',
                pattern: /\bvso\b|vault\s+secret(s)?\s+operator|secret(s)?\s+operator/i,
                positiveMessage: 'Current HAL help output includes VSO/Secrets Operator references, so this build supports operator-style validation flows.',
                negativeMessage: 'VSO/Secrets Operator is not explicitly listed in current HAL help output; verify your HAL build/version before relying on it.',
                queryPattern: /\bvso\b|secret(s)?\s+operator/i,
            },
            {
                label: 'CSI support',
                pattern: /\bcsi\b/i,
                positiveMessage: 'Current HAL help output includes CSI references, so CSI integration is available in this HAL build.',
                negativeMessage: 'CSI is not explicitly listed in current HAL help output; treat CSI support as unconfirmed until validated with `hal vault k8s --help`.',
                queryPattern: /\bcsi\b/i,
            },
        ],
        postEnableOutcomes: [
            'Vault Kubernetes auth is enabled and reachable at auth/kubernetes/.',
            'HAL local Kubernetes demo environment is prepared for Vault integration testing.',
            'Vault Secrets Operator (VSO) workflow can be exercised in-cluster with demo workload sync behavior.',
            'CSI integration support should be verified with `hal vault k8s --help` and a sample pod mount test.',
        ],
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
    const asksFeatureUnderstandingFlow = /understand|what is|what happens|what will i have|once|after|executed|execute|next steps|possible|can i|support|test/.test(lower)

    if (!asksConfigFlow && !asksFeatureUnderstandingFlow) {
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