/**
 * Adapter tool-call support (CRI-152, ADR-0004 §8/§9): wire constants, typed
 * errors, canonical args digests, and target parsing shared by the
 * `permission.request` helper and the `tools.callAdapterTool` helper on the
 * Helpers surface (server-v2.ts).
 *
 * The canonical-JSON implementation below is a byte-identical port of the
 * shared algorithm in `criteria/v2/canonical.go` (repo
 * github.com/brokenbots/criteria-adapter-proto, originally the Criteria
 * host's internal/adapter/audit/canonical.go): it is the pinned-subset JCS
 * dialect that `PermissionRequest.args_digest` and the `args_digest` key of
 * the `permission.request` AdapterEvent payload are documented over, so
 * digests computed here match the host and the Go SDK byte for byte
 * (CRI-154 parity). The deltas from RFC 8785 are part of that contract and
 * must NOT be "fixed":
 *   - object keys are sorted by UTF-8 byte order (Go sort.Strings), not
 *     UTF-16 code-unit order;
 *   - strings use Go encoding/json escaping with HTML escaping on
 *     (`<`, `>`, `&` → \u003c/\u003e/\u0026; U+2028/U+2029 escaped; other
 *     non-ASCII passes through raw; lone surrogates become U+FFFD);
 *   - numbers use Go encoding/json's float format (shortest round-trip;
 *     'e' notation when |v| < 1e-6 or |v| >= 1e21, with the leading zero of
 *     two-digit exponents stripped — e.g. 1e-7 not 1e-07), and -0 keeps its
 *     sign;
 *   - booleans and null are literal; output has no whitespace and no
 *     trailing newline.
 */

import { createHash } from 'node:crypto';

// ─── Wire constants (ADR-0004 §8) ────────────────────────────────────────────

/** The AdapterEvent event_kind that carries both plain permission requests and adapter tool calls. */
export const EVENT_KIND_PERMISSION_REQUEST = 'permission.request';

/** The `kind` value of a permission.request AdapterEvent payload that makes the request an adapter tool call. */
export const PAYLOAD_KIND_ADAPTER_TOOL = 'adapter_tool';

/**
 * The capability string an adapter declares when it speaks the tool-call flow
 * (ADR-0004 §9). Parity with the Go SDK's adapterhost.CapabilityAdapterTools.
 */
export const CAPABILITY_ADAPTER_TOOLS = 'adapter_tools';

/**
 * Deadline a tool call runs under when the caller passes no timeout (parity
 * with the Go SDK's adapterhost.DefaultToolCallTimeout). The bound is what
 * makes an old host — one that predates adapter tools and only ever answers a
 * granted call with a bare allow-grant — resolve deterministically instead of
 * hanging the call forever.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * Well-known ToolCallResult.call_error codes (CRI-152). The registry is
 * free-form: hosts may emit values not listed here and they round-trip
 * unchanged through {@link ToolCallError.code}.
 */
export const CALL_ERROR_UNKNOWN_ADAPTER = 'unknown_adapter';
export const CALL_ERROR_UNKNOWN_TOOL = 'unknown_tool';
export const CALL_ERROR_CAPABILITY_MISSING = 'capability_missing';
export const CALL_ERROR_HOST_UNSUPPORTED = 'host_unsupported';
export const CALL_ERROR_DEPTH_EXCEEDED = 'depth_exceeded';
export const CALL_ERROR_CYCLE_DETECTED = 'cycle_detected';
export const CALL_ERROR_CALLEE_CRASH = 'callee_crash';
export const CALL_ERROR_CALLEE_TIMEOUT = 'callee_timeout';
export const CALL_ERROR_CANCELED = 'canceled';
export const CALL_ERROR_NOT_YET_SUPPORTED = 'not_yet_supported';
export const CALL_ERROR_SELF_CALL = 'self_call';

// ─── Typed errors ────────────────────────────────────────────────────────────

/**
 * Typed failure of an adapter tool call, carrying the host's
 * ToolCallResult.call_error code (CRI-152). `code` is a free-form registry
 * value: well-known codes are the CALL_ERROR_* constants; unknown values
 * round-trip unchanged. A ToolCallError with code "host_unsupported" surfaces
 * from both detection paths — the host answering with that call_error, and
 * the SDK detecting a bare allow-grant with no result within the call
 * deadline (cached per session, see the helper).
 */
export class ToolCallError extends Error {
  /** The host's call_error code. */
  readonly code: string;

  constructor(code: string) {
    super(`adapter tool call failed: ${code}`);
    this.name = 'ToolCallError';
    this.code = code;
  }
}

/** The host denied the tool call (PermissionEvent.cancel). The host's reason is carried in the error text. */
export class ToolCallDeniedError extends Error {
  /** The host's deny reason, when one was sent. */
  readonly reason?: string;

  constructor(reason?: string) {
    super(reason ? `adapter tool call denied: ${reason}` : 'adapter tool call denied');
    this.name = 'ToolCallDeniedError';
    this.reason = reason;
  }
}

