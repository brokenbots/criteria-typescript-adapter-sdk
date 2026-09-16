import { describe, it, expect } from "bun:test";
import type { ServeConfig, Helpers } from "@brokenbots/criteria-typescript-adapter-sdk";
import { TestHost, type ToolCallRequestPayload } from "@brokenbots/criteria-typescript-adapter-sdk/testing";
import {
  argsDigest,
  CALL_ERROR_HOST_UNSUPPORTED,
} from "@brokenbots/criteria-typescript-adapter-sdk";

// Contract + regression tests for helpers.tools.callAdapterTool (CRI-152):
// the permission.request adapter_tool payload contract on the Execute
// stream, the tool_call_result/cancel dispatch on the Permissions stream,
// the old-host bare-grant degradation, and typed failures. Mirrors the Go
// SDK's adapterhost toolcall_test.go scenarios.

const TARGET = "adapter.http.echo.tools.ping";

/** Serializes a step report through the result reason. */
type Report = (data: unknown) => Promise<void>;

/** A typed failure surfaced through the step report. */
interface FailureReport {
  ok: false;
  name?: string;
  code?: string;
  reason?: string;
  message?: string;
}

/**
 * Runs one execute step against an in-process TestHost. The adapter body
 * invokes the helper surface and reports results through `report`; every
 * permission.request payload the adapter sends is captured via the replay
 * knob. Without a knob reply the fake host behaves like an old host
 * (bare grant, never answers).
 */
async function runToolStep(opts: {
  body: (helpers: Helpers, report: Report) => Promise<void>;
  toolCallResult?: (payload: ToolCallRequestPayload) => unknown;
  autoGrantPermissions?: boolean;
  permissionDelayMs?: number;
}): Promise<{ outcome: string; payloads: ToolCallRequestPayload[]; reported: unknown }> {
  const payloads: ToolCallRequestPayload[] = [];
  const host = new TestHost({
    config: {
      name: "tool-adapter",
      version: "1.0.0",
      description: "test adapter exercising the tool-call helper",
      async execute(_req, helpers) {
        const report: Report = (data) => helpers.outcomes.finalize("success", { reason: JSON.stringify(data) });
        await opts.body(helpers, report);
      },
    } as ServeConfig,
    toolCallResult: (payload) => {
      payloads.push(payload);
      return opts.toolCallResult ? opts.toolCallResult(payload) : { kind: "bare_grant" };
    },
    autoGrantPermissions: opts.autoGrantPermissions,
    permissionDelayMs: opts.permissionDelayMs,
  });

  await host.openSession({ config: {}, secrets: {} });
  const result = await host.execute({ stepName: "s1", input: {}, allowedOutcomes: ["success"] });
  await host.stop();

  let reported: unknown;
  if (result.reason) {
    try {
      reported = JSON.parse(result.reason);
    } catch {
      reported = undefined;
    }
  }
  return { outcome: result.outcome, payloads, reported };
}

/** Reports a successful tool call back through the step reason. */
const reportCall = async (
  call: () => Promise<{ outcome: string; outputs: Record<string, unknown> | undefined }>,
  report: Report
) => {
  const r = await call();
  await report({ ok: true, outcome: r.outcome, outputs: r.outputs ?? null });
};

/** Reports a thrown helper failure back through the step reason. */
const reportFailure = async (err: unknown, report: Report) => {
  const e = err as Error & { code?: string; reason?: string };
  await report({ ok: false, name: e.name, code: e.code, reason: e.reason, message: e.message });
};

/** Shape of one thrown helper failure, for embedding in a combined report. */
const failureOf = (err: unknown): FailureReport => {
  const e = err as Error & { code?: string; reason?: string };
  return { ok: false, name: e.name, code: e.code, reason: e.reason, message: e.message };
};

