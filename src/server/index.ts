import express, { Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { access } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { createLLMService } from './llm-factory.js'
import { ExecutionEngine } from './execution-engine.js'
import { VaultAuthManager } from './auth/manager.js'

dotenv.config()

const app = express()
const port = process.env.API_PORT || 9001
const uiHostname = process.env.VITE_HOSTNAME || 'hal.localhost'
const uiPort = process.env.VITE_PORT || 9000
const lokiUrl = process.env.LOKI_URL || 'http://loki.localhost:3100'
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://ollama.localhost:11434/v1'
const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b'
const halCommand = process.env.HAL_COMMAND || 'hal'
const halMcpCommand = process.env.HAL_MCP_COMMAND || `${process.env.HOME || ''}/.hal/bin/hal-mcp`
const execFileAsync = promisify(execFile)

async function isExecutablePath(path: string): Promise<boolean> {
    try {
        await access(path, fsConstants.X_OK)
        return true
    } catch (_error) {
        return false
    }
}

// Middleware
app.use(cors())
app.use(express.json())

// Initialize auth manager
const authManager = VaultAuthManager.fromEnv()

// Set up token renewal check interval (every 5 minutes)
setInterval(async () => {
    try {
        await authManager.renewIfNeeded()
    } catch (error) {
        console.error('[Auth] Token renewal check failed:', error)
    }
}, 5 * 60 * 1000) // 5 minutes

// Token estimation utility (rough approximation: ~4 chars per token)
function estimateTokenCount(agent: any): { total: number; messages: number; maxContext: number } {
    const conversationHistory = agent.conversationHistory || []
    let charCount = 0

    // Count characters in conversation history
    for (const msg of conversationHistory) {
        charCount += (msg.content || '').length
    }

    // Add system prompt estimate (~3000 chars)
    charCount += 3000

    // Rough conversion: 4 chars ≈ 1 token
    const estimatedTokens = Math.ceil(charCount / 4)

    // Default context estimate for local Ollama models
    const maxContext = 32768

    return {
        total: estimatedTokens,
        messages: conversationHistory.length,
        maxContext
    }
}

// Session management
interface SessionData {
    agent: any
    executionEngine: ExecutionEngine
    lastAccess: number
    suggestions: DocumentationSuggestion[]
    activities: Activity[]
}

const sessions = new Map<string, SessionData>()
const SESSION_TIMEOUT = 60 * 60 * 1000 // 1 hour

// Clear all per-session UI state and reset MCP clients.
// We do this during auth transitions to avoid cross-user/session residue.
async function resetAndClearAllSessions(reason: string): Promise<void> {
    console.log(`[Session] Resetting and clearing all sessions: ${reason}`)
    for (const [sessionId, session] of sessions.entries()) {
        try {
            if (typeof session.agent?.clearHistory === 'function') {
                session.agent.clearHistory()
            }
            session.suggestions = []
            session.activities = []
            await session.executionEngine.reset()
            console.log(`[Session] Cleared session: ${sessionId}`)
        } catch (error) {
            console.error(`[Session] Failed to clear session ${sessionId}:`, error)
        }
    }
}

// Get or create session
function getSession(sessionId: string): SessionData {
    let session = sessions.get(sessionId)

    if (!session) {
        console.log(`[Session] Creating new session: ${sessionId}`)
        const executionEngine = new ExecutionEngine(authManager)
        const agent = createLLMService(executionEngine)
        session = {
            agent,
            executionEngine,
            lastAccess: Date.now(),
            suggestions: [],
            activities: []
        }
        sessions.set(sessionId, session)

        // Set up suggestion handler for this session
        executionEngine.setSuggestionHandler((suggestion: Omit<DocumentationSuggestion, 'id' | 'timestamp'>) => {
            const newSuggestion: DocumentationSuggestion = {
                ...suggestion,
                id: `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp: new Date().toISOString(),
            }
            session!.suggestions.push(newSuggestion)
            if (session!.suggestions.length > MAX_SUGGESTIONS) {
                session!.suggestions.shift()
            }
        })

        // Set up activity handler for this session
        executionEngine.setActivityHandler((activity) => {
            const timestamp = new Date().toISOString()
            const mapped: Activity = {
                id: activity.activityId || `act-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp,
                type: activity.type,
                toolType: activity.toolType as 'vault' | 'audit' | 'hal' | 'system' | undefined,
                toolName: activity.toolName,
                description: activity.description,
                status: activity.status as 'running' | 'success' | 'error' | undefined,
                duration: activity.duration,
                error: activity.error
            }

            if (activity.activityId) {
                const idx = session!.activities.findIndex((a) => a.id === activity.activityId)
                if (idx >= 0) {
                    session!.activities[idx] = {
                        ...session!.activities[idx],
                        ...mapped,
                        id: session!.activities[idx].id,
                        timestamp: session!.activities[idx].timestamp
                    }
                    return
                }
            }

            session!.activities.push(mapped)
            if (session!.activities.length > MAX_ACTIVITIES) {
                session!.activities.shift()
            }
        })
    }

    session.lastAccess = Date.now()
    return session
}

// Extract session ID from request
function getSessionId(req: Request): string {
    return req.headers['x-session-id'] as string || 'default'
}

async function isLokiReady(baseUrl: string): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1200)
    try {
        const readyUrl = baseUrl.endsWith('/ready') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/ready`
        const response = await fetch(readyUrl, { signal: controller.signal })
        return response.ok
    } catch (_error) {
        return false
    } finally {
        clearTimeout(timeout)
    }
}

function stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-9;]*m/g, '')
}

interface HalFeatureStatus {
    name: string
    status: 'enabled' | 'disabled' | 'unknown'
    details?: string
}

interface HalProductStatus {
    name: string
    state: 'running' | 'not-deployed'
    endpoint: string
    version: string
    features: HalFeatureStatus[]
}

async function getHalStatus(): Promise<{ products: HalProductStatus[]; raw: string; error?: string }> {
    try {
        const { stdout } = await execFileAsync(halCommand, ['status'], {
            env: { ...process.env, NO_COLOR: '1' },
            timeout: 8000,
            maxBuffer: 1024 * 1024,
        })

        const output = stripAnsi(stdout)
        const lines = output.split('\n').map((line) => line.trimEnd())
        const products: HalProductStatus[] = []
        let current: HalProductStatus | null = null

        for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line) continue

            const productMatch = line.match(/^(⚪|🟢)\s+(.+?)\s+(Not Deployed|Running)\s{2,}(.+?)\s{2,}(.+)$/i)
            if (productMatch) {
                const icon = productMatch[1]
                const name = productMatch[2].trim()
                const stateText = productMatch[3].trim().toLowerCase()
                const endpoint = productMatch[4].trim()
                const version = productMatch[5].trim()

                current = {
                    name,
                    state: icon === '🟢' || stateText.includes('running') ? 'running' : 'not-deployed',
                    endpoint,
                    version,
                    features: [],
                }
                products.push(current)
                continue
            }

            const featureMatch = line.match(/^↳\s+([^\s]+)\s*(.*)$/)
            if (featureMatch && current) {
                const featureName = featureMatch[1].trim()
                const details = (featureMatch[2] || '').trim()
                const normalized = details.toLowerCase()
                const status: HalFeatureStatus['status'] = normalized.includes('enabled')
                    ? 'enabled'
                    : normalized.includes('disabled')
                        ? 'disabled'
                        : 'unknown'

                current.features.push({ name: featureName, status, details })
            }
        }

        for (const product of products) {
            if (product.name.toLowerCase() === 'tfe') {
                const hasWorkspace = product.features.some(
                    (feature) => feature.name.toLowerCase() === 'workspace'
                )
                if (!hasWorkspace) {
                    product.features.push({
                        name: 'workspace',
                        status: product.state === 'running' ? 'enabled' : 'disabled',
                        details: product.state === 'running' ? 'enabled' : 'disabled',
                    })
                }
            }
        }

        return { products, raw: output }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to execute hal status'
        return { products: [], raw: '', error: errorMessage }
    }
}

async function getOllamaStatus(baseUrl: string, model: string): Promise<{
    url: string
    model: string
    reachable: boolean
    installed: boolean
    availableModels: string[]
}> {
    const tagsUrl = `${baseUrl.replace(/\/v1\/?$/, '')}/api/tags`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)

    try {
        const response = await fetch(tagsUrl, { signal: controller.signal })
        if (!response.ok) {
            return { url: baseUrl, model, reachable: false, installed: false, availableModels: [] }
        }

        const data = await response.json() as { models?: Array<{ name?: string }> }
        const models = (data.models || [])
            .map((m) => m?.name)
            .filter((m): m is string => !!m)

        return {
            url: baseUrl,
            model,
            reachable: true,
            installed: models.includes(model),
            availableModels: models,
        }
    } catch (_error) {
        return { url: baseUrl, model, reachable: false, installed: false, availableModels: [] }
    } finally {
        clearTimeout(timeout)
    }
}

// Clean up expired sessions periodically
setInterval(() => {
    const now = Date.now()
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastAccess > SESSION_TIMEOUT) {
            console.log(`[Session] Cleaning up expired session: ${sessionId}`)
            sessions.delete(sessionId)
        }
    }
}, 10 * 60 * 1000) // Check every 10 minutes

// Activity tracking
interface Activity {
    id: string
    type: 'tool_call' | 'thinking' | 'result'
    timestamp: string
    toolType?: 'vault' | 'audit' | 'hal' | 'system'
    toolName?: string
    description?: string
    status?: 'running' | 'success' | 'error'
    duration?: number
    error?: string
}

const MAX_ACTIVITIES = 6

// Documentation suggestions storage
interface DocumentationSuggestion {
    id: string
    title: string
    url: string
    description: string
    context?: string
    timestamp: string
}

const MAX_SUGGESTIONS = 6 // Keep only the 6 most recent suggestions

// Health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/runtime-info', async (_req: Request, res: Response) => {
    const lokiReady = await isLokiReady(lokiUrl)
    const ollama = await getOllamaStatus(ollamaBaseUrl, ollamaModel)
    const halMcpExecutable = await isExecutablePath(halMcpCommand)

    res.json({
        ui: {
            url: `http://${uiHostname}:${uiPort}`,
        },
        loki: {
            url: lokiUrl,
            ready: lokiReady,
            hint: lokiReady ? null : 'Run "hal obs deploy" if Loki is not up yet.',
        },
        ollama: {
            ...ollama,
            hint: !ollama.reachable
                ? 'Start Ollama and verify OLLAMA_BASE_URL.'
                : !ollama.installed
                    ? `Model ${ollama.model} is not installed. Run: ollama pull ${ollama.model}`
                    : null,
        },
        halMcp: {
            command: halMcpCommand,
            executable: halMcpExecutable,
            hint: halMcpExecutable
                ? null
                : 'Set HAL_MCP_COMMAND to an executable hal-mcp binary (for example ~/.hal/bin/hal-mcp).',
        },
    })
})

