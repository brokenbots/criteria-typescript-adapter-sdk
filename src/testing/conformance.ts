/**
 * Conformance case: N concurrent Execute calls on ONE open session
 * (parallel_safe evidence).
 *
 * `parallel_safe` is a self-declared adapter capability. The engine's
 * parallel fan-out multiplexes several concurrent Execute calls over ONE wire
 * session and relies on the SDK delivering each call's result to that call's
 * own stream. That reliance broke once (CRI-305: session-scoped result
 * delivery cross-routed results and shared a finalized flag, surfacing as
 * "Result already sent" / "Execute completed without sending result"). This
 * module turns the reliance into an executable check any adapter author can
 * run against their own adapter before declaring `parallel_safe`:
 *
 *     N >= 3 concurrent Execute calls on ONE open session must each deliver
 *     exactly one result on their own stream, and that result must be the
 *     call's OWN: no result lost, no "Result already sent", no "Execute
 *     completed without sending result", no result landing on a sibling's
 *     stream. A sequential Execute on the same session must keep working.
 *
 * The contract is per-call RESULT CORRECTNESS, not simultaneous execution:
 * an adapter that serializes concurrent Executes satisfies it as long as
 * every call still gets its own result on its own stream. Outcomes are
 * asserted per call; wall-clock overlap is never asserted.
 *
 * Correlation convention (the default script)
 * -------------------------------------------
 * Each Execute request carries unique markers in `req.input`:
 *
 * - `call_id` — unique per call; the adapter under test must echo it back as
 *   the finalize `reason` (the only output `outcomes.finalize` writes, so it
 *   is delivered as the result's `outputs.reason`).
 * - `outcome` — the outcome string the call must finalize with.
 *
 * `echoConformanceAdapter()` is a reference adapter implementing exactly
 * that. It holds every finalize behind a barrier until all fan-out calls
 * have arrived on the shared session — the overlap shape that corrupted
 * per-session result delivery pre-CRI-305 (a finalize running while sibling
 * streams are already registered). An adapter under test must overlap the
 * same way; a trivially serialized handler that finalizes before its
 * siblings arrive can hide the defect, which is why the reference barrier
 * exists.
 *
 * Usage (adapter authors, in their own test suite):
 *
 * ```ts
 * import { assertConcurrentExecuteOnOneSession } from
 *   "@brokenbots/criteria-typescript-adapter-sdk/testing";
 *
 * await assertConcurrentExecuteOnOneSession({
 *   config: myAdapterConfig, // or `host` for an already-started TestHost
 *   calls: 5,
 * });
 * ```
 *
 * Adapters that cannot follow the echo convention supply their own per-call
 * script via `buildCall` (request + the result that must land on that call's
 * stream). Expected results must be pairwise distinct, or cross-delivery
 * would be undetectable.
 */

import type * as grpc from "@grpc/grpc-js";
import type { ServeConfig } from "../plugin/types-v2.js";
import { fromProtoStruct } from "../plugin/server-v2.js";
import { TestHost } from "./index.js";

/** The case is defined for N >= 3 concurrent calls; fewer cannot demonstrate per-call correlation. */
export const CONFORMANCE_MIN_CALLS = 3;

/** Default fan-out size (mirrors the Go/Python SDKs' concurrent-execute conformance). */
export const CONFORMANCE_DEFAULT_CALLS = 5;

/** Default per-call deadline, covering stream open, result delivery and stream end. */
export const CONFORMANCE_DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** The result one call's stream must deliver for the call to pass correlation. */
export interface ConformanceExpectedResult {
  outcome: string;
  /** The echoed call marker (see the correlation convention). Checked when set. */
  reason?: string;
}

/** One conformance call: the Execute request to send and the result that must land on its own stream. */
export interface ConformanceCallSpec {
  /** Unique per-call marker, echoed back by the adapter under test. */
  callId: string;
  stepName: string;
  input: Record<string, unknown>;
  allowedOutcomes: string[];
  expect: ConformanceExpectedResult;
}

/** What one Execute stream delivered during a conformance run. */
export interface ConformanceCallObservation {
  callId: string;
  /** Every result event delivered on this call's own stream, in arrival order. */
  results: { outcome: string; reason?: string }[];
  /** Message of the stream's RPC error, when the call failed before ending cleanly. */
  error?: string;
  /** True when the deadline passed with no result and no stream error. */
  timedOut?: boolean;
}

