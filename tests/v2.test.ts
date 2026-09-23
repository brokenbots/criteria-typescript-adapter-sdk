import { describe, it, expect } from "bun:test";
import { TestHost } from "@brokenbots/criteria-typescript-adapter-sdk/testing";

describe("v2 SDK", () => {
  it("in-process adapter executes and finalizes", async () => {
    const host = new TestHost({
      config: {
        name: "test-adapter",
        version: "1.0.0",
        description: "test",
        async execute(_req, helpers) {
          await helpers.log.stdout("hello");
          await helpers.outcomes.finalize("success");
        },
      },
    });

    await host.openSession({ config: {}, secrets: {} });
    const result = await host.execute({
      step: "s1",
      input: {},
      allowedOutcomes: ["success"],
    });

    expect(result.outcome).toBe("success");
    await host.stop();
  });

  it("handles concurrent permissions", async () => {
    const host = new TestHost({
      config: {
        name: "perm-adapter",
        version: "1.0.0",
        description: "test permissions",
        permissions: ["read_file", "write_file"],
        async execute(_req, helpers) {
          const decisions = await Promise.all([
            helpers.permission.request({ tool: "read_file", args: { path: "a" } }),
            helpers.permission.request({ tool: "read_file", args: { path: "b" } }),
            helpers.permission.request({ tool: "write_file", args: { path: "c" } }),
          ]);

          for (const dec of decisions) {
            if (dec.decision === "deny") {
              await helpers.outcomes.finalize("failure", { reason: "denied" });
              return;
            }
          }

          await helpers.outcomes.finalize("success");
        },
      },
      autoGrantPermissions: true,
    });

    await host.openSession({ config: {}, secrets: {} });
    const result = await host.execute({
      step: "s1",
      input: {},
      allowedOutcomes: ["success", "failure"],
    });

    expect(result.outcome).toBe("success");
    await host.stop();
  });

  it("snapshot and restore", async () => {
    const host = new TestHost({
      config: {
        name: "snap-adapter",
        version: "1.0.0",
        description: "test snapshot",
        async openSession(_req, helpers) {
          helpers.session.set("counter", 42);
        },
        async execute(_req, helpers) {
          const counter = helpers.session.get<number>("counter") ?? 0;
          await helpers.outcomes.finalize("success", { reason: String(counter) });
        },
        async snapshot(_sessionId, helpers) {
          const state = JSON.stringify({ counter: helpers.session.get<number>("counter") ?? 0 });
          return {
            schemaVersion: 1,
            state: new TextEncoder().encode(state),
          };
        },
        async restore(_sessionId, blob, helpers) {
          const state = JSON.parse(new TextDecoder().decode(blob.state)) as { counter: number };
          helpers.session.set("counter", state.counter);
        },
      },
    });

    await host.openSession({ config: {}, secrets: {} });
    const snap = await host.snapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.state).toBeDefined();

    // Restore into a fresh session
    const host2 = new TestHost({
      config: {
        name: "snap-adapter",
        version: "1.0.0",
        description: "test snapshot",
        async openSession(_req, helpers) {
          helpers.session.set("counter", 0);
        },
        async execute(_req, helpers) {
          const counter = helpers.session.get<number>("counter") ?? 0;
          await helpers.outcomes.finalize("success", { reason: String(counter) });
        },
        async snapshot(_sessionId, helpers) {
          const state = JSON.stringify({ counter: helpers.session.get<number>("counter") ?? 0 });
          return {
            schemaVersion: 1,
            state: new TextEncoder().encode(state),
          };
        },
        async restore(_sessionId, blob, helpers) {
          const state = JSON.parse(new TextDecoder().decode(blob.state)) as { counter: number };
          helpers.session.set("counter", state.counter);
        },
      },
    });
    await host2.start();
    await host2.openSession({ config: {}, secrets: {} });
    await host2.restore(snap);

    const result = await host2.execute({ step: "s1", input: {}, allowedOutcomes: ["success"] });
    expect(result.reason).toBe("42");
    await host.stop();
    await host2.stop();
  });

  it("delivers each iteration its own result under concurrent Executes on one session (CRI-305)", async () => {
    // Regression for CRI-305: a host running adapter-target parallel steps
    // multiplexes several concurrent Execute calls over ONE wire session.
    // Result-delivery state used to live on the session (a single
    // executeStream pointer, overwritten by every arriving Execute, plus a
    // shared finalized flag), so five concurrent iterations reproduced the
    // observed 1x "Execute completed without sending result" + 4x
    // "Result already sent" split - and the first finalizer's result could
    // be written to a DIFFERENT iteration's stream (cross-routing).
    const ITERATIONS = 5;
    let arrived = 0;
    let release!: () => void;
    const allArrived = new Promise<void>((resolve) => {
      release = resolve;
    });

    const host = new TestHost({
      config: {
        name: "parallel-adapter",
        version: "1.0.0",
        description: "test concurrent executes on one session",
        async execute(req, helpers) {
          arrived += 1;
          if (arrived === ITERATIONS) release();
          // Hold every iteration's finalize until ALL Execute calls have
          // arrived on the shared session, so each finalize runs with the
          // other calls' streams already registered - the exact fan-out
          // shape that corrupted per-session result delivery.
          await allArrived;
          await helpers.outcomes.finalize(`ok-${req.stepName}`, {
            reason: `reason-${req.stepName}`,
          });
        },
      },
    });

    await host.openSession({ config: {}, secrets: {} });

    const calls = Array.from({ length: ITERATIONS }, (_, i) =>
      host.execute({
        stepName: `iter-${i}`,
        input: {},
        allowedOutcomes: [`ok-iter-${i}`],
      }),
    );
    const settled = await Promise.allSettled(calls);

    // No "Result already sent" rejections and no "ended without result":
    for (const s of settled) {
      expect(s.status).toBe("fulfilled");
    }
    const results = settled.map(
      (s) => (s as PromiseFulfilledResult<{ outcome: string; reason?: string }>).value,
    );
    // No cross-routed results: each call sees its OWN outcome and reason.
    for (let i = 0; i < ITERATIONS; i++) {
      expect(results[i].outcome).toBe(`ok-iter-${i}`);
      expect(results[i].reason).toBe(`reason-iter-${i}`);
    }
    await host.stop();
  });
});
