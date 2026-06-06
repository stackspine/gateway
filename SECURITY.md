# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in StackSpine Gateway, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

Email **security@stackspine.com** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 5 business days
- **Fix & Disclosure**: Coordinated with reporter, typically within 30 days

### Scope

This policy covers:

- The gateway runtime (`gateway/`)
- Deployment configurations (`deploy/`)
- Database migrations (`migrations/`)
- Official SDKs (`sdks/`)

### Recognition

We credit security researchers in our changelog (with permission) and maintain a hall of fame for significant findings.

## Supported Versions

Security fixes land on the latest minor of the current major. Older minors
receive fixes only for critical (CVSS ≥ 9.0) vulnerabilities for 90 days after
a newer minor ships.

| Version | Supported          |
|---------|--------------------|
| 1.x (latest minor) | ✅ full support |
| 1.x (older minors) | ⚠️ critical fixes only, 90 days |
| < 1.0   | ❌ unsupported     |

## Coordinated Disclosure

We follow a 90-day coordinated disclosure window. Reporters who give us time
to ship a fix before publishing are credited in the release notes and in
`CHANGELOG.md`. We will never threaten legal action against good-faith
researchers operating within this policy.


## Security Best Practices

When self-hosting StackSpine Gateway:

1. **Rotate secrets regularly** — JWT secrets, service role keys, and provider API keys
2. **Enable TLS** — Always terminate TLS at your ingress/load balancer
3. **Restrict network access** — The gateway should only be accessible from your application servers
4. **Use RLS policies** — Never disable Row Level Security on the database
5. **Monitor audit logs** — Review `call_logs` and provider health regularly
6. **Keep updated** — Pull the latest gateway release for security patches
