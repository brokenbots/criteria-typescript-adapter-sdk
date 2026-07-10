# Contributing to @brokenbots/criteria-typescript-adapter-sdk

## Quick Start

The easiest way to get started is using Make:

```bash
# Build and install the codex adapter
make install

# Or install the greeter example
make install-greeter

# Show all available targets
make help
```

## Development Setup

### Prerequisites

- Bun 1.2.0+ (for compilation) - https://bun.sh
- Node.js 20+ (for development)
- Make (optional, for convenience)

### Install Dependencies

```bash
# Using Make
make dev-setup

# Or manually
bun install
```

## Project Structure

```
.
├── Makefile            # Build and install targets
├── src/
│   ├── plugin/         # Core plugin implementation
│   │   ├── types.ts    # TypeScript interfaces
│   │   ├── handshake.ts # Magic cookie validation
│   │   ├── server.ts   # gRPC server implementation
│   │   └── index.ts    # Public API
│   ├── proto/          # Generated proto bindings
│   └── index.ts        # SDK entry point
├── examples/
│   ├── greeter/        # Simple adapter example
│   └── codex/          # OpenAI Codex agent adapter
└── .github/workflows/  # CI/CD
```

## Proto Generation

The SDK uses the Criteria proto definitions from the main repo:

```bash
# Generate TypeScript from ../criteria/proto
make proto

# Or directly
bun run proto:generate
```

This requires:
- `buf` CLI installed (https://github.com/bufbuild/buf)
- `@bufbuild/protoc-gen-es` and `@connectrpc/protoc-gen-connect-es` packages

## Testing

```bash
# Run all tests
make test

# Run tests in watch mode
bun test --watch

# Run specific test file
bun test src/plugin/handshake.test.ts
```

## Building Examples

### Using Make (Recommended)

```bash
# Build and install greeter
make install-greeter

# Build and install codex
make install-codex

# Build custom adapter
make ADAPTER_NAME=my-adapter install
```

### Manual Build

```bash
cd examples/openai
bun build --compile index.ts --outfile criteria-adapter-openai
```

## Code Style

- TypeScript strict mode enabled
- Prefer explicit types over `any`
- Use async/await over raw promises
- JSDoc comments on public APIs

## Submitting Changes

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Ensure `make test` passes
5. Submit a pull request

## Release Process

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Tag the release: `git tag v0.x.x`
4. Push tags: `git push --tags`
5. CI will build and publish to npm and GHCR
