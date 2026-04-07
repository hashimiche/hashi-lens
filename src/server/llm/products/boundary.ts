import { ProductDescriptor } from './types.js'

export const boundaryProduct: ProductDescriptor = {
    id: 'boundary',
    displayName: 'Boundary',
    halName: 'boundary',
    halStatusName: 'Boundary',
    aliases: ['boundary'],
    smokeTestLabel: 'target discovery and session brokering',
    runningSteps: [
        'Open the Boundary UI and verify you can authenticate.',
        'Create or inspect a scope, project, host catalog, and at least one target.',
        'Start a test session to confirm the control plane and worker path are functioning.',
    ],
    scenarioPlaybook: [
        'Deploy/status: call `get_hal_status` (product=`boundary`) before recommending setup actions.',
        'SSH/target flows: prioritize HAL commands and session validation steps over generic architecture talk.',
        'When deployed: emphasize target reachability and one successful brokered session as minimum validation.',
    ],
    docs: [
        {
            title: 'Boundary Documentation',
            url: 'https://developer.hashicorp.com/boundary/docs',
            description: 'Core concepts and operator workflows for Boundary.',
        },
    ],
}