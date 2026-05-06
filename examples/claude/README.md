# Anthropic Claude Adapter Example

This example demonstrates using Anthropic's Claude models as agent backends in Criteria workflows.

## Features

- Multi-turn conversations with Claude models
- Tool use with `submit_outcome` for workflow integration
- Support for different models (claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5, etc.)
- Configurable max turns and max tokens per step
- Structured events for observability

## Setup

1. **Install dependencies:**
   ```bash
   cd examples/claude
   npm install
   ```

2. **Set your Anthropic API key:**
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

3. **Build the adapter:**
   ```bash
   npm run build
   ```

4. **Install to Criteria plugins directory:**
   ```bash
   mkdir -p ~/.criteria/plugins
   cp criteria-adapter-claude ~/.criteria/plugins/
   chmod +x ~/.criteria/plugins/criteria-adapter-claude
   ```

## Usage

Create a workflow file:

```hcl
step "analyze" {
  adapter = "claude"

  agent {
    config {
      model = "claude-sonnet-4-6"
      max_turns = 10
      max_tokens = 4096
      system_prompt = "You are a senior software engineer performing code reviews."
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
| `api_key` | string | No | `ANTHROPIC_API_KEY` env | Anthropic API key |
| `base_url` | string | No | - | Custom API base URL |
| `model` | string | No | `claude-sonnet-4-6` | Model to use |
| `max_turns` | number | No | `10` | Default max turns per step |
| `max_tokens` | number | No | `4096` | Max tokens per response |
| `system_prompt` | string | No | - | System prompt for the session |

### Step-level input (set per step)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | The prompt to send to Claude |
| `max_turns` | number | No | Per-step override for max turns |
| `max_tokens` | number | No | Per-step override for max tokens |
| `model` | string | No | Per-step override for model |

## How It Works

The adapter implements a multi-turn conversation loop:

1. **Session Open**: Creates an Anthropic client and stores conversation history
2. **Execute**: Sends the prompt to Claude with a `submit_outcome` tool
3. **Tool Use**: The model can call `submit_outcome(outcome, reason)` to finalize
4. **Outcome Validation**: The adapter validates the outcome against allowed outcomes
5. **Result**: Returns the outcome to Criteria for workflow transition

## Development

To modify the adapter:

1. Edit `index.ts`
2. Rebuild: `npm run build`
3. Test with `criteria apply`
