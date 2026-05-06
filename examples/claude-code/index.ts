/**
 * Claude Code Agent Adapter for Criteria
 *
 * This adapter controls the actual Claude Code CLI agent (not the Anthropic API)
 * via the @anthropic-ai/claude-agent-sdk. The agent can read files, run commands,
 * edit code, and use all built-in Claude Code tools.
 *
 * Features:
 * - Spawns real Claude Code CLI subprocess
 * - Bridges permission requests to Criteria's permission system
 * - Custom MCP tool `submit_outcome` for workflow integration
 * - Session persistence across execute calls
 * - Structured events for observability
 *
 * Environment Variables:
 * - ANTHROPIC_API_KEY: Required for first-party API access.
 *
 * Example workflow:
 * ```hcl
 * step "refactor" {
 *   adapter = "claude-code"
 *   input {
 *     prompt = "Refactor the auth module to use OAuth2"
 *   }
 *   outcome "success" { transition_to = "test" }
 *   outcome "failure" { transition_to = "review" }
 * }
 * ```
 */

import { serve, type EventSender, type ExecuteRequest, type PermitRequest } from '@criteria/adapter-sdk';
import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, Query, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

interface SessionState {
  query: Query | null;
  finalizedOutcome: string | null;
  finalizedReason: string;
  claudeSessionId: string | null;
  pendingPermissions: Map<string, { resolve: (result: PermissionResult) => void; reject: (reason: Error) => void }>;
  allowedOutcomes: Set<string>;
}

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_NAME = 'claude-code';
const PLUGIN_VERSION = '0.1.0';

