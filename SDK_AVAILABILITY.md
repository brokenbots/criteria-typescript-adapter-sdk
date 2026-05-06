# SDK Availability Check: Codex & Claude

## OpenAI (Codex)

### Official SDKs
| Language | Status | URL |
|----------|--------|-----|
| Python | ✅ Official | github.com/openai/openai-python |
| JavaScript/TypeScript | ✅ Official | github.com/openai/openai-node |
| **Go** | ✅ **Official** | github.com/openai/openai-go |
| .NET | ✅ Official | github.com/openai/openai-dotnet |
| Java | ✅ Official | github.com/openai/openai-java |

### Go SDK Details
- **Repository**: github.com/openai/openai-go
- **Status**: Official, maintained by OpenAI
- **Features**: Full API coverage including streaming
- **Codex Support**: Yes (via OpenAI API)

## Anthropic (Claude)

### Official SDKs
| Language | Status | URL |
|----------|--------|-----|
| Python | ✅ Official | github.com/anthropics/anthropic-sdk-python |
| JavaScript/TypeScript | ✅ Official | github.com/anthropics/anthropic-sdk-typescript |

### Third-Party Go SDKs
| Language | Status | URL |
|----------|--------|-----|
| **Go** | ⚠️ **Community** | github.com/liushuangls/go-anthropic (most popular) |

### Go SDK Details
- **Official Go SDK**: ❌ **Not available**
- **Community SDK**: Multiple exist, most popular is go-anthropic
- **Quality**: Good but not official, may lag behind API updates
- **Risk**: Anthropic could change API in ways that break community SDKs

---

## Summary Table

| AI Service | Official Go SDK | Community Go SDK | Official TS SDK |
|------------|-----------------|------------------|-----------------|
| OpenAI/Codex | ✅ Yes | N/A (official exists) | ✅ Yes |
| Anthropic/Claude | ❌ No | ✅ Yes (go-anthropic) | ✅ Yes |

---

## Implication for Language Choice

### If building adapters for both Codex AND Claude:

**Option 1: Go**
- OpenAI: Official SDK ✅
- Claude: Community SDK ⚠️ (risk of breakage, maintenance burden)
- **Verdict**: Risky for Claude support

**Option 2: TypeScript (Recommended)**
- OpenAI: Official SDK ✅
- Claude: Official SDK ✅
- **Verdict**: Best support for both

**Option 3: Multi-language adapters**
- Codex adapter in Go (official SDK)
- Claude adapter in TypeScript (official SDK)
- **Verdict**: Fragmentation, harder maintenance

---

## Recommendation

**Stick with TypeScript** because:

1. **Claude has no official Go SDK** - community SDKs are a maintenance risk
2. **Official SDKs provide**: Best practices, prompt templates, error handling, streaming
3. **Future-proofing**: API changes handled by official maintainers
4. **Ecosystem alignment**: Most AI tooling is TS-first

---

## Bun Decision Confirmed

Given the SDK landscape:

```
TypeScript + Bun --compile = Native binaries for OCI distribution
```

This gives us:
- ✅ Official SDKs for both OpenAI and Anthropic
- ✅ Native binary distribution via OCI
- ✅ Single-file execution on host OS
- ✅ Multi-arch support (Linux/macOS x86_64/ARM64)

The only trade-off is binary size (~50-80MB vs Go's 15-25MB), which is acceptable for the SDK coverage gains.