/** The tool call exceeded its deadline without the host granting or replying. No bare-grant was observed, so the session is NOT cached as unsupported. */
export class ToolCallTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallTimeoutError';
  }
}

/** The Permissions stream ended (or errored) while the tool call was still waiting for its correlated reply. */
export class ToolCallStreamClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallStreamClosedError';
  }
}

// ─── Canonical JSON + args digest ────────────────────────────────────────────

const HEX = '0123456789abcdef';
const textEncoder = new TextEncoder();

function utf8Bytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/** Go's sort.Strings ordering: plain UTF-8 byte order. */
function compareUtf8(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Escape one string exactly the way Go's encoding/json does with
 * escapeHTML=true, which differs from JSON.stringify: control characters use
 * \u00xx (no \b/\f shorthands), <, >, & are HTML-escaped, U+2028/U+2029 are
 * escaped, and lone surrogates (invalid UTF-8 upstream) become U+FFFD.
 */
function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c === 0x22) {
        out += '\\"';
      } else if (c === 0x5c) {
        out += '\\\\';
      } else if (c >= 0x20 && c !== 0x3c && c !== 0x3e && c !== 0x26) {
        out += s[i];
      } else if (c === 0x0a) {
        out += '\\n';
      } else if (c === 0x0d) {
        out += '\\r';
      } else if (c === 0x09) {
        out += '\\t';
      } else {
        out += `\\u00${HEX[c >> 4]}${HEX[c & 0xf]}`;
      }
      i++;
      continue;
    }
    // Non-ASCII: walk code points. U+2028/U+2029 escape; lone surrogates
    // (invalid UTF-8 upstream) encode as a literal U+FFFD, matching what the
    // Go round-trip (marshal replaces them with the escape, unmarshal yields
    // the character) would produce; everything else passes through raw.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        if (cp === 0x2028) {
          out += '\\u2028';
        } else if (cp === 0x2029) {
          out += '\\u2029';
        } else {
          out += s[i] + s[i + 1];
        }
        i += 2;
        continue;
      }
    }
    if (c === 0x2028) {
      out += '\\u2028';
    } else if (c === 0x2029) {
      out += '\\u2029';
    } else if (c >= 0xd800 && c <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += s[i];
    }
    i++;
  }
  return out + '"';
}

/**
 * Format a finite number exactly the way Go's encoding/json float encoder
 * does: the shortest decimal that round-trips, in plain notation for
 * |v| in [1e-6, 1e21) and 'e' notation otherwise. JS Number.prototype's
 * toString/toExponential use the same shortest-round-trip digits and switch
 * notations at those same magnitudes, so the two formats coincide for every
 * finite double; -0 keeps its sign and non-finite values error like Go.
 */
function encodeNumber(v: number): string {
  if (!Number.isFinite(v)) {
    throw new Error(`canonical json: encode number: cannot represent non-finite value ${String(v)}`);
  }
  if (Object.is(v, -0)) {
    return '-0';
  }
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e21)) {
    return v.toExponential();
  }
  return String(v);
}

