# Contributing to StackSpine Gateway

Thank you for your interest in contributing! We welcome contributions from the community.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Create a branch** for your change (`git checkout -b my-feature`)
4. **Make your changes** and add tests
5. **Run tests** to verify (`deno test --allow-net --allow-env`)
6. **Commit** with a descriptive message
7. **Push** to your fork and open a **Pull Request**

## Developer Certificate of Origin (DCO)

By contributing to this project, you agree to the [Developer Certificate of Origin](https://developercertificate.org/). You must sign off on each commit:

```bash
git commit -s -m "Add feature X"
```

This adds a `Signed-off-by` line to your commit message, certifying that you have the right to submit the contribution under the project's license.

## Code Style

- TypeScript for all gateway code (Deno runtime)
- Use `deno fmt` for formatting
- Use `deno lint` for linting
- Keep functions small and focused
- Add JSDoc comments to exported functions

## Testing

All changes should include tests. Run the test suite:

```bash
deno test --allow-net --allow-env gateway/tests/
```

## Pull Request Guidelines

- **One feature per PR** — keep changes focused
- **Include tests** for new functionality
- **Update documentation** if behavior changes
- **Reference issues** in your PR description
- **Keep commits clean** — squash fixup commits before requesting review

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps for bugs
- Check existing issues before creating a new one

## What lives in this repo

This repository is the **enforcement data plane**: routing, budget enforcement,
guardrails, rate limiting, prompt cache, and the five SDKs. Dashboards, SSO,
audit evidence, billing, and the self-optimizing routing optimizer are part of
the commercial StackSpine Cloud product and live in a separate private repo —
PRs adding those features here will be redirected.

If you are unsure whether a feature fits, open a Discussion first.

## Security issues

Please do **not** open public issues for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for the private reporting channel.

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0, and that you grant the patent license described in Section 3 of that license to all recipients of the software.

