# Example workflow using the Anthropic Claude adapter
#
# Prerequisites:
#   1. Build the adapter: bun run build
#   2. Install to plugins directory: cp criteria-adapter-claude ~/.criteria/plugins/
#   3. Set ANTHROPIC_API_KEY environment variable
#
# Run: criteria apply example.hcl

workflow "code-review" {
  version       = "0.1"
  initial_state = "analyze"
  target_state  = "done"

  step "analyze" {
    adapter = "claude"

    # Agent-level config (applies to all steps in this agent block)
    agent {
      config {
        model = "claude-sonnet-4-6"
        max_turns = 10
        max_tokens = 4096
        system_prompt = "You are a senior software engineer performing code reviews."
      }
    }

    # Step-level input
    input {
      prompt = "Review this code for security vulnerabilities: $(file src/main.ts)"
      max_turns = 5
    }

    outcome "clean" {
      transition_to = "deploy"
    }

    outcome "issues_found" {
      transition_to = "fix"
    }

    outcome "failure" {
      transition_to = "failed"
    }
  }

  step "fix" {
    adapter = "claude"

    input {
      prompt = "Fix the security issues found in the previous step."
    }

    outcome "success" {
      transition_to = "done"
    }

    outcome "failure" {
      transition_to = "failed"
    }
  }

  state "deploy" {
    terminal = true
  }

  state "done" {
    terminal = true
  }

  state "failed" {
    terminal = true
    success  = false
  }
}