function encodeCanonical(node: unknown): string {
  if (node === null || node === undefined) {
    return 'null';
  }
  switch (typeof node) {
    case 'boolean':
      return node ? 'true' : 'false';
    case 'number':
      return encodeNumber(node);
    case 'string':
      return encodeString(node);
    case 'object':
      break;
    default:
      throw new Error(`canonical json: unsupported type ${typeof node}`);
  }
  if (Array.isArray(node)) {
    // Index access turns holes into undefined, which encodes as null — the
    // same output JSON.stringify gives for sparse arrays.
    const parts = new Array<string>(node.length);
    for (let i = 0; i < node.length; i++) {
      parts[i] = encodeCanonical(node[i]);
    }
    return `[${parts.join(',')}]`;
  }
  if (Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) {
    throw new Error('canonical json: unsupported type: only JSON-representable values are encodable');
  }
  const entries = Object.keys(node as Record<string, unknown>).map((k) => ({ key: k, bytes: utf8Bytes(k) }));
  entries.sort((a, b) => compareUtf8(a.bytes, b.bytes));
  const obj = node as Record<string, unknown>;
  const parts = entries.map((e) => `${encodeString(e.key)}:${encodeCanonical(obj[e.key])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Canonical JSON (CRI-152): a byte-identical port of the pinned-subset JCS
 * algorithm in criteria-adapter-proto's `criteria/v2/canonical.go` — the
 * shared dialect `PermissionRequest.args_digest` and the adapter-tool payload's
 * `args_digest` key are documented over. See the module comment for the deltas
 * from RFC 8785 that are part of the pinned parity contract. The output never
 * contains a raw newline.
 *
 * @throws when the value is not JSON-representable (cyclic structures,
 *   BigInts, functions, non-finite numbers, class instances).
 */
export function canonicalJSON(value: unknown): string {
  return encodeCanonical(value);
}

/**
 * sha256 over the canonical-JSON bytes of `value`, lowercase hex — the
 * documented formula behind `PermissionRequest.args_digest` and the
 * `args_digest` key of the adapter-tool permission.request payload (CRI-154).
 * Byte-identical with the Go SDK's and the host's `ArgsDigest`
 * (criteria/v2/canonical.go) for the same args.
 */
export function argsDigest(value: unknown): string {
  const sum = createHash('sha256').update(Buffer.from(canonicalJSON(value), 'utf8'));
  return sum.digest('hex');
}

// ─── Tool-target parsing (ADR-0004 §2) ───────────────────────────────────────

export interface ParsedToolTarget {
  /** The "adapter.<type>.<name>" reference. */
  adapterRef: string;
  /** The tool label; empty for the bare whole-surface form. */
  tool: string;
}

function isBarewordLabel(s: string): boolean {
  if (s === '') return false;
  const first = s.charCodeAt(0);
  const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
  if (!isLetter(first) && first !== 0x5f) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!isLetter(c) && !isDigit(c) && c !== 0x5f && c !== 0x2d) return false;
  }
  return true;
}

/**
 * Parse the strict §2 tool-target form `adapter.<type>.<name>.tools[.<tool>]`
 * (a port of the host's parseToolCallTarget). Returns undefined when the
 * target does not parse; `tool` is empty for the bare whole-surface form.
 */
export function parseAdapterToolTarget(target: string): ParsedToolTarget | undefined {
  const labels = target.split('.');
  if (labels.length < 4 || labels.length > 5) return undefined;
  if (!labels.every(isBarewordLabel)) return undefined;
  if (labels[0] !== 'adapter' || labels[3] !== 'tools') return undefined;
  return { adapterRef: `${labels[1]}.${labels[2]}`, tool: labels[4] ?? '' };
}

// ─── ToolCallResult fragment reassembly ──────────────────────────────────────

/** Wire shape of one decoded PermissionEvent.tool_call_result fragment. */
export interface ToolCallResultFragment {
  requestId: string;
  outcome?: string;
  chunk?: { seq?: number; total?: number; final?: boolean } | undefined;
  outputsJson: Uint8Array;
  callError?: string;
}

/**
 * Reassemble outputs_json bytes from the ToolCallResult fragments of ONE tool
 * call — a port of criteria-adapter-proto's
 * `criteria/v2/chunking.go:JoinToolCallResultOutputs`: fragments are sorted by
 * Chunk.seq and concatenated, validating that every fragment carries Chunk
 * metadata and one request id, seqs form a contiguous run from 0, every
 * fragment reports the same total, and exactly one final chunk exists (at
 * seq total-1, with no earlier fragment setting the flag).
 */
export function joinToolCallResultOutputs(fragments: readonly ToolCallResultFragment[]): Buffer {
  if (fragments.length === 0) {
    throw new Error('no ToolCallResult fragments to join');
  }
  const requestID = fragments[0].requestId;
  if (requestID === '') {
    throw new Error('ToolCallResult fragments must carry a request_id');
  }
  fragments.forEach((f, i) => {
    if (f.requestId !== requestID) {
      throw new Error(`ToolCallResult fragment[${i}] mixes request ids: got "${f.requestId}", expected "${requestID}"`);
    }
  });

  const sorted = [...fragments].sort((a, b) => (a.chunk?.seq ?? 0) - (b.chunk?.seq ?? 0));

  let total = 0;
  sorted.forEach((f, i) => {
    if (!f.chunk) {
      throw new Error(`ToolCallResult fragment[${i}] has no Chunk metadata`);
    }
    if (i === 0) {
      total = f.chunk.total ?? 0;
      if (total === 0) {
        throw new Error('ToolCallResult fragment[0] declares total 0');
      }
      if (total !== sorted.length) {
        throw new Error(`ToolCallResult declares total ${total} chunks but ${sorted.length} were given`);
      }
    } else if ((f.chunk.total ?? 0) !== total) {
      throw new Error(`ToolCallResult fragment[${i}] declares total ${f.chunk.total ?? 0}, expected ${total}`);
    }
    if ((f.chunk.seq ?? 0) !== i) {
      throw new Error(`ToolCallResult chunk seq gap: got seq ${f.chunk.seq ?? 0}, expected ${i}`);
    }
  });

  const last = sorted[total - 1];
  if (!last.chunk?.final) {
    throw new Error(`ToolCallResult final chunk (seq ${total - 1}) missing final flag`);
  }
  for (let i = 0; i < total - 1; i++) {
    if (sorted[i].chunk?.final) {
      throw new Error(`ToolCallResult fragment[${i}] (seq ${sorted[i].chunk?.seq ?? 0}) sets final flag early`);
    }
  }

  return Buffer.concat(sorted.map((f) => Buffer.from(f.outputsJson ?? new Uint8Array(0))));
}