const SUBMIT_OUTCOME_TOOL_NAME = 'submit_outcome';
const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current workflow step. Call this exactly once with one of the allowed outcomes when you are done with your task. The allowed outcomes are provided in the system context.`;

// ============================================================================
// Sessions
// ============================================================================

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

function createSession(sessionId: string): SessionState {
  const state: SessionState = {
    query: null,
    finalizedOutcome: null,
    finalizedReason: '',
    claudeSessionId: null,
    pendingPermissions: new Map(),
    allowedOutcomes: new Set(),
  };
  sessions.set(sessionId, state);
  return state;
}

function closeSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state?.query) {
    try {
      state.query.close();
    } catch {
      // ignore
    }
  }
  // Reject any pending permissions so they don't hang
  for (const { reject } of state?.pendingPermissions.values() || []) {
    reject(new Error('Session closed'));
  }
  sessions.delete(sessionId);
}

// ============================================================================
// MCP Server
// ============================================================================

function buildOutcomeMcpServer(state: SessionState) {
  return createSdkMcpServer({
    name: 'criteria-workflow',
    tools: [
      {
        name: SUBMIT_OUTCOME_TOOL_NAME,
        description: SUBMIT_OUTCOME_DESCRIPTION,
        inputSchema: {
          outcome: z.string().describe('The outcome name to finalize. Must be one of the allowed outcomes.'),
          reason: z.string().optional().describe('Optional reason for the outcome.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        handler: async (args: any) => {
          const outcome = args.outcome?.trim() as string | undefined;
          const reason = (args.reason?.trim() as string | undefined) || '';

          if (!outcome) {
            return {
              content: [{ type: 'text', text: 'Outcome is required. Please provide a valid outcome name.' }],
              isError: true,
            };
          }

          if (!state.allowedOutcomes.has(outcome)) {
            const allowed = Array.from(state.allowedOutcomes).join(', ');
            if (state.allowedOutcomes.size === 0) {
              return {
                content: [{ type: 'text', text: 'No outcomes are declared for this step.' }],
                isError: true,
              };
            }
            return {
              content: [{ type: 'text', text: `Outcome "${outcome}" is not allowed. Choose one of: ${allowed}` }],
              isError: true,
            };
          }

          if (state.finalizedOutcome !== null) {
            return {
              content: [{ type: 'text', text: `Outcome already finalized as "${state.finalizedOutcome}".` }],
              isError: true,
            };
          }

          state.finalizedOutcome = outcome;
          state.finalizedReason = reason;

          // Interrupt the agent so the workflow can proceed
          if (state.query) {
            try {
              await state.query.interrupt();
            } catch {
              // ignore interrupt errors
            }
          }

          return {
            content: [{ type: 'text', text: `Outcome "${outcome}" recorded successfully. Workflow will proceed.` }],
          };
        },
      },
    ],
  });
}

// ============================================================================
// Permission Bridge
// ============================================================================

function buildCanUseTool(state: SessionState, sender: EventSender) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
    }
  ): Promise<PermissionResult> => {
    const details: Record<string, string> = {
      tool: toolName,
      toolUseId: options.toolUseID,
    };
    if (options.title) details.title = options.title;
    if (options.displayName) details.displayName = options.displayName;
    if (options.description) details.description = options.description;
    try {
      details.input = JSON.stringify(input).slice(0, 4000);
    } catch {
      details.input = '<unserializable>';
    }

    const permissionId = await sender.permissionRequest(toolName, details);

    return new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        state.pendingPermissions.delete(permissionId);
        resolve({ behavior: 'deny', message: 'Permission request timed out.', toolUseID: options.toolUseID });
      }, 300_000); // 5 minute timeout

      state.pendingPermissions.set(permissionId, {
        resolve: (result) => {
          clearTimeout(timeout);
          state.pendingPermissions.delete(permissionId);
          resolve(result);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          state.pendingPermissions.delete(permissionId);
          resolve({ behavior: 'deny', message: reason.message, toolUseID: options.toolUseID });
        },
      });
    });
  };
}

// ============================================================================
// Message Stream Handler
// ============================================================================

async function handleMessageStream(
  state: SessionState,
  sender: EventSender,
  q: Query
): Promise<void> {
  for await (const msg of q) {
    // Capture session id from any message for resume on next execute
    if ('session_id' in msg && msg.session_id) {
      state.claudeSessionId = msg.session_id;
    }

    switch (msg.type) {
      case 'assistant': {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              await sender.log('stdout', block.text);
              await sender.adapterEvent({ type: 'agent.message', content: block.text });
            }
          }
        }
        break;
      }

      case 'stream_event': {
        // Partial assistant message during streaming
        if (msg.event && msg.event.type === 'content_block_delta') {
          const delta = (msg.event as any).delta;
          if (delta?.type === 'text_delta' && delta.text) {
            await sender.log('stdout', delta.text);
          }
        }
        break;
      }

      case 'tool_progress': {
        const progressMsg = (msg as any).message || `${msg.tool_name} running...`;
        await sender.log('stdout', `[${msg.tool_name}] ${progressMsg}\n`);
        await sender.adapterEvent({
          type: 'tool.progress',
          tool: msg.tool_name,
          message: progressMsg,
        });
        break;
      }

      case 'system': {
        break;
      }

      case 'result': {
        // Final result message
        if (msg.subtype === 'success') {
          await sender.adapterEvent({
            type: 'query.complete',
            durationMs: msg.duration_ms,
            turns: msg.num_turns,
            costUsd: msg.total_cost_usd,
          });
        } else {
          await sender.adapterEvent({
            type: 'query.error',
            subtype: msg.subtype,
            errors: (msg as any).errors || [],
          });
        }
        break;
      }

      case 'auth_status': {
        if (msg.isAuthenticating) {
          await sender.log('stdout', '[claude-code] Authenticating...\n');
        }
        break;
      }

      default:
        break;
    }
  }
}

// ============================================================================
// Execute Logic
// ============================================================================

async function executeStep(state: SessionState, req: ExecuteRequest, sender: EventSender): Promise<void> {
  const prompt = req.config.prompt;
  if (!prompt) {
    throw new Error('config.prompt is required');
  }

  // Reset per-execution state
  state.finalizedOutcome = null;
  state.finalizedReason = '';
  state.allowedOutcomes = new Set(req.allowedOutcomes);

  const systemPrompt = req.config.system_prompt
    ? String(req.config.system_prompt)
    : `You are Claude Code, an autonomous software engineering agent integrated into a workflow system.
When you complete your task, you MUST call the submit_outcome tool with one of the allowed outcomes.

Allowed outcomes: ${req.allowedOutcomes.join(', ') || 'none declared'}.
`;

  // Build the full prompt with outcome instructions
  let fullPrompt = systemPrompt + '\n\n' + prompt;
  if (req.allowedOutcomes.length > 0) {
    fullPrompt += `

