import { describe, it, expect } from "bun:test";
import { TestHost } from "@brokenbots/criteria-typescript-adapter-sdk/testing";

/**
 * Regression test for the adapter teardown fix.
 *
 * go-plugin tears a plugin down by closing its gRPC client connection and
 * waiting ~2s for the plugin to self-exit before SIGKILLing. The adapter now
 * detects that disconnect (the long-lived Log stream closing, debounced) and
 * invokes the `onTeardown` hook so the caller can drain + exit on its own —
 * no signal or SIGKILL required from the host.
 *
 * This test drives the real gRPC path in-process: it opens a session (which
 * opens a Log stream), then closes the client the way the host does on teardown,
 * and asserts `onTeardown` fires. The callback here only records the call; the
 * real `serve()` is what turns it into a `process.exit(0)`.
 */
describe("host-disconnect teardown", () => {
  it("fires onTeardown when the host closes the gRPC connection", async () => {
    let fired = false;
    const host = new TestHost({
      config: {
        name: "teardown-test",
        version: "1.0.0",
        description: "teardown detection",
        async execute(_req, helpers) {
          await helpers.outcomes.finalize("success");
        },
      },
      onTeardown: () => {
        fired = true;
      },
    });

    await host.openSession({ config: {}, secrets: {} });
    const result = await host.execute({ step: "s1", input: {}, allowedOutcomes: ["success"] });
    expect(result.outcome).toBe("success");

    // Host teardown cancels the Log stream's gRPC call (the real host does this
    // in SessionManager.Close → cancelLog before Kill). The server sees the
    // CANCEL, the last Log stream closes, and after the debounce grace the SDK
    // fires onTeardown so the adapter can self-exit.
    host.cancelLogStream();

    // onTeardown fires after HOST_DISCONNECT_GRACE_MS (500ms). Give it room.
    const deadline = Date.now() + 3000;
    while (!fired && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fired).toBe(true);

    await host.stop();
  });

  it("does not fire onTeardown while the host stays connected", async () => {
    let fired = false;
    const host = new TestHost({
      config: {
        name: "teardown-neg",
        version: "1.0.0",
        description: "no teardown while connected",
        async execute(_req, helpers) {
          await helpers.outcomes.finalize("success");
        },
      },
      onTeardown: () => {
        fired = true;
      },
    });

    await host.openSession({ config: {}, secrets: {} });
    await host.execute({ step: "s1", input: {}, allowedOutcomes: ["success"] });

    // Connected and idle — well past the debounce grace — onTeardown must not
    // fire, because the Log stream is still open.
    await new Promise((r) => setTimeout(r, 900));
    expect(fired).toBe(false);

    await host.stop();
  });
});