# Infrastructure evidence

Infrastructure indexing defaults to `indexing.infra: true`; set it to false to
remove infra chunks on the next index. Normal ignore files and configured ignore
patterns apply. New discovery patterns cover Dockerfile*, *.sh, *.tf and
.env.example; YAML already participates in discovery. The watcher also accepts
extensionless Dockerfiles and `.env.example` updates.

Query the existing chunk `language` column for these kinds:

| language        | chunk boundary                                                                 |
| --------------- | ------------------------------------------------------------------------------ |
| compose-service | one service                                                                    |
| dockerfile      | one FROM stage                                                                 |
| k8s-resource    | one YAML resource (including List items)                                       |
| helm-values     | values file                                                                    |
| terraform-block | top-level resource/module/data/variable/output/provider/terraform/locals block |
| shell-script    | function or top-level section                                                  |
| env-example     | environment key list                                                           |

Chunks use fileType `config`, sectionTitle/symbolName for the entity name, and
startLine/endLine for evidence bounds. YAML bounds conservatively cover the file;
script, Dockerfile and Terraform bounds follow their sections. These are sanitized
structural evidence, not verbatim source excerpts. Compose retains image/build
context/dockerfile/target, ports, dependencies, environment keys, mounts, networks,
and command executables. Kubernetes retains identity, container images/ports,
environment keys, and ConfigMap/Secret reference names (never secret data or keys).
Helm and Terraform keep structure/attribute keys and redact scalar values.

Environment values and command arguments are never stored. ENV/ARG names remain
with `[REDACTED]`. Scripts retain function names, environment names and command
executables; comments, literal bodies and heredocs are omitted. Infra literal
sanitization removes interpolation defaults, credential URLs and secret-like
assignments/fields (password, secret, token, key, credential, dsn). YAML parsing
uses JSON_SCHEMA with bounded depth/alias expansion and fails closed. Malformed
infra never falls back to a raw text/config parser.

Unconditional safety exclusions cover .env and .env.* (except .env.example),
*.pem, *.key, token/tokens/tokens.json, _.tfstate_, *.tfvars and *.tfvars.json.
Scripts are limited to 256 KiB; other files retain the existing 2 MiB cap.

INFRA_PARSER_VERSION participates in infra file hashes and affected-view config
fingerprints. The indexer version advances to 3 for legacy daemon upgrade scans.
Registered views without eligible infra preserve their version-2 fingerprint;
infra-only upgrades replace infra chunks without rewriting existing code/docs.
No schema changes or new MCP/CLI signatures are needed.
