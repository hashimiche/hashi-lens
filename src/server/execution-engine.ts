/**
 * Execution Engine
 *
 * Coordinates execution of tool calls against both MCP servers:
 * - Vault Audit MCP Server: For querying audit logs (stdio via MCPAuditClient)
 * - Vault MCP Server: For performing Vault operations (stdio via MCPVaultClient)
 */

import { MCPAuditClient } from './mcp-audit-client.js'
import { MCPHalClient } from './mcp-hal-client.js'
import { MCPVaultClient } from './mcp-vault-client.js'
import { VaultAuthManager } from './auth/manager.js'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const DEFAULT_HAL_MCP_COMMAND = `${process.env.HOME || ''}/.hal/bin/hal-mcp`

async function runHalCommand(commandInput: string, args: string[]): Promise<{ stdout: string }> {
    const normalized = commandInput.trim()
    const parts = normalized.split(/\s+/).filter((part) => part.length > 0)
    const executable = parts[0] || 'hal'
    const preArgs = parts.slice(1)

    const envHal =
        typeof process.env.HAL_COMMAND === 'string' && process.env.HAL_COMMAND.trim().length > 0
            ? process.env.HAL_COMMAND.trim()
            : null
    const envHalParts = envHal ? envHal.split(/\s+/).filter((part) => part.length > 0) : []
    const envHalExecutable = envHalParts[0] || null
    const envHalPreArgs = envHalParts.slice(1)

    const candidates = [
        { bin: executable, preArgs },
        ...(envHalExecutable ? [{ bin: envHalExecutable, preArgs: envHalPreArgs }] : []),
        { bin: 'hal', preArgs: [] as string[] },
        ...(existsSync(`${process.env.HOME || ''}/.hal/bin/hal`)
            ? [{ bin: `${process.env.HOME || ''}/.hal/bin/hal`, preArgs: [] as string[] }]
            : []),
    ]

    const uniqueCandidates = candidates.filter(
        (candidate, index, all) =>
            all.findIndex(
                (other) =>
                    other.bin === candidate.bin && other.preArgs.join(' ') === candidate.preArgs.join(' ')
            ) === index
    )

    let lastError: unknown = null
    for (const candidate of uniqueCandidates) {
        try {
            const result = await execFileAsync(candidate.bin, [...candidate.preArgs, ...args], {
                env: { ...process.env, NO_COLOR: '1' },
                timeout: 8000,
                maxBuffer: 1024 * 1024,
            })
            return { stdout: result.stdout }
        } catch (error) {
            const code = (error as { code?: unknown })?.code
            // If HAL executed but returned a runtime error, surface it immediately.
            if (code !== 'ENOENT') {
                throw error instanceof Error ? error : new Error(String(error))
            }
            lastError = error
        }
    }

    if (lastError instanceof Error) {
        throw new Error('Unable to find HAL CLI executable. Install hal or set HAL_COMMAND to the correct binary path.')
    }

    throw new Error('Failed to execute HAL command')
}

export interface ToolCall {
    type: 'vault' | 'audit' | 'hal' | 'system'
    tool: string
    arguments: Record<string, unknown>
}

export interface ToolResult {
    type: 'vault' | 'audit' | 'hal' | 'system'
    tool: string
    success: boolean
    result?: unknown
    error?: string
}

export interface ExecutionPlan {
    steps: ToolCall[]
    reasoning: string
}

export class ExecutionEngine {
    private auditClient: MCPAuditClient
    private auditClientInitialized = false
    private halClient: MCPHalClient
    private halClientInitialized = false
    private vaultClient: MCPVaultClient
    private vaultClientInitialized = false
    private authManager: VaultAuthManager
    private suggestionHandler?: (suggestion: { title: string; url: string; description: string; context?: string }) => void
    private activityHandler?: (activity: { activityId?: string; type: 'tool_call' | 'thinking' | 'result'; toolType?: string; toolName?: string; description?: string; status?: string; duration?: number; error?: string }) => void

    constructor(authManager: VaultAuthManager) {
        this.authManager = authManager
        this.auditClient = new MCPAuditClient()
        this.halClient = new MCPHalClient(
            process.env.HAL_MCP_COMMAND || DEFAULT_HAL_MCP_COMMAND
        )
        this.vaultClient = new MCPVaultClient(
            process.env.VAULT_MCP_COMMAND || './vault-mcp-server',
            authManager
        )
    }

    /**
     * Set handler for documentation suggestions
     */
    setSuggestionHandler(handler: (suggestion: { title: string; url: string; description: string; context?: string }) => void) {
        this.suggestionHandler = handler
    }

