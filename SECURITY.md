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

- **`ctx_execute` repository scripts are opt-in.** The `ctx_execute` MCP tool can run `npm test`, `npm run build|lint`, and `npx vitest|jest` only when `execAllowRepoScripts: true` is configured (or `CONTEXTOS_EXEC_ALLOW_SCRIPTS=1` is set). These commands execute the target repository's `package.json` scripts and test files, so keep the setting disabled for untrusted repositories. Read-only commands (`ls`, `cat`, `grep`, `find`, `tree`, `git status|log|diff`) remain available.
- **File access is confined to the workspace root.** The file-reading and indexing MCP tools resolve every path against `CONTEXTOS_REPO_ROOT` and reject anything that escapes it — including via `..` segments and symlinks.
- **`git` on a repo shipped with its own `.git`.** `ctx_execute` allows read-only `git status|log|diff|branch`. A repository *delivered as a directory containing an attacker-controlled `.git/config`* (e.g. an extracted archive rather than a normal `git clone`) could set `diff.external` to run a command when the agent runs `git diff`. A normal `git clone` writes a fresh, safe `.git/config`; only fully-untrusted, pre-packaged repositories carry this risk.

## Dependency and runtime notes

The current lockfile was checked with `npm audit` for both the full graph and
the production graph; both reports contained zero vulnerabilities at the time
of this release. Re-run the audit after dependency changes because transitive
metadata and advisories can change.

- **`onnxruntime-node` → `adm-zip`** is used by the ONNX Runtime package
  installer. ContextOS does not accept repository-provided model archives; it
  requests the fixed `sentence-transformers/all-MiniLM-L6-v2` model through the
  Transformers runtime and keeps its cache under `~/.contextos/models`.
- **`sharp` / libvips** is an optional transitive dependency of
  `@huggingface/transformers`. ContextOS's embedding path is text-only and does
  not pass repository images to `sharp`. The installed libvips package carries
  LGPL-3.0-or-later metadata; see the repository's third-party inventory for
  redistribution notes.
- **Optional CUDA files:** on Linux x64, `onnxruntime-node` may download CUDA
  provider files during installation. CPU-only installations can set
  `ONNXRUNTIME_NODE_INSTALL=skip`; this retains the bundled CPU runtime and
  avoids that optional download.
