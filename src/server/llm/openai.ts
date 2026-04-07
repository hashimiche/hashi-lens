/**
 * OpenAI LLM Service
 *
 * Uses OpenAI models (GPT-4, etc.) as the LLM backend
 * Implements agentic loop with tool_calls response handling
 */

import OpenAI from 'openai'
import { ExecutionEngine, ToolCall, ToolResult } from '../execution-engine.js'
import { BaseLLMService, QueryResult, ConversationContext, StreamChunk } from './base.js'
import {
    detectPrimaryProduct,
    getProductDocumentationSuggestions,
    getProductScenarioPlaybookPrompt,
    isProductSetupIntent,
    isProductTestingIntent,
} from './products/index.js'
import type { ProductDescriptor } from './products/index.js'
import {
    detectNonVaultFeatureScenarioIntent,
    detectObservabilityIncidentScenarioIntent,
    detectVaultFeatureScenarioIntent,
    NON_VAULT_FEATURE_SCENARIOS,
    OBS_INCIDENT_SCENARIOS,
    VAULT_FEATURE_SCENARIOS,
} from './scenario-registry.js'
import type {
    NonVaultFeatureScenarioKey,
    ObservabilityIncidentScenarioKey,
    VaultFeatureScenarioKey,
} from './scenario-registry.js'

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.2'

export interface OpenAIServiceConfig {
    apiKey?: string
    baseURL?: string
    model?: string
    providerLabel?: string
}