/** One contract violation found by a conformance run. */
export interface ConformanceViolation {
  /** The offending call's marker, when the violation is per call. */
  callId?: string;
  message: string;
}

/** Outcome of a conformance run, for adapter-author diagnostics. */
export interface ConformanceReport {
  ok: boolean;
  violations: ConformanceViolation[];
  /** Per-call observations, in the order the calls were issued. */
  calls: ConformanceCallObservation[];
  /** The follow-up sequential Execute, when `checkSequential` was enabled. */
  sequential?: ConformanceCallObservation & { ok: boolean };
}

/** Tuning for the concurrent-execute-on-one-session conformance case. */
export interface ConcurrentExecuteConformanceOptions {
  /**
   * The adapter under test, started in-process on a fresh TestHost owned by
   * the run. Provide exactly one of `config` or `host`.
   */
  config?: ServeConfig;
  /**
   * An already-started TestHost to drive; the caller owns its lifecycle.
   * Provide exactly one of `config` or `host`.
   */
  host?: TestHost;
  /** Number of concurrent Execute calls driven against the one session. Must be >= 3. Defaults to 5. */
  calls?: number;
  /** Per-call deadline in ms. Must be > 0. Defaults to 10_000. */
  callTimeoutMs?: number;
  /**
   * Session id for the ONE open session backing every call. Defaults to a
   * fresh id per run: the server keeps session state per process, so a fixed
   * id could leak state between runs in one test process.
   */
  sessionId?: string;
  /**
   * Per-call request/expectation builder. The default implements the
   * correlation convention documented at the top of this module.
   */
  buildCall?: (i: number, calls: number) => ConformanceCallSpec;
  /**
   * Bare-grant every `permission.request` the adapter under test sends, on a
   * single Permissions stream opened for the run (the host's fan-out shape).
   * Off by default: an adapter that blocks on a permission request without
   * this knob hits the per-call deadline.
   */
  autoGrantPermissions?: boolean;
  /** Also drive ONE sequential Execute after the fan-out (default true). */
  checkSequential?: boolean;
}

/** Thrown by {@link assertConcurrentExecuteOnOneSession} when the contract is violated. */
export class ConcurrentExecuteConformanceFailure extends Error {
  readonly violations: ConformanceViolation[];

  constructor(violations: ConformanceViolation[]) {
    super(
      "concurrent-Execute-on-one-session conformance failed:\n  - " +
        violations.map((v) => v.message).join("\n  - "),
    );
    this.name = "ConcurrentExecuteConformanceFailure";
    this.violations = violations;
  }
}

/**
 * The default correlation-convention script (see the module doc). Call i
 * sends `input { call_id, outcome, conformance_calls }` and expects its own
 * stream to deliver outcome `ok-<i>` with the echoed `call_id` as the reason.
 * Every call carries the same allowed-outcomes list, so concurrent calls
 * racing to set the session's allowed set cannot invalidate each other.
 */
export function echoConformanceCall(i: number, calls: number): ConformanceCallSpec {
  const allOutcomes = Array.from({ length: calls }, (_, j) => `ok-${j}`);
  return {
    callId: `call-${i}`,
    stepName: `conformance-call-${i}`,
    input: { call_id: `call-${i}`, outcome: `ok-${i}`, conformance_calls: calls },
    allowedOutcomes: allOutcomes,
    expect: { outcome: `ok-${i}`, reason: `call-${i}` },
  };
}

/**
 * Reference adapter implementing the correlation convention: its execute
 * handler finalizes with `req.input.outcome` and echoes `req.input.call_id`
 * back as the finalize reason, holding every finalize behind a barrier until
 * all fan-out calls have arrived on the shared session. Use it to smoke-test
 * conformance wiring, or as the template for an adapter under test.
 */
