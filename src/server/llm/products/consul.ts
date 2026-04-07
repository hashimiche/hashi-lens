import { ProductDescriptor } from './types.js'

export const consulProduct: ProductDescriptor = {
    id: 'consul',
    displayName: 'Consul',
    halName: 'consul',
    halStatusName: 'Consul',
    aliases: ['consul'],
    smokeTestLabel: 'catalog visibility, service registration, and health checks',
    runningSteps: [
        'Open the Consul UI and verify the server is reachable.',
        'Register or inspect a small service and make sure it appears in the catalog.',
        'Validate health checks and service discovery behavior from the UI or API.',
    ],
    scenarioPlaybook: [
        'Deploy/status: call `get_hal_status` (product=`consul`) first and keep commands HAL-verified only.',
        'Validation: require at least one service registration + health check confirmation.',
        'Troubleshooting: separate control-plane reachability issues from catalog/service-check issues.',
    ],
    docs: [
        {
            title: 'Consul Documentation',
            url: 'https://developer.hashicorp.com/consul/docs',
            description: 'Consul concepts, service discovery, and operator workflows.',
        },
    ],
}