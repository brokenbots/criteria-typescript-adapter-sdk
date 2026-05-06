/**
 * Anthropic Claude Adapter for Criteria
 *
 * This adapter enables using Anthropic's Claude models as agent backends
 * in Criteria workflows.
 *
 * Features:
 * - Multi-turn conversations
 * - Tool use with submit_outcome for workflow integration
 * - Permission gating for sensitive operations
 * - Structured events for observability
 *
 * Environment Variables:
 * - ANTHROPIC_API_KEY: Required. Your Anthropic API key.
 * - ANTHROPIC_BASE_URL: Optional. Override the API base URL.
 * - ANTHROPIC_MODEL: Optional. Default model (default: claude-sonnet-4-6)
 *
 * Example workflow:
 * ```hcl
 * step "analyze" {
 *   adapter = "claude"
 *   input {
 *     prompt = "Analyze this codebase for security issues"
 *     max_turns = 10
 *   }
 *   outcome "clean" { transition_to = "deploy" }
 *   outcome "issues_found" { transition_to = "review" }
 *   outcome "failure" { transition_to = "failed" }
 * }
 * ```
 */

import { serve, type EventSender, type ExecuteRequest } from '@criteria/adapter-sdk';
import Anthropic from '@anthropic-ai/sdk';

// ============================================================================
// Types
// ============================================================================

interface SessionState {
  client: Anthropic;
  model: string;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  maxTurns: number;
  activeAllowedOutcomes: Set<string>;
  finalizedOutcome: string | null;
  finalizedReason: string;
  finalizeAttempts: number;
}

interface SubmitOutcomeArgs {
  outcome: string;
  reason?: string;
}

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_NAME = 'claude';
const PLUGIN_VERSION = '0.1.0';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOKENS = 4096;

