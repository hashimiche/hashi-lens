import { boundaryProduct } from './boundary.js'
import { consulProduct } from './consul.js'
import { nomadProduct } from './nomad.js'
import { obsProduct } from './obs.js'
import { terraformProduct } from './terraform.js'
import { vaultProduct } from './vault.js'
import type { ProductDescriptor, ProductDoc } from './types.js'

export type { ProductDescriptor, ProductDoc } from './types.js'

export const PRODUCT_CATALOG: ProductDescriptor[] = [
    vaultProduct,
    terraformProduct,
    boundaryProduct,
    consulProduct,
    nomadProduct,
    obsProduct,
]

export function detectPrimaryProduct(query: string): ProductDescriptor | null {
    const lower = query.toLowerCase()
    const candidates = PRODUCT_CATALOG.flatMap((product) =>
        product.aliases.map((alias) => ({ product, alias }))
    ).sort((left, right) => right.alias.length - left.alias.length)

    for (const candidate of candidates) {
        const escaped = candidate.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
            return candidate.product
        }
    }

    return null
}

export function isProductTestingIntent(query: string): boolean {
    return /\b(test|testing|smoke test|validate|validation|try|trying|get started|getting started|start with|what should i do|how should i start|how do i start|first steps)\b/i.test(query)
}

export function isProductSetupIntent(query: string): boolean {
    return /\b(local|deploy|setup|set up|install|bring up|spin up|run locally|is it possible|can i do this|can i use hal)\b/i.test(query)
}

export function getProductDocumentationSuggestions(combined: string): ProductDoc[] {
    const normalized = combined.toLowerCase()
    return PRODUCT_CATALOG.flatMap((product) =>
        product.aliases.some((alias) => normalized.includes(alias)) ? product.docs : []
    )
}

export function getProductScenarioPlaybookPrompt(): string {
    const lines: string[] = [
        'Product Scenario Playbooks (HAL-first):',
        '- Always detect primary product intent first (vault, terraform, boundary, consul, nomad, obs).',
        '- For deploy/setup/status guidance, prefer `get_hal_status` + `get_hal_help` before proposing commands.',
        '- For command outputs, only keep HAL commands that are verified from local recommendedCommands.',
    ]

    for (const product of PRODUCT_CATALOG) {
        if (!product.scenarioPlaybook || product.scenarioPlaybook.length === 0) continue
        lines.push(`- ${product.displayName} (${product.halName}):`)
        for (const scenario of product.scenarioPlaybook) {
            lines.push(`  * ${scenario}`)
        }
    }

    return lines.join('\n')
}