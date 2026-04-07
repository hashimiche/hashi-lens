/**
 * MCP HAL Client
 *
 * Communicates with HAL MCP server via stdio transport.
 */

import { spawn, ChildProcess } from 'child_process'

export interface HalToolResult {
    success: boolean
    result?: unknown
    error?: string
}

export class MCPHalClient {
    private process: ChildProcess | null = null
    private requestId = 0
    private pending = new Map<number, (response: any) => void>()
    private buffer = ''
    private command: string
    private initialized = false
    private readonly debugLogsEnabled =
        process.env.HASHILENS_MCP_DEBUG_LOGS === 'true' ||
        process.env.VAULTLENS_MCP_DEBUG_LOGS === 'true'

    constructor(command: string = process.env.HAL_MCP_COMMAND || `${process.env.HOME || ''}/.hal/bin/hal-mcp`) {
        this.command = command
    }

    async initialize(): Promise<void> {
        if (this.initialized) {
            return
        }

        console.log(`[MCP HAL Client] Starting: ${this.command}`)

        this.process = spawn(this.command, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            env: {
                ...process.env,
            },
        })

        if (!this.process.stdout || !this.process.stdin) {
            throw new Error('Failed to create stdio pipes for HAL MCP server')
        }

        this.process.stdout.on('data', (chunk: Buffer) => {
            this.buffer += chunk.toString()
            this.processBuffer()
        })

        this.process.stderr?.on('data', (chunk: Buffer) => {
            this.logServerStderr(chunk.toString())
        })

        this.process.on('exit', (code) => {
            console.warn(`[MCP HAL Client] Server exited with code ${code}`)
            this.initialized = false
        })

        await this.sendMessage({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: {
                    name: 'hashi-lens',
                    version: '1.0.0',
                },
            },
        })

        this.initialized = true
        console.log('[MCP HAL Client] Initialized')
    }

    private logServerStderr(raw: string): void {
        const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
        for (const line of lines) {
            const levelMatch = line.match(/\blevel=([a-zA-Z]+)\b/)
            const level = levelMatch?.[1]?.toLowerCase()
            const message = `[MCP HAL Server] ${line}`

            if (level === 'debug') {
                if (this.debugLogsEnabled) {
                    console.debug(message)
                }
                continue
            }
            if (level === 'info') {
                console.info(message)
                continue
            }
            if (level === 'warn' || level === 'warning') {
                console.warn(message)
                continue
            }
            if (level === 'error' || level === 'fatal' || level === 'panic') {
                console.error(message)
                continue
            }

            console.info(message)
        }
    }

    async callTool(
        toolName: string,
        args: Record<string, unknown>
    ): Promise<HalToolResult> {
        if (!this.initialized) {
            await this.initialize()
        }

        try {
            const requestId = this.requestId + 1
            const startTime = Date.now()
            console.log(`[MCP HAL Client] Tool call start id=${requestId} name=${toolName}`)
            console.log(`[MCP HAL Client] Tool args id=${requestId}:`, args)

            const response = await this.sendMessage({
                jsonrpc: '2.0',
                id: ++this.requestId,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: args,
                },
            })

            console.log(
                `[MCP HAL Client] Tool call end id=${requestId} duration_ms=${Date.now() - startTime}`
            )

            if (response.error) {
                return {
                    success: false,
                    error: response.error.message || 'MCP HAL tool call error',
                }
            }

            return {
                success: true,
                result: response.result?.content?.[0]?.text || response.result,
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    }

    private async sendMessage(message: any): Promise<any> {
        if (!this.process?.stdin) {
            throw new Error('HAL MCP server process not initialized')
        }

        const id = message.id
        const messageStr = JSON.stringify(message) + '\n'

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`MCP HAL request ${id} timed out`))
            }, 60000)

            this.pending.set(id, (response) => {
                clearTimeout(timeout)
                resolve(response)
            })

            this.process!.stdin!.write(messageStr, (err) => {
                if (err) {
                    this.pending.delete(id)
                    clearTimeout(timeout)
                    reject(err)
                }
            })
        })
    }

    private processBuffer(): void {
        while (this.buffer.includes('\n')) {
            const newlineIndex = this.buffer.indexOf('\n')
            const line = this.buffer.substring(0, newlineIndex).trim()
            this.buffer = this.buffer.substring(newlineIndex + 1)

            if (line.length === 0) {
                continue
            }

            try {
                const response = JSON.parse(line)
                const id = response.id

                if (id && this.pending.has(id)) {
                    const resolve = this.pending.get(id)!
                    this.pending.delete(id)
                    resolve(response)
                } else {
                    console.log('[MCP HAL Client] Received notification:', response)
                }
            } catch (error) {
                console.error('[MCP HAL Client] Failed to parse message:', line, error)
            }
        }
    }

    async close(): Promise<void> {
        if (this.process) {
            this.process.kill()
            this.process = null
            this.initialized = false
        }
    }
}
