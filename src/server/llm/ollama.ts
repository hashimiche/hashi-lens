/**
 * Ollama LLM Service
 *
 * Reuses the OpenAI-compatible chat/tool API exposed by Ollama.
 */

import { ExecutionEngine } from '../execution-engine.js'
import { OpenAILLMService } from './openai.js'

const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://ollama.localhost:11434/v1'
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b'

export class OllamaLLMService extends OpenAILLMService {
    constructor(executionEngine: ExecutionEngine) {
        super(executionEngine, {
            apiKey: process.env.OLLAMA_API_KEY || 'ollama',
            baseURL: DEFAULT_OLLAMA_BASE_URL,
            model: DEFAULT_OLLAMA_MODEL,
            providerLabel: 'Ollama',
        })
    }
}
