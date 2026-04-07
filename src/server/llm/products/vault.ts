import { ProductDescriptor } from './types.js'

export const vaultProduct: ProductDescriptor = {
    id: 'vault',
    displayName: 'Vault',
    halName: 'vault',
    halStatusName: 'Vault',
    aliases: ['vault'],
    smokeTestLabel: 'mounts, auth methods, and health endpoints',
    runningSteps: [
        'Confirm the UI or API endpoint is reachable.',
        'Check auth methods, mounts, or health depending on what you want to validate.',
        'Run one small write/read workflow to prove the stack is usable.',
    ],
    scenarioPlaybook: [
        'Runtime/health: start with `get_hal_status` (product=`vault`), then use Vault MCP internals only after runtime confirmation.',
        'Auth troubleshooting: use `list_auth_methods`, `read_auth_method`, `list_auth_roles`, and `read_auth_role` before proposing changes.',
        'Access analysis: prefer `introspect_self` + `analyze_secret_access` when user asks who can access a path.',
        'Ops diagnostics: use `read_cluster_health`, `read_replication_status`, `read_metrics`, and `list_leases` for HA/performance/lease questions.',
    ],
    docs: [
        {
            title: 'Vault CLI Quick Start',
            url: 'https://developer.hashicorp.com/vault/docs/commands',
            description: 'Core Vault CLI commands, flags, and usage patterns.',
        },
    ],
}