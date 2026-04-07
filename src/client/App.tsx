import React, { useState, useRef, useEffect, useCallback } from 'react'
import { MarkdownText } from './MarkdownText'
import { DocumentationSidebar } from './DocumentationSidebar'
import { ActivityPanel } from './ActivityPanel'
import { TokenUsage } from './TokenUsage'
import './App.css'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: string
    toolCalls?: Array<{ type: string; tool: string; arguments: Record<string, unknown> }>
    toolResults?: Array<{ type: string; tool: string; success: boolean; result?: unknown; error?: string }>
}

interface RuntimeInfo {
    ui: { url: string }
    loki: { url: string; ready: boolean; hint: string | null }
    halMcp?: { command: string; executable: boolean; hint: string | null }
    ollama?: {
        url: string
        model: string
        reachable: boolean
        installed: boolean
        hint: string | null
    }
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

interface HalStatusResponse {
    products: HalProductStatus[]
    raw: string
    error?: string
}

function App() {
    // Generate or retrieve session ID
    const getSessionId = () => {
        let sessionId = localStorage.getItem('hashilens-session-id')
        if (!sessionId) {
            sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            localStorage.setItem('hashilens-session-id', sessionId)
        }
        return sessionId
    }

    const sessionId = useRef(getSessionId())

    const [messages, setMessages] = useState<Message[]>([
        {
            id: '0',
            role: 'assistant',
            content: 'Hello! I\'m Hashi Lens. I can help with HAL workflows, Vault configuration, audit analysis, and Terraform guidance. You can start chatting now, and optionally connect Vault when you want live cluster inspection.',
            timestamp: new Date().toISOString(),
        },
    ])
    const [input, setInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [authenticated, setAuthenticated] = useState<boolean>(true)
    const [authLoading, setAuthLoading] = useState(false)
    const [authLoadingMessage, setAuthLoadingMessage] = useState<string | null>(null)
    // True after auth network calls finish but before UI is fully ready to use
    const [authPendingUiReady, setAuthPendingUiReady] = useState(false)
    const [tokenCount, setTokenCount] = useState<{ total: number; messages: number; maxContext: number } | null>(null)
    const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
    const [halStatus, setHalStatus] = useState<HalStatusResponse | null>(null)
    const [showReadyBanners, setShowReadyBanners] = useState(true)
    const [uiReadyForAuth] = useState(false)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const messagesContainerRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)

    // Check authentication status
    const checkAuth = useCallback(async () => {
        try {
            const response = await fetch('/api/auth/status')
            if (response.ok) {
                const data = await response.json()
                setAuthenticated(data.authenticated)
            }
        } catch (err) {
            console.error('Failed to check authentication:', err)
        }
    }, [])

    useEffect(() => {
        checkAuth()
        const interval = setInterval(checkAuth, 2000) // Check every 2 seconds for quick auth detection
        const handleAuthRefresh = () => {
            void checkAuth()
        }
        window.addEventListener('vault-auth-status-refresh', handleAuthRefresh)
        return () => {
            clearInterval(interval)
            window.removeEventListener('vault-auth-status-refresh', handleAuthRefresh)
        }
    }, [checkAuth])

    // Safety timeout: clear loading state if it's been active too long (prevents stuck state)
    useEffect(() => {
        if (authLoading && authLoadingMessage) {
            const safetyTimer = setTimeout(() => {
                console.warn('Loading state timeout - clearing after 30 seconds')
                setAuthLoading(false)
                setAuthLoadingMessage(null)
                setAuthPendingUiReady(false)
            }, 30000) // 30 second safety timeout

            return () => clearTimeout(safetyTimer)
        }
        return undefined
    }, [authLoading, authLoadingMessage])

    // Keep auth loading overlay visible until the UI is truly ready.
    // For login: wait for authenticated=true and one paint cycle.
    // For logout: wait for unauthenticated UI-ready callback.
    useEffect(() => {
        if (!authLoading || !authPendingUiReady) return undefined

        if (authenticated) {
            const timer = setTimeout(() => {
                setAuthLoading(false)
                setAuthLoadingMessage(null)
                setAuthPendingUiReady(false)
            }, 150)
            return () => clearTimeout(timer)
        }

        if (!authenticated && uiReadyForAuth) {
            setAuthLoading(false)
            setAuthLoadingMessage(null)
            setAuthPendingUiReady(false)
        }
        return undefined
    }, [authLoading, authPendingUiReady, authenticated, uiReadyForAuth])

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }

