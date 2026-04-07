export interface ProductDoc {
    title: string
    url: string
    description: string
}

export interface ProductAccessDefaults {
    portalUrl?: string
    username?: string
    password?: string
    email?: string
    notes?: string[]
}

export interface ProductDescriptor {
    id: string
    displayName: string
    halName: string
    halStatusName: string
    aliases: string[]
    smokeTestLabel: string
    runningSteps: string[]
    scenarioPlaybook?: string[]
    docs: ProductDoc[]
    accessDefaults?: ProductAccessDefaults
}