import { useEffect, useMemo, useState } from 'react'
import './HalStatusPanel.css'

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

function statusDot(state: 'running' | 'not-deployed' | 'enabled' | 'disabled' | 'unknown') {
    if (state === 'running' || state === 'enabled') return '🟢'
    if (state === 'not-deployed' || state === 'disabled') return '⚪'
    return '🟡'
}

export function HalStatusPanel() {
    const [data, setData] = useState<HalStatusResponse | null>(null)
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const response = await fetch('/api/hal/status')
                if (!response.ok) {
                    throw new Error('Failed to fetch HAL status')
                }
                const statusData = (await response.json()) as HalStatusResponse
                setData(statusData)
            } catch (err) {
                setData({ products: [], raw: '', error: err instanceof Error ? err.message : 'Unknown error' })
            }
        }

        fetchStatus()
        const interval = setInterval(fetchStatus, 8000)
        return () => clearInterval(interval)
    }, [])

    const products = useMemo(() => data?.products || [], [data])

    if (!data) {
        return <div className="hal-status-panel">Loading HAL status...</div>
    }

    return (
        <div className="hal-status-panel">
            <div className="hal-status-header">
                <h3>HAL Global Status</h3>
                <span className="hal-status-subtitle">Live product and feature readiness</span>
            </div>

            {data.error && (
                <div className="hal-status-error">
                    <strong>Unable to read hal status</strong>
                    <span>{data.error}</span>
                </div>
            )}

            <div className="hal-status-products">
                {products.map((product) => {
                    const isOpen = !!expanded[product.name]
                    const hasFeatures = product.features.length > 0
                    return (
                        <div className={`hal-product-card ${product.state}`} key={product.name}>
                            <button
                                type="button"
                                className="hal-product-header"
                                onClick={() => setExpanded((prev) => ({ ...prev, [product.name]: !isOpen }))}
                            >
                                <span className="hal-product-left">
                                    <span className="hal-dot" aria-hidden>{statusDot(product.state)}</span>
                                    <span className="hal-product-name">{product.name}</span>
                                </span>
                                <span className="hal-product-meta">
                                    <span className="hal-product-state">{product.state === 'running' ? 'Running' : 'Not Deployed'}</span>
                                    {hasFeatures && <span className="hal-expand-indicator">{isOpen ? '▾' : '▸'}</span>}
                                </span>
                            </button>

                            <div className="hal-product-summary">
                                <span>{product.endpoint}</span>
                                <span>{product.version}</span>
                            </div>

                            {isOpen && hasFeatures && (
                                <div className="hal-feature-list">
                                    {product.features.map((feature) => (
                                        <div className="hal-feature-row" key={`${product.name}-${feature.name}`}>
                                            <span className="hal-feature-main">
                                                <span className="hal-dot" aria-hidden>{statusDot(feature.status)}</span>
                                                <span>{feature.name}</span>
                                            </span>
                                            <span className="hal-feature-details">{feature.details || feature.status}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
