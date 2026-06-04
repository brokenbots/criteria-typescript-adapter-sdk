import { describe, it, expect } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";

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
});
