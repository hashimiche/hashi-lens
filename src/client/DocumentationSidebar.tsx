import { useState, useEffect, useCallback } from 'react'
import './DocumentationSidebar.css'

interface DocumentationSuggestion {
    id: string
    title: string
    url: string
    description: string
    context?: string
    timestamp: string
}

interface DocumentationSidebarProps {
    sessionId: string;
    authenticated: boolean;
}

export function DocumentationSidebar({ sessionId, authenticated }: DocumentationSidebarProps) {
    const [suggestions, setSuggestions] = useState<DocumentationSuggestion[]>([])
    const [collapsed, setCollapsed] = useState(false)

    // Keep auth poller active for other components that rely on status refresh events.
    const checkAuth = useCallback(async () => {
        try {
            const response = await fetch('/api/auth/status')
            if (response.ok) {
                await response.json()
            }
        } catch (err) {
            console.error('Failed to check auth status:', err)
        }
    }, [])

    // Listen for global status refresh events
    useEffect(() => {
        const handler = () => {
            checkAuth()
        }
        window.addEventListener('vault-auth-status-refresh', handler)
        return () => window.removeEventListener('vault-auth-status-refresh', handler)
    }, [checkAuth])

    useEffect(() => {
        checkAuth()
        const interval = setInterval(checkAuth, 30000) // Check every 30 seconds
        return () => clearInterval(interval)
    }, [checkAuth])

    // Previously attempted to register a handler with onAuthLoadingChange;
    // keep using polling and global events instead to refresh OIDC status.

    useEffect(() => {
        // Poll for suggestions
        const fetchSuggestions = async () => {
            try {
                const response = await fetch('/api/suggestions', {
                    headers: {
                        'X-Session-ID': sessionId
                    }
                })
                if (response.ok) {
                    const data = await response.json()
                    setSuggestions(data.suggestions || [])
                }
            } catch (err) {
                console.error('Failed to fetch documentation suggestions:', err)
            }
        }

        fetchSuggestions()
        const interval = setInterval(fetchSuggestions, 2000) // Poll every 2 seconds
        return () => clearInterval(interval)
    }, [sessionId, authenticated])

    return (
        <section className={`documentation-sidebar ${collapsed ? 'collapsed' : ''}`}>
            <button
                type="button"
                className="documentation-toggle"
                onClick={() => setCollapsed((prev) => !prev)}
            >
                <span className="documentation-title">Proposed Docs</span>
                <span className="documentation-count">{suggestions.length}</span>
                <span className="documentation-chevron" aria-hidden>{collapsed ? '▸' : '▾'}</span>
            </button>

            {!collapsed && (
                <div className="documentation-content">
                    {suggestions.length === 0 && (
                        <div className="documentation-empty">Docs will appear here as the assistant answers.</div>
                    )}

                    {suggestions.map((suggestion) => (
                        <details key={suggestion.id} className="documentation-card">
                            <summary className="documentation-card-title">{suggestion.title}</summary>
                            <p className="documentation-card-description">{suggestion.description}</p>
                            {suggestion.context && (
                                <p className="documentation-card-context">
                                    <em>{suggestion.context}</em>
                                </p>
                            )}
                            <a
                                href={suggestion.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="documentation-card-link"
                            >
                                Open Documentation →
                            </a>
                        </details>
                    ))}
                </div>
            )}
        </section>
    )
}
