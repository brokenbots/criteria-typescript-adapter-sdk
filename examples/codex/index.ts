/**
 * OpenAI Codex Adapter for Criteria
 *
 * This adapter uses the official @openai/codex-sdk to run OpenAI Codex
 * as an agentic backend in Criteria workflows.
 *
 * Features:
 * - Agentic coding with the Codex CLI
 * - Multi-turn sessions via Codex threads
 * - Streaming of agent messages, commands, file changes, and reasoning
 * - Outcome extraction from the agent's final response
 *
 * Environment Variables:
 * - OPENAI_API_KEY: Required. Your OpenAI API key.
 * - OPENAI_BASE_URL: Optional. Override the API base URL.
 * - OPENAI_MODEL: Optional. Default model (default: o4-mini)
 *
 * Prerequisites:
 * - The `codex` CLI must be installed (npm i -g @openai/codex)
 *
 * Example workflow:
 * ```hcl
 * step "analyze" {
 *   adapter = "codex"
 *   input {
 *     prompt = "Review this codebase for security issues"
 *   }
 *   outcome "clean" { transition_to = "deploy" }
 *   outcome "issues_found" { transition_to = "review" }
 *   outcome "failure" { transition_to = "failed" }
 * }
 * ```
 */

import { serve, type EventSender, type ExecuteRequest } from '@criteria/adapter-sdk';
import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type AgentMessageItem,
  type CommandExecutionItem,
  type FileChangeItem,
  type ReasoningItem,
} from '@openai/codex-sdk';

// ============================================================================
// Types
// ============================================================================

interface SessionState {
  thread: Thread;
  model: string;
  activeAllowedOutcomes: Set<string>;
  finalizedOutcome: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_NAME = 'codex';
const PLUGIN_VERSION = '0.1.0';

const DEFAULT_MODEL = 'o4-mini';
const DEFAULT_SANDBOX_MODE = 'workspace-write';
const DEFAULT_APPROVAL_POLICY = 'on-failure';

const OUTCOME_REGEX = /OUTCOME:\s*(.+?)\s*(?:\n|$)/i;

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

  const codex = new Codex({
    apiKey,
    baseUrl: config.base_url || process.env.OPENAI_BASE_URL,
  });

  const model = config.model || process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const sandboxMode = (config.sandbox_mode || DEFAULT_SANDBOX_MODE) as
    | 'read-only'
    | 'workspace-write'
    | 'danger-full-access';
  const approvalPolicy = (config.approval_policy || DEFAULT_APPROVAL_POLICY) as
    | 'never'
    | 'on-request'
    | 'on-failure'
    | 'untrusted';

  const thread = codex.startThread({
    model,
    sandboxMode,
    approvalPolicy,
    workingDirectory: config.working_directory || process.cwd(),
  });

  const state: SessionState = {
    thread,
    model,
    activeAllowedOutcomes: new Set(),
    finalizedOutcome: null,
  };

  sessions.set(sessionId, state);
  return state;
}

function closeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// ============================================================================
// Event Helpers
// ============================================================================

