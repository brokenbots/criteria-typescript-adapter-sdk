# OCI-Native Binary Distribution Analysis

## Key Constraint Change

**OCI = Distribution mechanism, NOT runtime container**

```
OCI Registry (ghcr.io, ECR, etc.)
         │
         ▼
    ┌─────────┐
    │  Pull   │ ← criteria downloads OCI artifact
    └────┬────┘
         │
         ▼
    ┌─────────┐
    │ Extract │ ← binary copied to local cache
    └────┬────┘
         │
         ▼
    ┌─────────┐
    │ Execute │ ← runs DIRECTLY on host OS
    │ binary  │    (no container runtime)
    └─────────┘
```

This changes everything.

## Requirements

| Requirement | Implication |
|-------------|-------------|
| Self-contained binary | Runtime must be bundled |
| Multi-arch OCI manifest | Platform-specific binaries in layers |
| Native execution | No Docker/container overhead |
| Cross-platform | Build matrix: macOS/Linux/Windows × x86_64/ARM64 |
| Cacheable | Binary extracted to ~/.criteria/cache/ |

## Runtime Options Re-evaluated

### Option 1: Bun --compile (RECOMMENDED)

**How it works:**
```bash
# Build native binary
bun build --compile plugin.ts --outfile criteria-adapter-mine

# Package into OCI
# (Manifest lists platforms: linux/amd64, linux/arm64, darwin/arm64, etc.)
```

**Pros:**
- ✅ Single binary, self-contained
- ✅ Native performance
- ✅ Smaller than Node.js + app (~50-80MB)
- ✅ Cross-compile support via Zig toolchain
- ✅ TypeScript native (no separate compile step)

**Cons:**
- ⚠️ Bun 1.0 released Sept 2023 (younger than Node)
- ⚠️ gRPC via `@grpc/grpc-js` works but less battle-tested
- ⚠️ Limited Windows support (v1.1+ improving)

**OCI Layout:**
```
oci://criteria-adapter-mine:v1.0.0
├── manifests/
│   ├── linux/amd64 → points to layer with binary
│   ├── linux/arm64 → points to layer with binary  
│   └── darwin/arm64 → points to layer with binary
└── blobs/
    ├── sha256:abc... (linux/amd64 binary)
    ├── sha256:def... (linux/arm64 binary)
    └── sha256:ghi... (darwin/arm64 binary)
```

**Build process:**
```bash
# Build per platform
for platform in linux-x64 linux-arm64 darwin-arm64; do
  bun build --compile --target=$platform plugin.ts \
    --outfile criteria-adapter-mine-$platform
done

# Push to OCI registry with multi-platform manifest
```

### Option 2: Node.js + pkg

**How it works:**
```bash
# Compile TypeScript first
npx tsc

# Bundle with pkg (creates Node.js runtime + app)
pkg dist/index.js --targets node20-linux-x64,node20-linux-arm64,...
```

**Pros:**
- ✅ Mature ecosystem
- ✅ `@grpc/grpc-js` well-tested
- ✅ `pkg` supports all target platforms

**Cons:**
- ❌ Larger binaries (~60-100MB)
- ❌ Two-step build (tsc + pkg)
- ❌ pkg is in maintenance mode (Vercel took over, future uncertain)

### Option 3: Node.js + nexe

Similar to pkg, different tradeoffs:
- More active development
- Slightly larger binaries
- Better support for native addons

### Option 4: Deno compile

**Pros:**
- ✅ Single binary like Bun
- ✅ Native TypeScript
- ✅ Cross-compilation

**Cons:**
- ❌ Limited npm compatibility
- ❌ gRPC ecosystem immature (no official `@grpc/grpc-js` support)
- ❌ Would need protobuf library rewrite

### Option 5: Go (Pivot)

**Reality check**: If native binary + OCI distribution is required, Go is purpose-built for this.

**Pros:**
- ✅ Single binary, ~15-25MB
- ✅ Native compilation, no bundler
- ✅ Official OCI image libraries
- ✅ Already used by Criteria (ecosystem fit)

**Cons:**
- ❌ Not TypeScript (stated goal)

## Recommendation: Bun --compile

Despite being newer, Bun is the best fit for this specific use case because:

1. **Single binary** - Like Go, but TypeScript
2. **TypeScript native** - No separate build step
3. **Cross-compile** - Via Zig backend
4. **Size competitive** - 50-80MB vs Go's 15-25MB
5. **Performance** - Comparable to Node.js, faster startup

### Platform Support Matrix

| Platform | Bun Support | Status |
|----------|-------------|--------|
| Linux x86_64 | ✅ Tier 1 | Production ready |
| Linux ARM64 | ✅ Tier 1 | Production ready |
| macOS ARM64 | ✅ Tier 1 | Production ready |
| macOS x86_64 | ✅ Tier 1 | Production ready |
| Windows x86_64 | ✅ Tier 2 | Good, improving |
| Windows ARM64 | ❌ | Not supported |

### Risk Mitigation

If Bun proves problematic:

1. **Fallback to Node.js + pkg** - Mature, works everywhere
2. **Wait for Bun to mature** - It's improving rapidly
3. **Contribute fixes** - Open source, responsive team

## Implementation Plan

### Phase 1: Bun Compile (MVP)
```typescript
// plugin.ts
import { serveAdapter } from '@criteria/adapter-sdk';

serveAdapter({
  name: 'my-adapter',
  version: '1.0.0',
  
  async execute(req, send) {
    await send.log('stdout', 'Hello from Bun!');
    await send.result('success', {});
  }
});
```

```bash
# Build
bun build --compile --target=bun-linux-x64 plugin.ts \
  --outfile criteria-adapter-mine

# Package into OCI
# (Use oras, crane, or custom tooling)
```

### Phase 2: Multi-Arch CI
```yaml
# .github/workflows/release.yml
strategy:
  matrix:
    include:
      - target: bun-linux-x64
        arch: amd64
      - target: bun-linux-arm64
        arch: arm64
      - target: bun-darwin-arm64
        arch: arm64
```

### Phase 3: Criteria Integration
```bash
# Criteria pulls and extracts
criteria apply workflow.hcl --adapter-oci ghcr.io/myorg/criteria-adapter-mine:v1.0.0

# Behind the scenes:
# 1. Pull OCI manifest
# 2. Select layer for current platform
# 3. Extract binary to ~/.criteria/cache/adapters/
# 4. Execute binary directly
```

## Size Comparison (Native Binary)

| Approach | Binary Size | Pros | Cons |
|----------|-------------|------|------|
| Go | 15-25MB | Smallest, native | Not TypeScript |
| Bun compile | 50-80MB | TypeScript, fast | Newer, smaller ecosystem |
| Node.js + pkg | 60-100MB | Mature, stable | Larger, maintenance mode |
| Node.js + nexe | 70-120MB | Active dev | Largest |

## Final Verdict

**Bun is the right choice** for this specific constraint (OCI-packaged native binary) because:

1. It delivers on the "TypeScript with Go-like distribution" promise
2. Single binary requirement is met
3. Multi-arch builds are supported
4. Size is acceptable (2-3x Go, but 30-50% smaller than pkg)
5. The team is responsive and the project is growing

**Contingency**: If Bun gRPC proves unstable, fall back to Node.js + pkg/nexe, accepting the size penalty for stability.
