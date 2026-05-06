# OCI Distribution Analysis for TypeScript SDK

## How OCI Changes Things

### Distribution Model Shift
| Aspect | Binary Distribution | OCI Distribution |
|--------|-------------------|------------------|
| Runtime | Must bundle or require Node.js | Baked into image |
| Multi-arch | Cross-compile per arch | `docker buildx` multi-platform |
| Size concern | Single binary size matters | Layer caching amortizes base image |
| Installation | Manual/curl/npm | `docker pull` or OCI-compliant runtime |
| Updates | Replace binary | Pull new image tag |

### Node.js in Containers - Pros
- **Base images**: `node:20-alpine` (~50MB) or `node:20-slim` (~75MB)
- **Multi-arch**: Official Node images support `linux/amd64`, `linux/arm64`
- **Build consistency**: Same Node version everywhere
- **No host dependencies**: Users don't install Node.js

### Node.js in Containers - Cons
- **Image size**: ~50-100MB per plugin (vs ~10-20MB Go binary)
- **Cold start**: Container startup overhead
- **Resource usage**: Higher memory footprint than Go

## Architecture Support Matrix

| OS/Arch | Node Container | Bun Container | Go Plugin |
|---------|---------------|---------------|-----------|
| Linux x86_64 | ✅ Official | ✅ Buildable | ✅ Native |
| Linux ARM64 | ✅ Official | ✅ Buildable | ✅ Native |
| macOS ARM64 | ❌* | ❌* | ✅ Native |
| Windows x86_64 | ✅ Official | ❌ Limited | ✅ Native |
| Windows ARM64 | ⚠️ Experimental | ❌ | ⚠️ Tier 2 |

\* Containers don't run natively on macOS; requires Docker Desktop (Linux VM)

## The macOS Challenge

**Critical**: OCI containers on macOS run in a Linux VM (Docker Desktop), not natively.

For Criteria plugins that need to:
- Access macOS-specific APIs (Keychain, native apps)
- Run "close to the metal" for performance
- Integrate with macOS-native tools

A **native binary is required**.

### Options for macOS ARM64

1. **Node.js + pkg/nexe**
   - Compile Node.js app to single binary
   - `pkg` supports macOS ARM64
   - ~40-50MB binaries

2. **Bun --compile**
   - Single binary output
   - Native macOS ARM64 support
   - ~50-80MB binaries

3. **Deno compile**
   - Single binary output
   - macOS ARM64 support
   - Similar size to Bun

## Recommendation: Hybrid Approach

```
┌─────────────────────────────────────────────────────────┐
│                    OCI Distribution                      │
│  ┌─────────────────┐    ┌─────────────────────────────┐  │
│  │ Node.js Alpine  │ or │ Bun distroless (smaller)   │  │
│  │ ~50MB base      │    │ ~30MB if achievable        │  │
│  └─────────────────┘    └─────────────────────────────┘  │
│         │                          │                    │
│         ▼                          ▼                    │
│    Linux x86_64               Linux ARM64                │
│    (primary target)          (Raspberry Pi, Graviton)   │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                  Native Binary Fallback                  │
│  ┌─────────────────┐    ┌─────────────────────────────┐  │
│  │ Bun compile      │ or │ pkg (Node.js)              │  │
│  │                  │    │                             │  │
│  │ macOS ARM64      │    │ macOS ARM64                │  │
│  │ macOS x86_64     │    │ Windows x86_64             │  │
│  └─────────────────┘    └─────────────────────────────┘  │
│                                                          │
│  For: Local dev, CI without containers,                   │
│       macOS-native integrations                          │
└─────────────────────────────────────────────────────────┘
```

## Revised Tech Stack (OCI-aware)

```
Runtime:        Node.js 20 (LTS) - primary
                Bun - optional for smaller images
                
Container:      node:20-alpine or distroless/cc
Multi-arch:     docker buildx (linux/amd64,linux/arm64)
                
Native binary:  Bun --compile (macOS, Linux)
                or pkg (broader compatibility)
                
Distribution:   OCI registry (primary)
                GitHub Releases (native binaries)
```

## Size Comparison

| Distribution | Size | Notes |
|-------------|------|-------|
| Go plugin binary | ~15-25MB | Single file, native |
| Node.js OCI image | ~60-80MB | Includes base OS + Node |
| Bun OCI image | ~40-60MB | Smaller runtime |
| Bun native binary | ~50-80MB | Self-contained |
| Node.js + pkg | ~40-60MB | Self-contained |

## Implementation Strategy

### Phase 1: OCI-First (Linux focus)
- Build on `node:20-alpine`
- Multi-arch: `linux/amd64`, `linux/arm64`
- Push to OCI registry
- Works for most server/CI use cases

### Phase 2: Native Binary (macOS focus)
- Bun compile for macOS ARM64/x86_64
- GitHub Actions for cross-compilation
- Distribute via GitHub Releases

### Phase 3: Windows (if needed)
- Lowest priority
- Bun has limited Windows support
- May need Node.js + pkg fallback

## Verdict: Node.js is Still the Right Choice

**Yes**, Node.js remains appropriate because:

1. **OCI neutralizes runtime concerns**: Node.js is in the image
2. **Multi-arch is solved**: Official Node images support all required Linux arches
3. **Hybrid distribution**: Bun compile provides native binary fallback
4. **Ecosystem maturity**: `@grpc/grpc-js` is battle-tested
5. **Developer experience**: TypeScript tooling is excellent

The key insight: **OCI distribution favors interpreted runtimes** because the "installation" happens at the container build, not the user's machine.