describe("helpers.tools.callAdapterTool", () => {
  it("grant + result resolves the full call and rides the documented payload", async () => {
    const { reported, payloads } = await runToolStep({
      body: async (helpers, report) => {
        try {
          await reportCall(
            () => helpers.tools.callAdapterTool({ target: TARGET, args: { hello: "world" } }),
            report
          );
        } catch (err) {
          await reportFailure(err, report);
        }
      },
      toolCallResult: () => ({ kind: "result", outcome: "success", outputs: { pong: true } }),
    });

    expect(reported).toEqual({ ok: true, outcome: "success", outputs: { pong: true } });

    // Payload contract: exactly one adapter_tool permission.request, in the
    // documented wire form.
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload.kind).toBe("adapter_tool");
    expect(typeof payload.request_id).toBe("string");
    expect(payload.request_id).toMatch(/^adapter-tool-/);
    expect(payload.target).toBe(TARGET);
    expect(payload.tool).toBe("ping");
    expect(payload.args).toEqual({ hello: "world" });
    expect(payload.args_digest).toBe(argsDigest({ hello: "world" }));
    expect(typeof payload.args_preview).toBe("string");
  });

  it("normalizes nil args to an empty object with the empty-object digest", async () => {
    const { reported, payloads } = await runToolStep({
      body: async (helpers, report) => {
        try {
          await reportCall(() => helpers.tools.callAdapterTool({ target: TARGET }), report);
        } catch (err) {
          await reportFailure(err, report);
        }
      },
      toolCallResult: () => ({ kind: "result", outcome: "success" }),
    });

    expect(reported).toEqual({ ok: true, outcome: "success", outputs: null });
    expect(payloads[0].args).toEqual({});
    expect(payloads[0].args_digest).toBe(argsDigest({}));
  });

  it("a result with no outputs decodes to undefined outputs", async () => {
    const { reported } = await runToolStep({
      body: async (helpers, report) => {
        try {
          const r = await helpers.tools.callAdapterTool({ target: TARGET, args: {} });
          await report({ ok: true, outcome: r.outcome, hasOutputs: r.outputs !== undefined });
        } catch (err) {
          await reportFailure(err, report);
        }
      },
      toolCallResult: () => ({ kind: "result", outcome: "done" }),
    });

    expect(reported).toEqual({ ok: true, outcome: "done", hasOutputs: false });
  });

  it("chunked fragments are reassembled in seq order", async () => {
    const { reported } = await runToolStep({
      body: async (helpers, report) => {
        try {
          await reportCall(
            () => helpers.tools.callAdapterTool({ target: TARGET, args: { big: true } }),
            report
          );
        } catch (err) {
          await reportFailure(err, report);
        }
      },
      toolCallResult: () => ({
        kind: "result",
        outcome: "success",
        // > 40 bytes of JSON forces multiple chunkBytes fragments.
        outputs: { blob: "x".repeat(120) },
        chunkBytes: 32,
      }),
    });

    expect(reported).toEqual({ ok: true, outcome: "success", outputs: { blob: "x".repeat(120) } });
  });

  it("a denied call (cancel) reports ToolCallDeniedError with the host reason", async () => {
    const { reported, payloads } = await runToolStep({
      body: async (helpers, report) => {
        try {
          await reportCall(
            () => helpers.tools.callAdapterTool({ target: TARGET, args: { n: 1 } }),
            report
          );
        } catch (err) {
          await reportFailure(err, report);
        }
      },
      toolCallResult: () => ({ kind: "deny", reason: "tool disabled by policy" }),
    });

    expect(reported?.ok).toBe(false);
    expect(reported?.name).toBe("ToolCallDeniedError");
    expect(reported?.reason).toBe("tool disabled by policy");
    // No result fragment ever arrives for a denied call.
    expect(payloads).toHaveLength(1);
  });

  it("a call_error resolves typed with the registry value; unknown codes round-trip", async () => {
    for (const code of ["unknown_adapter", "paused", "some_future_code"]) {
      const { reported } = await runToolStep({
        body: async (helpers, report) => {
          try {
            await reportCall(() => helpers.tools.callAdapterTool({ target: TARGET, args: {} }), report);
          } catch (err) {
            await reportFailure(err, report);
          }
        },
        toolCallResult: () => ({ kind: "result", outcome: "", callError: code }),
      });

      expect(reported?.ok).toBe(false);
      expect(reported?.name).toBe("ToolCallError");
      expect(reported?.code).toBe(code);
    }
  });

  it("an old host's bare allow-grant degrades to host_unsupported and caches the session", async () => {
    let sent = 0;
    const { reported } = await runToolStep({
      body: async (helpers, report) => {
        try {
          await helpers.tools.callAdapterTool({ target: TARGET, args: {} }, { timeoutMs: 150 });
        } catch (err) {
          await reportFailure(err, report);
        }
        try {
          // Second call on the same session: fails fast WITHOUT sending.
          await helpers.tools.callAdapterTool({ target: TARGET, args: {} }, { timeoutMs: 150 });
        } catch (err) {
          await reportFailure(err, report);
        }
      },
      // Old host: grant only, never answer.
      toolCallResult: () => {
        sent += 1;
        return { kind: "bare_grant" };
      },
    });

    expect(reported?.ok).toBe(false);
    expect(reported?.code).toBe(CALL_ERROR_HOST_UNSUPPORTED);
    expect(sent).toBe(1);
  });

  it("the host_unsupported cache is per session: another session is unaffected", async () => {
    let sent = 0;
    const host = new TestHost({
      config: {
        name: "tool-adapter",
        version: "1.0.0",
        description: "test",
        async execute(_req, helpers) {
          await helpers.tools
            .callAdapterTool({ target: TARGET, args: {} }, { timeoutMs: 150 })
            .catch(() => undefined);
          await helpers.outcomes.finalize("success");
        },
      },
      toolCallResult: () => {
        sent += 1;
        return { kind: "bare_grant" };
      },
    });
    await host.openSession({ sessionId: "s1" });
    await host.execute({ stepName: "s1", input: {}, allowedOutcomes: ["success"] });

    // A fresh session on the same host is NOT poisoned by the first one: the
    // second session's call is sent instead of failing fast.
    await host.openSession({ sessionId: "s2" });
    const result = await host.execute({ stepName: "s2", input: {}, allowedOutcomes: ["success"] });
    expect(result.outcome).toBe("success");
    expect(sent).toBe(2);
    await host.stop();
  });

  it("a deadline with no grant at all reports ToolCallTimeoutError and is NOT cached", async () => {
    const { reported, payloads } = await runToolStep({
      body: async (helpers, report) => {
        const reports: unknown[] = [];
        try {
          await helpers.tools.callAdapterTool({ target: TARGET, args: {} }, { timeoutMs: 120 });
        } catch (err) {
          reports.push({ step: 1, ...failureOf(err) });
        }
        // The timeout must not have cached the session as unsupported.
        try {
          const r = await helpers.tools.callAdapterTool(
            { target: TARGET, args: { retry: true } },
            { timeoutMs: 2000 }
          );
          reports.push({ step: 2, ok: true, outcome: r.outcome, outputs: r.outputs ?? null });
        } catch (err) {
          reports.push({ step: 2, ...failureOf(err) });
        }
        await report(reports);
      },
      toolCallResult: (payload) => {
        // First call: nothing at all — not granted, not answered. The second
        // call meets a working host that answers.
        if (payload.args && (payload.args as Record<string, unknown>).retry) {
          return { kind: "result", outcome: "success", outputs: { retried: true } };
        }
        return { kind: "silence" };
      },
    });

    const list = reported as { step: number; ok: boolean; name?: string; code?: string }[];
    expect(list).toHaveLength(2);
    expect(list[0].ok).toBe(false);
    expect(list[0].name).toBe("ToolCallTimeoutError");
    expect(list[1].ok).toBe(true);
    expect(list[1].outcome).toBe("success");
    expect(payloads).toHaveLength(2);
  });

  it("a reply that arrives after the caller timed out is dropped without crashing", async () => {
    const { reported, payloads } = await runToolStep({
      body: async (helpers, report) => {
        try {
          await reportCall(
            () => helpers.tools.callAdapterTool({ target: TARGET, args: { slow: true } }, { timeoutMs: 100 }),
            report
          );
        } catch (err) {
          await reportFailure(err, report);
        }
      },
      toolCallResult: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: "result", outcome: "success", outputs: { late: true } }), 250);
        }),
    });

    expect(reported?.ok).toBe(false);
    expect(reported?.name).toBe("ToolCallTimeoutError");
    expect(payloads).toHaveLength(1);
  });

  it("concurrent calls correlate by request_id", async () => {
    const { reported } = await runToolStep({
      body: async (helpers, report) => {
        const [a, b] = await Promise.all([
          helpers.tools.callAdapterTool({ target: "adapter.http.echo.tools.ping", args: { which: "a" } }),
          helpers.tools.callAdapterTool({ target: "adapter.http.echo.tools.pong", args: { which: "b" } }),
        ]);
        await report({
          ok: true,
          a: { outcome: a.outcome, outputs: a.outputs },
          b: { outcome: b.outcome, outputs: b.outputs },
        });
      },
      toolCallResult: (payload) => {
        const which = (payload.args as Record<string, unknown>).which;
        return { kind: "result", outcome: `done-${which}`, outputs: { answered: which } };
      },
    });

    expect(reported).toEqual({
      ok: true,
      a: { outcome: "done-a", outputs: { answered: "a" } },
      b: { outcome: "done-b", outputs: { answered: "b" } },
    });
  });

  it("validates the target locally: empty target and bare surface throw", async () => {
    const { reported, payloads } = await runToolStep({
      body: async (helpers, report) => {
        const failures: FailureReport[] = [];
        for (const bad of [{ target: "" }, { target: "adapter.http.echo.tools" }]) {
          try {
            await helpers.tools.callAdapterTool(bad as never);
          } catch (err) {
            const e = err as Error & { code?: string; reason?: string };
            failures.push({ ok: false, name: e.name, code: e.code, reason: e.reason, message: e.message });
          }
        }
        await report(failures);
      },
      toolCallResult: () => ({ kind: "result", outcome: "success" }),
    });

    // Neither call reached the host.
    expect(payloads).toHaveLength(0);
    const list = reported as { ok: boolean; name: string; code?: string; message: string }[];
    expect(list).toHaveLength(2);
    for (const item of list) {
      expect(item.ok).toBe(false);
      expect(item.name).toBe("Error");
      expect(item.code).toBeUndefined();
      expect(item.message).toContain("target");
    }
  });

  it("non-object args are rejected before sending", async () => {
    const { reported, payloads } = await runToolStep({
      body: async (helpers, report) => {
        const failures: FailureReport[] = [];
        for (const bad of [[1, 2], "str", 5, true]) {
          try {
            await helpers.tools.callAdapterTool({ target: TARGET, args: bad as never });
          } catch (err) {
            const e = err as Error & { code?: string; reason?: string };
            failures.push({ ok: false, name: e.name, code: e.code, reason: e.reason, message: e.message });
          }
        }
        await report(failures);
      },
      toolCallResult: () => ({ kind: "result", outcome: "success" }),
    });

    expect(payloads).toHaveLength(0);
    const list = reported as { ok: boolean; message?: string }[];
    expect(list).toHaveLength(4);
    for (const item of list) {
      expect(item.ok).toBe(false);
      expect(item.message).toContain("args must be a JSON object");
    }
  });

  it("the Permissions stream closing while a call is in flight resolves typed", async () => {
    const host = new TestHost({
      config: {
        name: "tool-adapter",
        version: "1.0.0",
        description: "test",
        async execute(_req, helpers) {
          try {
            const r = await helpers.tools.callAdapterTool({ target: TARGET, args: {} }, { timeoutMs: 5000 });
            await helpers.outcomes.finalize("success", { reason: JSON.stringify({ ok: true, outcome: r.outcome }) });
          } catch (err) {
            const e = err as Error & { code?: string };
            await helpers.outcomes.finalize("success", {
              reason: JSON.stringify({ ok: false, name: e.name, code: e.code, message: e.message }),
            });
          }
        },
      },
      // No grant, no result: the call stays pending until the stream dies.
      toolCallResult: () => ({ kind: "silence" }),
    });

    await host.openSession({ config: {}, secrets: {} });
    const executePromise = host.execute({ stepName: "s1", input: {}, allowedOutcomes: ["success"] });

    // Let the call go in flight, then tear the Permissions stream down the
    // way the real host does; the SDK must fail the call typed, not hang
    // until the deadline.
    await new Promise((r) => setTimeout(r, 150));
    host.cancelPermissionsStream();

    const result = await executePromise;
    await host.stop();
    const reported = result.reason
      ? (JSON.parse(result.reason) as { ok: boolean; name?: string; code?: string })
      : undefined;
    expect(reported?.ok).toBe(false);
    expect(reported?.name).toBe("ToolCallStreamClosedError");
  });

  it("the plain permission helper keeps working (allow) and carries the canonical args digest", async () => {
    const captured: ToolCallRequestPayload[] = [];
    const { reported } = await runToolStep({
      autoGrantPermissions: true,
      body: async (helpers, report) => {
        const decision = await helpers.permission.request({ tool: "fs.read", args: { "path": "a<b>&c" } });
        await report({ decision, expectedDigest: argsDigest({ "path": "a<b>&c" }) });
      },
      toolCallResult: (payload) => {
        captured.push(payload);
        return { kind: "bare_grant" };
      },
    });

    expect(reported?.decision?.decision).toBe("allow");
    // The plain permission request also carries its args digest on the wire,
    // now computed over the canonical JSON of the args (replacing the
    // server-v2.ts:228 TODO); it is not an adapter_tool payload.
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBeUndefined();
    expect(captured[0].argsDigest).toBe(reported?.expectedDigest);
  });
});
