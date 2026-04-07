import { ProductDescriptor } from './types.js'

export const nomadProduct: ProductDescriptor = {
    id: 'nomad',
    displayName: 'Nomad',
    halName: 'nomad',
    halStatusName: 'Nomad',
    aliases: ['nomad'],
    smokeTestLabel: 'job scheduling, allocations, and logs',
    runningSteps: [
        'Open the Nomad UI and verify the cluster view is healthy.',
        'Run a small sample job and confirm an allocation is created successfully.',
        'Inspect allocation status and logs to prove the job lifecycle works end to end.',
    ],
    scenarioPlaybook: [
        'Deploy/status: call `get_hal_status` (product=`nomad`) before job-level recommendations.',
        'Job validation: require at least one successful allocation and log inspection.',
        'Troubleshooting: distinguish scheduler/control-plane failures from workload configuration issues.',
    ],
    docs: [
        {
            title: 'Nomad Documentation',
            url: 'https://developer.hashicorp.com/nomad/docs',
            description: 'Nomad cluster concepts, jobs, and operational guidance.',
        },
    ],
}