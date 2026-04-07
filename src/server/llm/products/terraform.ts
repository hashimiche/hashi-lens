import { ProductDescriptor } from './types.js'

export const terraformProduct: ProductDescriptor = {
    id: 'tfe',
    displayName: 'Terraform Enterprise',
    halName: 'terraform',
    halStatusName: 'TFE',
    aliases: [
        'terraform enterprise',
        'tf enterprise',
        'tf',
        'tf-enterprise',
        'tfe',
        'terraform',
    ],
    smokeTestLabel: 'workspace creation, run execution, and state visibility',
    runningSteps: [
        'Open the TFE UI and verify you can sign in and reach the application normally.',
        'Create a small test organization or workspace and upload or connect a minimal Terraform configuration.',
        'Trigger a plan and apply, then verify run logs, outputs, and state history are visible.',
    ],
    scenarioPlaybook: [
        'Deploy/setup: use `get_hal_status` (product=`terraform`) and suggest only verified `hal terraform ...` commands.',
        'Access requests (URL/credentials): use `get_hal_help` topic=`terraform deploy` and extract defaults for admin user/email/password.',
        'Workspace enablement: mention `hal terraform workspace --help` for workspace automation paths when user asks for project bootstrapping.',
        'Troubleshooting: avoid Docker-compose/community install detours unless user explicitly requests non-HAL alternatives.',
    ],
    docs: [
        {
            title: 'Terraform Enterprise Documentation',
            url: 'https://developer.hashicorp.com/terraform/enterprise',
            description: 'Product documentation for Terraform Enterprise installation, operations, and administration.',
        },
        {
            title: 'Terraform Enterprise Workspaces',
            url: 'https://developer.hashicorp.com/terraform/enterprise/workspaces',
            description: 'How workspaces, runs, and execution flow work in Terraform Enterprise.',
        },
    ],
    accessDefaults: {
        portalUrl: 'https://tfe.localhost:8443',
        username: 'haladmin',
        password: 'hal9000FTW',
        email: 'haladmin@localhost',
        notes: [
            'These are HAL bootstrap defaults and can be overridden with deploy flags.',
        ],
    },
}