When you are done, call the submit_outcome tool with one of these outcomes: ${req.allowedOutcomes.join(', ')}.`;
  }

  await sender.log('stdout', `[claude-code] Starting agent query...\n`);

  const mcpServer = buildOutcomeMcpServer(state);
  const abortController = new AbortController();

  const q = query({
    prompt: fullPrompt,
    options: {
      abortController,
      cwd: req.config.cwd || process.cwd(),
      canUseTool: buildCanUseTool(state, sender),
      tools: { type: 'preset', preset: 'claude_code' },
      persistSession: true,
      resume: state.claudeSessionId || undefined,
      model: req.config.model || undefined,
      thinking: req.config.thinking === 'true'
        ? { type: 'adaptive' }
        : undefined,
      env: {
        CLAUDE_AGENT_SDK_CLIENT_APP: 'criteria-adapter-claude-code/0.1.0',
        ANTHROPIC_AUTH_TOKEN: (req.config as any).auth_token || process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_API_KEY: (req.config as any).api_key || process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: (req.config as any).base_url || process.env.ANTHROPIC_BASE_URL,
      },
    },
  });

  // Wire up the MCP server before iterating
  try {
    await q.setMcpServers({ [mcpServer.name]: mcpServer });
  } catch (e) {
    await sender.log('stderr', `[claude-code] Failed to set MCP servers: ${e}\n`);
  }

  state.query = q;

  try {
    await handleMessageStream(state, sender, q);
  } catch (e) {
    await sender.log('stderr', `[claude-code] Query error: ${e}\n`);
  } finally {
    state.query = null;
  }

  // Determine outcome
  if (state.finalizedOutcome) {
    await sender.result(state.finalizedOutcome, { reason: state.finalizedReason });
    return;
  }

  // No outcome was submitted
  if (state.allowedOutcomes.has('needs_review')) {
    await sender.result('needs_review', { reason: 'Agent completed without submitting an outcome' });
  } else {
    await sender.adapterEvent({
      type: 'outcome.failure',
      reason: 'missing submit_outcome',
    });
    await sender.result('failure', { reason: 'Agent completed without submitting an outcome' });
  }
}

// ============================================================================
// Main
// ============================================================================

serve({
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  capabilities: ['multi_turn', 'structured_events', 'tool_calling'],

  configSchema: {
    fields: {
      model: { type: 'string', required: false, doc: 'Model to use (e.g., claude-sonnet-4-6)' },
      cwd: { type: 'string', required: false, doc: 'Working directory for the agent. Defaults to process.cwd().' },
      system_prompt: { type: 'string', required: false, doc: 'Custom system prompt prepended to every execute call' },
      thinking: { type: 'bool', required: false, doc: 'Enable adaptive thinking mode' },
      auth_token: { type: 'string', required: false, doc: 'Value for ANTHROPIC_AUTH_TOKEN' },
      api_key: { type: 'string', required: false, doc: 'Value for ANTHROPIC_API_KEY' },
      base_url: { type: 'string', required: false, doc: 'Value for ANTHROPIC_BASE_URL' },
    },
  },

  inputSchema: {
    fields: {
      prompt: { type: 'string', required: true, doc: 'The task prompt to send to Claude Code' },
      model: { type: 'string', required: false, doc: 'Per-step model override' },
    },
  },

  async onOpenSession(req) {
    createSession(req.sessionId);
  },

  async execute(req, sender) {
    const state = getSession(req.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${req.sessionId}`);
    }
    await executeStep(state, req, sender);
  },

  async onPermit(req) {
    const state = getSession(req.sessionId);
    if (!state) return;

    const pending = state.pendingPermissions.get(req.permissionId);
    if (!pending) return;

    if (req.allow) {
      pending.resolve({ behavior: 'allow', toolUseID: req.permissionId });
    } else {
      pending.resolve({
        behavior: 'deny',
        message: req.reason || 'Denied by user',
        toolUseID: req.permissionId,
      });
    }
  },

  async onCloseSession(req) {
    closeSession(req.sessionId);
  },
});
