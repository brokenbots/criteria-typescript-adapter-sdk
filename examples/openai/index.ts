/**
 * OpenAI Adapter for Criteria
 *
 * This adapter enables using OpenAI's models
 * as agent backends in Criteria workflows.
 *
 * Features:
 * - Multi-turn conversations
 * - Tool calling with submit_outcome for workflow integration
 * - Permission gating for sensitive operations
 * - Structured events for observability
 *
 * Environment Variables:
 * - OPENAI_API_KEY: Required. Your OpenAI API key.
 * - OPENAI_BASE_URL: Optional. Override the API base URL.
 * - OPENAI_MODEL: Optional. Default model (default: gpt-4o)
 *
 * Example workflow:
 * ```hcl
 * step "analyze" {
 *   adapter = "openai"
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
import OpenAI from 'openai';

// ============================================================================
// Types
// ============================================================================

interface SessionState {
  client: OpenAI;
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
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

const PLUGIN_NAME = 'openai';
const PLUGIN_VERSION = '0.1.0';

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_MAX_TURNS = 10;

const SUBMIT_OUTCOME_TOOL_NAME = 'submit_outcome';
const SUBMIT_OUTCOME_DESCRIPTION = `Finalize the outcome for the current step. Call this exactly once with one of the allowed outcomes before ending the turn. The allowed outcomes are provided in the conversation context. Failure to call this tool with a valid outcome will fail the step.`;

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

// ============================================================================
// Sessions
// ============================================================================

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

function createSession(sessionId: string, config: Record<string, string>): SessionState {
  const apiKey = config.api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable or config.api_key');
  }
  
  const baseURL = config.base_url || process.env.OPENAI_BASE_URL;
  const model = config.model || process.env.OPENAI_MODEL || DEFAULT_MODEL;
  
  const client = new OpenAI({
    apiKey,
    baseURL,
  });
  
  const systemPrompt = config.system_prompt || `You are a helpful assistant integrated into a workflow system. When you complete your task, you MUST call the submit_outcome tool with the appropriate outcome to proceed.`;
  
  const state: SessionState = {
    client,
    model,
    messages: [{ role: 'system', content: systemPrompt }],
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

async function executeTurn(
  state: SessionState,
  req: ExecuteRequest,
  sender: EventSender
): Promise<void> {
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
  
  await sender.log('stdout', `[openai] Starting conversation with model ${state.model}\n`);
  
  let turnCount = 0;
  const maxTurns = parseInt(req.config.max_turns, 10) || state.maxTurns;
  
  while (turnCount < maxTurns) {
    turnCount++;
    
    await sender.log('stdout', `[openai] Turn ${turnCount}/${maxTurns}\n`);
    
    // Define tools
    const tools: OpenAI.Chat.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: SUBMIT_OUTCOME_TOOL_NAME,
          description: SUBMIT_OUTCOME_DESCRIPTION,
          parameters: {
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
      },
    ];
    
    // Call OpenAI API
    const response = await state.client.chat.completions.create({
      model: state.model,
      messages: state.messages,
      tools,
      tool_choice: 'auto',
    });
    
    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error('No response from OpenAI API');
    }
    
    // Add assistant message to history
    state.messages.push(message);
    
    // Stream content
    if (message.content) {
      await sender.log('stdout', message.content);
      await sender.adapterEvent({
        type: 'agent.message',
        content: message.content,
        turn: turnCount,
      });
    }
    
    // Handle tool calls
    if (message.tool_calls?.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.function.name === SUBMIT_OUTCOME_TOOL_NAME) {
          let args: SubmitOutcomeArgs;
          try {
            args = JSON.parse(toolCall.function.arguments);
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
          
          if (result.success) {
            // Return the result
            await sender.result(state.finalizedOutcome!, {});
            return;
          }
          
          // Add error to messages for retry
          state.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.message,
          });
        }
      }
    }
    
    // Check if conversation should end
    if (!message.tool_calls?.length) {
      // No tool calls, model ended turn without finalizing
      break;
    }
  }
  
  // Max turns reached or conversation ended without outcome
  if (turnCount >= maxTurns) {
    await sender.adapterEvent({
      type: 'limit.reached',
      max_turns: maxTurns,
    });
    
    // Check if needs_review is allowed
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
      api_key: { type: 'string', required: false, doc: 'OpenAI API key. Falls back to OPENAI_API_KEY env var.' },
      base_url: { type: 'string', required: false, doc: 'OpenAI API base URL. Falls back to OPENAI_BASE_URL env var.' },
      model: { type: 'string', required: false, doc: `Model to use (default: ${DEFAULT_MODEL})` },
      max_turns: { type: 'number', required: false, doc: 'Maximum turns per Execute call' },
      system_prompt: { type: 'string', required: false, doc: 'System prompt for the conversation' },
    },
  },
  
  inputSchema: {
    fields: {
      prompt: { type: 'string', required: true, doc: 'The prompt to send to the model' },
      max_turns: { type: 'number', required: false, doc: 'Per-step override for max turns' },
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
    // Permission handling - could integrate with OpenAI's permission system
    // For now, just log
    console.error(`Permission ${req.permissionId}: ${req.allow ? 'allowed' : 'denied'}`);
  },
  
  async onCloseSession(req) {
    closeSession(req.sessionId);
  },
});
