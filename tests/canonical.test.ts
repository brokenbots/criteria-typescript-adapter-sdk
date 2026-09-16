import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJSON, argsDigest } from "@brokenbots/criteria-typescript-adapter-sdk";

// The digest vectors in this file are the same pinned values the Go SDK's
// criteria/v2/canonical_test.go uses (TestCanonicalJSON,
// TestCanonicalJSON_InputKeyOrderIrrelevant, TestArgsDigest_HostParityVectors,
// TestArgsDigest_ToolCallParityWithPermissionRequest): host-computed values
// over the shared canonical-JSON dialect (byte-wise key sort, no whitespace,
// encoding/json string escaping). TS and Go must produce identical digests
// for the same inputs — this is the args_digest parity contract (CRI-154).

const decode = (raw: string): unknown => JSON.parse(raw);

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data as never).digest("hex");
}

describe("canonicalJSON (pinned host parity vectors)", () => {
  // [name, raw JSON (null → use native), want]
  const cases: [string, string | null, unknown, string][] = [
    ["empty object", "{}", null, "{}"],
    ["empty array", "[]", null, "[]"],
    ["null", "null", null, "null"],
    ["true", "true", null, "true"],
    ["false", "false", null, "false"],
    ["integer float", "1.5", null, "1.5"],
    ["exponent expands", "1e7", null, "10000000"],
    ["small exponent go format", "1e-7", null, "1e-7"],
    ["large exponent go format", "1e21", null, "1e+21"],
    ["negative exponent tiny", "1e-21", null, "1e-21"],
    ["float64 precision", "12345678901234567890", null, "12345678901234567000"],
    ["negative zero kept", "-0", null, "-0"],
    ["fraction stays full", "0.30000000000000004", null, "0.30000000000000004"],
    ["plain string", '"plain"', null, '"plain"'],
    ["string escapes", '"quote\\"inside"', null, '"quote\\"inside"'],
    ["backslash and newline", '"backslash\\\\and newline\\n"', null, '"backslash\\\\and newline\\n"'],
    ["html escaping", '"html<&>chars"', null, '"html\\u003c\\u0026\\u003echars"'],
    ["unicode passes through", '"unicode ☃ snowman"', null, '"unicode ☃ snowman"'],
    ["u2028 u2029 escaped", '"u2028 u2029 line-seps"', null, '"u2028\\u2028u2029\\u2029line-seps"'],
    ["keys sorted byte-wise", '{"z":1,"a":2,"M":3,"_":4,"0":5,"é":6,"☃":7}', null, '{"0":5,"M":3,"_":4,"a":2,"z":1,"é":6,"☃":7}'],
    ["nested containers", '{"b":{"d":4,"c":[1,2,{"y":1,"x":2}]},"a":1}', null, '{"a":1,"b":{"c":[1,2,{"x":2,"y":1}],"d":4}}'],
    ["mixed array", '[1,"two",null,false,{"k":"v"},[9,8]]', null, '[1,"two",null,false,{"k":"v"},[9,8]]'],
    ["empty key sorts first", '{"":"empty key","a":"dup risk"}', null, '{"":"empty key","a":"dup risk"}'],
    ["deep nesting", '{"deep":{"a":{"b":{"c":{"d":{"e":["x","y",{"f":true}]}}}}}}', null, '{"deep":{"a":{"b":{"c":{"d":{"e":["x","y",{"f":true}]}}}}}}'],
    ["go native map and slice", "", { beta: 2.5, alpha: "a", gamma: [true, null, 3.0] }, '{"alpha":"a","beta":2.5,"gamma":[true,null,3]}'],
    ["go native struct fields sorted", "", { tool: "create_issue", args: { title: "T", count: 2.0 } }, '{"args":{"count":2,"title":"T"},"tool":"create_issue"}'],
  ];

  for (const [name, raw, native, want] of cases) {
    it(name, () => {
      const value = raw !== "" ? decode(raw) : native;
      const got = canonicalJSON(value);
      expect(got).toBe(want);
      expect(got.includes("\n")).toBe(false);
    });
  }
});

describe("canonicalJSON input key order irrelevance", () => {
  it("different key orders produce identical bytes and digests", () => {
    const one = canonicalJSON({ a: 1, b: 2, c: { z: 1, y: 2 } });
    const two = canonicalJSON({ c: { y: 2, z: 1 }, b: 2, a: 1 });
    expect(one).toBe(two);

    const d1 = argsDigest({ a: 1, b: 2, c: { z: 1, y: 2 } });
    const d2 = argsDigest({ c: { y: 2, z: 1 }, b: 2, a: 1 });
    expect(d1).toBe(d2);
  });
});

