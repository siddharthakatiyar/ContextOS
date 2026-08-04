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

`npm audit` reports high-severity advisories without an upstream fix in two transitive dependencies of `@huggingface/transformers`:

- **`onnxruntime-node` → `adm-zip`** can allocate excessive memory when opening a malicious ZIP archive. ContextOS does not accept repository-provided model archives; it loads the configured, fixed Hugging Face model into its private cache.
- **`sharp` / libvips** contains image-processing advisories. ContextOS uses the transformer pipeline for text embeddings and does not pass repository images to `sharp`.

Embeddings are enabled during indexing by default, so these packages are reachable even though the affected archive/image inputs are not part of ContextOS's text-only workflow. The advisories are re-evaluated every release and will be patched when compatible upstream releases are available.
