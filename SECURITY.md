# Security Policy

## Supported Versions

Currently, only the latest minor release of the v0.x line is supported with security patches.

| Version | Supported          |
| ------- | ------------------ |
| 0.8.x   | :white_check_mark: |
| < 0.8.0 | :x:                |

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
