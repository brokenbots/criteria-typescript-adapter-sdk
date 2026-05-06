# OpenAI Adapter Example

This example demonstrates using OpenAI's models as agent backends in Criteria workflows.

## Features

- Multi-turn conversations with OpenAI models
- Tool calling with `submit_outcome` for workflow integration
- Support for different models (gpt-4o, gpt-4-turbo, etc.)
- Configurable max turns per step
- Structured events for observability

## Setup

1. **Install dependencies:**
   ```bash
   cd examples/openai
   npm install
   ```

2. **Set your OpenAI API key:**
   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

3. **Build the adapter:**
   ```bash
   npm run build
   ```

4. **Install to Criteria plugins directory:**
   ```bash
   mkdir -p ~/.criteria/plugins
   cp criteria-adapter-openai ~/.criteria/plugins/
   chmod +x ~/.criteria/plugins/criteria-adapter-openai
   ```

## Usage

Create a workflow file:

```hcl
step "analyze" {
  adapter = "openai"

  agent {
    config {
      model = "gpt-4o"
      max_turns = 10
      system_prompt = "You are a code reviewer."
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
| `model` | string | No | `gpt-4o` | Model to use |
| `max_turns` | number | No | `10` | Default max turns per step |
| `system_prompt` | string | No | - | System prompt for the session |

### Step-level input (set per step)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | The prompt to send to the model |
| `max_turns` | number | No | Per-step override for max turns |
| `model` | string | No | Per-step override for model |

## How It Works

The adapter implements a multi-turn conversation loop:

1. **Session Open**: Creates an OpenAI client and stores conversation history
2. **Execute**: Sends the prompt to OpenAI with a `submit_outcome` tool
3. **Tool Calling**: The model can call `submit_outcome(outcome, reason)` to finalize
4. **Outcome Validation**: The adapter validates the outcome against allowed outcomes
5. **Result**: Returns the outcome to Criteria for workflow transition

## Development

To modify the adapter:

1. Edit `index.ts`
2. Rebuild: `npm run build`
3. Test with `criteria apply`
