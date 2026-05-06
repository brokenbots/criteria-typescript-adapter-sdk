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