app.get('/hal/status', async (_req: Request, res: Response) => {
    const status = await getHalStatus()
    res.json(status)
})

// Query endpoint - accepts natural language queries and executes them via the agent
app.post('/query', async (req: Request, res: Response) => {
    try {
        const { query, context } = req.body

        if (!query || typeof query !== 'string') {
            res.status(400).json({ error: 'query parameter is required' })
            return
        }

        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        console.log(`[Query] Processing for session ${sessionId}: ${query}`)

        const result = await session.agent.executeQuery(query, context)
        res.json(result)
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Streaming query endpoint - accepts natural language queries and streams responses
app.post('/query/stream', async (req: Request, res: Response) => {
    try {
        const { query, context } = req.body

        if (!query || typeof query !== 'string') {
            res.status(400).json({ error: 'query parameter is required' })
            return
        }

        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        console.log(`[Query Stream] Processing for session ${sessionId}: ${query}`)

        // Set up Server-Sent Events (SSE) headers
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')

        // Stream the response
        try {
            for await (const chunk of session.agent.executeQueryStream(query, context)) {
                // Send each chunk as a Server-Sent Event
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            res.end()
        } catch (streamError) {
            console.error('[Stream Error]', streamError)
            const errorChunk = {
                type: 'error',
                error: streamError instanceof Error ? streamError.message : 'Stream error',
            }
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`)
            res.end()
        }
    } catch (error) {
        console.error('[Error]', error)
        if (!res.headersSent) {
            res.status(500).json({
                error: error instanceof Error ? error.message : 'Unknown error',
            })
        }
    }
})

// History endpoint - get query history
app.get('/history', async (req: Request, res: Response) => {
    try {
        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        const history = session.agent.getHistory()

        // Calculate token count
        const tokenCount = estimateTokenCount(session.agent)

        res.json({ history, tokenCount })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Clear history endpoint
app.post('/history/clear', async (req: Request, res: Response) => {
    try {
        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        session.agent.clearHistory()
        res.json({ success: true })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Token usage endpoint
app.get('/tokens', async (req: Request, res: Response) => {
    try {
        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        const tokenCount = estimateTokenCount(session.agent)
        res.json({ tokenCount, sessionId })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Documentation suggestions endpoints
app.get('/suggestions', async (req: Request, res: Response) => {
    try {
        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        res.json({ suggestions: session.suggestions })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

app.post('/suggestions/clear', async (req: Request, res: Response) => {
    try {
        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        session.suggestions = []
        res.json({ success: true })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Activity tracking endpoints
app.get('/activities', async (req: Request, res: Response) => {
    try {
        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        res.json({ activities: session.activities })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

app.post('/activities/clear', async (req: Request, res: Response) => {
    try {
        const sessionId = getSessionId(req)
        const session = getSession(sessionId)
        session.activities = []
        res.json({ success: true })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Authentication status endpoint
app.get('/auth/status', async (_req: Request, res: Response) => {
    try {
        const status = await authManager.getStatus()
        res.json(status)
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Get OIDC auth URL (for client-side popup)
app.post('/auth/oidc/auth-url', async (req: Request, res: Response) => {
    try {
        const { vaultAddr, oidcMount, oidcRole, skipVerify } = req.body

        if (!vaultAddr) {
            res.status(400).json({ error: 'vaultAddr is required' })
            return
        }

        // Switch cluster but don't authenticate yet
        await authManager.switchCluster(vaultAddr, oidcMount, oidcRole, skipVerify)

        // Get the auth URL for client to open
        const authUrl = await authManager.getOIDCAuthUrl()

        res.json({ authUrl })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Complete OIDC authentication (after client opens popup)
app.post('/auth/oidc/complete', async (_req: Request, res: Response) => {
    try {
        await authManager.completeOIDCAuth()

        await resetAndClearAllSessions('oidc-auth-complete')

        res.json({ success: true })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Trigger authentication (useful for re-authentication)
// Accepts vaultAddr, authMethod, token (for token auth), oidcMount, oidcRole (for OIDC), skipVerify
app.post('/auth/login', async (req: Request, res: Response) => {
    try {
        const { vaultAddr, authMethod, token, oidcMount, oidcRole, skipVerify } = req.body

        if (!vaultAddr) {
            res.status(400).json({ error: 'vaultAddr is required' })
            return
        }

        // Switch cluster with appropriate auth method
        if (authMethod === 'token') {
            if (!token) {
                res.status(400).json({ error: 'token is required for token-based authentication' })
                return
            }
            await authManager.switchCluster(vaultAddr, undefined, undefined, skipVerify, token)
        } else {
            await authManager.switchCluster(vaultAddr, oidcMount, oidcRole, skipVerify)
            await authManager.authenticate()
        }

        await resetAndClearAllSessions('login')

        res.json({ success: true })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Switch to a different Vault cluster
app.post('/auth/switch-cluster', async (req: Request, res: Response) => {
    try {
        const { vaultAddr, oidcMount, oidcRole } = req.body

        if (!vaultAddr) {
            res.status(400).json({ error: 'vaultAddr is required' })
            return
        }

        await authManager.switchCluster(vaultAddr, oidcMount, oidcRole)

        await resetAndClearAllSessions('switch-cluster')

        res.json({ success: true })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Clear cached token (logout)
app.post('/auth/logout', async (_req: Request, res: Response) => {
    try {
        // Revoke token in Vault and clear from cache
        await authManager.clearToken()

        await resetAndClearAllSessions('logout')

        console.log('[Auth] Logout complete - token revoked, cache cleared, sessions reset')
        res.json({ success: true })
    } catch (error) {
        console.error('[Error]', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
        })
    }
})

// Start server
app.listen(port, () => {
    console.log(`🔍 Hashi Lens API listening on port ${port}`)
    console.log(`Available endpoints:`)
    console.log(`  POST /query - Execute a query via the agent`)
    console.log(`  GET /history - Retrieve query history`)
    console.log(`  POST /history/clear - Clear query history`)
    console.log(`  GET /auth/status - Get authentication status`)
    console.log(`  POST /auth/login - Trigger authentication (accepts vaultAddr, oidcMount, oidcRole)`)
    console.log(`  POST /auth/switch-cluster - Switch to different Vault cluster`)
    console.log(`  POST /auth/logout - Clear cached token`)
    console.log(``)
    console.log(`🌐 Frontend available at: http://${uiHostname}:${uiPort}`)
})
