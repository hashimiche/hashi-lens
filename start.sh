#!/bin/bash
# Quick start script for Hashi Lens
# Requirements: Node.js 18+, npm, and a local Ollama runtime

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Hashi Lens Quick Start"
echo "=============================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required. You have $(node -v)"
    exit 1
fi

echo "✅ Node.js $(node -v) found"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found"
    exit 1
fi

echo "✅ npm $(npm -v) found"
echo ""

# Check .env file
if [ ! -f ".env" ]; then
    echo "📝 Setting up environment variables..."
    cp .env.example .env
    echo ""
    echo "⚠️  Please edit .env for your local setup:"
    echo "   nano .env"
    echo ""
    echo "   You'll need to add:"
    echo "   - OLLAMA_MODEL=... (model available in your local Ollama)"
    echo "   - VAULT_MCP_COMMAND=..."
    echo "   - VAULT_AUDIT_MCP_COMMAND=..."
    echo ""
    exit 1
fi

# Source .env to get the actual values (handles quotes automatically)
set +e
source .env 2>/dev/null
set -e

if [ -z "$HAL_MCP_COMMAND" ]; then
    HAL_MCP_COMMAND="$HOME/.hal/bin/hal-mcp"
fi

if [[ "$HAL_MCP_COMMAND" == */* ]]; then
    if [ ! -x "$HAL_MCP_COMMAND" ]; then
        echo "❌ HAL MCP command is not executable: $HAL_MCP_COMMAND"
        echo "   Set HAL_MCP_COMMAND in .env to a valid hal-mcp binary path"
        exit 1
    fi
else
    if ! command -v "$HAL_MCP_COMMAND" >/dev/null 2>&1; then
        echo "❌ HAL MCP command not found in PATH: $HAL_MCP_COMMAND"
        echo "   Set HAL_MCP_COMMAND in .env to a valid hal-mcp command or absolute path"
        exit 1
    fi
fi

echo "✅ HAL MCP command detected: $HAL_MCP_COMMAND"

# Determine which LLM provider is configured
LLM_PROVIDER=$(echo "${LLM_PROVIDER:-ollama}" | tr '[:upper:]' '[:lower:]')

if [ "$LLM_PROVIDER" != "ollama" ]; then
    echo "❌ Unknown LLM_PROVIDER '$LLM_PROVIDER' in .env"
    echo "   Supported values: ollama"
    exit 1
fi

if [ -z "$OLLAMA_BASE_URL" ]; then
    echo "❌ OLLAMA_BASE_URL not set in .env"
    exit 1
fi

if [ -z "$OLLAMA_MODEL" ]; then
    echo "❌ OLLAMA_MODEL not set in .env"
    exit 1
fi

OLLAMA_PROBE_URL="${OLLAMA_BASE_URL%/v1}/api/tags"
if ! curl -fsS "$OLLAMA_PROBE_URL" >/dev/null 2>&1; then
    echo "❌ Unable to reach Ollama at ${OLLAMA_BASE_URL}"
    echo "   Start Ollama first, or update OLLAMA_BASE_URL in .env"
    exit 1
fi

echo "✅ Ollama configuration detected"
echo ""

# Install dependencies
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

echo "✅ Dependencies installed"
echo ""

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run type-check
echo "✅ Type check passed"
echo ""

# Start servers
API_PORT_DISPLAY="${API_PORT:-9001}"
VITE_PORT_DISPLAY="${VITE_PORT:-9000}"
VITE_HOSTNAME_DISPLAY="${VITE_HOSTNAME:-hal.localhost}"

echo "🎯 Starting Hashi Lens..."
echo ""
echo "📍 Frontend:  http://${VITE_HOSTNAME_DISPLAY}:${VITE_PORT_DISPLAY}"
echo "📍 Backend:   http://localhost:${API_PORT_DISPLAY}"
echo ""
echo "Press Ctrl+C to stop"
echo ""

npm run dev