    useEffect(() => {
        if (autoScrollEnabled) {
            scrollToBottom()
        }
    }, [messages, autoScrollEnabled])

    const handleMessagesScroll = useCallback(() => {
        const container = messagesContainerRef.current
        if (!container) return

        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
        const nearBottom = distanceFromBottom < 40

        if (nearBottom) {
            if (!autoScrollEnabled) setAutoScrollEnabled(true)
            return
        }

        if (autoScrollEnabled) setAutoScrollEnabled(false)
    }, [autoScrollEnabled])

    const handleJumpToLatest = useCallback(() => {
        setAutoScrollEnabled(true)
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [])

    // Auto-focus input on mount and after loading completes
    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    useEffect(() => {
        if (!loading) {
            inputRef.current?.focus()
        }
    }, [loading])

    useEffect(() => {
        const fetchRuntimeInfo = async () => {
            try {
                const response = await fetch('/api/runtime-info')
                if (response.ok) {
                    const data = await response.json()
                    setRuntimeInfo(data)
                }
            } catch (err) {
                console.error('Failed to fetch runtime info:', err)
            }
        }

        fetchRuntimeInfo()
        const interval = setInterval(fetchRuntimeInfo, 15000)
        return () => clearInterval(interval)
    }, [])

    useEffect(() => {
        const fetchHalStatus = async () => {
            try {
                const response = await fetch('/api/hal/status')
                if (response.ok) {
                    const data = await response.json() as HalStatusResponse
                    setHalStatus(data)
                }
            } catch (err) {
                console.error('Failed to fetch HAL status:', err)
            }
        }

        fetchHalStatus()
        const interval = setInterval(fetchHalStatus, 12000)
        return () => clearInterval(interval)
    }, [])

    useEffect(() => {
        if (!runtimeInfo?.loki || !runtimeInfo?.ollama) return
        if (!(runtimeInfo.loki.ready && runtimeInfo.ollama.reachable && runtimeInfo.ollama.installed)) return

        const timer = setTimeout(() => {
            setShowReadyBanners(false)
        }, 4500)

        return () => clearTimeout(timer)
    }, [runtimeInfo])
    // Fetch token count periodically
    useEffect(() => {
        const fetchTokenCount = async () => {
            try {
                const response = await fetch('/api/tokens', {
                    headers: { 'X-Session-ID': sessionId.current }
                })
                if (response.ok) {
                    const data = await response.json()
                    setTokenCount(data.tokenCount)
                }
            } catch (err) {
                console.error('Failed to fetch token count:', err)
            }
        }

        fetchTokenCount()
        const interval = setInterval(fetchTokenCount, 5000) // Update every 5 seconds
        return () => clearInterval(interval)
    }, [messages])
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!input.trim() || loading) return

