import { useState, useEffect } from 'react'
import './ActivityPanel.css'

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

interface ActivityPanelProps {
    sessionId: string
}

export function ActivityPanel({ sessionId }: ActivityPanelProps) {
    const [activities, setActivities] = useState<Activity[]>([])
    const [collapsed, setCollapsed] = useState(false)
    const visibleToolCalls = activities
        .filter((activity) => activity.type === 'tool_call')
        .slice(-6)

    useEffect(() => {
        // Poll for activities
        const fetchActivities = async () => {
            try {
                const response = await fetch('/api/activities', {
                    headers: {
                        'X-Session-ID': sessionId
                    }
                })
                if (response.ok) {
                    const data = await response.json()
                    setActivities(data.activities || [])
                }
            } catch (err) {
                console.error('Failed to fetch activities:', err)
            }
        }

        fetchActivities()
        const interval = setInterval(fetchActivities, 1000) // Poll every second for real-time updates
        return () => clearInterval(interval)
    }, [sessionId])

    const getActivityIcon = (activity: Activity) => {
        if (activity.type === 'tool_call') {
            if (activity.toolType === 'vault') return '🔐'
            if (activity.toolType === 'audit') return '📋'
            if (activity.toolType === 'hal') return '🤖'
            if (activity.toolType === 'system') return '⚙️'
            return '🔧'
        }
        if (activity.type === 'result') {
            if (activity.status === 'error') return '❌'
            if (activity.status === 'success') return '✅'
            return '✓'
        }
        return '💭'
    }

    const getStatusClass = (activity: Activity) => {
        if (activity.status === 'running') return 'running'
        if (activity.status === 'error') return 'error'
        if (activity.status === 'success') return 'success'
        return ''
    }

    return (
        <section className={`activity-panel ${collapsed ? 'collapsed' : ''}`}>
            <button
                type="button"
                className="activity-panel-toggle"
                onClick={() => setCollapsed((prev) => !prev)}
            >
                <span className="activity-panel-title">Execution Feed</span>
                <span className="activity-panel-meta">{visibleToolCalls.length} recent calls</span>
                <span className="activity-panel-chevron" aria-hidden>{collapsed ? '▸' : '▾'}</span>
            </button>

            {!collapsed && (
                <div className="activity-content">
                    {visibleToolCalls.map((activity, index) => {
                    // Calculate opacity based on position (older items at top fade out)
                    // Newest (bottom, last index) = 1.0, oldest (top, index 0) = 0.3
                    const positionFromEnd = visibleToolCalls.length - 1 - index
                    const opacity = Math.max(0.3, 1 - (positionFromEnd * 0.14))

                    return (
                        <div
                            key={activity.id}
                            className={`activity-item ${getStatusClass(activity)}`}
                            style={{ opacity }}
                        >
                            <div className="activity-item-header">
                                <span className="activity-item-icon">
                                    {getActivityIcon(activity)}
                                </span>
                                <span className="activity-item-title">
                                    {activity.toolName || activity.type}
                                </span>
                                {activity.duration && (
                                    <span className="activity-item-duration">
                                        {activity.duration}ms
                                    </span>
                                )}
                            </div>
                            {activity.description && (
                                <div className="activity-item-description">
                                    {activity.description}
                                </div>
                            )}
                            {activity.error && (
                                <div className="activity-item-error">{activity.error}</div>
                            )}
                        </div>
                    )
                    })}
                </div>
            )}
        </section>
    )
}
