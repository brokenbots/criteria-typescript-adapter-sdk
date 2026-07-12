# Criteria TypeScript SDK Makefile
# Provides build and install targets for adapter plugins

.PHONY: all build install clean test lint proto help

# Default target - build everything
all: install-codex install-claude-code

# Detect platform for native build
UNAME_S := $(shell uname -s | tr '[:upper:]' '[:lower:]')
UNAME_M := $(shell uname -m)

# Map architecture names
ifeq ($(UNAME_M),x86_64)
	ARCH := x64
else ifeq ($(UNAME_M),amd64)
	ARCH := x64
else ifeq ($(UNAME_M),aarch64)
	ARCH := arm64
else ifeq ($(UNAME_M),arm64)
	ARCH := arm64
else
	ARCH := $(UNAME_M)
endif

# Determine Bun target
BUN_TARGET := bun-$(UNAME_S)-$(ARCH)

# Plugin directory
PLUGIN_DIR := $(HOME)/.criteria/plugins

# Adapter name (can be overridden)
ADAPTER_NAME ?= codex
ADAPTER_BINARY := criteria-adapter-$(ADAPTER_NAME)

# Colors for output
BLUE := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RED := \033[31m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "$(BLUE)Criteria TypeScript SDK$(NC)"
	@echo ""
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-15s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables:"
	@echo "  $(YELLOW)ADAPTER_NAME$(NC)    - Name of adapter to build (default: codex)"
	@echo "  $(YELLOW)BUN_TARGET$(NC)      - Bun compile target (detected: $(BUN_TARGET))"

build: ## Build SDK and the adapter (ADAPTER_NAME=codex by default)
	@echo "$(BLUE)Building SDK...$(NC)"
	@if command -v bun >/dev/null 2>&1; then \
		bun install; \
		bun run build; \
	else \
		echo "$(YELLOW)Bun not found, using npm...$(NC)"; \
		npm install; \
		npx tsc; \
	fi
	@echo "$(GREEN)SDK build complete$(NC)"
	@echo ""
	@echo "$(BLUE)Building adapter: $(ADAPTER_NAME)...$(NC)"
	@cd examples/$(ADAPTER_NAME) && \
	if command -v bun >/dev/null 2>&1; then \
		bun install; \
		bun build --compile --target=$(BUN_TARGET) index.ts --outfile $(ADAPTER_BINARY); \
	else \
		echo "$(RED)Error: Bun is required for compilation$(NC)"; \
		exit 1; \
	fi
	@echo "$(GREEN)Adapter built: examples/$(ADAPTER_NAME)/$(ADAPTER_BINARY)$(NC)"

install: build ## Build and install adapter to ~/.criteria/plugins/
	@echo ""
	@echo "$(BLUE)Installing $(ADAPTER_BINARY) to $(PLUGIN_DIR)...$(NC)"
	@mkdir -p $(PLUGIN_DIR)
	@cp examples/$(ADAPTER_NAME)/$(ADAPTER_BINARY) $(PLUGIN_DIR)/
	@chmod +x $(PLUGIN_DIR)/$(ADAPTER_BINARY)
	@echo "$(GREEN)Installed: $(PLUGIN_DIR)/$(ADAPTER_BINARY)$(NC)"
	@echo ""
	@echo "$(YELLOW)Next steps:$(NC)"
	@echo "  1. Ensure Criteria can find the plugin:"
	@echo "     export CRITERIA_PLUGINS=$(PLUGIN_DIR)"
	@echo "  2. Verify installation:"
	@echo "     criteria status"

install-greeter: ## Build and install the greeter example
	@$(MAKE) ADAPTER_NAME=greeter install

install-openai: ## Build and install the openai example
	@$(MAKE) ADAPTER_NAME=openai install

install-codex: ## Build and install the codex example
	@$(MAKE) ADAPTER_NAME=codex install

install-claude: ## Build and install the claude example
	@$(MAKE) ADAPTER_NAME=claude install

install-claude-code: ## Build and install the claude-code example
	@$(MAKE) ADAPTER_NAME=claude-code install

clean: ## Remove build artifacts
	@echo "$(BLUE)Cleaning build artifacts...$(NC)"
	@rm -rf dist/
	@rm -f examples/greeter/criteria-adapter-greeter
	@rm -f examples/openai/criteria-adapter-openai
	@rm -f examples/codex/criteria-adapter-codex
	@rm -f examples/claude/criteria-adapter-claude
	@rm -f examples/claude-code/criteria-adapter-claude-code
	@echo "$(GREEN)Clean complete$(NC)"

test: ## Run tests
	@echo "$(BLUE)Running tests...$(NC)"
	@if command -v bun >/dev/null 2>&1; then \
		bun test; \
	else \
		npm test; \
	fi

lint: ## Run linter
	@echo "$(BLUE)Running linter...$(NC)"
	@if command -v bun >/dev/null 2>&1; then \
		bun run lint; \
	else \
		npm run lint; \
	fi

proto: ## Generate proto bindings (requires buf CLI)
	@echo "$(BLUE)Generating proto bindings...$(NC)"
	@if command -v npx >/dev/null 2>&1 && npx buf --version >/dev/null 2>&1; then \
		npx buf generate ../criteria-adapter-proto/proto; \
	elif command -v buf >/dev/null 2>&1; then \
		buf generate ../criteria-adapter-proto/proto; \
	else \
		echo "$(RED)Error: buf CLI is required$(NC)"; \
		echo "Install from: https://github.com/bufbuild/buf"; \
		exit 1; \
	fi
	@echo "$(GREEN)Proto generation complete$(NC)"

uninstall: ## Remove installed adapter from ~/.criteria/plugins/
	@echo "$(BLUE)Removing $(ADAPTER_BINARY) from $(PLUGIN_DIR)...$(NC)"
	@rm -f $(PLUGIN_DIR)/$(ADAPTER_BINARY)
	@echo "$(Green)Uninstalled$(NC)"

# Convenience target for development
dev-setup: ## Install dependencies for development
	@echo "$(BLUE)Setting up development environment...$(NC)"
	@if ! command -v bun >/dev/null 2>&1; then \
		echo "$(YELLOW)Installing Bun...$(NC)"; \
		curl -fsSL https://bun.sh/install | bash; \
	fi
	@bun install
	@echo "$(GREEN)Development setup complete$(NC)"