        // Add user message
        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: input,
            timestamp: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, userMessage])
        setInput('')
        setLoading(true)
        setError(null)

        // Create placeholder assistant message that we'll update as we stream
        const assistantId = (Date.now() + 1).toString()
        const assistantMessage: Message = {
            id: assistantId,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            toolCalls: [],
            toolResults: [],
        }
        setMessages((prev) => [...prev, assistantMessage])

        try {
            const response = await fetch('/api/query/stream', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-ID': sessionId.current
                },
                body: JSON.stringify({ query: userMessage.content }),
            })

            if (!response.ok) {
                let serverError = 'Failed to start streaming query'
                try {
                    const data = await response.json()
                    if (data?.error && typeof data.error === 'string') {
                        serverError = data.error
                    }
                } catch (_parseError) {
                    // Ignore parse failures and keep fallback message.
                }
                throw new Error(serverError)
            }

            if (!response.body) {
                throw new Error('No response body for streaming')
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''

            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() || ''

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6)
                        if (data.trim()) {
                            const chunk = JSON.parse(data)

                            if (chunk.type === 'text') {
                                // Append text to the assistant message
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === assistantId
                                            ? { ...msg, content: msg.content + chunk.content }
                                            : msg
                                    )
                                )
                            } else if (chunk.type === 'tool_call') {
                                // Add tool call to the message
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === assistantId
                                            ? {
                                                ...msg,
                                                toolCalls: [...(msg.toolCalls || []), chunk.toolCall],
                                            }
                                            : msg
                                    )
                                )
                            } else if (chunk.type === 'tool_result') {
                                // Add tool result to the message
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === assistantId
                                            ? {
                                                ...msg,
                                                toolResults: [
                                                    ...(msg.toolResults || []),
                                                    chunk.toolResult,
                                                ],
                                            }
                                            : msg
                                    )
                                )
                            } else if (chunk.type === 'done') {
                                // Final update with complete result
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === assistantId
                                            ? {
                                                ...msg,
                                                content: chunk.result.response,
                                                toolCalls: chunk.result.toolCalls,
                                                toolResults: chunk.result.toolResults,
                                                timestamp: chunk.result.timestamp,
                                            }
                                            : msg
                                    )
                                )
                            } else if (chunk.type === 'error') {
                                throw new Error(chunk.error)
                            }
                        }
                    }
                }
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error'
            setError(message)
            console.error('Error:', err)
            // Remove the incomplete assistant message
            setMessages((prev) => prev.filter((msg) => msg.id !== assistantId))
        } finally {
            setLoading(false)
        }
    }

    const handleClearHistory = async () => {
        try {
            await fetch('/api/history/clear', {
                method: 'POST',
                headers: { 'X-Session-ID': sessionId.current }
            })
            await fetch('/api/suggestions/clear', {
                method: 'POST',
                headers: { 'X-Session-ID': sessionId.current }
            })
            setMessages([
                {
                    id: '0',
                    role: 'assistant',
                    content: 'Hello! I\'m Hashi Lens. I can help with HAL workflows, Vault configuration, audit analysis, and Terraform guidance. What would you like to do?',
                    timestamp: new Date().toISOString(),
                },
            ])
            // Reset token count
            setTokenCount(null)
        } catch (err) {
            console.error('Error clearing history:', err)
        }
    }

    // Restore welcome message when re-authenticated
    useEffect(() => {
        if (authenticated && messages.length === 0) {
            setMessages([
                {
                    id: '0',
                    role: 'assistant',
                    content: 'Hello! I\'m Hashi Lens. I can help with HAL workflows, Vault configuration, audit analysis, and Terraform guidance. What would you like to do?',
                    timestamp: new Date().toISOString(),
                },
            ])
        }
    }, [authenticated, messages.length])

    // Helper to detect if content contains markdown tables or code blocks
    const hasTableContent = (content: string): boolean => {
        // Check for markdown table syntax (lines with multiple |)
        const lines = content.split('\n')
        const hasTable = lines.some(line => {
            const pipeCount = (line.match(/\|/g) || []).length
            return pipeCount >= 2 // At least 2 pipes indicates table columns
        })
        // Check for code blocks (triple backticks)
        const hasCodeBlock = content.includes('```')
        return hasTable || hasCodeBlock
    }

    const hasUserMessages = messages.some((msg) => msg.role === 'user')
    const lokiReady = !!runtimeInfo?.loki?.ready
    const ollamaReady = !!(runtimeInfo?.ollama?.reachable && runtimeInfo?.ollama?.installed)
    const halMcpReady = runtimeInfo?.halMcp?.executable ?? true

    const showLokiBanner = !!runtimeInfo?.loki && (!lokiReady || showReadyBanners)
    const showOllamaBanner = !!runtimeInfo?.ollama && (!ollamaReady || showReadyBanners)
    const halProducts = halStatus?.products || []

    return (
        <>
            {/* Global auth loading overlay: only show when authentication is actively loading */}
            {authLoading && (
                <div className="auth-loading-overlay">
                    <div className="auth-loading-content">
                        <div className="auth-loading-spinner"></div>
                        <div className="auth-loading-message">{authLoadingMessage || 'Loading...'}</div>
                    </div>
                </div>
            )}

            <div className={`app ${hasUserMessages ? 'compact' : 'landing'}`}>
                <div className="workspace-layout">
                    <aside className="left-column">
                        <ActivityPanel sessionId={sessionId.current} />
                        <DocumentationSidebar
                            sessionId={sessionId.current}
                            authenticated={authenticated}
                        />
                    </aside>

                    <div className="right-column">
                        <header className="app-header">
                            <div className="header-content">
                                <img src="/hal_logo.png" alt="Hashi Lens" className="vault-logo" />
                                <div className="header-text">
                                    <h1>Hashi Lens</h1>
                                    <p>[ Agent-powered HAL + HashiCorp operations interface ]</p>
                                </div>
                            </div>
                            <div className="status-chip-row">
                                {runtimeInfo?.loki && (
                                    <div className={`status-chip ${lokiReady ? 'ok' : 'warn'}`}>
                                        <span className="status-dot" aria-hidden>{lokiReady ? '●' : '○'}</span>
                                        <span>Loki</span>
                                        <span className="status-chip-popover">
                                            {runtimeInfo.loki.url} · {lokiReady ? 'ready' : 'not reachable'}
                                            {runtimeInfo.loki.hint ? ` · ${runtimeInfo.loki.hint}` : ''}
                                        </span>
                                    </div>
                                )}
                                {runtimeInfo?.ollama && (
                                    <div className={`status-chip ${ollamaReady ? 'ok' : 'warn'}`}>
                                        <span className="status-dot" aria-hidden>{ollamaReady ? '●' : '○'}</span>
                                        <span>Ollama</span>
                                        <span className="status-chip-popover">
                                            {runtimeInfo.ollama.url} · model {runtimeInfo.ollama.model} · {ollamaReady ? 'ready' : (runtimeInfo.ollama.reachable ? 'model missing' : 'not reachable')}
                                            {runtimeInfo.ollama.hint ? ` · ${runtimeInfo.ollama.hint}` : ''}
                                        </span>
                                    </div>
                                )}
                                {runtimeInfo?.halMcp && (
                                    <div className={`status-chip ${halMcpReady ? 'ok' : 'warn'}`}>
                                        <span className="status-dot" aria-hidden>{halMcpReady ? '●' : '○'}</span>
                                        <span>HAL MCP</span>
                                        <span className="status-chip-popover">
                                            {runtimeInfo.halMcp.command} · {halMcpReady ? 'executable' : 'not executable'}
                                            {runtimeInfo.halMcp.hint ? ` · ${runtimeInfo.halMcp.hint}` : ''}
                                        </span>
                                    </div>
                                )}
                                {halProducts.map((product) => {
                                    const running = product.state === 'running'
                                    return (
                                        <div key={product.name} className={`status-chip ${running ? 'ok' : 'warn'}`}>
                                            <span className="status-dot" aria-hidden>{running ? '●' : '○'}</span>
                                            <span>{product.name}</span>
                                            <span className="status-chip-popover">
                                                {product.endpoint || 'endpoint unknown'} · {running ? 'running' : 'not deployed'} · v{product.version}
                                                {product.features.length > 0
                                                    ? ` · ${product.features.map((feature) => `${feature.name}:${feature.status}`).join(', ')}`
                                                    : ''}
                                            </span>
                                        </div>
                                    )
                                })}
                                <TokenUsage tokenCount={tokenCount} compact />
                            </div>
                            {showLokiBanner && runtimeInfo?.loki && (
                                <div className={`loki-status-banner ${runtimeInfo.loki.ready ? 'ready' : 'not-ready'}`}>
                                    <span>
                                        Loki: {runtimeInfo.loki.url} · {runtimeInfo.loki.ready ? 'ready' : 'not reachable'}
                                    </span>
                                    {!runtimeInfo.loki.ready && runtimeInfo.loki.hint && (
                                        <span className="loki-hint">{runtimeInfo.loki.hint}</span>
                                    )}
                                </div>
                            )}
                            {showOllamaBanner && runtimeInfo?.ollama && (
                                <div
                                    className={`loki-status-banner ${runtimeInfo.ollama.reachable && runtimeInfo.ollama.installed ? 'ready' : 'not-ready'}`}
                                >
                                    <span>
                                        Ollama: {runtimeInfo.ollama.url} · model {runtimeInfo.ollama.model} · {runtimeInfo.ollama.reachable ? (runtimeInfo.ollama.installed ? 'ready' : 'model missing') : 'not reachable'}
                                    </span>
                                    {runtimeInfo.ollama.hint && (
                                        <span className="loki-hint">{runtimeInfo.ollama.hint}</span>
                                    )}
                                </div>
                            )}
                        </header>

                        <div className="main-layout">
                        <div className="center-content">
                        <div className="chat-container">
                            <div
                                ref={messagesContainerRef}
                                className="messages"
                                onScroll={handleMessagesScroll}
                            >
                                {messages.map((msg) => {
                                    const messageClasses = `message message-${msg.role}${hasTableContent(msg.content) ? ' has-table' : ''}`
                                    return (
                                        <div key={msg.id} className={messageClasses}>
                                            <div className="message-header">
                                                {msg.role === 'user' ? (
                                                    <span className="message-role">Me</span>
                                                ) : (
                                                    <img src="/vault-icon-black.png" alt="Hashi Lens" className="message-avatar" />
                                                )}
                                                <span className="message-time">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                                            </div>
                                            <div className="message-content">
                                                {msg.content ? (
                                                    <MarkdownText content={msg.content} />
                                                ) : msg.role === 'assistant' ? (
                                                    <span className="thinking-dots">
                                                        <span>.</span><span>.</span><span>.</span>
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                    )
                                })}
                                {error && (
                                    <div className="message message-error">
                                        <div className="message-header">
                                            <span className="message-role">Error</span>
                                        </div>
                                        <div className="message-content">{error}</div>
                                    </div>
                                )}
                                <div ref={messagesEndRef} />
                            </div>
                        </div>

                        {loading && !autoScrollEnabled && (
                            <div className="auto-scroll-chip-row">
                                <button
                                    type="button"
                                    className="auto-scroll-chip"
                                    onClick={handleJumpToLatest}
                                >
                                    Auto-scroll paused · Jump to latest
                                </button>
                            </div>
                        )}

                        <div className="input-area">
                            <form onSubmit={handleSubmit} className="input-form">
                                <textarea
                                    ref={inputRef}
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault()
                                            handleSubmit(e as unknown as React.FormEvent)
                                        }
                                    }}
                                    placeholder="Ask about HAL, Vault, Terraform, or audits... (Enter to send, Shift+Enter for new line)"
                                    disabled={loading}
                                    rows={3}
                                />
                                <div className="button-group">
                                    <button type="submit" disabled={loading || !input.trim()} className="button-primary">
                                        {loading ? 'Sending...' : 'Send'}
                                    </button>
                                    <button type="button" onClick={handleClearHistory} disabled={loading} className="button-secondary">
                                        Clear History
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>

                </div>

                </div>

            </div>
        </>
    )
}

export default App
