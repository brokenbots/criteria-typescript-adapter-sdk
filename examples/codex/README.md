# OpenAI Codex Adapter Example

This example demonstrates using the official `@openai/codex-sdk` to run OpenAI Codex as an agentic backend in Criteria workflows.

## Features

- Agentic coding with the Codex CLI
- Multi-turn sessions via Codex threads
- Streaming of agent messages, commands, file changes, and reasoning
- Outcome extraction from the agent's final response
- Configurable sandbox mode and approval policy

## Prerequisites

1. **Install the Codex CLI:**
   ```bash
   npm install -g @openai/codex
   ```

2. **Install dependencies:**
   ```bash
   cd examples/codex
   npm install
   ```

3. **Set your OpenAI API key:**
   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

4. **Build the adapter:**
   ```bash
   npm run build
   ```

5. **Install to Criteria plugins directory:**
   ```bash
   mkdir -p ~/.criteria/plugins
   cp criteria-adapter-codex ~/.criteria/plugins/
   chmod +x ~/.criteria/plugins/criteria-adapter-codex
   ```

## Usage

Create a workflow file:

```hcl
step "analyze" {
  adapter = "codex"

  agent {
    config {
      model           = "o4-mini"
      sandbox_mode    = "workspace-write"
      approval_policy = "on-failure"
    }
  }

  input {
    prompt = "Review this code for bugs: $(file src/main.ts)"
  }

  outcome "clean" { transition_to = "deploy" }
  outcome "issues_found" { transition_to = "fix" }
  outcome "failure" { transition_to = "failed" }
}
```

Run the workflow:
```bash
criteria apply workflow.hcl
```

## Configuration

### Agent-level config (set once per session)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `api_key` | string | No | `OPENAI_API_KEY` env | OpenAI API key |
| `base_url` | string | No | - | Custom API base URL |
| `model` | string | No | `o4-mini` | Model to use |
| `sandbox_mode` | string | No | `workspace-write` | Sandbox restrictions |
| `approval_policy` | string | No | `on-failure` | When to ask for approval |
| `working_directory` | string | No | current dir | Working directory for the agent |

### Step-level input (set per step)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | The prompt to send to Codex |

## How It Works

The adapter interfaces with the Codex CLI via the `@openai/codex-sdk`:

1. **Session Open**: Creates a Codex client and starts a new thread
2. **Execute**: Sends the prompt to the Codex agent
3. **Streaming**: Streams agent messages, commands, file changes, and reasoning back to Criteria
4. **Outcome Extraction**: The adapter appends instructions to the prompt requesting the agent end its response with `OUTCOME: <outcome_name>`. The adapter parses the final message to determine the workflow outcome.
5. **Result**: Returns the outcome to Criteria for workflow transition

## Development

To modify the adapter:

1. Edit `index.ts`
2. Rebuild: `npm run build`
3. Test with `criteria apply`
