/**
 * LLM Factory
 *
 * Factory pattern for creating the appropriate LLM service instance
 * based on the LLM_PROVIDER environment variable
 */

import { ExecutionEngine } from './execution-engine.js'
import { BaseLLMService } from './llm/base.js'
import { OllamaLLMService } from './llm/ollama.js'

export type LLMProvider = 'ollama'

/**
 * Create an LLM service instance based on the configured provider
 *
 * @param executionEngine - The execution engine to pass to the service
 * @returns An instance of the appropriate LLM service
 * @throws Error if the provider is not configured or is invalid
 */
export function createLLMService(executionEngine: ExecutionEngine): BaseLLMService {
    const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase()

    if (provider !== 'ollama') {
        throw new Error(
            `Unsupported LLM provider: ${provider}. Hashi Lens is configured for ollama only.`
        )
    }

    console.log(`[LLM Factory] Creating ${provider} LLM service`)
    return new OllamaLLMService(executionEngine)
}
