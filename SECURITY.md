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

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Security Best Practices

When self-hosting StackSpine Gateway:

1. **Rotate secrets regularly** — JWT secrets, service role keys, and provider API keys
2. **Enable TLS** — Always terminate TLS at your ingress/load balancer
3. **Restrict network access** — The gateway should only be accessible from your application servers
4. **Use RLS policies** — Never disable Row Level Security on the database
5. **Monitor audit logs** — Review `call_logs` and provider health regularly
6. **Keep updated** — Pull the latest gateway release for security patches