const SUBMIT_OUTCOME_TOOL_NAME = 'submit_outcome';
const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current step. Call this exactly once with one of the allowed outcomes before ending the turn. The allowed outcomes are provided in the conversation context. Failure to call this tool with a valid outcome will fail the step.`;

// ============================================================================
// Sessions
// ============================================================================

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

function createSession(sessionId: string, config: Record<string, string>): SessionState {
  const apiKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable or config.api_key');
  }

  const baseURL = config.base_url || process.env.ANTHROPIC_BASE_URL;
  const model = config.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const client = new Anthropic({
    apiKey,
    baseURL,
  });

  const systemPrompt =
    config.system_prompt ||
    `You are a helpful assistant integrated into a workflow system. When you complete your task, you MUST use the submit_outcome tool with the appropriate outcome to proceed.`;

  const state: SessionState = {
    client,
    model,
    systemPrompt,
    messages: [],
    maxTurns: parseInt(config.max_turns, 10) || DEFAULT_MAX_TURNS,
    activeAllowedOutcomes: new Set(),
    finalizedOutcome: null,
    finalizedReason: '',
    finalizeAttempts: 0,
  };

  sessions.set(sessionId, state);
  return state;
}

function closeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ============================================================================
// Tool Handlers
// ============================================================================

function handleSubmitOutcome(state: SessionState, args: SubmitOutcomeArgs): { success: boolean; message: string } {
  state.finalizeAttempts++;

  const outcome = args.outcome?.trim();
  const reason = args.reason?.trim() || '';

  // Check for duplicate
  if (state.finalizedOutcome !== null) {
    return {
      success: false,
      message: `Outcome already finalized as "${state.finalizedOutcome}". Do not call submit_outcome again.`,
    };
  }

  // Check for missing outcome
  if (!outcome) {
    return {
      success: false,
      message: 'Outcome is required. Please provide a valid outcome name.',
    };
  }

  // Check for valid outcome
  if (!state.activeAllowedOutcomes.has(outcome)) {
    const allowed = Array.from(state.activeAllowedOutcomes).join(', ');
    if (state.activeAllowedOutcomes.size === 0) {
      return {
        success: false,
        message: 'No outcomes are declared for this step.',
      };
    }
    return {
      success: false,
      message: `Outcome "${outcome}" is not in the allowed set. Choose one of: ${allowed}`,
    };
  }

  // Success
  state.finalizedOutcome = outcome;
  state.finalizedReason = reason;

  return {
    success: true,
    message: `Outcome "${outcome}" recorded successfully.`,
  };
}

// ============================================================================
// Execute Logic
// ============================================================================

async function executeTurn(state: SessionState, req: ExecuteRequest, sender: EventSender): Promise<void> {
  const prompt = req.config.prompt;
  if (!prompt) {
    throw new Error('config.prompt is required');
  }

  // Reset per-execution state
  state.finalizedOutcome = null;
  state.finalizedReason = '';
  state.finalizeAttempts = 0;
  state.activeAllowedOutcomes = new Set(req.allowedOutcomes);

  // Add allowed outcomes preamble
  if (req.allowedOutcomes.length > 0) {
    const outcomeList = req.allowedOutcomes.join(', ');
    const preamble = `You must finalize the outcome for this step by calling the submit_outcome tool exactly once before ending the turn. The allowed outcomes are: ${outcomeList}. If you do not call the tool with a valid outcome, the step will fail.\n\n`;
    state.messages.push({ role: 'user', content: preamble + prompt });
  } else {
    state.messages.push({ role: 'user', content: prompt });
  }

  await sender.log('stdout', `[claude] Starting conversation with model ${state.model}\n`);

  let turnCount = 0;
  const maxTurns = parseInt(req.config.max_turns, 10) || state.maxTurns;
  const maxTokens = parseInt(req.config.max_tokens, 10) || DEFAULT_MAX_TOKENS;

  // Per-step model override
  const model = req.config.model || state.model;

  while (turnCount < maxTurns) {
    turnCount++;

    await sender.log('stdout', `[claude] Turn ${turnCount}/${maxTurns}\n`);

    // Define tools
    const tools: Anthropic.Tool[] = [
      {
        name: SUBMIT_OUTCOME_TOOL_NAME,
        description: SUBMIT_OUTCOME_DESCRIPTION,
        input_schema: {
          type: 'object',
          properties: {
            outcome: {
              type: 'string',
              description: 'The outcome name to finalize. Must be one of the allowed outcomes.',
            },
            reason: {
              type: 'string',
              description: 'Optional reason for the outcome.',
            },
          },
          required: ['outcome'],
        },
      },
    ];

    // Call Anthropic API
    const response = await state.client.messages.create({
      model,
      max_tokens: maxTokens,
      system: state.systemPrompt,
      messages: state.messages,
      tools,
    });

    const message = response;

    // Add assistant message to history
    state.messages.push({ role: 'assistant', content: message.content });

    // Stream content blocks
    const textBlocks = message.content.filter((block) => block.type === 'text');
    for (const block of textBlocks) {
      if (block.text) {
        await sender.log('stdout', block.text);
        await sender.adapterEvent({
          type: 'agent.message',
          content: block.text,
          turn: turnCount,
        });
      }
    }

    // Handle tool use
    const toolUseBlocks = message.content.filter((block) => block.type === 'tool_use');
    for (const toolUse of toolUseBlocks) {
      if (toolUse.name === SUBMIT_OUTCOME_TOOL_NAME) {
        let args: SubmitOutcomeArgs;
        try {
          args = toolUse.input as SubmitOutcomeArgs;
        } catch (e) {
          await sender.adapterEvent({
            type: 'tool.error',
            error: 'Failed to parse submit_outcome arguments',
          });
          continue;
        }

        const result = handleSubmitOutcome(state, args);

        await sender.adapterEvent({
          type: 'outcome.finalized',
          outcome: args.outcome,
          reason: args.reason,
          success: result.success,
        });

        // Send tool result back to model
        state.messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result.message,
            },
          ],
        });

        if (result.success) {
          await sender.result(state.finalizedOutcome!, {});
          return;
        }
      }
    }

    // If no tool calls, the model ended the turn without finalizing
    if (toolUseBlocks.length === 0) {
      break;
    }
  }

  // Max turns reached or conversation ended without outcome
  if (turnCount >= maxTurns) {
    await sender.adapterEvent({
      type: 'limit.reached',
      max_turns: maxTurns,
    });

    if (state.activeAllowedOutcomes.has('needs_review')) {
      await sender.result('needs_review', { reason: 'Max turns reached' });
    } else {
      await sender.result('failure', { reason: 'Max turns reached without outcome' });
    }
  } else {
    await sender.adapterEvent({
      type: 'outcome.failure',
      reason: 'missing finalize',
      attempts: state.finalizeAttempts,
    });
    await sender.result('failure', { reason: 'Conversation ended without submit_outcome' });
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
      api_key: { type: 'string', required: false, doc: 'Anthropic API key. Falls back to ANTHROPIC_API_KEY env var.' },
      base_url: { type: 'string', required: false, doc: 'Anthropic API base URL. Falls back to ANTHROPIC_BASE_URL env var.' },
      model: { type: 'string', required: false, doc: `Model to use (default: ${DEFAULT_MODEL})` },
      max_turns: { type: 'number', required: false, doc: 'Maximum turns per Execute call' },
      max_tokens: { type: 'number', required: false, doc: `Maximum tokens per response (default: ${DEFAULT_MAX_TOKENS})` },
      system_prompt: { type: 'string', required: false, doc: 'System prompt for the conversation' },
    },
  },

  inputSchema: {
    fields: {
      prompt: { type: 'string', required: true, doc: 'The prompt to send to Claude' },
      max_turns: { type: 'number', required: false, doc: 'Per-step override for max turns' },
      max_tokens: { type: 'number', required: false, doc: 'Per-step override for max tokens' },
      model: { type: 'string', required: false, doc: 'Per-step override for model' },
    },
  },

  async onOpenSession(req) {
    createSession(req.sessionId, req.config);
  },

  async execute(req, sender) {
    const state = getSession(req.sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${req.sessionId}`);
    }

    await executeTurn(state, req, sender);
  },

  async onPermit(req) {
    console.error(`Permission ${req.permissionId}: ${req.allow ? 'allowed' : 'denied'}`);
  },

  async onCloseSession(req) {
    closeSession(req.sessionId);
  },
});