const getSystemPrompt = (): string => {
    const now = new Date().toISOString();
    return `You are HashiLens, an intelligent HashiCorp operations assistant.

Primary goal: help users deploy and operate local HashiCorp stacks with HAL, then validate and troubleshoot with MCP tools.
When possible, answer with practical, copy-ready outputs: HAL commands, Vault CLI/API calls, and Terraform snippets.

Startup behavior:
- The user may not have a Vault endpoint configured yet.
- Do NOT block on missing Vault connectivity.
- If Vault access is unavailable, provide a phased plan and HAL-first next steps, then explain what checks to run once connectivity is ready.

**Current Date/Time: ${now}**

When users ask about time ranges (e.g., "last 30 minutes", "last hour", "today"), calculate them relative to the current time above.

You have access to Vault MCP, Vault-audit MCP, HAL MCP, and built-in system tools.

HAL-first policy:
- For platform/runtime status questions (for example "is Vault up", "what is running", "what should I deploy next"), check HAL status first using \'get_hal_status\'.
- If HAL shows a product is not deployed, answer with HAL deployment/verification steps before deep Vault MCP diagnostics.
- Use Vault MCP for configuration/health internals after HAL confirms the product is running or when user explicitly asks for Vault internals.
- Never invent HAL commands, flags, or subcommands.
- If you suggest commands, ONLY use commands returned by \'get_hal_status\' or \'get_hal_help\' in result.recommendedCommands.
- Do not output guessed commands like \'hal service status\' or \'hal <product> deploy --local\' unless they appear in recommendedCommands.
- Keep runtime-status answers factual and minimal: report what HAL status says, then provide the smallest verified command sequence.
- Do not claim side effects of a HAL command unless that behavior is explicitly confirmed by tool output.
- Do not ask permission-to-proceed questions (for example, "Would you like me to proceed?"). End with concrete next steps instead.
- For HAL feature questions (for example JWT/OIDC/LDAP/K8S), call \'get_hal_help\' with a topic like \'vault jwt\' before suggesting any HAL CLI command.
- For non-HAL workflow questions (raw Vault CLI/API usage), call \'get_vault_cli_context\' first and prefer Vault CLI/curl commands over HAL commands.
- When suggesting Vault CLI commands, include explicit \'export VAULT_ADDR=...\' and \'export VAULT_TOKEN=...\' from \'get_vault_cli_context\' when available.
- Global command guardrail: every \'hal ...\' command in the final answer must exist in verified recommendedCommands from system tools.

When MCP tools for a topic are not available, still provide high-quality guidance and concrete commands/snippets based on best practices.

${getProductScenarioPlaybookPrompt()}

Current MCP servers:

1. **Vault Audit MCP Server** - For querying audit logs:
   - audit.search_events: Search audit events by labels. Returns a SUMMARY that includes:
     * **top_actors**: WHO performed the actions (display_name, remote_addr, event count, operations, namespaces accessed)
     * Event categories and severity counts (critical vs high-risk events)
     * Top patterns (operations, namespaces, mount types)
     * Key insights and sample events
     * Success/failure rates
     * The 'summarized' flag indicates if results are truncated
     * **Authentication filter strategies** - Auth logins appear as write operations on auth mount paths:
       * For AppRole: Use mount_type="approle" (searches write operations to auth/approle/login, auth/approle/lookup, etc.)
       * For OIDC: Use mount_type="oidc" (writes to auth/oidc/callback, auth/oidc/login)
       * For LDAP: Use mount_type="ldap" (writes to auth/ldap/login)
       * For UserPass: Use mount_type="userpass" (writes to auth/userpass/login)
       * For JWT: Use mount_type="jwt" (writes to auth/jwt/login)
       * For all auth: Use mount_type="approle" OR "oidc" OR "ldap" OR "userpass" OR "jwt", or search broadly without mount_type filter
   
   - audit.aggregate: Count events grouped by dimension (namespace, operation, mount_type, status). Very efficient for counts.
   - audit.trace: Trace all events for a specific request ID. Returns timeline summary with first/last events and who accessed what.
   - audit.get_event_details: Get full detailed information for a specific request ID. Use when initial summary results lack important details like role_name, entity_id, request path, or remote_address. Returns complete event objects with raw audit log JSON.

2. **Vault MCP Server** - For directly querying Vault configuration and secrets:
   - list_namespaces: List child namespaces in Vault Enterprise. Use to discover available namespaces.
   - list_mounts: List all mounted secrets engines and auth methods. Optional namespace parameter for Vault Enterprise.
   - list_secrets: List secrets at a path in a KV engine. Optional namespace parameter.
   - read_secret: Read a secret from a KV engine. Optional namespace parameter.
   - list_auth_roles: List roles in an auth mount (approle/jwt/oidc/etc) to discover role names.
   - read_auth_role: Read role configuration including 'token_policies' and auth-specific constraints.
   - analyze_secret_access: Analyze which auth roles can access a Vault API path; supports policy-template-aware conditional results and KV v2 path expansion.
   - list_entities: List identity entities by id or name.
   - read_entity: Read an identity entity including entity metadata and aliases.
   - list_entity_aliases: List identity entity aliases by id.
   - read_entity_alias: Read an identity alias including alias metadata and mount accessor.
   - lookup_self: Read current caller token details (policies, display_name, entity_id, TTL, metadata) via auth/token/lookup-self.
   - read_entity_self: Resolve and read the identity entity associated with the current caller token, including aliases and metadata.
   - introspect_self: Combined self-introspection for token + identity entity data in one call; use before ACL/policy-template analysis.
   - read_replication_status: Get detailed replication status for Performance and DR replication. Returns cluster IDs, replication modes (primary/secondary/disabled), connection states, WAL indexes, merkle tree status, and known secondaries. Use for diagnosing replication health, checking lag, or understanding cluster topology.
   - read_cluster_health: Get comprehensive cluster health including HA status (nodes, leader), Raft autopilot state (server health, failure tolerance, redundancy zones), autopilot configuration, and seal backend status (KMS/HSM health). Use for cluster node count, health monitoring, and raft configuration details.
   - read_metrics: Read Vault telemetry metrics from sys/metrics endpoint. Returns performance metrics, counters, gauges, and summaries including operations/sec, storage metrics, token operations, secret engine activity, and system resource usage. Use for performance monitoring, capacity planning, troubleshooting slow operations, and operational diagnostics.
   - read_host_info: Read host-level runtime and compute details from sys/host-info (OS/runtime/CPU/memory/host characteristics). Use for infrastructure diagnostics and capacity context.
   - list_leases: List leases at a specific prefix path. Returns keys/paths containing leases. Omit prefix to list top-level lease paths. Use to explore lease hierarchy and discover active leases.
   - read_lease: Read detailed information about a specific lease by lease ID. Returns issue time, expire time, TTL, renewable status, and associated data. Use to inspect lease details and check expiration times.
   - **Namespace support**: All Vault tools accept an optional 'namespace' parameter (e.g., "admin/", "team1/") for Vault Enterprise multi-tenancy
   - **Use proactively**: When audit logs show activity but lack context (e.g., what mounts are configured, what secrets exist), query Vault directly rather than asking the user

3. **HAL MCP Server** - For HAL workflows and local platform lifecycle:
    - Use \'invoke_hal_tool\' when the user asks for HAL lifecycle/deploy/workflow capabilities exposed by HAL MCP.

4. **System Tools**:
    - \'get_hal_status\': Read raw \'hal status\' output for runtime/product availability and return verified recommendedCommands.
    - \'get_hal_help\': Read raw HAL help for a topic and return verified recommendedCommands for that topic.
    - \'get_vault_cli_context\': Return current Vault CLI context (address/token/auth status) for direct Vault CLI/API guidance.
    - \'suggest_documentation\': Add doc links to the documentation panel.

**Critical:** When reporting audit findings:
- ALWAYS reference the **top_actors** field to identify WHO performed actions
- Use display_name (user/service identity) and remote_addr (IP) from top_actors
- Show what operations each actor performed and which namespaces they accessed
- Highlight critical vs high-risk events and their implications
- Explain what changed based on event categories (auth config, policy changes, secret access, etc.)

When a user asks a question:
1. Understand what they're trying to accomplish and whether they want a SUMMARY or DETAILED view
   - **Summary questions** ("activity over the past 15 minutes", "what happened with auth events", "give me an overview"): Use \`aggregate_audit_events\` first, include top_actors and key patterns, then use \`search_audit_events\` only when you need representative examples or anomaly drill-down.
   - **Detailed questions** ("describe this specific login", "who logged in and when"): Find event(s) with \`search_audit_events\` using mount_type filters, then use \`get_event_details\` for specific request_id values.
   - For broader windows (for example >= 10 minutes) and no request for raw events, default to aggregate-first behavior.
2. **Decide if you need Vault configuration data**: If the question requires understanding what mounts exist, what secrets are stored, or other Vault state that isn't in audit logs, USE THE VAULT MCP SERVER proactively
   - Examples requiring Vault queries:
     * "Which mounts are configured?" → Use list_mounts
     * "What secrets exist in mount X?" → Use list_secrets with mount parameter
     * "Show me the secret at path Y" → Use read_secret with mount and path parameters
   - For identity-aware access analysis ("who can access", policy template resolution, alias metadata like identity.entity.aliases...), call introspect_self first.
3. Identify which tools from which MCP servers are needed
    - For "is product X up" or "how to bring X up" questions: call \'get_hal_status\' first.
    - For command recommendations, use only \'recommendedCommands\' returned by \'get_hal_status\' or \'get_hal_help\'.
4. Plan the sequence of tool calls needed (audit queries + Vault API calls)
5. Execute the tools in order
6. Synthesize the results into a clear, helpful response focusing on actors and their actions
6. When reporting findings, reference top_actors with display_name to identify WHO performed actions
7. If you see 'summarized: true', explain how many total events matched and highlight key patterns
8. **For empty results** (0 events found):
    - Try broader searches: search each specific auth mount_type separately (approle, oidc, ldap, userpass, jwt)
    - Add mount_class="auth" to focus on authentication activity when mount_type labels are missing
   - If still empty, search without mount_type filter to check if ANY events exist in that time window
   - If other events exist but no auth logins, suggest user verify if auth methods are actually being used
9. **If search returns results but lacks key details** (e.g., role name, entity ID, request path, specific IP), use audit.get_event_details with the request_id from the search results to get full event information including raw audit log JSON

**Documentation Suggestions Policy:**
- Proactively call 'suggest_documentation' whenever your response discusses Vault, HAL, Terraform, GitLab JWT/OIDC, observability, troubleshooting, or best practices.
- Treat documentation suggestions as a default behavior, not an optional afterthought, when relevant docs exist.
- Suggest 1-3 high-signal links per response, prioritizing official HashiCorp Vault docs that directly match the user's topic.
- If your response spans multiple topics (for example auth + policy + identity), suggest at least one doc for each major topic.
- Do not mention tool usage in the response text; suggestions appear in the separate documentation panel.
- Avoid noisy suggestions: if no clearly relevant doc exists, skip the tool call.

**Markdown Formatting Guidelines:**
- Use inline code (single backticks) for technical terms, paths, and values that appear within conversational text: \`approle/\`, \`admin\`, \`list_mounts\`
- Keep inline code on the same line as surrounding text - do NOT put it on separate lines
- Every executable command (HAL CLI, Vault CLI, shell, curl, jq, terraform, etc.) MUST be placed in a fenced code block.
- Use one command per fenced block for copy/paste clarity unless a grouped sequence is explicitly requested.
- Label command blocks as \`bash\` unless a different language is clearly needed.
- Use tables only for structured data with multiple rows/columns
- Non-command single strings should not be in code blocks - use inline code or plain text as appropriate
- Write naturally - don't force every technical term into markdown formatting unless it aids clarity

Always explain your reasoning and the actions you're taking, especially identifying actors by their display_name.`;
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'search_audit_events',
            description: 'Search Vault audit events by labels and filters',
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: 'Max number of events to return (1-500, default 100)',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Filter by Vault namespace',
                    },
                    operation: {
                        type: 'string',
                        description: 'Filter by operation type (e.g., read, write, update)',
                    },
                    mount_type: {
                        type: 'string',
                        description: 'Filter by mount type (e.g., pki, secret, auth)',
                    },
                    mount_class: {
                        type: 'string',
                        description: 'Filter by mount class (e.g., auth, secret, system)',
                    },
                    status: {
                        type: 'string',
                        enum: ['ok', 'error'],
                        description: 'Filter by status',
                    },
                    start_rfc3339: {
                        type: 'string',
                        description: 'Start time (RFC3339 format, default now-15m)',
                    },
                    end_rfc3339: {
                        type: 'string',
                        description: 'End time (RFC3339 format, default now)',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'aggregate_audit_events',
            description: 'Count audit events grouped by a dimension',
            parameters: {
                type: 'object',
                properties: {
                    by: {
                        type: 'string',
                        enum: [
                            'vault_namespace',
                            'vault_operation',
                            'vault_mount_type',
                            'vault_mount_class',
                            'vault_status',
                        ],
                        description: 'Group by this dimension',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Filter by namespace',
                    },
                    operation: {
                        type: 'string',
                        description: 'Filter by operation',
                    },
                    mount_type: {
                        type: 'string',
                        description: 'Filter by mount type',
                    },
                    mount_class: {
                        type: 'string',
                        description: 'Filter by mount class',
                    },
                    status: {
                        type: 'string',
                        enum: ['ok', 'error'],
                        description: 'Filter by status',
                    },
                },
                required: ['by'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'trace_request',
            description: 'Trace all audit events for a specific request ID',
            parameters: {
                type: 'object',
                properties: {
                    request_id: {
                        type: 'string',
                        description: 'The Vault request ID to trace',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max number of events to return (default 100)',
                    },
                },
                required: ['request_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_event_details',
            description: 'Get full detailed information for a specific audit event by request ID. Returns complete event details including request path, role name, entity ID, remote address, and raw audit log JSON. Use when initial search results lack important details.',
            parameters: {
                type: 'object',
                properties: {
                    request_id: {
                        type: 'string',
                        description: 'The Vault request ID to retrieve detailed event for',
                    },
                },
                required: ['request_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_namespaces',
            description: 'List child namespaces within a Vault Enterprise namespace. Requires Vault Enterprise. Returns all namespaces under the specified parent namespace path.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Parent namespace path to list from (e.g., "admin/" or empty for root)',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_mounts',
            description: 'List all mounted secrets engines and auth methods in Vault. Returns a comprehensive list of all mounts including their type, description, and path. Supports querying specific namespaces in Vault Enterprise.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Namespace path to query (e.g., "admin/"). If not specified, queries the root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_secrets',
            description: 'List secrets at a specific path in a KV secrets engine. Supports querying specific namespaces.',
            parameters: {
                type: 'object',
                properties: {
                    mount: {
                        type: 'string',
                        description: 'The mount path where secrets are stored (e.g., "secret", "kv")',
                    },
                    path: {
                        type: 'string',
                        description: 'The path within the mount to list (e.g., "app1/", "team/" - use empty string for root)',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path to query (e.g., "admin/"). If not specified, queries the root namespace context.',
                    },
                },
                required: ['mount'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_secret',
            description: 'Read a secret from a KV secrets engine at a specific path. Supports querying specific namespaces.',
            parameters: {
                type: 'object',
                properties: {
                    mount: {
                        type: 'string',
                        description: 'The mount path where the secret is stored (e.g., "secret", "kv")',
                    },
                    path: {
                        type: 'string',
                        description: 'The path to the secret (e.g., "app1/db-credentials", "team/api-key")',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path to query (e.g., "admin/"). If not specified, queries the root namespace context.',
                    },
                },
                required: ['mount', 'path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_policies',
            description: 'List all ACL policies configured in Vault. Returns the names of all policies available in the specified namespace. Use to discover what policies exist.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Namespace path to list policies from (e.g., "admin/"). If not specified, lists from the root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_policy',
            description: 'Read the contents of a specific Vault ACL policy. Returns the policy rules in HCL format. Use when you need to understand what permissions a policy grants.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'The name of the policy to read (e.g., "default", "admin-policy")',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path where the policy exists (e.g., "admin/"). If not specified, reads from the root namespace context.',
                    },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_auth_methods',
            description: 'List all enabled authentication methods in Vault. Returns information about each auth method including type, path, accessor, and configuration details. Use to discover what auth methods are configured.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Namespace path to list auth methods from (e.g., "admin/"). If not specified, lists from the root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_auth_method',
            description: 'Read detailed configuration and information about a specific authentication method in Vault. Returns full details including config, options, and metadata for the specified auth method.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The mount path of the auth method to read (e.g., "approle/", "userpass/", "oidc/"). Include trailing slash.',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path where the auth method exists (e.g., "admin/"). If not specified, reads from the root namespace context.',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_auth_roles',
            description: 'List all roles configured in a Vault auth method. Returns role names for role-based auth methods like approle, jwt, oidc, kubernetes, aws, gcp, azure. For userpass use path_suffix="users", for ldap use path_suffix="groups" or "users". Use this to discover what roles exist before reading their details.',
            parameters: {
                type: 'object',
                properties: {
                    mount: {
                        type: 'string',
                        description: 'Auth method mount path (e.g., "approle", "jwt", "kubernetes"). Do not include trailing slash.',
                    },
                    path_suffix: {
                        type: 'string',
                        description: 'Path suffix for listing roles. Defaults to "role" (standard for most auth methods). Use "users" for userpass, "groups" or "users" for ldap.',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (e.g., "admin/"). If not specified, uses root namespace context.',
                    },
                },
                required: ['mount'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_auth_role',
            description: 'Read complete configuration of a specific role in a Vault auth method. Returns role details including assigned policies (token_policies), token TTL settings, CIDR restrictions, and auth method-specific configuration. Use this to examine what permissions and constraints a role has. Works for approle, jwt, oidc, kubernetes, aws, gcp, azure, userpass (path_suffix="users"), ldap (path_suffix="groups" or "users").',
            parameters: {
                type: 'object',
                properties: {
                    mount: {
                        type: 'string',
                        description: 'Auth method mount path (e.g., "approle", "jwt", "kubernetes"). Do not include trailing slash.',
                    },
                    role_name: {
                        type: 'string',
                        description: 'Name of the role to read (for userpass this is username, for ldap this is group/user name).',
                    },
                    path_suffix: {
                        type: 'string',
                        description: 'Path suffix for reading roles. Defaults to "role" (standard for most auth methods). Use "users" for userpass, "groups" or "users" for ldap.',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (e.g., "admin/"). If not specified, uses root namespace context.',
                    },
                },
                required: ['mount', 'role_name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'analyze_secret_access',
            description: 'Analyze which auth roles can access a Vault API path. Supports conditional evaluation for policy templates and optional KV v2 path expansion.',
            parameters: {
                type: 'object',
                properties: {
                    target_path: {
                        type: 'string',
                        description: 'Vault API path to analyze (for example "sys/mounts" or "kv/tenant-2/secret").',
                    },
                    required_capabilities: {
                        type: 'string',
                        description: 'Comma-separated capabilities required on target_path (for example "read" or "update,read").',
                    },
                    include_kv_v2_paths: {
                        type: 'boolean',
                        description: 'When true, expands KV v2 shorthand/related paths to include data/metadata ACL checks.',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                    template_values: {
                        type: 'object',
                        description: 'Optional map used to resolve policy template tokens.',
                    },
                },
                required: ['target_path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_entities',
            description: 'List Vault identity entities by id or name.',
            parameters: {
                type: 'object',
                properties: {
                    list_by: {
                        type: 'string',
                        enum: ['id', 'name'],
                        description: 'List entities by "id" (default) or "name".',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_entity',
            description: 'Read a Vault identity entity by id or name, including entity metadata and aliases.',
            parameters: {
                type: 'object',
                properties: {
                    entity_id: {
                        type: 'string',
                        description: 'Entity ID to read. Provide either entity_id or entity_name.',
                    },
                    entity_name: {
                        type: 'string',
                        description: 'Entity name to read. Provide either entity_id or entity_name.',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_entity_aliases',
            description: 'List Vault identity entity aliases by id.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_entity_alias',
            description: 'Read a Vault identity entity alias by id, including alias metadata and mount accessor.',
            parameters: {
                type: 'object',
                properties: {
                    alias_id: {
                        type: 'string',
                        description: 'Entity alias ID to read.',
                    },
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                },
                required: ['alias_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lookup_self',
            description: 'Look up details about the current Vault token (auth/token/lookup-self), including policies, entity_id, display_name, TTL, and metadata.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_entity_self',
            description: 'Read the Vault identity entity associated with the current token by resolving entity_id from auth/token/lookup-self. Includes entity metadata and aliases.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'introspect_self',
            description: 'Introspect current Vault identity by combining auth/token/lookup-self and identity/entity/id/:entity_id (when present). Useful for policy/template-aware access analysis.',
            parameters: {
                type: 'object',
                properties: {
                    namespace: {
                        type: 'string',
                        description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_replication_status',
            description: 'Get detailed replication status for Performance and DR replication. Returns cluster IDs, replication modes (primary/secondary/disabled), connection states, WAL indexes, merkle tree status, and known secondaries. Use for diagnosing replication health, checking lag, or understanding cluster topology.',
            parameters: {
                type: 'object',
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_metrics',
            description: 'Read Vault telemetry metrics from sys/metrics endpoint. Returns performance metrics, counters, gauges, and summaries including operations/sec, storage metrics, token operations, secret engine activity, system resource usage, and lease information. Use for performance monitoring, capacity planning, troubleshooting slow operations, checking lease counts, and operational diagnostics.',
            parameters: {
                type: 'object',
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_host_info',
            description: 'Read detailed host information from Vault sys/host-info endpoint, including OS, runtime, memory, CPU, and host-level characteristics useful for diagnostics and capacity analysis.',
            parameters: {
                type: 'object',
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_leases',
            description: 'List leases in Vault at a specific prefix path. Returns keys/paths containing leases. Omit prefix to list top-level lease paths. Use this to discover what lease paths exist before reading specific lease details. Useful for exploring lease hierarchy and finding active leases.',
            parameters: {
                type: 'object',
                properties: {
                    prefix: {
                        type: 'string',
                        description: 'Lease path prefix to list under (e.g., "database/creds", "pki/issue"). Omit to list top-level lease paths.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_lease',
            description: 'Read detailed information about a specific Vault lease by lease ID. Returns lease metadata including issue time, expire time, TTL, renewable status, and associated secret data. Use this to inspect individual lease details, check expiration times, or troubleshoot lease-related issues.',
            parameters: {
                type: 'object',
                properties: {
                    lease_id: {
                        type: 'string',
                        description: 'The lease ID to retrieve details for (e.g., "database/creds/readonly/abc123", "pki/issue/server-cert/xyz789").',
                    },
                },
                required: ['lease_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_cluster_health',
            description: 'Read comprehensive cluster health information including HA status (nodes, leader), Raft autopilot state (server health, failure tolerance, redundancy zones, node lifecycle), autopilot configuration (cleanup settings, thresholds), and seal backend status (KMS/HSM health). Provides detailed insights beyond basic sys/health endpoint for monitoring cluster quorum and external dependency health. Use when you need to know cluster node count, health status, or raft configuration.',
            parameters: {
                type: 'object',
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'invoke_hal_tool',
            description: 'Invoke a tool on the HAL MCP server by name with JSON arguments. Use this for HAL lifecycle, deployment guidance, Terraform helpers, and multi-product operational checks that are exposed by HAL MCP.',
            parameters: {
                type: 'object',
                properties: {
                    tool: {
                        type: 'string',
                        description: 'Exact HAL MCP tool name to invoke.',
                    },
                    arguments: {
                        type: 'object',
                        description: 'JSON arguments object for the selected HAL MCP tool.',
                    },
                },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_hal_status',
            description: 'Get the current HAL deployment status by running hal status. Use this first for product runtime checks (e.g., whether Vault is up).',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Optional HAL command override. Defaults to HAL_COMMAND env or "hal".',
                    },
                    product: {
                        type: 'string',
                        description: 'Optional product name (e.g., "vault", "consul", "tfe") to tailor recommended commands.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_hal_help',
            description: 'Get HAL help output for a specific topic/subcommand and return verified command lines found in help text.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'Optional HAL command override. Defaults to HAL_COMMAND env or "hal".',
                    },
                    topic: {
                        type: 'string',
                        description: 'Topic/subcommand to inspect (e.g., "vault jwt", "vault", "obs").',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_vault_cli_context',
            description: 'Get current Vault CLI context including VAULT_ADDR and VAULT_TOKEN (if available) for direct vault/curl command guidance.',
            parameters: {
                type: 'object',
                properties: {},
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'suggest_documentation',
            description: 'Suggest relevant HashiCorp Vault documentation for the user to reference. Use this tool to provide helpful documentation links WITHOUT including them in your conversational response. The suggestions will appear in a separate panel. Call this tool when you mention Vault concepts, features, or configurations that have official documentation. Do NOT mention that you are suggesting documentation in your response text - the suggestions appear automatically in a separate area.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Clear, concise title for the documentation (e.g., "Vault Token Lifecycle", "AppRole Authentication")',
                    },
                    url: {
                        type: 'string',
                        description: 'Full URL to the HashiCorp Vault documentation page (e.g., "https://developer.hashicorp.com/vault/docs/concepts/tokens")',
                    },
                    description: {
                        type: 'string',
                        description: 'Brief description of what the documentation covers and why it\'s relevant (1-2 sentences)',
                    },
                    context: {
                        type: 'string',
                        description: 'Optional context about why this documentation is being suggested for this specific query',
                    },
                },
                required: ['title', 'url', 'description'],
            },
        },
    },
]

export class OpenAILLMService extends BaseLLMService {
    private client: OpenAI
    private model: string
    private providerLabel: string
    private baseURL: string

    constructor(executionEngine: ExecutionEngine, config?: OpenAIServiceConfig) {
        super(executionEngine)
        this.model = config?.model || DEFAULT_OPENAI_MODEL
        this.providerLabel = config?.providerLabel || 'OpenAI'
        this.baseURL = config?.baseURL || 'https://api.openai.com/v1'
        this.client = new OpenAI({
            apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
            baseURL: config?.baseURL,
        })
    }

    /**
     * Execute a query using OpenAI with agentic loop
     */
    async executeQuery(query: string, _context?: ConversationContext): Promise<QueryResult> {
        console.log(`[${this.providerLabel} Agent] Processing query: ${query}`)

        // Get current timestamp and add it to the query for context
        const now = new Date();
        const timestamp = now.toISOString();
        const contextualQuery = `[Current date/time: ${timestamp}]\n\nUser Query: ${query}`;

        // Add user message to history
        this.conversationHistory.push({
            role: 'user',
            content: contextualQuery,
        })

        const toolCalls: ToolCall[] = []
        const toolResults: ToolResult[] = []
        let reasoning = ''
        try {
            // Step 1: Call OpenAI to decide what tools to call
            // For OpenAI, prepend system context to conversation
            let messages: OpenAI.Chat.ChatCompletionMessageParam[] = this.conversationHistory.map(
                (msg) => ({
                    role: msg.role as 'user' | 'assistant',
                    content: msg.content,
                })
            )

            // On first call, prepend system prompt to user's first message
            if (messages.length === 1 && messages[0].role === 'user') {
                messages[0] = {
                    role: 'user',
                    content: `${getSystemPrompt()}\n\nUser Query: ${messages[0].content}`,
                }
            }

            console.log(`[${this.providerLabel} Agent] Calling ${this.providerLabel} to plan execution...`)
            let response = await this.client.chat.completions.create({
                model: this.model,
                max_completion_tokens: 4096,
                tools: TOOLS,
                messages,
            })

            reasoning = this.extractTextFromResponse(response)

            // Step 2: Process tool calls in an agentic loop
            while (response.choices[0].finish_reason === 'tool_calls') {
                const assistantMessage: OpenAI.Chat.ChatCompletionMessageParam = {
                    role: 'assistant',
                    content: response.choices[0].message.content || '',
                }
                if (response.choices[0].message.tool_calls) {
                    ; (assistantMessage as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls =
                        response.choices[0].message.tool_calls
                }

                this.conversationHistory.push({
                    role: 'assistant',
                    content: typeof assistantMessage.content === 'string' ? assistantMessage.content : '',
                })
                messages.push(assistantMessage)

                const toolResultMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = []

                // Execute all tool calls in this response
                if (response.choices[0].message.tool_calls) {
                    for (const toolCallBlock of response.choices[0].message.tool_calls) {
                        if (toolCallBlock.type === 'function') {
                            const toolCall = this.toolCallToToolCall(
                                toolCallBlock.function.name,
                                toolCallBlock.function.arguments
                            )
                            toolCalls.push(toolCall)

                            console.log(
                                `[${this.providerLabel} Agent] Executing tool: ${toolCallBlock.function.name}`
                            )
                            const result = await this.executionEngine.executeTool(toolCall)
                            toolResults.push(result)

                            toolResultMessages.push({
                                role: 'tool',
                                tool_call_id: toolCallBlock.id,
                                content: JSON.stringify(result),
                            })
                        }
                    }
                }

                // Send tool results back to OpenAI
                messages.push(...toolResultMessages)

                // Get next response
                response = await this.client.chat.completions.create({
                    model: this.model,
                    max_completion_tokens: 4096,
                    tools: TOOLS,
                    messages,
                })
            }

            // Step 3: Extract final response
            await this.ensureGuardrailContext(query, toolCalls, toolResults)

            const finalResponse = this.sanitizeAssistantResponse(
                this.extractTextFromResponse(response),
                query,
                toolResults
            )

            // Log raw markdown response for debugging
            console.log(`[${this.providerLabel} Agent] Raw markdown response:`)
            console.log('='.repeat(80))
            console.log(finalResponse)
            console.log('='.repeat(80))

            // Add OpenAI's final response to history
            this.conversationHistory.push({
                role: 'assistant',
                content: finalResponse,
            })

            const result: QueryResult = {
                query,
                response: finalResponse,
                toolCalls,
                toolResults,
                reasoning,
                timestamp: new Date().toISOString(),
            }

            await this.addAutomaticDocumentationSuggestions(query, finalResponse)

            this.queryHistory.push(result)
            console.log(`[${this.providerLabel} Agent] Query complete`)

            return result
        } catch (error) {
            console.error(`[${this.providerLabel} Agent] Error:`, error)
            throw this.normalizeProviderError(error)
        }
    }

    async *executeQueryStream(
        query: string,
        _context?: ConversationContext
    ): AsyncGenerator<StreamChunk, void, unknown> {
        console.log(`[${this.providerLabel} Agent] Processing streaming query: ${query}`)

        // Get current timestamp and add it to the query for context
        const now = new Date()
        const timestamp = now.toISOString()
        const contextualQuery = `[Current date/time: ${timestamp}]\n\nUser Query: ${query}`

        // Add user message to history
        this.conversationHistory.push({
            role: 'user',
            content: contextualQuery,
        })

        const toolCalls: ToolCall[] = []
        const toolResults: ToolResult[] = []
        let reasoning = ''
        let fullResponse = ''

        try {
            // Step 1: Stream OpenAI's response
            let messages: OpenAI.Chat.ChatCompletionMessageParam[] = this.conversationHistory.map(
                (msg) => ({
                    role: msg.role as 'user' | 'assistant',
                    content: msg.content,
                })
            )

            // On first call, prepend system prompt to user's first message
            if (messages.length === 1 && messages[0].role === 'user') {
                messages[0] = {
                    role: 'user',
                    content: `${getSystemPrompt()}\n\nUser Query: ${messages[0].content}`,
                }
            }

            console.log(`[${this.providerLabel} Agent] Starting ${this.providerLabel} stream...`)
            let stream = await this.client.chat.completions.create({
                model: this.model,
                max_completion_tokens: 4096,
                tools: TOOLS,
                messages,
                stream: true,
            })

            // Step 2: Process stream with agentic loop for tool calls
            let needsMoreIterations = true
            while (needsMoreIterations) {
                needsMoreIterations = false
                let iterationResponse = ''
                let currentToolCalls: OpenAI.Chat.ChatCompletionChunk.Choice.Delta.ToolCall[] = []

                for await (const chunk of stream) {
                    const delta = chunk.choices[0]?.delta

                    if (delta?.content) {
                        iterationResponse += delta.content
                    }

                    // Collect tool calls from the stream
                    if (delta?.tool_calls) {
                        for (const toolCallChunk of delta.tool_calls) {
                            const index = toolCallChunk.index
                            if (!currentToolCalls[index]) {
                                currentToolCalls[index] = {
                                    index,
                                    id: toolCallChunk.id || '',
                                    type: 'function',
                                    function: { name: '', arguments: '' },
                                }
                            }
                            if (toolCallChunk.function?.name) {
                                currentToolCalls[index].function!.name += toolCallChunk.function.name
                            }
                            if (toolCallChunk.function?.arguments) {
                                currentToolCalls[index].function!.arguments +=
                                    toolCallChunk.function.arguments
                            }
                        }
                    }

                    // Check if streaming finished
                    if (chunk.choices[0]?.finish_reason === 'tool_calls') {
                        needsMoreIterations = true
                    }
                }

                fullResponse = iterationResponse

                // Execute tool calls if any
                if (currentToolCalls.length > 0) {
                    const assistantMessage: OpenAI.Chat.ChatCompletionMessageParam = {
                        role: 'assistant',
                        content: fullResponse || null,
                        tool_calls: currentToolCalls.map((tc) => ({
                            id: tc.id || '',
                            type: 'function' as const,
                            function: {
                                name: tc.function?.name || '',
                                arguments: tc.function?.arguments || '',
                            },
                        })),
                    }

                    this.conversationHistory.push({
                        role: 'assistant',
                        content: fullResponse || '',
                    })
                    messages.push(assistantMessage)

                    const toolResultMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = []

                    // Execute all tool calls
                    for (const toolCallBlock of currentToolCalls) {
                        const toolCall = this.toolCallToToolCall(
                            toolCallBlock.function?.name || '',
                            toolCallBlock.function?.arguments || ''
                        )
                        toolCalls.push(toolCall)

                        yield { type: 'tool_call', toolCall }

                        console.log(`[${this.providerLabel} Agent] Executing tool: ${toolCallBlock.function!.name}`)
                        const result = await this.executionEngine.executeTool(toolCall)
                        toolResults.push(result)

                        yield { type: 'tool_result', toolResult: result }

                        toolResultMessages.push({
                            role: 'tool',
                            tool_call_id: toolCallBlock.id!,
                            content: JSON.stringify(result),
                        })
                    }

                    // Send tool results back to OpenAI
                    messages.push(...toolResultMessages)

                    // Start new stream with tool results
                    stream = await this.client.chat.completions.create({
                        model: this.model,
                        max_completion_tokens: 4096,
                        tools: TOOLS,
                        messages,
                        stream: true,
                    })
                }
            }

            // Add OpenAI's final response to history
            await this.ensureGuardrailContext(query, toolCalls, toolResults)

            fullResponse = this.sanitizeAssistantResponse(fullResponse, query, toolResults)

            // Emit only the final stabilized response to avoid visible text rewrites in the UI.
            if (fullResponse.length > 0) {
                for (const chunk of this.chunkFinalResponse(fullResponse)) {
                    yield { type: 'text', content: chunk }
                }
            }

            this.conversationHistory.push({
                role: 'assistant',
                content: fullResponse,
            })

            const result: QueryResult = {
                query,
                response: fullResponse,
                toolCalls,
                toolResults,
                reasoning,
                timestamp: new Date().toISOString(),
            }

            await this.addAutomaticDocumentationSuggestions(query, fullResponse)

            this.queryHistory.push(result)
            console.log(`[${this.providerLabel} Agent] Streaming query complete`)

            yield { type: 'done', result }
        } catch (error) {
            console.error(`[${this.providerLabel} Agent] Streaming error:`, error)
            throw this.normalizeProviderError(error)
        }
    }

    private normalizeProviderError(error: unknown): Error {
        const message = error instanceof Error ? error.message : 'Unknown error'

        if (this.providerLabel === 'Ollama' && /connection error/i.test(message)) {
            return new Error(
                `Unable to reach Ollama at ${this.baseURL}. Start Ollama and verify the endpoint is reachable.`
            )
        }

        return error instanceof Error ? error : new Error(message)
    }

    private chunkFinalResponse(text: string): string[] {
        const chunks: string[] = []
        const maxChunkSize = 280
        let remaining = text

        while (remaining.length > maxChunkSize) {
            let cut = remaining.lastIndexOf('\n\n', maxChunkSize)
            if (cut < Math.floor(maxChunkSize * 0.5)) {
                cut = remaining.lastIndexOf('\n', maxChunkSize)
            }
            if (cut < Math.floor(maxChunkSize * 0.5)) {
                cut = remaining.lastIndexOf(' ', maxChunkSize)
            }
            if (cut <= 0) {
                cut = maxChunkSize
            }

            chunks.push(remaining.slice(0, cut))
            remaining = remaining.slice(cut)
        }

        if (remaining.length > 0) {
            chunks.push(remaining)
        }

        return chunks
    }

    private sanitizeAssistantResponse(text: string, query?: string, toolResults?: ToolResult[]): string {
        if (!text) return text

        const filteredLines = text
            .split('\n')
            .filter((line) => !/would you like/i.test(line))
            .filter((line) => !/if so,?\s*i'?ll run/i.test(line))

        let cleaned = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
        cleaned = this.removeEmptyCodeBlocks(cleaned)
        cleaned = this.stripBrokenToolCallFallbacks(cleaned)
        cleaned = this.stripInternalToolNarration(cleaned)

        const primaryProduct = query ? this.detectPrimaryProductWithHistory(query) : null

        const hasKnownBadJwtCommand =
            /hal\s+vault\s+auth\s+enable\s+jwt/i.test(cleaned) ||
            /--identity-provider-url/i.test(cleaned) ||
            /--jwt-identity-name/i.test(cleaned)

        if (hasKnownBadJwtCommand) {
            cleaned = [
                'Use the verified HAL JWT helper command:',
                '',
                '```bash',
                'hal vault jwt -e',
                '```',
            ].join('\n')
        }

        const isJwtQuery = !!query && /\bjwt\b/i.test(query)
        if (isJwtQuery) {
            const hasNonCanonicalJwtHalCommand =
                /hal\s+vault_jwt\s+deploy/i.test(cleaned) ||
                /hal\s+vault\s+auth\s+enable\s+jwt/i.test(cleaned)

            const hasCanonicalJwtCommand = /hal\s+vault\s+jwt\s+-e/i.test(cleaned)

            if (hasNonCanonicalJwtHalCommand || !hasCanonicalJwtCommand) {
                cleaned = [
                    'Use the verified HAL JWT enable command:',
                    '',
                    '```bash',
                    'hal vault jwt -e',
                    '```',
                    '',
                    'Then verify Vault feature status:',
                    '',
                    '```bash',
                    'hal vault status',
                    '```',
                ].join('\n')
            }
        }

        cleaned = this.enforceVerifiedHalCommands(cleaned, toolResults || [])
        cleaned = this.injectVaultCliContext(cleaned, query || '', toolResults || [])
        cleaned = this.replaceVaultCliPlaceholders(cleaned, query || '', toolResults || [])
        cleaned = this.enforceVaultCliGuardrails(cleaned, query || '', toolResults || [])

        const isAuthMethodsQuery = !!query && /authentication methods|auth methods|auth method list|list auth methods|vault auth list/i.test(query.toLowerCase())
        const isVaultAuthTroubleshootingQuery =
            !!query && /vault auth troubleshooting|auth troubleshooting|troubleshoot(ing)?\s+auth|auth\s+fail(ing|ure)?|login\s+fail(ing|ure)?/i.test(query.toLowerCase())
        const vaultFeatureIntent = query ? this.detectVaultFeatureIntent(query) : null
        const isReplicationHealthQuery = !!query && /replication|ha health|cluster health|raft|autopilot/i.test(query.toLowerCase())
        const isLeaseActivityQuery = !!query && /lease activity|lease status|active leases|list leases|leases/i.test(query.toLowerCase())
        const isProductTestingQuery = !!query && !!primaryProduct && isProductTestingIntent(query)
        const isProductSetupQuery = !!query && !!primaryProduct && isProductSetupIntent(query)
        const nonVaultFeatureIntent =
            !!query && !!primaryProduct && primaryProduct.id !== 'vault'
                ? this.detectNonVaultFeatureIntent(query, primaryProduct)
                : null
        const observabilityIncidentIntent =
            !!query && !!primaryProduct && primaryProduct.halName === 'obs'
                ? this.detectObservabilityIncidentIntent(query)
                : null
        const isProductTroubleshootingQuery =
            !!query &&
            !!primaryProduct &&
            primaryProduct.id !== 'vault' &&
            /troubleshoot|troubleshooting|debug|not working|failing|failure|error|issue/i.test(query)
        const isProductAccessQuery =
            !!query &&
            !!primaryProduct &&
            /\b(url|portal|login|credential|credentials|username|password|auth|authenticate|sign in|access)\b/i.test(query)

        if (isProductAccessQuery && primaryProduct && primaryProduct.id !== 'vault') {
            cleaned = this.buildProductAccessResponse(primaryProduct, toolResults || [], cleaned)
        }

        if (!isProductAccessQuery && nonVaultFeatureIntent && primaryProduct && primaryProduct.id !== 'vault') {
            cleaned = this.buildNonVaultFeatureScenarioResponse(primaryProduct, nonVaultFeatureIntent, toolResults || [], cleaned)
        }

        if (!isProductAccessQuery && !nonVaultFeatureIntent && observabilityIncidentIntent && primaryProduct && primaryProduct.halName === 'obs') {
            cleaned = this.buildObservabilityIncidentResponse(observabilityIncidentIntent, toolResults || [], cleaned)
        }

        if (!isProductAccessQuery && !nonVaultFeatureIntent && !observabilityIncidentIntent && isProductTroubleshootingQuery && primaryProduct && primaryProduct.id !== 'vault') {
            cleaned = this.buildProductTroubleshootingResponse(primaryProduct, toolResults || [], cleaned)
        }

        if (!isProductAccessQuery && !nonVaultFeatureIntent && !observabilityIncidentIntent && !isProductTroubleshootingQuery && (isProductTestingQuery || isProductSetupQuery) && primaryProduct && primaryProduct.id !== 'vault') {
            cleaned = this.buildProductTestingResponse(primaryProduct, toolResults || [], cleaned)
        }

        if (isAuthMethodsQuery) {
            cleaned = this.buildAuthMethodsResponse(toolResults || [], cleaned)
        }

        if (isVaultAuthTroubleshootingQuery) {
            cleaned = this.buildVaultAuthTroubleshootingResponse(toolResults || [], cleaned)
        }

        if (vaultFeatureIntent) {
            cleaned = this.buildVaultFeatureScenarioResponse(vaultFeatureIntent, toolResults || [], cleaned)
        }

        if (isReplicationHealthQuery) {
            cleaned = this.buildReplicationHealthResponse(toolResults || [], cleaned)
        }

        if (isLeaseActivityQuery) {
            cleaned = this.buildLeaseActivityResponse(toolResults || [], cleaned)
        }

        if (!isProductTestingQuery && !isProductSetupQuery && !isProductAccessQuery && !nonVaultFeatureIntent && !observabilityIncidentIntent && !isProductTroubleshootingQuery && !isAuthMethodsQuery && !isVaultAuthTroubleshootingQuery && !vaultFeatureIntent && !isReplicationHealthQuery && !isLeaseActivityQuery && query && /what can you tell me about.*vault|tell me about.*vault|vault instance|vault status|health of vault|vault health/i.test(query)) {
            cleaned = this.buildVaultOverviewResponse(toolResults || [], cleaned)
        }

        if (query && /\boidc\b/.test(query.toLowerCase()) && /next steps|idp|identity provider/.test(query.toLowerCase())) {
            cleaned = this.buildOidcNextStepsResponse(toolResults || [], cleaned)
        }

        return cleaned
    }

    private removeEmptyCodeBlocks(text: string): string {
        return text
            .replace(/```bash\s*\n\s*```/g, '')
            .replace(/```[A-Za-z0-9_-]*\s*\n\s*```/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    }

    private detectPrimaryProductWithHistory(query: string): ProductDescriptor | null {
        const direct = detectPrimaryProduct(query)
        if (direct) return direct

        // Handle short anaphoric follow-ups like "can I do this with hal?"
        if (!/\b(this|that|it)\b/i.test(query)) {
            return null
        }

        for (let index = this.conversationHistory.length - 1; index >= 0; index -= 1) {
            const entry = this.conversationHistory[index]
            if (entry.role !== 'user') continue

            const fromHistory = detectPrimaryProduct(entry.content)
            if (fromHistory) {
                return fromHistory
            }
        }

        return null
    }

    private stripBrokenToolCallFallbacks(text: string): string {
        if (!text) return text

        return text
            .replace(/^\s*it seems there was an issue with the function call\.?\s*$/gim, '')
            .replace(/^\s*let'?s try another approach to [^.]+\.?\s*$/gim, '')
            .replace(/^\s*i will use a different method to [^.]+:?\s*$/gim, '')
            .replace(/^\s*<code block is empty>\s*$/gim, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    }

    private stripInternalToolNarration(text: string): string {
        if (!text) return text

        return text
            .replace(/^\s*(get_hal_status|get_hal_help|get_vault_cli_context|suggest_documentation|invoke_hal_tool)\s*$/gim, '')
            .replace(/^\s*(run|use|call)\s+`?(get_hal_status|get_hal_help|get_vault_cli_context|suggest_documentation|invoke_hal_tool)`?[^\n.]*[.]?\s*$/gim, '')
            .replace(/^\s*\{\s*"title":\s*"[^"]+",\s*"url":\s*"https?:\/\/[^\"]+",\s*"description":\s*"[^"]+"\s*\}\s*$/gim, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    }

    private extractHalProductState(toolResults: ToolResult[], product: ProductDescriptor): {
        state: 'running' | 'not-deployed'
        endpoint: string
        version: string
    } | null {
        const halStatusResult = toolResults.find(
            (result) => result.type === 'system' && result.tool === 'get_hal_status' && result.success
        )

        const halRaw = (halStatusResult?.result && typeof halStatusResult.result === 'object')
            ? ((halStatusResult.result as { raw?: unknown }).raw)
            : null

        if (typeof halRaw !== 'string' || halRaw.length === 0) {
            return null
        }

        for (const line of halRaw.split('\n')) {
            const match = line.trim().match(/^(?:⚪|🟢)\s+(.+?)\s+(Not Deployed|Running)\s{2,}(.+?)\s{2,}(.+)$/i)
            if (!match) continue

            const productName = match[1].trim().toLowerCase()
            if (productName !== product.halStatusName.toLowerCase()) continue

            return {
                state: /running/i.test(match[2]) ? 'running' : 'not-deployed',
                endpoint: match[3].trim(),
                version: match[4].trim(),
            }
        }

        return null
    }

    private buildProductTestingResponse(
        product: ProductDescriptor,
        toolResults: ToolResult[],
        fallbackText: string
    ): string {
        const productState = this.extractHalProductState(toolResults, product)
        const verifiedHal = this.extractVerifiedHalCommands(toolResults)
        const productCommands = verifiedHal.filter(
            (command) => command === 'hal status' || command.startsWith(`hal ${product.halName}`)
        )

        const deployCommand = productCommands.find((command) => command === `hal ${product.halName} deploy`)
        const statusCommand = productCommands.find((command) => command === `hal ${product.halName} status`)
        const helpCommand = productCommands.find((command) => command === `hal ${product.halName} --help`)
            || productCommands.find((command) => command.startsWith(`hal ${product.halName} `) && command.endsWith('--help'))

        const lines: string[] = [`${product.displayName} testing plan:`, '']

        if (productState) {
            if (productState.state === 'running') {
                lines.push(
                    `${product.displayName} appears running at ${productState.endpoint} (version ${productState.version}).`
                )
            } else {
                lines.push(`${product.displayName} is not currently deployed in HAL.`)
            }
            lines.push('')
        }

        if (productState?.state !== 'running') {
            lines.push(`Start by bringing ${product.displayName} up, then verify the runtime before doing any deeper smoke test.`)
            lines.push('')

            if (deployCommand || statusCommand) {
                lines.push('```bash')
                if (deployCommand) {
                    lines.push(deployCommand)
                }
                if (statusCommand) {
                    lines.push(statusCommand)
                }
                lines.push('```')
                lines.push('')
            }

            if (product.accessDefaults?.portalUrl) {
                lines.push(`Portal URL after deploy: ${product.accessDefaults.portalUrl}`)
            }
            if (product.accessDefaults?.username) {
                lines.push(`Bootstrap username: ${product.accessDefaults.username}`)
            }
            if (product.accessDefaults?.password) {
                lines.push(`Bootstrap password: ${product.accessDefaults.password}`)
            }
            if (product.accessDefaults?.email) {
                lines.push(`Bootstrap email: ${product.accessDefaults.email}`)
            }
            if (product.accessDefaults?.notes?.length) {
                lines.push('')
                for (const note of product.accessDefaults.notes) {
                    lines.push(`- ${note}`)
                }
            }
            lines.push('')
        } else {
            lines.push(`A good first-pass validation for ${product.displayName} is ${product.smokeTestLabel}.`)
            lines.push('')

            if (statusCommand) {
                lines.push('Verified runtime check:')
                lines.push('')
                lines.push('```bash')
                lines.push(statusCommand)
                lines.push('```')
                lines.push('')
            }
        }

        lines.push('Suggested validation flow:')
        lines.push('')
        for (let index = 0; index < product.runningSteps.length; index += 1) {
            lines.push(`${index + 1}. ${product.runningSteps[index]}`)
        }

        if (helpCommand) {
            lines.push('')
            lines.push('If you want to explore HAL product-specific verbs, use:')
            lines.push('')
            lines.push('```bash')
            lines.push(helpCommand)
            lines.push('```')
        }

        lines.push('')
        lines.push('Relevant product documentation has been added to the docs panel when available.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildProductAccessResponse(
        product: ProductDescriptor,
        toolResults: ToolResult[],
        fallbackText: string
    ): string {
        const productState = this.extractHalProductState(toolResults, product)
        const deployHelpRaw = this.extractHalHelpRaw(toolResults, `${product.halName} deploy`)

        const defaultFromHelp = {
            username: this.extractDefaultFlagValue(deployHelpRaw, 'tfe-admin-username'),
            password: this.extractDefaultFlagValue(deployHelpRaw, 'tfe-admin-password'),
            email: this.extractDefaultFlagValue(deployHelpRaw, 'tfe-admin-email'),
        }

        const portalUrl = productState?.endpoint || product.accessDefaults?.portalUrl || 'not available'
        const username = defaultFromHelp.username || product.accessDefaults?.username || 'not available'
        const password = defaultFromHelp.password || product.accessDefaults?.password || 'not available'
        const email = defaultFromHelp.email || product.accessDefaults?.email

        const lines: string[] = [`${product.displayName} access details:`, '']

        if (productState?.state === 'running') {
            lines.push(`${product.displayName} is currently running.`)
            lines.push('')
        } else if (productState?.state === 'not-deployed') {
            lines.push(`${product.displayName} is not deployed yet, but these are the expected local access defaults after deploy.`)
            lines.push('')
        }

        lines.push(`- Portal URL: ${portalUrl}`)
        lines.push(`- Username: ${username}`)
        lines.push(`- Password: ${password}`)
        if (email) {
            lines.push(`- Email: ${email}`)
        }

        lines.push('')
        lines.push('Use these HAL commands:')
        lines.push('')
        lines.push('```bash')
        lines.push(`hal ${product.halName} deploy`)
        lines.push(`hal ${product.halName} status`)
        lines.push('```')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private extractHalHelpRaw(toolResults: ToolResult[], topic: string): string {
        for (const result of toolResults) {
            if (result.type !== 'system' || result.tool !== 'get_hal_help' || !result.success || !result.result || typeof result.result !== 'object') {
                continue
            }

            const value = result.result as { topic?: unknown; raw?: unknown }
            if (typeof value.topic === 'string' && value.topic.toLowerCase() === topic.toLowerCase() && typeof value.raw === 'string') {
                return value.raw
            }
        }

        return ''
    }

    private extractDefaultFlagValue(helpText: string, flagName: string): string | null {
        if (!helpText) return null
        const escaped = flagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`--${escaped}\\s+[^\\n]*\\(default\\s+"([^"]+)"\\)`, 'i')
        const match = helpText.match(regex)
        return match?.[1] || null
    }

    private buildAuthMethodsResponse(toolResults: ToolResult[], fallbackText: string): string {
        const authMethodsResult = toolResults.find(
            (result) => result.type === 'vault' && result.tool === 'list_auth_methods'
        )
        const mountsResult = toolResults.find(
            (result) => result.type === 'vault' && result.tool === 'list_mounts'
        )

        let methods: Array<{ path: string; type: string; description?: string }> = []

        const parseAuthMethodsPayload = (payload: unknown): Array<{ path: string; type: string; description?: string }> => {
            if (!payload) return []

            const normalized = typeof payload === 'string' ? (() => {
                try {
                    return JSON.parse(payload) as unknown
                } catch (_error) {
                    return null
                }
            })() : payload

            if (!normalized || typeof normalized !== 'object') {
                return []
            }

            if (Array.isArray(normalized)) {
                const parsed: Array<{ path: string; type: string; description?: string }> = []
                for (const item of normalized) {
                    if (!item || typeof item !== 'object') continue
                    const value = item as { path?: unknown; name?: unknown; type?: unknown; description?: unknown }
                    const path = typeof value.path === 'string'
                        ? value.path
                        : (typeof value.name === 'string' ? value.name : null)
                    const type = typeof value.type === 'string' ? value.type : null
                    const description = typeof value.description === 'string' ? value.description : undefined
                    if (!path || !type) continue
                    parsed.push({ path, type, description })
                }
                return parsed
            }

            const objectPayload = normalized as Record<string, unknown>
            const parsed: Array<{ path: string; type: string; description?: string }> = []
            for (const [path, details] of Object.entries(objectPayload)) {
                if (!details || typeof details !== 'object') continue
                const value = details as { type?: unknown; description?: unknown }
                if (typeof value.type !== 'string') continue
                const description = typeof value.description === 'string' ? value.description : undefined
                parsed.push({ path, type: value.type, description })
            }
            return parsed
        }

        if (authMethodsResult?.success) {
            methods = parseAuthMethodsPayload(authMethodsResult.result)
        }

        if (methods.length === 0 && mountsResult?.success) {
            const mounts = parseAuthMethodsPayload(mountsResult.result)
            methods = mounts.filter((mount) => mount.path.startsWith('auth/') || mount.type === 'token')
        }

        const lines: string[] = ['Vault authentication methods snapshot:', '']

        if (authMethodsResult?.success || mountsResult?.success) {
            if (methods.length > 0) {
                lines.push(`Found ${methods.length} authentication method${methods.length === 1 ? '' : 's'}:`)
                lines.push('')
                for (const method of methods.slice(0, 10)) {
                    const detail = method.description ? ` - ${method.description}` : ''
                    lines.push(`- ${method.path} (${method.type})${detail}`)
                }
            } else {
                lines.push('No non-token auth methods are currently enabled (or they are not visible from this namespace/context).')
            }
        } else {
            lines.push(`Unable to read auth methods right now (${authMethodsResult?.error || mountsResult?.error || 'unknown error'}).`)
        }

        lines.push('')
        lines.push('Verified command to confirm from Vault CLI:')
        lines.push('')
        lines.push('```bash')
        lines.push('vault auth list')
        lines.push('```')
        lines.push('')
        lines.push('If you want, I can inspect one method in detail (config, roles, and assigned policies).')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildVaultAuthTroubleshootingResponse(toolResults: ToolResult[], fallbackText: string): string {
        const halStatusResult = toolResults.find(
            (result) => result.type === 'system' && result.tool === 'get_hal_status'
        )
        const authMethodsResult = toolResults.find(
            (result) => result.type === 'vault' && result.tool === 'list_auth_methods'
        )

        const methods: Array<{ path: string; type: string }> = []
        if (authMethodsResult?.success) {
            const payload = authMethodsResult.result
            const normalized = typeof payload === 'string' ? (() => {
                try {
                    return JSON.parse(payload) as unknown
                } catch (_error) {
                    return null
                }
            })() : payload

            if (normalized && typeof normalized === 'object') {
                if (Array.isArray(normalized)) {
                    for (const item of normalized) {
                        if (!item || typeof item !== 'object') continue
                        const value = item as { path?: unknown; name?: unknown; type?: unknown }
                        const path = typeof value.path === 'string'
                            ? value.path
                            : (typeof value.name === 'string' ? value.name : null)
                        const type = typeof value.type === 'string' ? value.type : null
                        if (!path || !type) continue
                        methods.push({ path, type })
                    }
                } else {
                    const objectPayload = normalized as Record<string, unknown>
                    for (const [path, details] of Object.entries(objectPayload)) {
                        if (!details || typeof details !== 'object') continue
                        const value = details as { type?: unknown }
                        if (typeof value.type !== 'string') continue
                        methods.push({ path, type: value.type })
                    }
                }
            }
        }

        const halRaw = (halStatusResult?.result && typeof halStatusResult.result === 'object')
            ? ((halStatusResult.result as { raw?: unknown }).raw)
            : null

        let vaultRunning: boolean | null = null
        if (typeof halRaw === 'string' && halRaw.length > 0) {
            for (const line of halRaw.split('\n')) {
                const match = line.trim().match(/^(?:⚪|🟢)\s+Vault\s+(Not Deployed|Running)\s{2,}.+$/i)
                if (!match) continue
                vaultRunning = /running/i.test(match[1])
                break
            }
        }

        const lines: string[] = ['Vault auth troubleshooting sequence:', '']

        if (vaultRunning === false) {
            lines.push('Vault is not currently deployed. Bring it up first, then start auth diagnostics.')
            lines.push('')
            lines.push('```bash')
            lines.push('hal vault deploy')
            lines.push('hal vault status')
            lines.push('```')
            lines.push('')
        } else if (vaultRunning === true) {
            lines.push('Vault runtime looks up. Start with auth surface discovery, then narrow to specific methods and roles.')
            lines.push('')
        }

        lines.push('1. Confirm runtime and baseline health:')
        lines.push('')
        lines.push('```bash')
        lines.push('hal vault status')
        lines.push('vault status')
        lines.push('```')
        lines.push('')

        lines.push('2. Enumerate enabled auth methods:')
        lines.push('')
        lines.push('```bash')
        lines.push('vault auth list')
        lines.push('```')

        if (methods.length > 0) {
            lines.push('')
            lines.push(`Detected auth mounts (${methods.length}):`)
            for (const method of methods.slice(0, 8)) {
                lines.push(`- ${method.path} (${method.type})`)
            }
        }

        lines.push('')
        lines.push('3. Drill into the failing method configuration and roles (replace with your mount):')
        lines.push('')
        lines.push('```bash')
        lines.push('vault read auth/<mount>/config')
        lines.push('vault list auth/<mount>/role')
        lines.push('vault read auth/<mount>/role/<role-name>')
        lines.push('```')
        lines.push('')

        lines.push('4. Verify identity and policy linkage for the caller token:')
        lines.push('')
        lines.push('```bash')
        lines.push('vault token lookup')
        lines.push('vault read identity/entity/id/<entity-id>')
        lines.push('```')
        lines.push('')

        lines.push('5. Correlate failures with audit events by mount type (approle/oidc/jwt/ldap/userpass) and request IDs.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private detectVaultFeatureIntent(query: string): VaultFeatureScenarioKey | null {
        return detectVaultFeatureScenarioIntent(query)
    }

    private buildVaultFeatureScenarioResponse(
        feature: VaultFeatureScenarioKey,
        toolResults: ToolResult[],
        fallbackText: string
    ): string {
        const scenario = VAULT_FEATURE_SCENARIOS[feature]
        const verifiedHal = this.extractVerifiedHalCommands(toolResults)
        const featureCommands = verifiedHal.filter((command) => command.startsWith(`hal vault ${scenario.featureToken}`))
        const statusCommand = verifiedHal.find((command) => command === 'hal vault status') || 'hal vault status'
        const helpCommand =
            featureCommands.find((command) => command.endsWith(' --help'))
            || `hal vault ${scenario.featureToken} --help`
        const enableCommand =
            featureCommands.find((command) => /\s(-e|--enable)(\s|$)/.test(command))
            || `hal vault ${scenario.featureToken} -e`

        const lines: string[] = [
            scenario.title,
            '',
            scenario.description,
            '',
            '1. Check runtime first:',
            '',
            '```bash',
            statusCommand,
            '```',
            '',
            '2. List HAL capability surface from local help:',
            '',
            '```bash',
            helpCommand,
            '```',
        ]

        if (featureCommands.length > 0) {
            lines.push('')
            lines.push('Verified HAL commands from local tool output:')
            for (const command of featureCommands.slice(0, 8)) {
                lines.push(`- ${command}`)
            }
        }

        lines.push('')
        lines.push('3. Configure/enable feature:')
        lines.push('')
        lines.push('```bash')
        lines.push(enableCommand)
        lines.push('```')
        lines.push('')
        lines.push('4. Validate resulting Vault auth configuration:')
        lines.push('')
        lines.push('```bash')
        lines.push('vault auth list')
        lines.push(`vault read auth/${scenario.authMount}/config`)
        lines.push(`vault list auth/${scenario.authMount}/role`)
        lines.push(`vault read auth/${scenario.authMount}/role/${scenario.roleHint}`)
        lines.push('```')
        lines.push('')
        lines.push('5. Troubleshoot failures by checking role constraints and audit events for the auth mount type.')
        lines.push('Relevant docs are added to the documentation panel when available.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private detectNonVaultFeatureIntent(
        query: string,
        product: ProductDescriptor
    ): NonVaultFeatureScenarioKey | null {
        return detectNonVaultFeatureScenarioIntent(query, product.halName)
    }

    private detectObservabilityIncidentIntent(query: string): ObservabilityIncidentScenarioKey | null {
        return detectObservabilityIncidentScenarioIntent(query)
    }

    private getNonVaultHelpTopic(
        product: ProductDescriptor,
        featureIntent: NonVaultFeatureScenarioKey | null
    ): string {
        if (featureIntent) {
            return NON_VAULT_FEATURE_SCENARIOS[featureIntent].helpTopic
        }
        return product.halName
    }

    private buildNonVaultFeatureScenarioResponse(
        product: ProductDescriptor,
        featureIntent: NonVaultFeatureScenarioKey,
        toolResults: ToolResult[],
        fallbackText: string
    ): string {
        const scenario = NON_VAULT_FEATURE_SCENARIOS[featureIntent]
        const verifiedHal = this.extractVerifiedHalCommands(toolResults)
        const productCommands = verifiedHal.filter((command) => command.startsWith(`hal ${product.halName}`))
        const statusCommand = productCommands.find((command) => command === `hal ${product.halName} status`) || `hal ${product.halName} status`
        const helpTopic = scenario.helpTopic
        const helpCommand = productCommands.find((command) => command.endsWith(' --help')) || `hal ${helpTopic} --help`
        const deployCommand = productCommands.find((command) => command === `hal ${product.halName} deploy`) || `hal ${product.halName} deploy`

        const lines: string[] = [`${scenario.title}:`, '', scenario.description, '']

        lines.push('1. Verify runtime state first:')
        lines.push('')
        lines.push('```bash')
        lines.push(statusCommand)
        lines.push('```')
        lines.push('')

        lines.push('2. List product capability surface from HAL help:')
        lines.push('')
        lines.push('```bash')
        lines.push(helpCommand)
        lines.push('```')

        if (productCommands.length > 0) {
            lines.push('')
            lines.push(`Verified HAL ${product.displayName} commands from local tool output:`)
            for (const command of productCommands.slice(0, 8)) {
                lines.push(`- ${command}`)
            }
        }

        lines.push('')
        lines.push('3. Execute baseline lifecycle commands:')
        lines.push('')
        lines.push('```bash')
        lines.push(deployCommand)
        lines.push(statusCommand)
        lines.push('```')
        lines.push('')

        lines.push('4. Validation checklist:')
        lines.push('')
        for (const item of scenario.validationChecklist) {
            lines.push(`- ${item}`)
        }

        if (scenario.troubleshootingChecklist.length > 0) {
            lines.push('')
            lines.push('5. Fault isolation checklist:')
            lines.push('')
            for (const item of scenario.troubleshootingChecklist) {
                lines.push(`- ${item}`)
            }
        }

        lines.push('')
        lines.push('Relevant product documentation has been added to the docs panel when available.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildProductTroubleshootingResponse(
        product: ProductDescriptor,
        toolResults: ToolResult[],
        fallbackText: string
    ): string {
        const productState = this.extractHalProductState(toolResults, product)
        const verifiedHal = this.extractVerifiedHalCommands(toolResults)
        const productCommands = verifiedHal.filter((command) => command.startsWith(`hal ${product.halName}`))
        const statusCommand = productCommands.find((command) => command === `hal ${product.halName} status`) || `hal ${product.halName} status`
        const deployCommand = productCommands.find((command) => command === `hal ${product.halName} deploy`) || `hal ${product.halName} deploy`
        const helpCommand = productCommands.find((command) => command.endsWith(' --help')) || `hal ${product.halName} --help`

        const lines: string[] = [`${product.displayName} troubleshooting sequence:`, '']

        if (productState?.state === 'not-deployed') {
            lines.push(`${product.displayName} is currently not deployed. Start with lifecycle recovery:`)
            lines.push('')
            lines.push('```bash')
            lines.push(deployCommand)
            lines.push(statusCommand)
            lines.push('```')
            lines.push('')
        } else if (productState?.state === 'running') {
            lines.push(`${product.displayName} is running at ${productState.endpoint}. Proceed with workflow-level diagnostics.`)
            lines.push('')
        }

        lines.push('1. Re-check runtime and available product verbs:')
        lines.push('')
        lines.push('```bash')
        lines.push(statusCommand)
        lines.push(helpCommand)
        lines.push('```')
        lines.push('')

        lines.push('2. Validate the minimum successful workflow:')
        for (let index = 0; index < product.runningSteps.length; index += 1) {
            lines.push(`${index + 1}. ${product.runningSteps[index]}`)
        }
        lines.push('')

        if (product.halName === 'boundary') {
            lines.push('3. For Boundary incidents, isolate auth, target reachability, and worker/controller path failures.')
        } else if (product.halName === 'terraform') {
            lines.push('3. For TFE incidents, isolate platform runtime issues from workspace/run pipeline issues.')
        } else if (product.halName === 'nomad') {
            lines.push('3. For Nomad incidents, isolate scheduler placement failures from job spec/log issues.')
        } else if (product.halName === 'consul') {
            lines.push('3. For Consul incidents, isolate server reachability from catalog and health-check failures.')
        } else if (product.halName === 'obs') {
            lines.push('3. For Observability incidents, isolate by stack layer in this order: Grafana UI, Prometheus targets, Loki ingestion/query.')
            lines.push('4. Verify one known-good data path end to end (recent deploy event visible in logs and metrics).')
        }

        lines.push('')
        lines.push('Relevant product documentation has been added to the docs panel when available.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildObservabilityIncidentResponse(
        incident: ObservabilityIncidentScenarioKey,
        toolResults: ToolResult[],
        fallbackText: string
    ): string {
        const scenario = OBS_INCIDENT_SCENARIOS[incident]
        const verifiedHal = this.extractVerifiedHalCommands(toolResults)
        const obsCommands = verifiedHal.filter((command) => command.startsWith('hal obs'))
        const statusCommand = obsCommands.find((command) => command === 'hal obs status') || 'hal obs status'
        const helpCommand = obsCommands.find((command) => command === 'hal obs --help') || 'hal obs --help'
        const deployCommand = obsCommands.find((command) => command === 'hal obs deploy') || 'hal obs deploy'

        const lines: string[] = [scenario.title, '', scenario.description, '']

        lines.push('1. Confirm stack runtime and available actions:')
        lines.push('')
        lines.push('```bash')
        lines.push(statusCommand)
        lines.push(helpCommand)
        lines.push('```')
        lines.push('')

        lines.push('2. Isolation checklist:')
        lines.push('')
        for (const item of scenario.isolationChecklist) {
            lines.push(`- ${item}`)
        }

        lines.push('')
        lines.push('3. Recovery checklist:')
        lines.push('')
        for (const item of scenario.recoveryChecklist) {
            lines.push(`- ${item}`)
        }

        lines.push('')
        lines.push('```bash')
        lines.push(deployCommand)
        lines.push(statusCommand)
        lines.push('```')

        lines.push('')
        lines.push('Relevant product documentation has been added to the docs panel when available.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildReplicationHealthResponse(toolResults: ToolResult[], fallbackText: string): string {
        const clusterResult = toolResults.find(
            (result) => result.type === 'vault' && result.tool === 'read_cluster_health'
        )
        const replicationResult = toolResults.find(
            (result) => result.type === 'vault' && result.tool === 'read_replication_status'
        )

        const clusterError = clusterResult?.error || 'not available'
        const replicationError = replicationResult?.error || 'not available'
        const clusterUnavailable = /tool not found/i.test(clusterError)
        const replicationUnavailable = /tool not found/i.test(replicationError)

        const lines: string[] = ['Vault replication and HA snapshot:', '']

        if (clusterResult?.success) {
            lines.push('- Cluster health check: success')
        } else {
            lines.push(
                clusterUnavailable
                    ? '- Cluster health check: unavailable in current Vault MCP server build'
                    : `- Cluster health check: failed (${clusterError})`
            )
        }

        if (replicationResult?.success) {
            lines.push('- Replication status check: success')
        } else {
            lines.push(
                replicationUnavailable
                    ? '- Replication status check: unavailable in current Vault MCP server build'
                    : `- Replication status check: failed (${replicationError})`
            )
        }

        lines.push('')
        lines.push('Verified next checks:')
        lines.push('')
        lines.push('```bash')
        lines.push('hal vault status')
        lines.push('```')
        lines.push('')
        lines.push('```bash')
        lines.push('vault read sys/health')
        lines.push('```')
        lines.push('')
        lines.push('If you want, I can drill into leader state, autopilot node health, and replication mode details.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildLeaseActivityResponse(toolResults: ToolResult[], fallbackText: string): string {
        const leasesResult = toolResults.find(
            (result) => result.type === 'vault' && result.tool === 'list_leases'
        )
        const leasesError = leasesResult?.error || 'not available'
        const leasesUnavailable = /tool not found/i.test(leasesError)

        let leaseKeys: string[] = []
        if (leasesResult?.success && leasesResult.result && typeof leasesResult.result === 'string') {
            try {
                const parsed = JSON.parse(leasesResult.result) as { keys?: unknown }
                if (Array.isArray(parsed.keys)) {
                    leaseKeys = parsed.keys.filter((item): item is string => typeof item === 'string')
                }
            } catch (_error) {
                leaseKeys = []
            }
        }

        const lines: string[] = ['Vault lease activity snapshot:', '']

        if (leasesResult?.success) {
            lines.push('- Lease listing check: success')
            if (leaseKeys.length > 0) {
                lines.push(`- Lease paths (${leaseKeys.length}): ${leaseKeys.slice(0, 8).join(', ')}`)
            } else {
                lines.push('- No top-level lease paths were returned in the current context.')
            }
        } else {
            lines.push(
                leasesUnavailable
                    ? '- Lease listing check: unavailable in current Vault MCP server build'
                    : `- Lease listing check: failed (${leasesError})`
            )
        }

        lines.push('')
        lines.push('Verified command to inspect lease hierarchy:')
        lines.push('')
        lines.push('```bash')
        lines.push('vault list sys/leases/lookup')
        lines.push('```')
        lines.push('')
        lines.push('If you want, I can inspect a specific lease ID and break down TTL and renewability.')

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildOidcNextStepsResponse(toolResults: ToolResult[], fallbackText: string): string {
        const verifiedHal = this.extractVerifiedHalCommands(toolResults)
        const hasHalOidcEnable = verifiedHal.some((cmd) => cmd.toLowerCase() === 'hal vault oidc -e')

        const contextResult = toolResults.find(
            (result) => result.type === 'system' && result.tool === 'get_vault_cli_context' && result.success
        )

        const context = (contextResult?.result && typeof contextResult.result === 'object')
            ? (contextResult.result as { vaultAddr?: unknown; vaultToken?: unknown })
            : null

        const vaultAddr = typeof context?.vaultAddr === 'string' ? context.vaultAddr : 'http://vault.localhost:8200'
        const vaultToken = typeof context?.vaultToken === 'string' ? context.vaultToken : null

        const lines: string[] = [
            'OIDC next steps (HAL first, then Vault internals):',
            '',
            '1. Deploy/configure OIDC through HAL:',
            '',
            '```bash',
            hasHalOidcEnable ? 'hal vault oidc -e' : 'hal vault oidc --help',
            '```',
            '',
            '2. Validate Vault runtime and feature state:',
            '',
            '```bash',
            'hal vault status',
            '```',
            '',
            '3. Under the hood with Vault CLI (same local sandbox context):',
            '',
            '```bash',
            `export VAULT_ADDR=${vaultAddr}`,
            ...(vaultToken ? [`export VAULT_TOKEN=${vaultToken}`] : ['# set VAULT_TOKEN from your local HAL context']),
            'vault auth list',
            'vault read auth/oidc/config',
            '```',
            '',
            '4. Optional behavior verification with audit logs:',
            '',
            '```bash',
            'hal status',
            '```',
            '',
            'Check the docs panel for the official OIDC and health endpoint references.',
        ]

        const assembled = this.removeEmptyCodeBlocks(lines.join('\n'))
        return assembled.length > 0 ? assembled : fallbackText
    }

    private buildVaultOverviewResponse(toolResults: ToolResult[], fallbackText: string): string {
        const halStatusResult = toolResults.find(
            (result) => result.type === 'system' && result.tool === 'get_hal_status'
        )
        const mountsResult = toolResults.find(
            (result) => result.type === 'vault' && result.tool === 'list_mounts'
        )

        const halRaw = (halStatusResult?.result && typeof halStatusResult.result === 'object')
            ? ((halStatusResult.result as { raw?: unknown }).raw)
            : null

        const halRawText = typeof halRaw === 'string' ? halRaw : ''
        const vaultLineMatch = halRawText.match(/^[^\n]*\bVault\b\s+([A-Za-z ]+)\s+(https?:\/\/[^\s]+)\s+(.+)$/m)
        const vaultRuntimeState = vaultLineMatch?.[1]?.trim() || null
        const vaultEndpoint = vaultLineMatch?.[2]?.trim() || 'http://vault.localhost:8200'
        const vaultVersion = vaultLineMatch?.[3]?.trim() || 'unknown'

        let parsedMounts: Array<{ name: string; type: string }> = []
        const mountsPayload = mountsResult?.result
        if (typeof mountsPayload === 'string') {
            try {
                const parsed = JSON.parse(mountsPayload) as Array<{ name?: unknown; type?: unknown }>
                parsedMounts = parsed
                    .filter((mount) => typeof mount?.name === 'string' && typeof mount?.type === 'string')
                    .map((mount) => ({ name: mount.name as string, type: mount.type as string }))
            } catch (_error) {
                parsedMounts = []
            }
        }

        const lines: string[] = ['Vault instance snapshot (HAL first, Vault MCP second):', '']

        if (halStatusResult?.success) {
            lines.push(
                `Vault appears ${vaultRuntimeState ? vaultRuntimeState.toLowerCase() : 'available'} at ${vaultEndpoint} (version ${vaultVersion}).`
            )
            lines.push('')
        }

        if (halStatusResult?.success) {
            lines.push('- HAL runtime check: success')
            lines.push('- Verified command to inspect Vault runtime:')
            lines.push('')
            lines.push('```bash')
            lines.push('hal vault status')
            lines.push('```')
            lines.push('')
        } else {
            lines.push(`- HAL runtime check: failed (${halStatusResult?.error || 'unknown error'})`)
            lines.push('')
        }

        if (mountsResult?.success) {
            lines.push('- Vault MCP mounts check: success')
            if (parsedMounts.length > 0) {
                const mountSummary = parsedMounts
                    .slice(0, 8)
                    .map((mount) => `${mount.name} (${mount.type})`)
                    .join(', ')
                lines.push(`- Mount points (${parsedMounts.length}): ${mountSummary}`)
            }
        } else {
            lines.push(`- Vault MCP mounts check: failed (${mountsResult?.error || 'not available'})`)
        }

        lines.push('')
        lines.push('Useful health endpoint reference is available in the docs panel (`sys/health`).')
        lines.push('If you want, I can drill down next into auth methods, lease activity, or replication/HA health.')

        const assembled = lines.join('\n').trim()
        return assembled.length > 0 ? assembled : fallbackText
    }

    private enforceVaultCliGuardrails(text: string, query: string, toolResults: ToolResult[]): string {
        const lower = query.toLowerCase()
        const asksAuthMethodList = /auth method|auth methods|auth list/.test(lower)
        const asksForVaultCli = /vault cli|outside hal scope|curl|vault command|vault api/.test(lower)

        if (!asksForVaultCli || !asksAuthMethodList) {
            return text
        }

        const contextResult = toolResults.find(
            (result) => result.type === 'system' && result.tool === 'get_vault_cli_context' && result.success
        )

        let vaultAddr = 'http://vault.localhost:8200'
        let vaultToken: string | null = null
        if (contextResult?.result && typeof contextResult.result === 'object') {
            const value = contextResult.result as { vaultAddr?: unknown; vaultToken?: unknown }
            if (typeof value.vaultAddr === 'string' && value.vaultAddr.length > 0) {
                vaultAddr = value.vaultAddr
            }
            if (typeof value.vaultToken === 'string' && value.vaultToken.length > 0) {
                vaultToken = value.vaultToken
            }
        }

        const lines = [
            vaultToken
                ? 'Use this verified Vault CLI context and command:'
                : 'VAULT_TOKEN is not currently available from the active session. Authenticate first, then run:',
            '',
            '```bash',
            `export VAULT_ADDR=${vaultAddr}`,
            ...(vaultToken ? [`export VAULT_TOKEN=${vaultToken}`] : []),
            'vault auth list',
            '```',
        ]

        return lines.join('\n')
    }

    private replaceVaultCliPlaceholders(text: string, query: string, toolResults: ToolResult[]): string {
        const lower = query.toLowerCase()
        const asksForVaultCli = /vault cli|outside hal scope|curl|vault command|vault api/.test(lower)
        if (!asksForVaultCli) return text

        const contextResult = toolResults.find(
            (result) => result.type === 'system' && result.tool === 'get_vault_cli_context' && result.success
        )

        if (!contextResult || !contextResult.result || typeof contextResult.result !== 'object') {
            return text
        }

        const value = contextResult.result as { vaultAddr?: unknown; vaultToken?: unknown; exportCommands?: unknown }
        const vaultAddr = typeof value.vaultAddr === 'string' ? value.vaultAddr : null
        const vaultToken = typeof value.vaultToken === 'string' ? value.vaultToken : null

        let cleaned = text
            .replace(/<your_vault_address>/gi, vaultAddr || 'http://vault.localhost:8200')
            .replace(/<your_vault_token>/gi, vaultToken || 'TOKEN_NOT_AVAILABLE')
            .replace(/your-generated-token-here/gi, vaultToken || 'TOKEN_NOT_AVAILABLE')

        if (!vaultToken) {
            cleaned = cleaned.replace(/export\s+VAULT_TOKEN\s*=\s*TOKEN_NOT_AVAILABLE\s*\n?/gi, '')
            if (!/VAULT_TOKEN is not currently available/i.test(cleaned)) {
                cleaned = [
                    'VAULT_TOKEN is not currently available from the active session. Authenticate first, then re-run the command set.',
                    '',
                    cleaned,
                ].join('\n')
            }
        }

        return cleaned
    }

    private injectVaultCliContext(text: string, query: string, toolResults: ToolResult[]): string {
        const lower = query.toLowerCase()
        const asksForVaultCli = /vault cli|outside hal scope|curl|vault command|vault api/.test(lower)
        if (!asksForVaultCli) return text

        const contextResult = toolResults.find(
            (result) => result.type === 'system' && result.tool === 'get_vault_cli_context' && result.success
        )

        if (!contextResult || !contextResult.result || typeof contextResult.result !== 'object') {
            return text
        }

        const value = contextResult.result as { exportCommands?: unknown }
        const exportCommands = Array.isArray(value.exportCommands)
            ? value.exportCommands.filter((cmd): cmd is string => typeof cmd === 'string' && cmd.length > 0)
            : []

        if (exportCommands.length === 0) {
            return text
        }

        const hasVaultAddr = /export\s+VAULT_ADDR=/i.test(text)
        const hasVaultToken = /export\s+VAULT_TOKEN=/i.test(text)
        if (hasVaultAddr || hasVaultToken) {
            return text
        }

        return [
            'Use this Vault CLI context first:',
            '',
            '```bash',
            ...exportCommands,
            '```',
            '',
            text,
        ].join('\n')
    }

    private extractVerifiedHalCommands(toolResults: ToolResult[]): string[] {
        const commands = new Set<string>()

        for (const result of toolResults) {
            if (result.type !== 'system' || !result.success || !result.result || typeof result.result !== 'object') {
                continue
            }

            const value = result.result as { recommendedCommands?: unknown }
            if (!Array.isArray(value.recommendedCommands)) {
                continue
            }

            for (const command of value.recommendedCommands) {
                if (typeof command === 'string' && command.trim().startsWith('hal ')) {
                    const normalized = command.trim().replace(/\s+/g, ' ')
                    if (/[\[\]<>]/.test(normalized)) {
                        continue
                    }
                    commands.add(normalized)
                }
            }
        }

        return Array.from(commands)
    }

    private normalizeHalCommandToken(command: string): string {
        return command
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/[.,;:!?]+$/g, '')
    }

    private coerceToVerifiedHalCommand(command: string, verified: string[]): string | null {
        const normalized = this.normalizeHalCommandToken(command)
        const verifiedSet = new Set(verified.map((item) => this.normalizeHalCommandToken(item).toLowerCase()))
        const normalizedLower = normalized.toLowerCase()

        if (verifiedSet.has(normalizedLower)) {
            return normalized
        }

        // If a command extends a verified command with extra unverified flags/args,
        // keep the verified base command and drop the extra suffix.
        const baseMatch = verified.find((item) =>
            normalizedLower.startsWith(`${this.normalizeHalCommandToken(item).toLowerCase()} `)
        )

        return baseMatch ? this.normalizeHalCommandToken(baseMatch) : null
    }

    private detectHalHelpTopic(query: string): string | null {
        const lower = query.toLowerCase()

        if (lower.includes('vault jwt') || lower.includes(' jwt')) return 'vault jwt'
        if (lower.includes('vault oidc') || lower.includes(' oidc')) return 'vault oidc'
        if (lower.includes('vault ldap') || lower.includes(' ldap')) return 'vault ldap'
        if (lower.includes('vault k8s') || lower.includes(' kubernetes') || lower.includes(' k8s')) return 'vault k8s'
        if (lower.includes('boundary ssh') || (lower.includes('boundary') && /\bssh\b/.test(lower))) return 'boundary ssh'
        if (lower.includes('terraform workspace') || ((lower.includes('terraform') || lower.includes('tfe')) && /\bworkspace\b/.test(lower))) return 'terraform workspace'
        if (lower.includes('terraform token') || ((lower.includes('terraform') || lower.includes('tfe')) && /\btoken\b/.test(lower))) return 'terraform token'

        const primaryProduct = this.detectPrimaryProductWithHistory(query)
        if (primaryProduct) return primaryProduct.halName

        if (lower.includes('vault')) return 'vault'
        if (lower.includes('hal')) return ''

        return null
    }

    private async ensureGuardrailContext(
        query: string,
        toolCalls: ToolCall[],
        toolResults: ToolResult[]
    ): Promise<void> {
        const lower = query.toLowerCase()
        const primaryProduct = this.detectPrimaryProductWithHistory(query)
        const hasVerifiedHal = this.extractVerifiedHalCommands(toolResults).length > 0
        const topic = this.detectHalHelpTopic(query)
        const featureTopic = /\bjwt\b|\boidc\b|\bldap\b|\bk8s\b/.test(lower)
        const asksProductTesting = !!primaryProduct && isProductTestingIntent(query)
        const asksProductSetup = !!primaryProduct && isProductSetupIntent(query)
        const asksProductAccess =
            !!primaryProduct && /\b(url|portal|login|credential|credentials|username|password|auth|authenticate|sign in|access)\b/i.test(query)
        const productFeatureIntent =
            primaryProduct && primaryProduct.id !== 'vault'
                ? this.detectNonVaultFeatureIntent(query, primaryProduct)
                : null
        const asksProductTroubleshooting =
            !!primaryProduct && primaryProduct.id !== 'vault' && /troubleshoot|troubleshooting|debug|not working|failing|failure|error|issue/.test(lower)
        const asksObsIncident =
            !!primaryProduct &&
            primaryProduct.halName === 'obs' &&
            (/datasource|data source|dashboard|panel|prometheus|loki|grafana|no data|empty|missing/.test(lower))

        const mentionsHalOrHalFeatures =
            /\bhal\b/.test(lower) || /\bjwt\b|\boidc\b|\bldap\b|\bk8s\b/.test(lower)

        const alreadyCalledHalHelp = toolCalls.some(
            (call) => call.type === 'system' && call.tool === 'get_hal_help'
        )

        if (mentionsHalOrHalFeatures && (!hasVerifiedHal || featureTopic) && !alreadyCalledHalHelp) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_help',
                arguments: topic ? { topic } : {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const asksForVaultCli =
            /vault cli|outside hal scope|curl|vault command|vault api/.test(lower)
        const asksOidcNextSteps = /\boidc\b/.test(lower) && /next steps|idp|identity provider/.test(lower)

        const alreadyHasVaultContext = toolCalls.some(
            (call) => call.type === 'system' && call.tool === 'get_vault_cli_context'
        )

        if ((asksForVaultCli || asksOidcNextSteps) && !alreadyHasVaultContext) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_vault_cli_context',
                arguments: {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const asksVaultOverview =
            /what can you tell me about.*vault|tell me about.*vault|vault instance|vault status|health of vault|vault health/.test(lower)

        const asksVaultAuthMethods =
            /authentication methods|auth methods|auth method list|list auth methods|vault auth list/.test(lower)
        const asksVaultAuthTroubleshooting =
            /vault auth troubleshooting|auth troubleshooting|troubleshoot(ing)?\s+auth|auth\s+fail(ing|ure)?|login\s+fail(ing|ure)?/.test(lower)
        const asksVaultFeatureConfig = /configure|configuration|enable|setup|set up|deploy|how do i|how to|capabilities|outputs/.test(lower)
            && /\bjwt\b|\boidc\b|\bldap\b|\bk8s\b|\bkubernetes\b/.test(lower)
        const asksReplicationHealth =
            /replication|ha health|cluster health|raft|autopilot/.test(lower)
        const asksLeaseActivity =
            /lease activity|lease status|active leases|list leases|leases/.test(lower)

        const alreadyHasHalStatus = toolCalls.some(
            (call) => call.type === 'system' && call.tool === 'get_hal_status'
        )

        const alreadyHasProductHalStatus = !!primaryProduct && toolCalls.some(
            (call) =>
                call.type === 'system' &&
                call.tool === 'get_hal_status' &&
                typeof call.arguments.product === 'string' &&
                call.arguments.product.toLowerCase() === primaryProduct.halName
        )

        if (primaryProduct && primaryProduct.id !== 'vault' && !alreadyHasProductHalStatus) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_status',
                arguments: { product: primaryProduct.halName },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (
            primaryProduct &&
            primaryProduct.id !== 'vault' &&
            (asksProductTesting || asksProductSetup) &&
            !toolCalls.some((call) => call.type === 'system' && call.tool === 'get_hal_help')
        ) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_help',
                arguments: { topic: primaryProduct.halName },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (
            primaryProduct &&
            primaryProduct.id !== 'vault' &&
            (asksProductTroubleshooting || !!productFeatureIntent) &&
            !toolCalls.some((call) => call.type === 'system' && call.tool === 'get_hal_help')
        ) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_help',
                arguments: { topic: this.getNonVaultHelpTopic(primaryProduct, productFeatureIntent) },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (
            primaryProduct &&
            primaryProduct.halName === 'obs' &&
            asksObsIncident &&
            !toolCalls.some((call) => call.type === 'system' && call.tool === 'get_hal_help')
        ) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_help',
                arguments: { topic: 'obs' },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (
            primaryProduct &&
            primaryProduct.halName === 'obs' &&
            asksObsIncident &&
            !toolCalls.some((call) => {
                if (call.type !== 'system' || call.tool !== 'get_hal_status') return false
                const argProduct = typeof call.arguments.product === 'string' ? call.arguments.product.toLowerCase() : ''
                const argCommand = typeof call.arguments.command === 'string' ? call.arguments.command.toLowerCase() : ''
                return argProduct === 'obs' || /\bobs\b/.test(argCommand)
            })
        ) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_status',
                arguments: { product: 'obs' },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const alreadyHasProductDeployHelp = !!primaryProduct && toolCalls.some(
            (call) =>
                call.type === 'system' &&
                call.tool === 'get_hal_help' &&
                typeof call.arguments.topic === 'string' &&
                call.arguments.topic.toLowerCase() === `${primaryProduct.halName} deploy`
        )

        if (primaryProduct && primaryProduct.id !== 'vault' && asksProductAccess && !alreadyHasProductDeployHelp) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_help',
                arguments: { topic: `${primaryProduct.halName} deploy` },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (asksVaultOverview && !alreadyHasHalStatus) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_status',
                arguments: { product: 'vault' },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const alreadyHasMounts = toolCalls.some(
            (call) => call.type === 'vault' && call.tool === 'list_mounts'
        )

        if (asksVaultOverview && !alreadyHasMounts) {
            const call: ToolCall = {
                type: 'vault',
                tool: 'list_mounts',
                arguments: {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const alreadyHasAuthMethods = toolCalls.some(
            (call) => call.type === 'vault' && call.tool === 'list_auth_methods'
        )

        if (asksVaultAuthMethods && !alreadyHasAuthMethods) {
            const call: ToolCall = {
                type: 'vault',
                tool: 'list_auth_methods',
                arguments: {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (asksVaultAuthTroubleshooting && !alreadyHasHalStatus) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_status',
                arguments: { product: 'vault' },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (asksVaultAuthTroubleshooting && !alreadyHasAuthMethods) {
            const call: ToolCall = {
                type: 'vault',
                tool: 'list_auth_methods',
                arguments: {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (asksVaultFeatureConfig && !alreadyHasHalStatus) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_status',
                arguments: { product: 'vault' },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const alreadyHasClusterHealth = toolCalls.some(
            (call) => call.type === 'vault' && call.tool === 'read_cluster_health'
        )
        if (asksReplicationHealth && !alreadyHasClusterHealth) {
            const call: ToolCall = {
                type: 'vault',
                tool: 'read_cluster_health',
                arguments: {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const alreadyHasReplicationStatus = toolCalls.some(
            (call) => call.type === 'vault' && call.tool === 'read_replication_status'
        )
        if (asksReplicationHealth && !alreadyHasReplicationStatus) {
            const call: ToolCall = {
                type: 'vault',
                tool: 'read_replication_status',
                arguments: {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        const alreadyHasLeases = toolCalls.some(
            (call) => call.type === 'vault' && call.tool === 'list_leases'
        )
        if (asksLeaseActivity && !alreadyHasLeases) {
            const call: ToolCall = {
                type: 'vault',
                tool: 'list_leases',
                arguments: {},
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

        if (asksOidcNextSteps && !toolCalls.some((call) => call.type === 'system' && call.tool === 'get_hal_help')) {
            const call: ToolCall = {
                type: 'system',
                tool: 'get_hal_help',
                arguments: { topic: 'vault oidc' },
            }
            toolCalls.push(call)
            const result = await this.executionEngine.executeTool(call)
            toolResults.push(result)
        }

    }

    private enforceVerifiedHalCommands(text: string, toolResults: ToolResult[]): string {
        const verified = this.extractVerifiedHalCommands(toolResults)
        let workingText = text

        // Normalize inline code commands such as `hal tfe deploy --local`.
        workingText = workingText.replace(/`(hal\s+[^`]+)`/gi, (_full, rawCommand) => {
            const coerced = this.coerceToVerifiedHalCommand(rawCommand, verified)
            if (coerced) {
                return `\`${coerced}\``
            }
            return ''
        })

        const lines = workingText.split('\n')
        const commandLinePattern = /^\s*(?:[-*]\s+)?(?:`)?(?:\$\s*)?(hal\s+[^`]+?)(?:`)?\s*$/i

        const normalizedLines = lines
            .map((line) => {
                const match = line.match(commandLinePattern)
                if (!match) {
                    return line
                }

                const rawCommand = match[1]
                const coerced = this.coerceToVerifiedHalCommand(rawCommand, verified)
                if (!coerced) {
                    return ''
                }

                return line.replace(rawCommand, coerced)
            })
            .filter((line) => line.trim().length > 0)

        const halLines = normalizedLines
            .map((line) => line.trim())
            .filter((line) => /^hal\s+/i.test(line))

        if (verified.length === 0) {
            if (halLines.length === 0) {
                return workingText
            }

            const withoutHalLines = normalizedLines
                .filter((line) => !line.trim().startsWith('hal '))
                .join('\n')
                .trim()

            if (withoutHalLines.length > 0) {
                return `${withoutHalLines}\n\nHAL command suggestions were omitted because they were not verified from local HAL output.`
            }

            return [
                'HAL command suggestions were omitted because they were not verified from local HAL output.',
                '',
                '```bash',
                'hal --help',
                '```',
            ].join('\n')
        }

        const verifiedSet = new Set(verified.map((cmd) => this.normalizeHalCommandToken(cmd).toLowerCase()))
        const unauthorized = new Set<string>()

        for (const line of normalizedLines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('hal ')) continue

            const normalized = this.normalizeHalCommandToken(trimmed).toLowerCase()
            if (!verifiedSet.has(normalized)) {
                unauthorized.add(trimmed)
            }
        }

        if (unauthorized.size === 0) {
            return text
        }

        const filteredText = normalizedLines
            .filter((line) => {
                const trimmed = line.trim()
                if (!trimmed.startsWith('hal ')) {
                    return true
                }
                const normalized = this.normalizeHalCommandToken(trimmed).toLowerCase()
                return verifiedSet.has(normalized)
            })
            .join('\n')
            .trim()

        const verifiedBlock = [
            'Using only verified HAL commands from the local runtime:',
            '',
            ...verified.slice(0, 6).flatMap((cmd) => ['```bash', cmd, '```', '']),
        ].join('\n').trim()

        return filteredText.length > 0 ? `${filteredText}\n\n${verifiedBlock}` : verifiedBlock
    }

    /**
     * Convert OpenAI's tool call to our ToolCall format
     */
    private toolCallToToolCall(toolName: string, args: string | Record<string, unknown>): ToolCall {
        const input = typeof args === 'string' ? JSON.parse(args) : args

        // Map LLM tool names to actual MCP server tool names
        if (toolName === 'search_audit_events') {
            return {
                type: 'audit',
                tool: 'audit.search_events', // vault-audit-mcp tool name
                arguments: input,
            }
        } else if (toolName === 'aggregate_audit_events') {
            return {
                type: 'audit',
                tool: 'audit.aggregate', // vault-audit-mcp tool name
                arguments: input,
            }
        } else if (toolName === 'trace_request') {
            return {
                type: 'audit',
                tool: 'audit.trace', // vault-audit-mcp tool name
                arguments: input,
            }
        } else if (toolName === 'get_event_details') {
            return {
                type: 'audit',
                tool: 'audit.get_event_details', // vault-audit-mcp tool name
                arguments: input,
            }
        } else if (toolName === 'list_namespaces' || toolName === 'list_mounts' || toolName === 'list_secrets' || toolName === 'read_secret' || toolName === 'list_policies' || toolName === 'read_policy' || toolName === 'list_auth_methods' || toolName === 'read_auth_method' || toolName === 'list_auth_roles' || toolName === 'read_auth_role' || toolName === 'analyze_secret_access' || toolName === 'list_entities' || toolName === 'read_entity' || toolName === 'list_entity_aliases' || toolName === 'read_entity_alias' || toolName === 'lookup_self' || toolName === 'read_entity_self' || toolName === 'introspect_self' || toolName === 'read_replication_status' || toolName === 'read_metrics' || toolName === 'read_host_info' || toolName === 'list_leases' || toolName === 'read_lease' || toolName === 'read_cluster_health') {
            return {
                type: 'vault',
                tool: toolName, // vault-mcp-server tool name
                arguments: input,
            }
        } else if (toolName === 'invoke_hal_tool') {
            const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
            const halTool = input.tool

            if (!halTool || typeof halTool !== 'string') {
                throw new Error('invoke_hal_tool requires a string "tool" field')
            }

            return {
                type: 'hal',
                tool: halTool,
                arguments:
                    input.arguments && typeof input.arguments === 'object'
                        ? (input.arguments as Record<string, unknown>)
                        : {},
            }
        } else if (toolName === 'suggest_documentation') {
            return {
                type: 'system',
                tool: 'suggest_documentation',
                arguments: input,
            }
        } else if (toolName === 'get_hal_status') {
            const inputObj = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {}
            const normalized: Record<string, unknown> = {}

            if (typeof inputObj.product === 'string' && inputObj.product.trim().length > 0) {
                const product = inputObj.product.trim().toLowerCase()
                if (/^(vault|terraform|boundary|consul|nomad|obs|observability|tfe)$/.test(product)) {
                    normalized.product = product === 'observability' ? 'obs' : product
                }
            }

            return {
                type: 'system',
                tool: 'get_hal_status',
                arguments: normalized,
            }
        } else if (toolName === 'get_hal_help') {
            return {
                type: 'system',
                tool: 'get_hal_help',
                arguments: input,
            }
        } else if (toolName === 'get_vault_cli_context') {
            return {
                type: 'system',
                tool: 'get_vault_cli_context',
                arguments: input,
            }
        }
        throw new Error(`Unknown tool: ${toolName}`)
    }

    /**
     * Extract text from OpenAI's response
     */
    private extractTextFromResponse(response: OpenAI.Chat.ChatCompletion): string {
        return response.choices[0].message.content || ''
    }

    private async addAutomaticDocumentationSuggestions(query: string, response: string): Promise<void> {
        const combined = `${query}\n${response}`.toLowerCase()
        const suggestions: Array<{ title: string; url: string; description: string }> = []

        suggestions.push(...getProductDocumentationSuggestions(combined))

        if (/\bvault\b/.test(combined)) {
            suggestions.push({
                title: 'Vault CLI Quick Start',
                url: 'https://developer.hashicorp.com/vault/docs/commands',
                description: 'Core Vault CLI commands, flags, and usage patterns.',
            })
        }

        if (/\bjwt\b/.test(combined)) {
            suggestions.push({
                title: 'Vault JWT Auth Method',
                url: 'https://developer.hashicorp.com/vault/docs/auth/jwt',
                description: 'Configure and operate the JWT/OIDC auth method in Vault.',
            })
        }

        if (/\boidc\b/.test(combined)) {
            suggestions.push({
                title: 'Vault OIDC Auth Method',
                url: 'https://developer.hashicorp.com/vault/docs/auth/jwt/oidc-providers',
                description: 'OIDC provider configuration patterns for Vault auth flows.',
            })
        }

        if (/vault instance|vault status|vault health|cluster health|sys\/health/.test(combined)) {
            suggestions.push({
                title: 'Vault Health Check API',
                url: 'https://developer.hashicorp.com/vault/api-docs/system/health',
                description: 'Understand sys/health status codes and fields for Vault operational health.',
            })
        }

        for (const suggestion of suggestions.slice(0, 2)) {
            await this.executionEngine.executeTool({
                type: 'system',
                tool: 'suggest_documentation',
                arguments: suggestion,
            })
        }
    }
}
