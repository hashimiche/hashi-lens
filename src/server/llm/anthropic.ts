/**
 * Anthropic LLM Service
 *
 * Uses Claude (via Anthropic SDK) as the LLM backend
 * Implements agentic loop with tool_use response handling
 */

import Anthropic from '@anthropic-ai/sdk'
import { ExecutionEngine, ToolCall, ToolResult } from '../execution-engine.js'
import { BaseLLMService, QueryResult, ConversationContext, StreamChunk } from './base.js'
import { getProductScenarioPlaybookPrompt } from './products/index.js'

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

You have access to MCP tools currently wired in this runtime (Vault + audit + system docs). Additional MCPs (for example HAL/Terraform) may be added later.

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
   - read_metrics: Read Vault telemetry metrics from sys/metrics endpoint. Returns performance metrics, counters, gauges, and summaries including operations/sec, storage metrics, token operations, secret engine activity, and system resource usage. Supports 'json' or 'prometheus' format. Use for performance monitoring, capacity planning, troubleshooting slow operations, and operational diagnostics.
   - read_host_info: Read host-level runtime and compute details from sys/host-info (OS/runtime/CPU/memory/host characteristics). Use for infrastructure diagnostics and capacity context.
   - **Namespace support**: All Vault tools accept an optional 'namespace' parameter (e.g., "admin/", "team1/") for Vault Enterprise multi-tenancy
   - **Use proactively**: When audit logs show activity but lack context (e.g., what mounts are configured, what secrets exist), query Vault directly rather than asking the user

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
- Only use code blocks (triple backticks) for multi-line code, JSON, or HCL content
- Use tables only for structured data with multiple rows/columns
- Write naturally - don't force every technical term into markdown formatting unless it aids clarity

