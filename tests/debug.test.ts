import { describe, it, expect } from "bun:test";
import { TestHost } from "@criteria/adapter-sdk/testing";

describe("debug", () => {
  it("shows event shape", async () => {
    const host = new TestHost({
      config: {
        name: "debug",
        version: "1.0.0",
        description: "debug",
        permissions: ["read_file"],
        async execute(_req, helpers) {
          const dec = await helpers.permission.request({ tool: "read_file", args: { path: "a" } });
          await helpers.outcomes.finalize("success", { reason: dec.decision });
        },
      },
      autoGrantPermissions: true,
    });

    await host.openSession({ config: {}, secrets: {} });
    const result = await host.execute({ step: "s1", input: {}, allowed_outcomes: ["success"] });
    console.log("RESULT:", JSON.stringify(result));
    await host.stop();
  });
});