    /**
     * Set handler for activity tracking
     */
    setActivityHandler(handler: (activity: { activityId?: string; type: 'tool_call' | 'thinking' | 'result'; toolType?: string; toolName?: string; description?: string; status?: string; duration?: number; error?: string }) => void) {
        this.activityHandler = handler
    }

    /**
     * Execute a tool call against one of the MCP servers
     */
    async executeTool(toolCall: ToolCall): Promise<ToolResult> {
        console.log(
            `[ExecutionEngine] Executing ${toolCall.type} tool: ${toolCall.tool}`
        )

        const activityId = `act-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        const startTime = Date.now()

        // Emit activity start immediately so UI can show an in-progress pulse.
        if (this.activityHandler) {
            this.activityHandler({
                activityId,
                type: 'tool_call',
                toolType: toolCall.type,
                toolName: toolCall.tool,
                description: 'Running...',
                status: 'running',
            })
        }

        try {
            let result: ToolResult

            if (toolCall.type === 'audit') {
                result = await this.executeAuditTool(toolCall.tool, toolCall.arguments)
            } else if (toolCall.type === 'hal') {
                result = await this.executeHalTool(toolCall.tool, toolCall.arguments)
            } else if (toolCall.type === 'vault') {
                result = await this.executeVaultTool(toolCall.tool, toolCall.arguments)
            } else if (toolCall.type === 'system') {
                result = await this.executeSystemTool(toolCall.tool, toolCall.arguments)
            } else {
                result = {
                    type: toolCall.type,
                    tool: toolCall.tool,
                    success: false,
                    error: `Unknown tool type: ${toolCall.type}`,
                }
            }

            const duration = Date.now() - startTime

            // Emit activity completion
            if (this.activityHandler) {
                this.activityHandler({
                    activityId,
                    type: 'tool_call',
                    toolType: toolCall.type,
                    toolName: toolCall.tool,
                    description: result.success ? `Completed in ${duration}ms` : `Failed: ${result.error}`,
                    status: result.success ? 'success' : 'error',
                    duration,
                    error: result.error
                })
            }

            return result
        } catch (error) {
            const duration = Date.now() - startTime
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'

            // Emit activity error
            if (this.activityHandler) {
                this.activityHandler({
                    activityId,
                    type: 'tool_call',
                    toolType: toolCall.type,
                    toolName: toolCall.tool,
                    description: `Error: ${errorMsg}`,
                    status: 'error',
                    duration,
                    error: errorMsg
                })
            }

            return {
                type: toolCall.type,
                tool: toolCall.tool,
                success: false,
                error: errorMsg,
            }
        }
    }

    /**
     * Execute a tool call against the HAL MCP server
     */
    private async executeHalTool(
        tool: string,
        args: Record<string, unknown>
    ): Promise<ToolResult> {
        const startTime = Date.now()
        console.log(`[HAL] Calling ${tool} with args:`, args)

        try {
            if (!this.halClientInitialized) {
                await this.halClient.initialize()
                this.halClientInitialized = true
            }

            const result = await this.halClient.callTool(tool, args as Record<string, unknown>)

            console.log(
                `[HAL] Result ${tool} success=${result.success} duration_ms=${Date.now() - startTime}`
            )

            return {
                type: 'hal',
                tool,
                success: result.success,
                result: result.result,
                error: result.error,
            }
        } catch (error) {
            return {
                type: 'hal',
                tool,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    }

    /**
     * Execute a tool call against the Vault Audit MCP server
     */
    private async executeAuditTool(
        tool: string,
        args: Record<string, unknown>
    ): Promise<ToolResult> {
        const startTime = Date.now()
        console.log(`[Audit] Calling ${tool} with args:`, args)

        try {
            // Initialize client on first use
            if (!this.auditClientInitialized) {
                await this.auditClient.initialize()
                this.auditClientInitialized = true
            }

            // Send the full tool name to the MCP server (e.g., "audit.search_events")
            // vault-audit-mcp expects tool names with the namespace prefix
            const result = await this.auditClient.callTool(tool, args as Record<string, unknown>)

            console.log(
                `[Audit] Result ${tool} success=${result.success} duration_ms=${Date.now() - startTime}`
            )

            return {
                type: 'audit',
                tool,
                success: result.success,
                result: result.result,
                error: result.error,
            }
        } catch (error) {
            return {
                type: 'audit',
                tool,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    }

    /**
     * Execute a tool call against the Vault MCP server
     */
    private async executeVaultTool(
        tool: string,
        args: Record<string, unknown>
    ): Promise<ToolResult> {
        const startTime = Date.now()
        console.log(`[Vault] Calling ${tool} with args:`, args)

        try {
            // Initialize client on first use
            if (!this.vaultClientInitialized) {
                await this.vaultClient.initialize()
                this.vaultClientInitialized = true
            }

            // Send the tool call to the Vault MCP server
            const result = await this.vaultClient.callTool(tool, args as Record<string, unknown>)

            // Compatibility fallback: some Vault MCP builds do not expose list_auth_methods.
            // Derive auth methods from list_mounts to avoid hard failures in mixed environments.
            if (
                tool === 'list_auth_methods' &&
                !result.success &&
                typeof result.error === 'string' &&
                /tool\s+.*not found|tool not found/i.test(result.error)
            ) {
                const mountsFallback = await this.vaultClient.callTool('list_mounts', args as Record<string, unknown>)
                if (mountsFallback.success) {
                    return {
                        type: 'vault',
                        tool,
                        success: true,
                        result: this.deriveAuthMethodsFromMounts(mountsFallback.result),
                    }
                }
            }

            console.log(
                `[Vault] Result ${tool} success=${result.success} duration_ms=${Date.now() - startTime}`
            )

            return {
                type: 'vault',
                tool,
                success: result.success,
                result: result.result,
                error: result.error,
            }
        } catch (error) {
            return {
                type: 'vault',
                tool,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    }

    private deriveAuthMethodsFromMounts(mountsPayload: unknown): Array<{ path: string; type: string; description?: string }> {
        let parsed: unknown = mountsPayload

        if (typeof mountsPayload === 'string') {
            try {
                parsed = JSON.parse(mountsPayload)
            } catch (_error) {
                return []
            }
        }

        if (!parsed || typeof parsed !== 'object') {
            return []
        }

        const out: Array<{ path: string; type: string; description?: string }> = []

        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (!item || typeof item !== 'object') continue
                const value = item as { path?: unknown; name?: unknown; type?: unknown; description?: unknown }
                const path = typeof value.path === 'string' ? value.path : (typeof value.name === 'string' ? value.name : null)
                const type = typeof value.type === 'string' ? value.type : null
                const description = typeof value.description === 'string' ? value.description : undefined
                if (!path || !type) continue
                if (path.startsWith('auth/') || type === 'token') {
                    out.push({ path, type, description })
                }
            }
            return out
        }

        for (const [path, details] of Object.entries(parsed as Record<string, unknown>)) {
            if (!details || typeof details !== 'object') continue
            const value = details as { type?: unknown; description?: unknown }
            if (typeof value.type !== 'string') continue
            if (path.startsWith('auth/') || value.type === 'token') {
                const description = typeof value.description === 'string' ? value.description : undefined
                out.push({ path, type: value.type, description })
            }
        }

        return out
    }

    /**
     * Execute a system tool (built-in functionality that doesn't require MCP servers)
     */
    private async executeSystemTool(
        tool: string,
        args: Record<string, unknown>
    ): Promise<ToolResult> {
        console.log(`[System] Calling ${tool} with args:`, args)

        try {
            if (tool === 'suggest_documentation') {
                // Validate required fields
                const { title, url, description, context } = args

                if (!title || typeof title !== 'string') {
                    throw new Error('title is required and must be a string')
                }
                if (!url || typeof url !== 'string') {
                    throw new Error('url is required and must be a string')
                }
                const normalizedDescription =
                    typeof description === 'string' && description.trim().length > 0
                        ? description
                        : `Reference: ${title}`

                // Call the suggestion handler
                if (this.suggestionHandler) {
                    this.suggestionHandler({
                        title,
                        url,
                        description: normalizedDescription,
                        context: context as string | undefined,
                    })
                }

                return {
                    type: 'system',
                    tool,
                    success: true,
                    result: { message: 'Documentation suggestion added' },
                }
            } else if (tool === 'get_hal_status') {
                const halCommand =
                    (typeof args.command === 'string' && args.command.trim().length > 0)
                        ? args.command.trim()
                        : (process.env.HAL_COMMAND || 'hal')
                const product =
                    (typeof args.product === 'string' && args.product.trim().length > 0)
                        ? args.product.trim().toLowerCase()
                        : ''

                const genericCommands = ['hal status']
                const productCommands = product
                    ? [`hal ${product} deploy`, `hal ${product} status`]
                    : []

                const { stdout } = await runHalCommand(halCommand, ['status'])

                return {
                    type: 'system',
                    tool,
                    success: true,
                    result: {
                        command: halCommand,
                        raw: stdout,
                        recommendedCommands: [...genericCommands, ...productCommands],
                    },
                }
            } else if (tool === 'get_hal_help') {
                const halCommand =
                    (typeof args.command === 'string' && args.command.trim().length > 0)
                        ? args.command.trim()
                        : (process.env.HAL_COMMAND || 'hal')
                const topic =
                    (typeof args.topic === 'string' && args.topic.trim().length > 0)
                        ? args.topic.trim().toLowerCase()
                        : ''

                const topicParts = topic
                    .split(/\s+/)
                    .filter((part) => /^[a-z0-9:_-]+$/i.test(part))

                const helpArgs = topicParts.length > 0 ? [...topicParts, '--help'] : ['--help']
                const { stdout } = await runHalCommand(halCommand, helpArgs)

                const commandLines = stdout
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.startsWith('hal '))
                    .filter((line) => !/\[flags\]/i.test(line))
                const usageMatch = stdout.match(/Usage:\s*\n\s*(hal\s+[^\n]+)/i)
                const usageCommand = usageMatch?.[1]?.trim()
                const usageBase = usageCommand ? usageCommand.replace(/\s+\[flags\]\s*$/i, '') : ''

                const flagLines = stdout
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => /^-[a-z],\s+--[a-z0-9-]+/i.test(line))

                const actionCommands: string[] = []
                if (usageBase) {
                    for (const flagLine of flagLines) {
                        const shortFlagMatch = flagLine.match(/^(-[a-z]),\s+--([a-z0-9-]+)/i)
                        if (!shortFlagMatch) continue

                        const shortFlag = shortFlagMatch[1]
                        const longFlag = shortFlagMatch[2]
                        if (['enable', 'disable', 'force'].includes(longFlag)) {
                            actionCommands.push(`${usageBase} ${shortFlag}`)
                        }
                    }
                }

                const recommendedCommands = Array.from(
                    new Set([
                        ...(usageBase ? [usageBase] : []),
                        ...actionCommands,
                        ...commandLines,
                        ...(topicParts.length > 0 ? [`hal ${topicParts.join(' ')} --help`] : ['hal --help']),
                    ])
                ).slice(0, 20)

                return {
                    type: 'system',
                    tool,
                    success: true,
                    result: {
                        command: halCommand,
                        topic,
                        helpArgs,
                        raw: stdout,
                        recommendedCommands,
                    },
                }
            } else if (tool === 'get_vault_cli_context') {
                const cluster = this.authManager.getCurrentCluster()
                const token = await this.authManager.getTokenForCliContext()
                const status = await this.authManager.getStatus()
                const resolvedVaultAddr =
                    cluster.vaultAddr || status.cluster?.vaultAddr || 'http://vault.localhost:8200'

                return {
                    type: 'system',
                    tool,
                    success: true,
                    result: {
                        vaultAddr: resolvedVaultAddr,
                        vaultToken: token,
                        authenticated: status.authenticated,
                        sealed: status.cluster?.sealed ?? null,
                        initialized: status.cluster?.initialized ?? null,
                        exportCommands: [
                            `export VAULT_ADDR=${resolvedVaultAddr}`,
                            token ? `export VAULT_TOKEN=${token}` : null,
                        ].filter((cmd): cmd is string => !!cmd),
                    },
                }
            } else {
                return {
                    type: 'system',
                    tool,
                    success: false,
                    error: `Unknown system tool: ${tool}`,
                }
            }
        } catch (error) {
            return {
                type: 'system',
                tool,
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    }

    /**
     * Execute a sequence of tool calls
     */
    async executePlan(plan: ExecutionPlan): Promise<ToolResult[]> {
        const results: ToolResult[] = []

        for (const step of plan.steps) {
            const result = await this.executeTool(step)
            results.push(result)

            // Stop execution if a critical step fails
            if (!result.success && this.isCriticalStep(step)) {
                console.warn(
                    `[ExecutionEngine] Critical step failed: ${step.tool}, stopping execution`
                )
                break
            }
        }

        return results
    }

    private isCriticalStep(_toolCall: ToolCall): boolean {
        // Define which steps are critical (failures should stop execution)
        // For now, all steps are critical
        return true
    }

    /**
     * Reset all MCP clients (closes connections and clears state)
     * Should be called when authentication changes (e.g., logout)
     */
    async reset(): Promise<void> {
        console.log('[ExecutionEngine] Resetting MCP clients...')

        // Close vault client
        if (this.vaultClientInitialized) {
            await this.vaultClient.close()
            this.vaultClientInitialized = false
        }

        // Close audit client
        if (this.auditClientInitialized) {
            await this.auditClient.close()
            this.auditClientInitialized = false
        }

        // Close HAL client
        if (this.halClientInitialized) {
            await this.halClient.close()
            this.halClientInitialized = false
        }

        console.log('[ExecutionEngine] MCP clients reset complete')
    }
}
