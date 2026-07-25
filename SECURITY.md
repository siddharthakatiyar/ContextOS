# Security Policy

## Supported Versions

From v1.0.0 onward, only the latest patch release of the current major version is supported with security patches.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues. 

If you believe you have found a security vulnerability in ContextOS, please report it to us via email at **siddharthakatiyar25@gmail.com**.

We take all security vulnerabilities seriously. Thank you for improving the security of ContextOS!

### Scope

We are particularly interested in:
- Path traversal vulnerabilities during indexing (e.g., escaping the workspace).
- SQL injection vulnerabilities in SQLite queries.
- Remote Code Execution (RCE) via malicious repositories.
- Denial of Service (DoS) vectors targeting the background daemon.

## Running ContextOS on untrusted repositories

ContextOS serves context from whatever repository it points at. Two things to know when that repository is not fully trusted:

- **`ctx_execute` runs the repository's own scripts.** By default the `ctx_execute` MCP tool allows `npm test`, `npm run build|lint`, and `npx vitest|jest`, which execute the target repo's `package.json` scripts and test files — i.e. repo-controlled code. When indexing an untrusted repository, disable this with `execAllowRepoScripts: false` in your config or `CONTEXTOS_EXEC_ALLOW_SCRIPTS=0`. Read-only commands (`ls`, `cat`, `grep`, `find`, `tree`, `git status|log|diff`) remain available.
- **File access is confined to the workspace root.** The file-reading and indexing MCP tools resolve every path against `CONTEXTOS_REPO_ROOT` and reject anything that escapes it — including via `..` segments and symlinks.
- **`git` on a repo shipped with its own `.git`.** `ctx_execute` allows read-only `git status|log|diff|branch`. A repository *delivered as a directory containing an attacker-controlled `.git/config`* (e.g. an extracted archive rather than a normal `git clone`) could set `diff.external` to run a command when the agent runs `git diff`. A normal `git clone` writes a fresh, safe `.git/config`; only fully-untrusted, pre-packaged repositories carry this risk.

## Known dependency advisories (accepted risk)

`npm audit` reports advisories in transitive dependencies that ContextOS ships but does not exercise on its default path:

- **`@xenova/transformers`** pulls a stale `onnxruntime-web` → `protobufjs` / `sharp` chain used for local embeddings. Embeddings are optional and off the default retrieval path, and the vulnerable code paths (dynamic protobuf schema loading, image decoding) are not reached by ContextOS's text-only usage. The upstream package is unmaintained; a migration to `@huggingface/transformers` is tracked.
- **`@modelcontextprotocol/sdk`** pulls `ajv` → `fast-uri` and `@hono/node-server`. ContextOS uses the SDK over the **stdio** transport (no HTTP server), so the affected HTTP/URI code paths are not instantiated.

These are re-evaluated every release and patched once fixed upstream, without forcing a breaking downgrade.
