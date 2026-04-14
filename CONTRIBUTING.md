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

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
