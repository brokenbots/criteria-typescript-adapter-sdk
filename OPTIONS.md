# Implementation Options Analysis

## Runtime Options

### Node.js 18/20 (Recommended)
**Pros:**
- Mature ecosystem with excellent gRPC support
- `@grpc/grpc-js` is official and well-maintained
- Strong debugging and profiling tools
- Easy to bundle with tools like `esbuild`, `pkg`, or `nexe`
- Works with HashiCorp go-plugin's stdio transport

**Cons:**
- Requires Node.js installation on target machines
- Larger distribution size than Go binaries
- Startup latency higher than Go

**Best for:** Production plugins, enterprise use, developer tooling

### Bun 1.0+ (Single Binary)
**Pros:**
- Native `bun build --compile` for single binaries
- Zero external dependencies in compiled output
- Performance comparable to Go for many workloads
- Direct drop-in replacement for Node.js

**Cons:**
- Still maturing (1.0 released 2023)
- Some npm packages may have compatibility issues
- gRPC support via `@grpc/grpc-js` but less battle-tested

**Best for:** Distribution simplicity, CLI tools, self-contained plugins

### Deno
**Not recommended** - lacks mature gRPC support and go-plugin compatibility.

---

## gRPC Implementation Options

### Option 1: @grpc/grpc-js (Recommended)
- Native Node.js gRPC implementation
- Server streaming support for `Execute` RPC
- Protocol-first design
- Widely used in production

### Option 2: connectrpc/connect
- Uses Connect protocol (HTTP/1.1 or HTTP/2)
- Criteria uses this for its Go SDK
- Would require go-plugin to support Connect
- More ergonomic but may need host-side changes

### Option 3: protobufjs + custom server
- More control but higher maintenance burden
- Would need to implement gRPC wire protocol

**Recommendation:** Start with `@grpc/grpc-js` - it's the de facto standard.

---

## Protocol Generation

### Option 1: buf + protoc-gen-ts
```bash
buf generate --template buf.gen.yaml
```
- Cleanest output
- Best IDE support
- Requires buf CLI

### Option 2: protobufjs (pbjs/pbts)
```bash
npx pbjs -t static-module -w es6 proto/*.proto
npx pbts -o types.d.ts proto.js
```
- Single JS file output
- Works without protoc
- More verbose type definitions

### Option 3: grpc-tools
```bash
npx grpc_tools_node_protoc --ts_out=. proto/*.proto
```
- Direct integration with @grpc/grpc-js
- Requires protoc installation

**Recommendation:** Option 1 (buf) for cleanest code, Option 2 for simplicity.

---

## Distribution Strategies

| Strategy | Size | Setup | Best For |
|----------|------|-------|----------|
| npm + node | ~50MB | `npm install` | CI/CD, dev environments |
| Single binary (Bun) | ~50-80MB | Copy file | End users, portable |
| Docker | ~100MB+ | `docker run` | Containerized workflows |
| pkg/nexe | ~40MB | Copy file | Legacy Node.js projects |

---

## Package Naming

Options:
1. `@criteria/sdk` - Scoped to criteria org
2. `@criteria/adapter` - Specific to adapters
3. `criteria-adapter-sdk` - Simple flat name
4. `@brokenbots/criteria-sdk` - Match Go module path

**Recommendation:** `@brokenbots/criteria-typescript-adapter-sdk` - clear scope, matches Go SDK structure.

---

## Recommended Tech Stack

```
Runtime:        Node.js 18+ (LTS)
gRPC:           @grpc/grpc-js
Protobuf:       buf + protoc-gen-ts
Build:          tsup (fast bundling)
Testing:        vitest
Lint:           eslint + prettier
Distribution:  npm + optional Bun compile
```

---

## Implementation Priority

### Phase 1: Core SDK
- [ ] Proto generation from criteria proto files
- [ ] gRPC server implementation for AdapterPluginService
- [ ] Handshake validation (magic cookie)
- [ ] `serveAdapter()` entry point
- [ ] Type definitions for all messages

### Phase 2: Developer Experience
- [ ] Greeter example port
- [ ] Helper functions for common patterns
- [ ] Error handling best practices
- [ ] Logging integration

### Phase 3: Distribution
- [ ] npm package publishing
- [ ] Bun compile example
- [ ] Docker image example
- [ ] CI/CD template
