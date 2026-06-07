# @criteria/adapter-sdk

TypeScript SDK for building Criteria adapter plugins. This SDK enables you to write out-of-process adapter plugins for the Criteria workflow engine using TypeScript, with Bun compilation for native binary distribution via OCI.

## Features

- **TypeScript-native** - Full type safety and IDE support
- **Simple API** - `serve()` function for quick adapters
- **Full control** - `serveAdapter()` for complex implementations
- **Bun compilation** - Single binary output for OCI distribution
- **Multi-arch** - Linux x86_64, Linux ARM64, macOS ARM64
- **gRPC transport** - Compatible with HashiCorp go-plugin

## Requirements

- Bun 1.2.0+ (for compilation)
- Node.js 20+ (for development)
- Make (optional, for convenience targets)

## Quick Start with Make

The easiest way to build and install an adapter:

```bash
# Build and install the codex adapter (default)
make install

# Or install the greeter example
make install-greeter

# Build for a custom adapter
make ADAPTER_NAME=my-adapter install
```

## Manual Installation

### 1. Install Dependencies

```bash
# With Bun (recommended)
bun install

# Or with npm
npm install
```

### 2. Build an Adapter

```bash
# Build the SDK first
bun run build

# Build an example adapter
cd examples/openai
bun build --compile --target=bun-linux-x64 index.ts --outfile criteria-adapter-openai
```

### 3. Install to Criteria

```bash
mkdir -p ~/.criteria/plugins
cp examples/openai/criteria-adapter-openai ~/.criteria/plugins/
chmod +x ~/.criteria/plugins/criteria-adapter-openai
```

## Usage in Workflows

```hcl
step "analyze" {
  adapter = "openai"

  agent {
    config {
      model = "gpt-4o"
      max_turns = 10
    }
  }
  
  input {
    prompt = "Review this code for security issues"
  }
  
  outcome "clean" { transition_to = "done" }
  outcome "issues_found" { transition_to = "review" }
  outcome "failure" { transition_to = "failed" }
}
```

Run the workflow:
```bash
criteria apply workflow.hcl
```

## Make Targets

| Target | Description |
|--------|-------------|
| `make` or `make build` | Build SDK and adapter (default: codex) |
| `make install` | Build and install to `~/.criteria/plugins/` |
| `make install-greeter` | Build and install the greeter example |
| `make install-codex` | Build and install the codex example |
| `make ADAPTER_NAME=my-adapter install` | Build and install custom adapter |
| `make clean` | Remove build artifacts |
| `make test` | Run tests |
| `make lint` | Run linter |
| `make help` | Show all available targets |

## Examples

### Greeter (Simple)

See `examples/greeter/` - The simplest possible adapter.

```bash
make install-greeter
```

### OpenAI (Agent)

See `examples/openai/` - Full agent adapter with multi-turn conversations.

```bash
# Requires OPENAI_API_KEY environment variable
export OPENAI_API_KEY="sk-..."

make install-openai
```

Features:
- Multi-turn conversations with OpenAI models
- Tool calling with `submit_outcome` for workflow integration
- Session management
- Configurable max turns per step

## API Reference

### `serve(config)`

Simplest way to create an adapter:

```typescript
import { serve } from '@criteria/adapter-sdk';

serve({
  name: 'my-adapter',
  version: '1.0.0',
  
  async execute(req, sender) {
    await sender.log('stdout', 'Processing...\n');
    await sender.result('success', { output: 'done' });
  },
});
```

### `EventSender`

Stream events back to Criteria:

```typescript
interface EventSender {
  log(stream: 'stdout' | 'stderr', chunk: string): Promise<void>;
  adapterEvent(event: unknown): Promise<void>;
  result(outcome: string, outputs: Record<string, string>): Promise<void>;
}
```

See `examples/openai/index.ts` for a complete implementation.

## Running as a remote adapter

By default an adapter is launched locally by the Criteria host. An adapter can
instead run anywhere (Kubernetes, ECS, a VM, a systemd unit) and *dial out* to
the host's `remote` environment shim. From your code this is a one-function
change — `serveRemote(config, options)` instead of `serve(config)`; every
handler behaves identically.

```typescript
import { serveRemote } from '@criteria/adapter-sdk';

serveRemote(
  {
    name: 'my-adapter',
    version: '1.0.0',
    description: 'Does useful things',
    async execute(req, helpers) {
      await helpers.outcomes.finalize('success');
    },
  },
  {
    // Host bind address of the workflow's `remote` environment.
    host: 'criteria.example.com:7778',
    // mTLS material — PEM contents or file paths are both accepted.
    mtls: {
      client_cert: process.env.CRITERIA_REMOTE_TLS_CERT!,
      client_key: process.env.CRITERIA_REMOTE_TLS_KEY!,
      ca_bundle: process.env.CRITERIA_REMOTE_CA!,
    },
    // Optional bearer token the host requires on connect.
    accept_token: process.env.CRITERIA_REMOTE_TOKEN,
    // The host verifies this digest against its lockfile entry.
    identity: { digest: process.env.CRITERIA_REMOTE_DIGEST! },
    // Reconnect with backoff when the host connection drops (the default).
    reconnect: true,
  },
);
```

How it works: the SDK opens an mTLS connection to the host, sends a single
newline-terminated identity frame (`{ name, version, digest, token }`), then
serves the gRPC `AdapterService` over the held connection. The host shim bridges
that connection to a local socket and consumes it as if the adapter were local.

`serveRemote` still supports `--emit-manifest`, so the same binary works in your
build/publish pipeline unchanged. The OCI artifact is identical; only the
container entrypoint / launcher script decides whether to call `serve` or
`serveRemote`.

**Deployment examples** — copy-pasteable Kubernetes `Deployment`,
`docker-compose`, and `systemd` manifests live under
[`examples/remote/`](examples/remote/). Adapter launch and network reachability
(VPN, Tailscale, ngrok, a public address) are the operator's responsibility;
Criteria does not start or tunnel to remote adapters.

## Project Structure

```
├── Makefile                      # Build and install targets
├── src/                          # SDK source code
│   ├── plugin/                   # Core plugin SDK
│   └── proto/                    # Proto bindings
├── examples/
│   ├── greeter/                  # Simple example
│   └── codex/                    # OpenAI Codex agent adapter
└── proto/                        # Proto files from criteria
```

## Development

```bash
# Install dependencies
bun install

# Build SDK
bun run build

# Run tests
bun test

# Generate proto bindings
bun run proto:generate
```

## License

MIT

## Security & dependencies

See [SECURITY.md](SECURITY.md) and [docs/dependency-policy.md](docs/dependency-policy.md).
Reproduce the CI security checks locally:

```bash
bun run vuln-scan      # osv-scanner — blocking known-vulnerability gate (reads bun.lock)
bun run deps:outdated  # bun outdated — freshness report
```
