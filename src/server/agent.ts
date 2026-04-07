/**
 * Agent Service
 *
 * ⚠️ DEPRECATED: This module is kept for backward compatibility.
 * New code should import from './llm/base.js' and use createLLMService() from './llm-factory'
 *
 * This module now re-exports from the new modular LLM architecture
 * currently configured for Ollama in this repo.
 */

export { BaseLLMService as AgentService, QueryResult, ConversationContext } from './llm/base.js'
export { OllamaLLMService } from './llm/ollama.js'

