import { describe, it, expect } from "bun:test";
import {
  CONFORMANCE_DEFAULT_CALLS,
  CONFORMANCE_MIN_CALLS,
  assertConcurrentExecuteOnOneSession,
  echoConformanceAdapter,
  echoConformanceCall,
  runConcurrentExecuteConformance,
} from "@brokenbots/criteria-typescript-adapter-sdk/testing";
import type { ServeConfig } from "@brokenbots/criteria-typescript-adapter-sdk/testing";

/**
 * A fresh config per run: each conformance run starts its own TestHost from
 * it (config path); the host-path test reuses an already-started host.
 */
function echoHostConfig(): ServeConfig {
  return echoConformanceAdapter();
}

describe("concurrent-Execute-on-one-session conformance", () => {
  it("passes against the reference echo adapter (green case)", async () => {
    const report = await runConcurrentExecuteConformance({ config: echoHostConfig(), calls: 5 });

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.calls).toHaveLength(5);
    for (const [i, obs] of report.calls.entries()) {
      expect(obs.callId).toBe(`call-${i}`);
      expect(obs.error).toBeUndefined();
      expect(obs.timedOut).toBeUndefined();
      // Exactly one result per call's own stream, and it is the call's own.
      expect(obs.results).toHaveLength(1);
      expect(obs.results[0].outcome).toBe(`ok-${i}`);
      expect(obs.results[0].reason).toBe(`call-${i}`);
    }
    // Sequential behavior unchanged: one more call, alone, still correct.
    expect(report.sequential?.ok).toBe(true);
    expect(report.sequential?.results).toHaveLength(1);
    expect(report.sequential?.results[0].outcome).toBe("ok-5");
    expect(report.sequential?.results[0].reason).toBe("call-5");
  });

  it("passes against a spec-conformant adapter that validates requested outcomes", async () => {
    // The SDK's documented adapter pattern: check the requested outcome
    // against allowed_outcomes (helpers.outcomes.validate) before finalizing.
    // The default script's allowed list must cover the sequential follow-up's
    // outcome (ok-<calls>) — omitting it mislabeled a conformant adapter as
    // the CRI-305 defect class ("Execute completed without sending result").
    const config: ServeConfig = {
      name: "conformance-validating-adapter",
      version: "0.0.0",
      description: "adapter that validates the requested outcome before finalizing",
      async execute(req, helpers) {
        const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
        const requested = String(input.outcome ?? "");
        const callId = String(input.call_id ?? "");
        const check = await helpers.outcomes.validate(requested);
        if (!check.valid) {
          await helpers.outcomes.finalize("failure", { reason: callId });
          return;
        }
        await helpers.outcomes.finalize(requested, { reason: callId });
      },
    };
    const report = await runConcurrentExecuteConformance({ config, calls: 5 });

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.sequential?.ok).toBe(true);
    expect(report.sequential?.results[0].outcome).toBe("ok-5");
  });

  describe("default script self-consistency", () => {
    it("keeps every generated spec's expected outcome inside its allowedOutcomes", () => {
      for (const calls of [CONFORMANCE_MIN_CALLS, CONFORMANCE_DEFAULT_CALLS, 8]) {
        // Concurrent specs 0..calls-1 plus the sequential follow-up at index calls.
        const specs = Array.from({ length: calls + 1 }, (_, i) => echoConformanceCall(i, calls));
        for (const spec of specs) {
          expect(spec.allowedOutcomes).toContain(spec.expect.outcome);
        }
        // Expectations stay pairwise distinct, so cross-delivery is detectable.
        const keys = new Set(specs.map((s) => JSON.stringify([s.expect.outcome, s.expect.reason ?? null])));
        expect(keys.size).toBe(calls + 1);
      }
    });
  });

  it("reuses one returned config across runs (per-run overlap barrier)", async () => {
    // The overlap barrier must not leak between runs: reusing one returned
    // ServeConfig for a second run must not inherit the first run's released
    // barrier (which would silently drop the second run's overlap shape).
    const config = echoConformanceAdapter();
    for (let run = 0; run < 2; run++) {
      const report = await runConcurrentExecuteConformance({ config, calls: 5 });
      expect(report.ok).toBe(true);
      expect(report.violations).toEqual([]);
      expect(report.sequential?.ok).toBe(true);
    }
  });

  it("does not report a timeout when the stream delivered its result but stayed open", async () => {
    // A handler that finalizes correctly and then never resolves keeps each
    // stream open past the deadline. The contract is per-call result
    // correctness: the delivered result satisfies it, so the run must pass —
    // while the overdue streams stay recorded as per-call diagnostics.
    let arrived = 0;
    let releaseAll!: () => void;
    const allArrived = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const config: ServeConfig = {
      name: "conformance-finalize-then-hang-adapter",
      version: "0.0.0",
      description: "adapter that finalizes correctly but never lets its stream end",
      async execute(req, helpers) {
        const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
        arrived += 1;
        if (arrived >= 3) releaseAll();
        await allArrived;
        await helpers.outcomes.finalize(String(input.outcome), { reason: String(input.call_id) });
        await new Promise<void>(() => {});
      },
    };
    const report = await runConcurrentExecuteConformance({
      config,
      calls: 3,
      callTimeoutMs: 1500,
      checkSequential: false,
    });
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    for (const [i, obs] of report.calls.entries()) {
      expect(obs.timedOut).toBe(true);
      expect(obs.results).toHaveLength(1);
      expect(obs.results[0].outcome).toBe(`ok-${i}`);
    }
  });

  it("passes via the assert helper at the minimum fan-out size", async () => {
    const report = await assertConcurrentExecuteOnOneSession({ config: echoHostConfig(), calls: 3 });
    expect(report.ok).toBe(true);
    expect(report.calls.map((c) => c.results[0].outcome)).toEqual(["ok-0", "ok-1", "ok-2"]);
    expect(CONFORMANCE_MIN_CALLS).toBe(3);
  });

  it("accepts an already-started host and leaves its lifecycle to the caller", async () => {
    const { TestHost: Host } = await import("@brokenbots/criteria-typescript-adapter-sdk/testing");
    const host = new Host({ config: echoHostConfig() });
    await host.start();
    try {
      const report = await runConcurrentExecuteConformance({ host, calls: 3 });
      expect(report.ok).toBe(true);
      // The runner did not stop the caller's host: it is still usable.
      const after = await host.execute({
        stepName: "post-run",
        input: { call_id: "post-run", outcome: "success", conformance_calls: 1 },
        allowedOutcomes: ["success"],
      });
      expect(after.outcome).toBe("success");
      expect(after.reason).toBe("post-run");
    } finally {
      await host.stop();
    }
  });

  it("grants permission requests when autoGrantPermissions is set", async () => {
    const config: ServeConfig = {
      name: "conformance-permission-adapter",
      version: "0.0.0",
      description: "adapter that asks for a permission before finalizing",
      async execute(req, helpers) {
        const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
        await helpers.permission.request({ tool: "conformance-tool", args: { call: input.call_id } });
        await helpers.outcomes.finalize(String(input.outcome), { reason: String(input.call_id) });
      },
    };
    const report = await runConcurrentExecuteConformance({
      config,
      calls: 3,
      autoGrantPermissions: true,
    });
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("honors a custom per-call script", async () => {
    const report = await runConcurrentExecuteConformance({
      config: echoHostConfig(),
      calls: 4,
      buildCall: (i, calls) => ({
        callId: `probe-${i}`,
        stepName: `probe-${i}`,
        input: { call_id: `probe-${i}`, outcome: `pass-${i}`, conformance_calls: calls },
        // +1 covers the sequential follow-up at index `calls` (pass-<calls>).
        allowedOutcomes: Array.from({ length: calls + 1 }, (_, j) => `pass-${j}`),
        expect: { outcome: `pass-${i}`, reason: `probe-${i}` },
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.calls.map((c) => c.results[0].outcome)).toEqual([
      "pass-0",
      "pass-1",
      "pass-2",
      "pass-3",
    ]);
    expect(report.sequential?.ok).toBe(true);
    expect(report.sequential?.results[0].outcome).toBe("pass-4");
  });

  it("skips the sequential check when asked", async () => {
    const report = await runConcurrentExecuteConformance({
      config: echoHostConfig(),
      calls: 3,
      checkSequential: false,
    });
    expect(report.ok).toBe(true);
    expect(report.sequential).toBeUndefined();
  });

  it("does not require wall-clock overlap: a serializing adapter still passes", async () => {
    // The contract is per-call RESULT CORRECTNESS, not simultaneous
    // execution. An adapter that serializes its executes must still pass:
    // every call's own result lands on its own stream.
    let chain: Promise<void> = Promise.resolve();
    const config: ServeConfig = {
      name: "conformance-serial-adapter",
      version: "0.0.0",
      description: "adapter that finalizes one call at a time",
      async execute(req, helpers) {
        const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
        const outcome = String(input.outcome);
        const callId = String(input.call_id);
        chain = chain.then(async () => {
          await helpers.outcomes.finalize(outcome, { reason: callId });
        });
        await chain;
      },
    };
    const report = await runConcurrentExecuteConformance({ config, calls: 4 });
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  describe("detects the defect class (negative controls)", () => {
    it("flags a cross-routed result even when the multiset of results matches", async () => {
      // Finalizes each call with its NEIGHBOR's outcome+reason: every stream
      // receives exactly one result, but not its own. The global multiset
      // matches, so only per-call correlation catches this.
      const makeSwapAdapter = (): ServeConfig => {
        let arrived = 0;
        let releaseAll!: () => void;
        const allArrived = new Promise<void>((resolve) => {
          releaseAll = resolve;
        });
        return {
          name: "conformance-swap-adapter",
          version: "0.0.0",
          description: "adapter that routes each result to the wrong call",
          async execute(req, helpers) {
            const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
            const i = Number(String(input.call_id).split("-")[1]);
            const total = Number(input.conformance_calls ?? 0);
            arrived += 1;
            if (arrived >= 4) releaseAll();
            await allArrived;
            if (i >= total) {
              // The follow-up sequential call is not part of the swap.
              await helpers.outcomes.finalize(`ok-${i}`, { reason: `call-${i}` });
              return;
            }
            const neighbor = (i + 1) % 4;
            await helpers.outcomes.finalize(`ok-${neighbor}`, { reason: `call-${neighbor}` });
          },
        };
      };
      const report = await runConcurrentExecuteConformance({ config: makeSwapAdapter(), calls: 4 });
      expect(report.ok).toBe(false);
      // Every stream delivers exactly one result and the delivered multiset
      // matches the issued one — only per-call correlation catches the swap.
      expect(report.violations.length).toBe(8);
      for (const v of report.violations) {
        expect(v.message).toMatch(/cross-routed result|correlation broken/);
      }
      for (let i = 0; i < 4; i++) {
        const perCall = report.violations.filter((v) => v.callId === `call-${i}`);
        expect(perCall.some((v) => v.message.includes("cross-routed result"))).toBe(true);
      }
      // The sequential follow-up on the same session sees correct routing again.
      expect(report.sequential?.ok).toBe(true);
    });

    it("flags 'Result already sent' when a call finalizes twice", async () => {
      const makeDoubleAdapter = (): ServeConfig => {
        let arrived = 0;
        let releaseAll!: () => void;
        const allArrived = new Promise<void>((resolve) => {
          releaseAll = resolve;
        });
        return {
          name: "conformance-double-finalize-adapter",
          version: "0.0.0",
          description: "adapter that finalizes twice on the shared session",
          async execute(req, helpers) {
            const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
            arrived += 1;
            if (arrived >= 3) releaseAll();
            await allArrived;
            await helpers.outcomes.finalize(String(input.outcome), { reason: String(input.call_id) });
            await helpers.outcomes.finalize(String(input.outcome), { reason: String(input.call_id) });
          },
        };
      };
      const report = await runConcurrentExecuteConformance({ config: makeDoubleAdapter(), calls: 3 });
      expect(report.ok).toBe(false);
      const messages = report.violations.map((v) => v.message).join("\n");
      expect(messages).toContain("Result already sent");
      expect(messages).toContain("CRI-305 defect class");
    });

    it("flags a stream that ends without any result", async () => {
      const makeSilentAdapter = (): ServeConfig => {
        let arrived = 0;
        let releaseAll!: () => void;
        const allArrived = new Promise<void>((resolve) => {
          releaseAll = resolve;
        });
        return {
          name: "conformance-silent-adapter",
          version: "0.0.0",
          description: "adapter that never finalizes",
          async execute(_req, helpers) {
            arrived += 1;
            if (arrived >= 3) releaseAll();
            await allArrived;
            await helpers.log.stdout("handled but never finalized");
          },
        };
      };
      const report = await runConcurrentExecuteConformance({
        config: makeSilentAdapter(),
        calls: 3,
        callTimeoutMs: 1500,
        checkSequential: false,
      });
      expect(report.ok).toBe(false);
      expect(report.violations.length).toBe(3);
      for (const v of report.violations) {
        // The handler completes without finalizing: the stream either errors
        // with the lost-result signature or hits the runner's deadline.
        expect(v.message).toMatch(/completed without sending result|no result within the 1500ms deadline/);
      }
    });

    it("pinpoints exactly one lost call when only one call never finalizes", async () => {
      const makeOneSilentAdapter = (): ServeConfig => {
        let arrived = 0;
        let releaseAll!: () => void;
        const allArrived = new Promise<void>((resolve) => {
          releaseAll = resolve;
        });
        return {
          name: "conformance-one-silent-adapter",
          version: "0.0.0",
          description: "adapter that drops exactly one call's result",
          async execute(req, helpers) {
            const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
            arrived += 1;
            if (arrived >= 4) releaseAll();
            await allArrived;
            if (String(input.call_id) === "call-2") {
              // Hangs forever: the runner's deadline must catch it.
              await new Promise<void>(() => {});
            }
            await helpers.outcomes.finalize(String(input.outcome), { reason: String(input.call_id) });
          },
        };
      };
      const report = await runConcurrentExecuteConformance({
        config: makeOneSilentAdapter(),
        calls: 4,
        callTimeoutMs: 1500,
      });
      expect(report.ok).toBe(false);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0].callId).toBe("call-2");
      expect(report.violations[0].message).toContain("no result within the 1500ms deadline");
    });
  });

  describe("argument validation", () => {
    const echoConfig = echoHostConfig();

    it("requires calls >= 3 (integer)", async () => {
      await expect(runConcurrentExecuteConformance({ config: echoConfig, calls: 2 })).rejects.toThrow(
        /integer >= 3/,
      );
      await expect(runConcurrentExecuteConformance({ config: echoConfig, calls: 2.5 })).rejects.toThrow();
      await expect(
        runConcurrentExecuteConformance({ config: echoConfig, calls: CONFORMANCE_MIN_CALLS }),
      ).resolves.toBeTruthy();
    });

    it("requires a positive callTimeoutMs", async () => {
      await expect(
        runConcurrentExecuteConformance({ config: echoConfig, calls: 3, callTimeoutMs: 0 }),
      ).rejects.toThrow(/callTimeoutMs/);
    });

    it("requires exactly one of config or host", async () => {
      const { TestHost: Host } = await import("@brokenbots/criteria-typescript-adapter-sdk/testing");
      const host = new Host({ config: echoConfig });
      await host.start();
      try {
        await expect(
          runConcurrentExecuteConformance({ config: echoConfig, host, calls: 3 }),
        ).rejects.toThrow(/exactly one of `config` or `host`/);
        await expect(runConcurrentExecuteConformance({ calls: 3 })).rejects.toThrow(
          /exactly one of `config` or `host`/,
        );
      } finally {
        await host.stop();
      }
    });

    it("rejects duplicate callIds from buildCall", async () => {
      await expect(
        runConcurrentExecuteConformance({
          config: echoConfig,
          calls: 3,
          buildCall: () => ({
            callId: "same",
            stepName: "s",
            input: {},
            allowedOutcomes: [],
            expect: { outcome: "x" },
          }),
        }),
      ).rejects.toThrow(/duplicate callId/);
    });

    it("rejects non-distinct expected results from buildCall", async () => {
      await expect(
        runConcurrentExecuteConformance({
          config: echoConfig,
          calls: 3,
          buildCall: () => ({
            callId: `call-${Math.random()}`,
            stepName: "s",
            input: {},
            allowedOutcomes: [],
            expect: { outcome: "same" },
          }),
        }),
      ).rejects.toThrow(/pairwise distinct/);
    });

    it("rejects a script whose sequential follow-up collides with a fan-out expectation", async () => {
      // The sequential spec (buildCall(calls, calls)) is driven on the same
      // session and counts toward the distinctness rule: its expected result
      // must differ from every fan-out call's, or cross-delivery onto its
      // stream would be undetectable.
      await expect(
        runConcurrentExecuteConformance({
          config: echoConfig,
          calls: 3,
          buildCall: (i) => ({
            callId: `call-${i}`,
            stepName: `s-${i}`,
            input: {},
            allowedOutcomes: [],
            expect: { outcome: "same", reason: `call-${Math.min(i, 2)}` },
          }),
        }),
      ).rejects.toThrow(/pairwise distinct/);
    });

    it("rejects a buildCall that omits callId", async () => {
      await expect(
        runConcurrentExecuteConformance({
          config: echoConfig,
          calls: 3,
          buildCall: () => ({
            callId: "",
            stepName: "s",
            input: {},
            allowedOutcomes: [],
            expect: { outcome: "x" },
          }),
        }),
      ).rejects.toThrow(/no callId/);
    });
  });

  describe("rawClient accessor", () => {
    it("throws before start and exposes the client after", async () => {
      const { TestHost: Host } = await import("@brokenbots/criteria-typescript-adapter-sdk/testing");
      const host = new Host({ config: echoHostConfig() });
      expect(() => host.rawClient).toThrow(/not started/);
      await host.start();
      try {
        expect(host.rawClient).toBeTruthy();
      } finally {
        await host.stop();
      }
    });
  });
});