Always explain your reasoning and the actions you're taking, especially identifying actors by their display_name.`;
}

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'search_audit_events',
        description: 'Search Vault audit events by labels and filters',
        input_schema: {
            type: 'object' as const,
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
            required: [],
        },
    },
    {
        name: 'aggregate_audit_events',
        description: 'Count audit events grouped by a dimension',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'trace_request',
        description: 'Trace all audit events for a specific request ID',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'get_event_details',
        description: 'Get full detailed information for a specific audit event by request ID. Returns complete event details including request path, role name, entity ID, remote address, and raw audit log JSON. Use when initial search results lack important details.',
        input_schema: {
            type: 'object' as const,
            properties: {
                request_id: {
                    type: 'string',
                    description: 'The Vault request ID to retrieve detailed event for',
                },
            },
            required: ['request_id'],
        },
    },
    {
        name: 'list_namespaces',
        description: 'List child namespaces within a Vault Enterprise namespace. Requires Vault Enterprise. Returns all namespaces under the specified parent namespace path.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Parent namespace path to list from (e.g., "admin/"). If not specified, lists from the root namespace context.',
                },
            },
        },
    },
    {
        name: 'list_mounts',
        description: 'List all mounted secrets engines and auth methods in Vault. Returns a comprehensive list of all mounts including their type, description, and path. Supports querying specific namespaces in Vault Enterprise.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Namespace path to query (e.g., "admin/"). If not specified, queries the root namespace context.',
                },
            },
        },
    },
    {
        name: 'list_secrets',
        description: 'List secrets at a specific path in a KV secrets engine. Supports querying specific namespaces.',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'read_secret',
        description: 'Read a secret from a KV secrets engine at a specific path. Supports querying specific namespaces.',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'list_policies',
        description: 'List all ACL policies configured in Vault. Returns the names of all policies available in the specified namespace. Use to discover what policies exist.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Namespace path to list policies from (e.g., "admin/"). If not specified, lists from the root namespace context.',
                },
            },
        },
    },
    {
        name: 'read_policy',
        description: 'Read the contents of a specific Vault ACL policy. Returns the policy rules in HCL format. Use when you need to understand what permissions a policy grants.',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'list_auth_methods',
        description: 'List all enabled authentication methods in Vault. Returns information about each auth method including type, path, accessor, and configuration details. Use to discover what auth methods are configured.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Namespace path to list auth methods from (e.g., "admin/"). If not specified, lists from the root namespace context.',
                },
            },
        },
    },
    {
        name: 'read_auth_method',
        description: 'Read detailed configuration and information about a specific authentication method in Vault. Returns full details including config, options, and metadata for the specified auth method.',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'list_auth_roles',
        description: 'List all roles configured in a Vault auth method. Returns role names for role-based auth methods like approle, jwt, oidc, kubernetes, aws, gcp, azure. For userpass use path_suffix="users", for ldap use path_suffix="groups" or "users".',
        input_schema: {
            type: 'object' as const,
            properties: {
                mount: {
                    type: 'string',
                    description: 'Auth method mount path (e.g., "approle", "jwt", "kubernetes"). Do not include trailing slash.',
                },
                path_suffix: {
                    type: 'string',
                    description: 'Path suffix for listing roles. Defaults to "role". Use "users" for userpass, "groups" or "users" for ldap.',
                },
                namespace: {
                    type: 'string',
                    description: 'Namespace path (e.g., "admin/"). If not specified, uses root namespace context.',
                },
            },
            required: ['mount'],
        },
    },
    {
        name: 'read_auth_role',
        description: 'Read complete configuration of a specific role in a Vault auth method, including token_policies and role-specific settings.',
        input_schema: {
            type: 'object' as const,
            properties: {
                mount: {
                    type: 'string',
                    description: 'Auth method mount path (e.g., "approle", "jwt", "kubernetes"). Do not include trailing slash.',
                },
                role_name: {
                    type: 'string',
                    description: 'Name of the role to read.',
                },
                path_suffix: {
                    type: 'string',
                    description: 'Path suffix for reading roles. Defaults to "role". Use "users" for userpass, "groups" or "users" for ldap.',
                },
                namespace: {
                    type: 'string',
                    description: 'Namespace path (e.g., "admin/"). If not specified, uses root namespace context.',
                },
            },
            required: ['mount', 'role_name'],
        },
    },
    {
        name: 'analyze_secret_access',
        description: 'Analyze which auth roles can access a Vault API path. Supports conditional evaluation for policy templates and optional KV v2 path expansion.',
        input_schema: {
            type: 'object' as const,
            properties: {
                target_path: {
                    type: 'string',
                    description: 'Vault API path to analyze (for example "sys/mounts" or "kv/tenant-2/secret").',
                },
                required_capabilities: {
                    type: 'string',
                    description: 'Comma-separated capabilities required on target_path.',
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
    {
        name: 'list_entities',
        description: 'List Vault identity entities by id or name.',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'read_entity',
        description: 'Read a Vault identity entity by id or name, including entity metadata and aliases.',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'list_entity_aliases',
        description: 'List Vault identity entity aliases by id.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                },
            },
        },
    },
    {
        name: 'read_entity_alias',
        description: 'Read a Vault identity entity alias by id, including alias metadata and mount accessor.',
        input_schema: {
            type: 'object' as const,
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
    {
        name: 'lookup_self',
        description: 'Look up details about the current Vault token (auth/token/lookup-self), including policies, entity_id, display_name, TTL, and metadata.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                },
            },
        },
    },
    {
        name: 'read_entity_self',
        description: 'Read the Vault identity entity associated with the current token by resolving entity_id from auth/token/lookup-self. Includes entity metadata and aliases.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                },
            },
        },
    },
    {
        name: 'introspect_self',
        description: 'Introspect current Vault identity by combining auth/token/lookup-self and identity/entity/id/:entity_id (when present). Useful for policy/template-aware access analysis.',
        input_schema: {
            type: 'object' as const,
            properties: {
                namespace: {
                    type: 'string',
                    description: 'Namespace path (for example "admin/"). If not specified, uses root namespace context.',
                },
            },
        },
    },
    {
        name: 'read_replication_status',
        description: 'Get detailed replication status for Performance and DR replication. Returns cluster IDs, replication modes (primary/secondary/disabled), connection states, WAL indexes, merkle tree status, and known secondaries. Use for diagnosing replication health, checking lag, or understanding cluster topology.',
        input_schema: {
            type: 'object' as const,
            properties: {},
        },
    },
    {
        name: 'read_metrics',
        description: 'Read Vault telemetry metrics from sys/metrics endpoint. Returns performance metrics, counters, gauges, and summaries including operations/sec, storage metrics, token operations, secret engine activity, system resource usage, and lease information. Use for performance monitoring, capacity planning, troubleshooting slow operations, and operational diagnostics.',
        input_schema: {
            type: 'object' as const,
            properties: {},
        },
    },
    {
        name: 'read_host_info',
        description: 'Read detailed host information from Vault sys/host-info endpoint, including OS, runtime, memory, CPU, and host-level characteristics useful for diagnostics and capacity analysis.',
        input_schema: {
            type: 'object' as const,
            properties: {},
        },
    },
    {
        name: 'read_cluster_health',
        description: 'Read comprehensive cluster health information including HA status (nodes, leader), Raft autopilot state (server health, failure tolerance, redundancy zones, node lifecycle), autopilot configuration (cleanup settings, thresholds), and seal backend status (KMS/HSM health). Provides detailed insights beyond basic sys/health endpoint for monitoring cluster quorum and external dependency health. Use when you need to know cluster node count, health status, or raft configuration.',
        input_schema: {
            type: 'object' as const,
            properties: {},
        },
    },
    {
        name: 'suggest_documentation',
        description: 'Suggest relevant HashiCorp Vault documentation for the user to reference. Use this tool to provide helpful documentation links WITHOUT including them in your conversational response. The suggestions will appear in a separate panel. Call this tool when you mention Vault concepts, features, or configurations that have official documentation. Do NOT mention that you are suggesting documentation in your response text - the suggestions appear automatically in a separate area.',
        input_schema: {
            type: 'object' as const,
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
]

export class AnthropicLLMService extends BaseLLMService {
    private client: Anthropic

    constructor(executionEngine: ExecutionEngine) {
        super(executionEngine)
        this.client = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
        })
    }

    /**
     * Execute a query using Claude with agentic loop
     */
    async executeQuery(query: string, _context?: ConversationContext): Promise<QueryResult> {
        console.log(`[Anthropic Agent] Processing query: ${query}`)

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
            // Step 1: Call Claude to decide what tools to call
            let messages: Anthropic.MessageParam[] = this.conversationHistory.map((msg) => ({
                role: msg.role,
                content: msg.content,
            }))

            console.log('[Anthropic Agent] Calling Claude to plan execution...')
            let response = await this.client.messages.create({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 4096,
                system: getSystemPrompt(),
                tools: TOOLS,
                messages,
            })

            reasoning = this.extractTextFromResponse(response)

            // Step 2: Process tool uses in an agentic loop
            while (response.stop_reason === 'tool_use') {
                const assistantMessage: Anthropic.MessageParam = {
                    role: 'assistant',
                    content: response.content,
                }
                messages.push(assistantMessage)
                this.conversationHistory.push({
                    role: 'assistant',
                    content: this.extractTextFromResponse(response),
                })

                const toolResultContent: Anthropic.ToolResultBlockParam[] = []

                // Execute all tool calls in this response
                for (const block of response.content) {
                    if (block.type === 'tool_use') {
                        const toolCall = this.toolUseToToolCall(block.name, this.normalizeToolInput(block.input))
                        toolCalls.push(toolCall)

                        console.log(`[Anthropic Agent] Executing tool: ${block.name}`)
                        const result = await this.executionEngine.executeTool(toolCall)
                        toolResults.push(result)

                        toolResultContent.push({
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: JSON.stringify(result),
                        })
                    }
                }

                // Send tool results back to Claude
                messages.push({
                    role: 'user',
                    content: toolResultContent,
                })

                // Get next response
                response = await this.client.messages.create({
                    model: 'claude-3-5-sonnet-20241022',
                    max_tokens: 4096,
                    system: getSystemPrompt(),
                    tools: TOOLS,
                    messages,
                })
            }

            // Step 3: Extract final response
            const finalResponse = this.extractTextFromResponse(response)

            // Log raw markdown response for debugging
            console.log('[Anthropic Agent] Raw markdown response:')
            console.log('='.repeat(80))
            console.log(finalResponse)
            console.log('='.repeat(80))

            // Add Claude's final response to history
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

            this.queryHistory.push(result)
            console.log('[Anthropic Agent] Query complete')

            return result
        } catch (error) {
            console.error('[Anthropic Agent] Error:', error)
            throw error
        }
    }

    async *executeQueryStream(
        query: string,
        _context?: ConversationContext
    ): AsyncGenerator<StreamChunk, void, unknown> {
        console.log(`[Anthropic Agent] Processing streaming query: ${query}`)

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
            // Step 1: Stream Claude's response
            let messages: Anthropic.MessageParam[] = this.conversationHistory.map((msg) => ({
                role: msg.role,
                content: msg.content,
            }))

            console.log('[Anthropic Agent] Starting Claude stream...')
            let stream = this.client.messages.stream({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 4096,
                system: getSystemPrompt(),
                tools: TOOLS,
                messages,
            })

            // Step 2: Process stream with agentic loop for tool calls
            let needsMoreIterations = true
            while (needsMoreIterations) {
                needsMoreIterations = false
                let iterationResponse = ''
                let iterationHadToolUse = false

                for await (const event of stream) {
                    if (event.type === 'content_block_delta') {
                        if (event.delta.type === 'text_delta') {
                            const textChunk = event.delta.text
                            iterationResponse += textChunk
                        }
                    }

                    if (event.type === 'message_stop') {
                        const message = await stream.finalMessage()

                        // Check if Claude wants to use tools
                        if (message.stop_reason === 'tool_use') {
                            needsMoreIterations = true
                            iterationHadToolUse = true

                            // Add assistant message to history
                            const assistantMessage: Anthropic.MessageParam = {
                                role: 'assistant',
                                content: message.content,
                            }
                            messages.push(assistantMessage)
                            this.conversationHistory.push({
                                role: 'assistant',
                                content: this.extractTextFromResponse(message),
                            })

                            const toolResultContent: Anthropic.ToolResultBlockParam[] = []

                            // Execute all tool calls in this response
                            for (const block of message.content) {
                                if (block.type === 'tool_use') {
                                    const toolCall = this.toolUseToToolCall(block.name, this.normalizeToolInput(block.input))
                                    toolCalls.push(toolCall)

                                    yield { type: 'tool_call', toolCall }

                                    console.log(`[Anthropic Agent] Executing tool: ${block.name}`)
                                    const result = await this.executionEngine.executeTool(toolCall)
                                    toolResults.push(result)

                                    yield { type: 'tool_result', toolResult: result }

                                    toolResultContent.push({
                                        type: 'tool_result',
                                        tool_use_id: block.id,
                                        content: JSON.stringify(result),
                                    })
                                }
                            }

                            // Send tool results back to Claude
                            messages.push({
                                role: 'user',
                                content: toolResultContent,
                            })

                            // Start new stream with tool results
                            stream = this.client.messages.stream({
                                model: 'claude-3-5-sonnet-20241022',
                                max_tokens: 4096,
                                system: getSystemPrompt(),
                                tools: TOOLS,
                                messages,
                            })
                        }
                    }
                }

                if (!iterationHadToolUse) {
                    fullResponse = iterationResponse
                }
            }

            // Emit only final response to avoid visible draft rewrites in the UI.
            if (fullResponse.length > 0) {
                for (const chunk of this.chunkFinalResponse(fullResponse)) {
                    yield { type: 'text', content: chunk }
                }
            }

            // Add Claude's final response to history
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

            this.queryHistory.push(result)
            console.log('[Anthropic Agent] Streaming query complete')

            yield { type: 'done', result }
        } catch (error) {
            console.error('[Anthropic Agent] Streaming error:', error)
            throw error
        }
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

    /**
     * Convert Claude's tool_use block to our ToolCall format
     */
    private toolUseToToolCall(toolName: string, input: Record<string, unknown>): ToolCall {
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
        } else if (toolName === 'list_namespaces' || toolName === 'list_mounts' || toolName === 'list_secrets' || toolName === 'read_secret' || toolName === 'list_policies' || toolName === 'read_policy' || toolName === 'list_auth_methods' || toolName === 'read_auth_method' || toolName === 'list_auth_roles' || toolName === 'read_auth_role' || toolName === 'analyze_secret_access' || toolName === 'list_entities' || toolName === 'read_entity' || toolName === 'list_entity_aliases' || toolName === 'read_entity_alias' || toolName === 'lookup_self' || toolName === 'read_entity_self' || toolName === 'introspect_self' || toolName === 'read_replication_status' || toolName === 'read_metrics' || toolName === 'read_host_info' || toolName === 'read_cluster_health') {
            return {
                type: 'vault',
                tool: toolName, // vault-mcp-server tool name
                arguments: input,
            }
        } else if (toolName === 'suggest_documentation') {
            return {
                type: 'system',
                tool: 'suggest_documentation',
                arguments: input,
            }
        }
        throw new Error(`Unknown tool: ${toolName}`)
    }

    private normalizeToolInput(input: unknown): Record<string, unknown> {
        if (input && typeof input === 'object' && !Array.isArray(input)) {
            return input as Record<string, unknown>
        }
        return {}
    }

    /**
     * Extract text from Claude's response
     */
    private extractTextFromResponse(response: Anthropic.Message): string {
        return response.content
            .filter((block) => block.type === 'text')
            .map((block) => (block as Anthropic.TextBlock).text)
            .join('\n')
    }
}