function formatItem(item: ThreadItem): string {
  switch (item.type) {
    case 'agent_message':
      return (item as AgentMessageItem).text;
    case 'reasoning':
      return `[reasoning] ${(item as ReasoningItem).text}`;
    case 'command_execution': {
      const cmd = item as CommandExecutionItem;
      let out = `[command] ${cmd.command}`;
      if (cmd.aggregated_output) {
        out += `\n${cmd.aggregated_output}`;
      }
      if (cmd.exit_code !== undefined) {
        out += `\n[exit code: ${cmd.exit_code}]`;
      }
      return out;
    }
    case 'file_change': {
      const change = item as FileChangeItem;
      const changes = change.changes.map((c) => `${c.kind} ${c.path}`).join(', ');
      return `[files] ${changes} (${change.status})`;
    }
    case 'mcp_tool_call':
      return `[mcp] ${item.tool} on ${item.server}`;
    case 'web_search':
      return `[web] ${item.query}`;
    case 'todo_list': {
      const todos = item.items.map((t) => `[${t.completed ? 'x' : ' '}] ${t.text}`).join('\n');
      return `[plan]\n${todos}`;
    }
    case 'error':
      return `[error] ${item.message}`;
    default:
      return `[${(item as any).type}]`;
  }
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

  state.activeAllowedOutcomes = new Set(req.allowedOutcomes);
  state.finalizedOutcome = null;

  let fullPrompt = prompt;
  if (req.allowedOutcomes.length > 0) {
    fullPrompt +=
      `\n\n[WORKFLOW INSTRUCTION] When you have completed the task, you must end your ` +
      `final message with exactly:\nOUTCOME: <one of: ${req.allowedOutcomes.join(', ')}>\n` +
      `This is required for the workflow to proceed.`;
  }

  await sender.log('stdout', `[codex] Starting turn with model ${state.model}\n`);

  const streamedTurn = await state.thread.runStreamed(fullPrompt);
  let lastAgentMessage = '';

  for await (const event of streamedTurn.events) {
    switch (event.type) {
      case 'thread.started': {
        await sender.adapterEvent({ type: 'thread.started', thread_id: event.thread_id });
        break;
      }

      case 'turn.started': {
        await sender.adapterEvent({ type: 'turn.started' });
        break;
      }

      case 'item.started':
      case 'item.updated': {
        const desc = formatItem(event.item);
        await sender.adapterEvent({
          type: event.type,
          itemType: event.item.type,
          description: desc,
        });
        if (event.item.type === 'agent_message') {
          lastAgentMessage = (event.item as AgentMessageItem).text;
        }
        break;
      }

      case 'item.completed': {
        const desc = formatItem(event.item);
        await sender.adapterEvent({
          type: 'item.completed',
          itemType: event.item.type,
          description: desc,
        });

        if (event.item.type === 'agent_message') {
          const text = (event.item as AgentMessageItem).text;
          lastAgentMessage = text;
          await sender.log('stdout', text + '\n');
        } else if (event.item.type === 'command_execution') {
          const cmd = event.item as CommandExecutionItem;
          await sender.log('stdout', formatItem(cmd) + '\n');
        } else if (event.item.type === 'file_change') {
          await sender.log('stdout', formatItem(event.item as FileChangeItem) + '\n');
        } else if (event.item.type === 'error') {
          await sender.log('stderr', formatItem(event.item) + '\n');
        }
        break;
      }

      case 'turn.completed': {
        await sender.adapterEvent({
          type: 'turn.completed',
          usage: event.usage,
        });

        if (req.allowedOutcomes.length > 0) {
          const match = lastAgentMessage.match(OUTCOME_REGEX);
          if (match) {
            const outcome = match[1].trim();
            if (state.activeAllowedOutcomes.has(outcome)) {
              state.finalizedOutcome = outcome;
              await sender.result(outcome, { final_response: lastAgentMessage });
              return;
            }
          }
        }
        break;
      }

      case 'turn.failed': {
        throw new Error(event.error?.message || 'Codex turn failed');
      }

      case 'error': {
        throw new Error(event.message || 'Codex thread error');
      }
    }
  }

  // If no outcome was finalized during the stream, handle gracefully
  if (state.finalizedOutcome) {
    return;
  }

  if (req.allowedOutcomes.length > 0) {
    await sender.adapterEvent({
      type: 'outcome.failure',
      reason: 'No valid outcome found in agent response',
    });
    await sender.result('failure', {
      reason: 'No valid outcome found in agent response',
      final_response: lastAgentMessage,
    });
  } else {
    await sender.result('success', { final_response: lastAgentMessage });
  }
}

// ============================================================================
// Main
// ============================================================================

serve({
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  capabilities: ['multi_turn', 'structured_events'],

  configSchema: {
    fields: {
      api_key: {
        type: 'string',
        required: false,
        doc: 'OpenAI API key. Falls back to OPENAI_API_KEY env var.',
      },
      base_url: {
        type: 'string',
        required: false,
        doc: 'OpenAI API base URL. Falls back to OPENAI_BASE_URL env var.',
      },
      model: {
        type: 'string',
        required: false,
        doc: `Model to use (default: ${DEFAULT_MODEL})`,
      },
      sandbox_mode: {
        type: 'string',
        required: false,
        doc: 'Sandbox mode: read-only, workspace-write, danger-full-access (default: workspace-write)',
      },
      approval_policy: {
        type: 'string',
        required: false,
        doc: 'Approval policy: never, on-request, on-failure, untrusted (default: on-failure)',
      },
      working_directory: {
        type: 'string',
        required: false,
        doc: 'Working directory for the agent (default: current directory)',
      },
    },
  },

  inputSchema: {
    fields: {
      prompt: { type: 'string', required: true, doc: 'The prompt to send to Codex' },
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
