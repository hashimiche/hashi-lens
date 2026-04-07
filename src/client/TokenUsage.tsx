/**
 * Token Usage Component
 * 
 * Displays current token usage and remaining context window
 */

import './TokenUsage.css'

interface TokenUsageProps {
    tokenCount: {
        total: number
        messages: number
        maxContext: number
    } | null
    compact?: boolean
}

export function TokenUsage({ tokenCount, compact = false }: TokenUsageProps) {
    if (!tokenCount) {
        return null
    }

    const { total, messages, maxContext } = tokenCount
    const percentage = Math.min((total / maxContext) * 100, 100)
    const remaining = Math.max(maxContext - total, 0)

    // Determine color based on usage
    let statusClass = 'safe'
    if (percentage > 80) {
        statusClass = 'critical'
    } else if (percentage > 60) {
        statusClass = 'warning'
    }

    if (compact) {
        return (
            <div className={`token-chip ${statusClass}`} title={`${total.toLocaleString()} / ${maxContext.toLocaleString()} tokens`}>
                <span className="token-chip-icon" aria-hidden>◔</span>
                <span className="token-chip-label">Context</span>
                <span className="token-chip-percent">{Math.round(percentage)}%</span>
                <div className="token-chip-track" aria-hidden>
                    <div
                        className={`token-chip-fill ${statusClass}`}
                        style={{ width: `${percentage}%` }}
                    />
                </div>
                <div className="token-chip-popover">
                    <div>{total.toLocaleString()} / {maxContext.toLocaleString()} tokens</div>
                    <div>{messages} messages</div>
                    <div>{remaining.toLocaleString()} remaining</div>
                </div>
            </div>
        )
    }

    return (
        <div className="token-usage">
            <div className="token-usage-header">
                <span className="token-usage-label">Context</span>
                <span className="token-usage-stats">
                    {total.toLocaleString()} / {maxContext.toLocaleString()} tokens
                </span>
            </div>
            <div className="token-usage-bar-container">
                <div
                    className={`token-usage-bar ${statusClass}`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            <div className="token-usage-info">
                <span className="token-usage-messages">{messages} messages</span>
                <span className="token-usage-remaining">
                    {remaining.toLocaleString()} remaining
                </span>
            </div>
        </div>
    )
}
