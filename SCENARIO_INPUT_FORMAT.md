# Scenario Input Format

Use this format to propose high-priority deterministic scenarios for Hashi Lens.

## Recommended structure

```yaml
id: configure_vault_jwt
priority: high
product: vault
intent_tags:
  - configure
  - jwt
trigger_examples:
  - "configure vault jwt"
  - "set up gitlab jwt auth in vault"
required_tools:
  - get_hal_status
  - get_hal_help: "vault jwt"
  - list_auth_methods
  - read_auth_method: "jwt/"
verified_hal_commands:
  - "hal vault status"
  - "hal vault jwt --help"
  - "hal vault jwt -e"
response_contract:
  sections:
    - runtime_check
    - capabilities
    - execution_steps
    - validation
    - troubleshooting
  must_include:
    - "HAL verified command list"
    - "Vault auth path checks"
  must_not_include:
    - "Unverified HAL flags"
    - "Invented endpoints"
validation_checks:
  - "Vault runtime is running"
  - "auth/jwt/ exists"
  - "role read succeeds"
docs:
  - "https://developer.hashicorp.com/vault/docs/auth/jwt"
  - "https://developer.hashicorp.com/vault/docs/commands"
```

## Field notes

- id: stable key; snake_case; action + product + feature.
- priority: high, medium, low.
- product: vault, terraform, boundary, consul, nomad, obs.
- intent_tags: short routing tags used for trigger matching.
- trigger_examples: realistic user prompts you expect.
- required_tools: minimum tool calls before answering.
- verified_hal_commands: local commands that must appear if available.
- response_contract: required sections and hard exclusions.
- validation_checks: concrete checks proving scenario success.
- docs: official documentation links preferred.

## Minimal quick format

If you want to move faster, this short format also works:

```yaml
id: access_tfe_local
product: terraform
trigger_examples:
  - "what is the local tfe url and admin login"
required_tools:
  - get_hal_status
  - get_hal_help: "terraform deploy"
verified_hal_commands:
  - "hal terraform deploy"
  - "hal terraform status"
must_include:
  - "portal url"
  - "username"
  - "password"
must_not_include:
  - "non-hal install instructions"
```
