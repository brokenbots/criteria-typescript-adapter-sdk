# TypeScript Criteria SDK Proposal

## Overview
A TypeScript implementation of the Criteria adapter SDK, enabling developers to write Criteria plugins in TypeScript/JavaScript.

## Architecture

### Package Structure
```
@criteria/sdk/
├── src/
│   ├── proto/          # Generated TypeScript from proto files
│   ├── plugin/         # go-plugin compatible server
│   │   ├── server.ts   # gRPC server implementation
│   │   ├── handshake.ts # Magic cookie handling
│   │   └── types.ts    # Service interface definitions
│   ├── helpers/        # Utility functions
│   │   └── events.ts   # Event builders
│   └── index.ts        # Public API exports
├── examples/
│   └── greeter/        # TypeScript version of examples/plugins/greeter
└── package.json
```

### Core Interface

```typescript
// The Service interface adapters must implement
export interface AdapterService {
  info(): Promise<InfoResponse>;
  openSession(req: OpenSessionRequest): Promise<OpenSessionResponse>;
  execute(
    req: ExecuteRequest,
    sender: EventSender
  ): Promise<void>;
  permit(req: PermitRequest): Promise<PermitResponse>;
  closeSession(req: CloseSessionRequest): Promise<CloseSessionResponse>;
}

// Stream sender for Execute events
export interface EventSender {
  log(stream: 'stdout' | 'stderr', chunk: string | Buffer): Promise<void>;
  adapterEvent(event: unknown): Promise<void>;
  permissionRequest(permission: string, details: Record<string, string>): Promise<string>;
  result(outcome: string, outputs: Record<string, string>): Promise<void>;
}
```

### Public API

```typescript
// Simplest usage
import { serveAdapter } from '@criteria/sdk';

serveAdapter({
  name: 'my-adapter',
  version: '1.0.0',
  capabilities: ['stream'],
  
  async execute(req, send) {
    const name = req.config.name || 'world';
    await send.log('stdout', `Hello, ${name}!`);
    await send.result('success', { greeting: `Hello, ${name}` });
  }
});
```

## Runtime Compatibility

| Runtime | Status | Notes |
|---------|--------|-------|
| Node.js 18+ | ✅ Supported | Recommended for production |
| Node.js 20+ | ✅ Supported | Best performance |
| Bun 1.0+ | 🧪 Experimental | Single binary compilation |
| Deno | ❌ Not planned | gRPC limitations |

## Distribution Options

### 1. NPM Package (Primary)
```bash
npm install @criteria/sdk
npx tsc plugin.ts && node plugin.js
```

### 2. Single Binary (via Bun)
```bash
bun build --compile plugin.ts --outfile criteria-adapter-mine
```

### 3. Container Image
```dockerfile
FROM node:20-alpine
COPY --from=plugin /app/criteria-adapter-mine /usr/local/bin/
```

## Technical Implementation Notes

### gRPC Server
- Use `@grpc/grpc-js` for Node.js compatibility
- Implement the `AdapterPluginService` from proto
- Handle server-streaming for `Execute` RPC

### go-plugin Handshake
- Read `CRITERIA_PLUGIN` env var
- If not set or wrong value, exit immediately
- If correct, proceed to start gRPC server on stdio or TCP

### Protocol Generation
- Use `protobufjs` or `grpc-tools` to generate TypeScript from proto
- Alternative: `buf` with TypeScript plugin

## Migration Path from Go SDK

| Go SDK | TypeScript SDK |
|--------|---------------|
| `pluginhost.Serve(impl)` | `serveAdapter(config)` |
| `Service` interface | `AdapterService` interface |
| `ExecuteEventSender` | `EventSender` interface |
| `pb.InfoResponse` | `InfoResponse` type |
| `pb.ExecuteEvent` | Built into `EventSender` methods |

## Open Questions

1. Should we support the CriteriaService client SDK (for orchestrators) too, or just adapter plugins?
2. Do we need to support Connect protocol variants, or stick to native gRPC?
3. Should we provide a CLI scaffolding tool (`npm create criteria-adapter`)?