export function echoConformanceAdapter(): ServeConfig {
  let arrived = 0;
  let releaseAll!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  return {
    name: "conformance-echo-adapter",
    version: "0.0.0",
    description: "reference echo adapter for the concurrent-Execute conformance case",
    async execute(req, helpers) {
      const input = ((req as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
      const callId = String(input.call_id ?? "");
      const outcome = String(input.outcome ?? "");
      const total = Number(input.conformance_calls ?? 0);
      arrived += 1;
      if (total > 0 && arrived >= total) releaseAll();
      // Hold every finalize until ALL fan-out calls have arrived on the
      // shared session (see the module doc for why the overlap matters).
      await allArrived;
      // The correlation convention: finalize with the requested outcome and
      // echo the call marker back as the reason.
      await helpers.outcomes.finalize(outcome, { reason: callId });
    },
  };
}

/**
 * Drive the concurrent-execute-on-one-session conformance case and return a
 * report; never throws on contract violations (argument validation does
 * throw). Adapter authors who want a failing test on violation should use
 * {@link assertConcurrentExecuteOnOneSession}.
 */
export async function runConcurrentExecuteConformance(
  options: ConcurrentExecuteConformanceOptions,
): Promise<ConformanceReport> {
  if (!!options.config === !!options.host) {
    throw new Error("concurrent-execute conformance: provide exactly one of `config` or `host`");
  }
  const calls = options.calls ?? CONFORMANCE_DEFAULT_CALLS;
  if (!Number.isInteger(calls) || calls < CONFORMANCE_MIN_CALLS) {
    throw new Error(
      `concurrent-execute conformance: ${calls} concurrent calls requested; the case needs an integer >= ${CONFORMANCE_MIN_CALLS}`,
    );
  }
  const callTimeoutMs = options.callTimeoutMs ?? CONFORMANCE_DEFAULT_CALL_TIMEOUT_MS;
  if (callTimeoutMs <= 0) {
    throw new Error(`concurrent-execute conformance: callTimeoutMs must be > 0, got ${callTimeoutMs}`);
  }
  const buildCall = options.buildCall ?? echoConformanceCall;

  const specs = Array.from({ length: calls }, (_, i) => buildCall(i, calls));
  validateCallSpecs(specs, { requireDistinct: true });

  const ownedHost = !options.host;
  let host: TestHost;
  if (options.host) {
    host = options.host;
  } else {
    host = new TestHost({ config: options.config });
    await host.start();
  }
  const sessionId = options.sessionId ?? `concurrent-execute-conformance-${randomRunId()}`;
  try {
    // ONE open session backs every concurrent call, matching the host's
    // parallel fan-out (one wire session per adapter ref).
    await host.openSession({ sessionId });
    const client = host.rawClient;
    const permStream = options.autoGrantPermissions ? openPermissionGrantStream(client) : undefined;

    const violations: ConformanceViolation[] = [];
    try {
      const observations = await Promise.all(
        specs.map((spec) => driveConformanceExecute(client, sessionId, spec, callTimeoutMs, permStream)),
      );
      violations.push(...evaluateObservations(specs, observations, callTimeoutMs));

      let sequential: ConformanceReport["sequential"];
      if (options.checkSequential ?? true) {
        // Sequential behavior must be unchanged by the fan-out: one call,
        // driven alone, still delivers its own result on the same session.
        const sequentialSpec = buildCall(calls, calls);
        const observation = await driveConformanceExecute(
          client,
          sessionId,
          sequentialSpec,
          callTimeoutMs,
          permStream,
        );
        const sequentialViolations = evaluateObservations([sequentialSpec], [observation], callTimeoutMs);
        sequential = { ...observation, ok: sequentialViolations.length === 0 };
        violations.push(...sequentialViolations);
      }

      return { ok: violations.length === 0, violations, calls: observations, sequential };
    } finally {
      if (permStream) {
        try {
          permStream.end();
        } catch {
          /* already closed */
        }
      }
    }
  } finally {
    if (ownedHost) await host.stop();
  }
}

/**
 * Run {@link runConcurrentExecuteConformance} and throw
 * {@link ConcurrentExecuteConformanceFailure} on any contract violation.
 * This is the entry point adapter authors wire into their own test suite as
 * the parallel_safe gate.
 */
export async function assertConcurrentExecuteOnOneSession(
  options: ConcurrentExecuteConformanceOptions,
): Promise<ConformanceReport> {
  const report = await runConcurrentExecuteConformance(options);
  if (!report.ok) {
    throw new ConcurrentExecuteConformanceFailure(report.violations);
  }
  return report;
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function randomRunId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Open one Permissions stream for the run: grant responses are written back
 * on this stream (the autoGrantPermissions signature of the TestHost
 * harness). The permission.request events themselves arrive as adapter
 * events on each call's Execute stream, where the driver watches for them.
 * Only opened when opted in; the case itself never needs a decision.
 */
function openPermissionGrantStream(client: grpc.Client): grpc.ClientDuplexStream<unknown, unknown> {
  // The dynamic proto-loader client is untyped here; the shapes match
  // TestHost's own Permissions handling.
  const stream = (client as unknown as Record<string, (req: unknown) => grpc.ClientDuplexStream<unknown, unknown>>)
    .Permissions({});
  stream.on("data", () => {});
  stream.on("error", () => {});
  return stream;
}

/**
 * Drive one Execute call on its own stream and observe exactly what that
 * stream delivered: every result event, the RPC error (if any), and whether
 * the stream ended with no result at all. The stream is consumed to its end,
 * so extra results on the stream are detected, not just the first one. When
 * `grantStream` is set, permission.request events raised by the call are
 * bare-granted on it.
 */
function driveConformanceExecute(
  client: grpc.Client,
  sessionId: string,
  spec: ConformanceCallSpec,
  timeoutMs: number,
  grantStream?: grpc.ClientDuplexStream<unknown, unknown> | undefined,
): Promise<ConformanceCallObservation> {
  return new Promise((resolve) => {
    const observation: ConformanceCallObservation = { callId: spec.callId, results: [] };
    let settled = false;
    let stream: grpc.ClientReadableStream<unknown> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(observation);
    };
    const timer = setTimeout(() => {
      observation.timedOut = true;
      observation.error = observation.error ?? `no result within ${timeoutMs}ms`;
      try {
        stream?.cancel();
      } catch {
        /* already closed */
      }
      finish();
    }, timeoutMs);
    timer.unref?.();

    try {
      const rawClient = client as unknown as Record<
        string,
        (req: unknown) => grpc.ClientReadableStream<unknown>
      >;
      stream = rawClient.Execute({
        sessionId,
        stepName: spec.stepName,
        input: spec.input,
        allowedOutcomes: spec.allowedOutcomes,
      });
    } catch (err) {
      observation.error = `Execute RPC failed to start: ${(err as Error).message}`;
      finish();
      return;
    }

    stream.on("data", (evt: unknown) => {
      const event = evt as { result?: Record<string, unknown>; adapter?: Record<string, unknown> };
      if (event.result) observation.results.push(readResultEvent(event.result));
      const adapterEvt = event.adapter;
      if (grantStream && adapterEvt?.eventKind === "permission.request") {
        const payload = fromProtoStruct(adapterEvt.payload) as Record<string, unknown>;
        const requestId = (payload.request_id ?? payload.requestId) as string | undefined;
        if (requestId) {
          try {
            grantStream.write({ request: { requestId } });
          } catch {
            /* grant stream already closed: the pending request hits its timeout */
          }
        }
      }
    });
    stream.on("error", (err: unknown) => {
      if (observation.timedOut) {
        finish();
        return;
      }
      observation.error = (err as Error)?.message ?? String(err);
      finish();
    });
    stream.on("end", finish);
  });
}

/**
 * Read one ExecuteResult event into the observed (outcome, reason) pair.
 * Outputs travel on the outputs_json bytes field; `finalize` writes
 * `{ reason }` there, which is the correlation convention's echo channel.
 */
function readResultEvent(result: Record<string, unknown>): { outcome: string; reason?: string } {
  const outcome = String(result.outcome ?? "");
  const raw = result.outputsJson as Uint8Array | string | undefined;
  if (!raw) return { outcome };
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  let outputs: unknown;
  try {
    outputs = JSON.parse(buf.toString("utf8"));
  } catch {
    return { outcome };
  }
  const reason = (outputs as Record<string, unknown> | null)?.reason;
  return { outcome, reason: typeof reason === "string" ? reason : undefined };
}

/** Validate script output up front so a malformed script cannot silently weaken the case. */
function validateCallSpecs(specs: ConformanceCallSpec[], opts: { requireDistinct: boolean }): void {
  const seenCallIds = new Set<string>();
  for (const [i, spec] of specs.entries()) {
    if (!spec.callId) {
      throw new Error(`concurrent-execute conformance: buildCall returned no callId for call ${i}`);
    }
    if (seenCallIds.has(spec.callId)) {
      throw new Error(`concurrent-execute conformance: duplicate callId ${spec.callId}`);
    }
    seenCallIds.add(spec.callId);
  }
  if (opts.requireDistinct) {
    const distinct = new Set(specs.map(resultKey));
    if (distinct.size < specs.length) {
      throw new Error(
        "concurrent-execute conformance: expected results must be pairwise distinct (outcome, reason) " +
          "so cross-delivery is detectable",
      );
    }
  }
}

function resultKey(spec: ConformanceCallSpec): string {
  return JSON.stringify([spec.expect.outcome, spec.expect.reason ?? null]);
}

/**
 * Compare every call's own stream against its expected result. Any stream
 * error, zero-result stream, duplicate delivery or foreign result is a
 * violation; the two CRI-305 error signatures are called out by name so the
 * failure message points at the defect class.
 */
function evaluateObservations(
  specs: ConformanceCallSpec[],
  observations: (ConformanceCallObservation | undefined)[],
  callTimeoutMs: number,
): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  observations.forEach((observation, i) => {
    const spec = specs[i];
    const label = `call ${i} (${spec.callId})`;
    if (!observation) {
      violations.push({ callId: spec.callId, message: `${label}: no observation recorded` });
      return;
    }
    if (observation.timedOut) {
      violations.push({
        callId: spec.callId,
        message: `${label}: no result within the ${callTimeoutMs}ms deadline${observation.error ? ` (${observation.error})` : ""}`,
      });
      return;
    }
    if (observation.error) {
      violations.push({
        callId: spec.callId,
        message: `${label}: stream error: ${observation.error}${signatureNote(observation.error)}`,
      });
      return;
    }
    if (observation.results.length === 0) {
      violations.push({
        callId: spec.callId,
        message: `${label}: stream ended with no result — the result was lost ("Execute completed without sending result" class)`,
      });
      return;
    }
    if (observation.results.length > 1) {
      violations.push({
        callId: spec.callId,
        message: `${label}: stream received ${observation.results.length} results, expected exactly one (a sibling's result landed on this stream)`,
      });
      return;
    }
    const got = observation.results[0];
    if (got.outcome !== spec.expect.outcome) {
      violations.push({
        callId: spec.callId,
        message: `${label}: cross-routed result: stream delivered outcome ${JSON.stringify(got.outcome)}, expected this call's own ${JSON.stringify(spec.expect.outcome)}`,
      });
    }
    if (spec.expect.reason !== undefined && got.reason !== spec.expect.reason) {
      violations.push({
        callId: spec.callId,
        message: `${label}: correlation broken: stream delivered echoed marker ${JSON.stringify(got.reason ?? null)}, expected own ${JSON.stringify(spec.expect.reason)}`,
      });
    }
  });

  // Global correlation: the delivered results must match the issued calls
  // exactly (nothing lost, duplicated, or rerouted). Only meaningful when
  // every call actually delivered a result — otherwise the per-call
  // violations above already name the losses.
  if (observations.length > 0) {
    const delivered = observations
      .filter((o): o is ConformanceCallObservation => !!o && !o.error && !o.timedOut && o.results.length === 1)
      .flatMap((o) => o.results.map((r) => JSON.stringify([r.outcome, r.reason ?? null])))
      .sort();
    if (delivered.length === observations.length) {
      const expected = specs.map(resultKey).sort();
      if (delivered.join("|") !== expected.join("|")) {
        violations.push({
          message: `result correlation broken: delivered results ${delivered.join(", ")} do not match the issued calls ${expected.join(", ")}`,
        });
      }
    }
  }
  return violations;
}

/** Tag the CRI-305 error signatures so a violation points at the defect class. */
function signatureNote(message: string): string {
  if (message.includes("Result already sent")) {
    return ' — the shared-finalized-flag signature of session-scoped result delivery (CRI-305 defect class)';
  }
  if (message.includes("completed without sending result")) {
    return " — the lost-result signature of session-scoped result delivery (CRI-305 defect class)";
  }
  return "";
}