describe("argsDigest host parity vectors (TestArgsDigest_HostParityVectors)", () => {
  const cases: [string, string | null, unknown, string][] = [
    ["empty object", "{}", null, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
    ["empty array", "[]", null, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"],
    ["null", "null", null, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
    ["small exponent go format", "1e-7", null, "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"],
    ["html escaping", '"html<&>chars"', null, "9f4010548524be217ca3539249cc528d9b067ba7de07c095271f80df4553b75a"],
    ["unicode passes through", '"unicode ☃ snowman"', null, "9d9a5c2f1aca16ca4978530c381aa4a58db0a8ed2baf766db03a4aa1e9645398"],
    ["byte-wise key sort", '{"z":1,"a":2,"M":3,"_":4,"0":5,"é":6,"☃":7}', null, "b741b73ebe81afe9d2a8c00617ce3ebadfb5bd1bf031142863056361f1abf8a3"],
    ["nested containers", '{"b":{"d":4,"c":[1,2,{"y":1,"x":2}]},"a":1}', null, "a93275b484a96df365c78234c327323850c9f5d6cee140fc296b26ae7450956f"],
    ["float64 precision", "12345678901234567890", null, "afdcd3321a2fcdb3414cb69a0c92c6bb8d74c06066d721083cc01fec664ab97f"],
    ["go native struct", "", { tool: "create_issue", args: { title: "T", count: 2.0 } }, "7c869fd97b0d13b6081238b94183ecaf7cf1611b04586cc6d14d9567230910a9"],
    ["adapter tool call args", null, { adapter: "github", tool: "create_issue", args: { title: "T", body: "B", labels: ["p1", "p2"], draft: false } }, "66b19796b64efff0e606607318cc389ca57d066067e8bac1a5967667930a85c2"],
    ["adapter tool args realistic", "", { owner: "octocat", repo: "hello-world", title: "Found a bug", body: "I'm having a problem with this.", labels: ["bug", "help wanted"], draft: false }, "7a8cfc10662c078da696d5b3f4574c830a2aa3e5a675f3d4d0086f1bf9d5ff11"],
    ["adapter tool args nested", "", { config: { retries: 3, timeout_ms: 1500.5, flags: [true, false] }, id: "req-123" }, "9d85fdfad7cbc6f66da717261972f7bda1e76fce9b5f730a6ceb4e56ee98b7e5"],
  ];

  for (const [name, raw, native, wantDigest] of cases) {
    it(name, () => {
      const value = raw !== "" && raw !== null ? decode(raw) : native;
      const got = argsDigest(value);
      expect(got).toBe(wantDigest);
      expect(got).toHaveLength(64);
    });
  }
});

describe("argsDigest matches canonical JSON sha256", () => {
  it("digest is exactly sha256 over the canonical bytes", () => {
    const value = { tool: "create_issue", args: { n: 1, s: "x" } };
    const canon = canonicalJSON(value);
    expect(argsDigest(value)).toBe(sha256Hex(canon));
  });
});

describe("canonicalJSON unsupported types error", () => {
  it("errors instead of producing garbage", () => {
    expect(() => canonicalJSON(NaN)).toThrow();
    expect(() => canonicalJSON(Infinity)).toThrow();
    expect(() => canonicalJSON(1n)).toThrow();
    expect(() => canonicalJSON(() => "fn")).toThrow();
    expect(() => canonicalJSON(new (class Foo {})())).toThrow();
  });

  it("rejects circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJSON(circular)).toThrow();
  });
});

describe("argsDigest tool-call parity with permission request", () => {
  const vectors: [string, string, string, string][] = [
    [
      "flat args, key order differs from canonical",
      '{"title":"Found a bug","labels":["bug","help wanted"]}',
      '{"labels":["bug","help wanted"],"title":"Found a bug"}',
      "1ad0cfd63d392e1498cc20c961665b51f9595916fa6f74d6fc201eeeae1d34e9",
    ],
    [
      "nested args, nested key order differs too",
      '{"draft":false,"repo":"hello-world","owner":"octocat","config":{"timeout_ms":1500.5,"retries":3}}',
      '{"config":{"retries":3,"timeout_ms":1500.5},"draft":false,"owner":"octocat","repo":"hello-world"}',
      "fc795b0731cf8ee1c9b55c4cf19d7c320e7066d92043804b9df3f192f8a4af0d",
    ],
    [
      "args containing HTML-escapable characters",
      '{"body":"a<b>&c"}',
      '{"body":"a\\u003cb\\u003e\\u0026c"}',
      "4299b4663303acff818fd993e0cabd98949de46231b7de58fa5808087ba2834a",
    ],
    ["empty args object", "{}", "{}", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
  ];

  for (const [name, argsJSON, wantCanon, wantDigest] of vectors) {
    it(name, () => {
      const args = decode(argsJSON) as Record<string, unknown>;
      expect(canonicalJSON(args)).toBe(wantCanon);
      const digest = argsDigest(args);
      expect(digest).toBe(wantDigest);
      // The digest is exactly sha256 over the pinned canonical bytes.
      expect(digest).toBe(sha256Hex(wantCanon));
    });
  }

  it("same args in different map orders digest identically", () => {
    const d1 = argsDigest({ title: "T", body: "B", labels: ["bug", "p1"], draft: false });
    const d2 = argsDigest({ draft: false, labels: ["bug", "p1"], body: "B", title: "T" });
    expect(d1).toBe(d2);
  });
});