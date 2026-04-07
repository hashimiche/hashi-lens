Build/upgrade HAL MCP to be a deterministic operations backend for Hashi Lens.

Mandatory contract:
- Every tool response MUST validate against HAL_MCP_CONTRACT.json.
- Never return free-text-only tool output.
- Do not invent commands.
- Put executable commands only in recommended_commands.

Primary objective:
- HAL-first for deploy/runtime workflows.
- Return validated commands and structured context so LLM cannot hallucinate CLI syntax.
- Cover all HAL product areas, not only auth:
	- Vault (oidc, jwt, ldap, k8s auth, VSO/CSI integrations)
	- Boundary (controller/worker/targets, SSH flows)
	- TFE (workspace bootstrap, org/project/workspace variables)
	- Consul/Nomad core lifecycle and health
	- Observability stack (loki/prometheus/grafana)
	- Cross-product dependencies and prerequisites

Required tools:
1) get_runtime_status
- Return product status, endpoint, version, features, and health summary.

2) get_capabilities
- Return all supported commands/subcommands/flags as structured data.

3) get_help_for_topic
- Input: topic (e.g., "vault oidc", "vault jwt").
- Output: usage, flags, recommended_commands.

4) plan_next_steps
- Input: intent + context.
- Output: ordered steps, expected outcomes, recommended_commands.

5) validate_command
- Input: command string.
- Output: valid(bool), corrected command (if invalid), reason.

6) get_component_context
- Return endpoint, auth state, and available credential references.
- Never leak secrets unless explicitly requested in secure mode.

7) get_audit_summary
- Input: time window, filters.
- Output: concise behavior summary + key events.

8) get_oidc_status, enable_oidc
- OIDC readiness and actionable enable flow.

9) get_jwt_status, enable_jwt
- JWT readiness and actionable enable flow.

10) get_boundary_status, enable_boundary, get_ssh_flow_status
- Boundary lifecycle, critical checks, and SSH-ready status.

11) get_tfe_status, setup_tfe_workspace
- TFE runtime + workspace setup plan (org/project/workspace/vars).

12) get_k8s_integration_status, enable_vault_k8s_integration
- Vault Kubernetes integrations including VSO/CSI readiness.

13) get_cross_product_dependencies
- Return prerequisite graph and ordering (for example Consul before Nomad, Vault before VSO/CSI, etc.).

Execution modes:
- dry_run: no mutation, returns planned actions.
- apply: performs action and returns post-check commands.

Error model (stable code values):
- command_not_found
- invalid_flag
- missing_dependency
- not_deployed
- not_authenticated
- permission_denied
- endpoint_unreachable
- timeout
- parse_error
- unsupported_operation

For all errors:
- status=error
- include remediation in message
- include recommended_commands for recovery

Quality gates:
- Tests must fail if recommended_commands are not executable.
- Add snapshot tests for vault oidc and vault jwt help parsing.
- Add integration tests for running/not-deployed/auth-missing scenarios.

Output constraints:
- Keep data compact and stable.
- Maintain deterministic ordering in arrays.
- Avoid non-deterministic prose fields.

Critical formatting behavior:
- recommended_commands must contain only executable commands that are valid in the current HAL install.
- next_steps should contain ordered, user-facing actions with expected outcomes.
- checks should expose health/readiness in a compact machine-readable form for UI chips and hover details.
- credentials must use references/redacted values by default (never print secret values unless explicitly requested in secure mode).
