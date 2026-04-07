/**
 * OIDC Authentication Module
 * 
 * Handles interactive authentication with Vault via OIDC provider.
 * Opens browser for user authentication, receives callback, and exchanges for Vault token.
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'
import open from 'open'
import axios, { AxiosInstance } from 'axios'
import https from 'https'

export interface OIDCConfig {
    vaultAddr: string
    oidcMount: string
    oidcRole: string
    redirectUri: string
    skipVerify: boolean
}

interface VaultAuthURLResponse {
    data: {
        auth_url: string
    }
}

interface VaultLoginResponse {
    auth: {
        client_token: string
        lease_duration: number
        renewable: boolean
    }
}

export class OIDCAuthenticator {
    private config: OIDCConfig
    private httpClient: AxiosInstance
    private callbackServer: Server | null = null
    private authState: {
        authUrl?: string
        state?: string
        nonce?: string
        callbackPromise?: Promise<{ code: string }>
        callbackUrl?: URL
    } = {}

    constructor(config: OIDCConfig) {
        this.config = config

        // Create HTTP client with optional TLS skip verification
        this.httpClient = axios.create({
            httpsAgent: config.skipVerify
                ? new https.Agent({ rejectUnauthorized: false })
                : undefined
        })
    }

    /**
     * Perform interactive OIDC authentication
     * Returns a Vault token and its TTL
     */
    async authenticate(): Promise<{ token: string, ttl: number }> {
        console.log('[OIDC] Starting interactive authentication flow')

        // 1. Get auth URL from Vault
        const { authUrl, state, nonce } = await this.getAuthURL()

        console.log('[OIDC] Auth URL obtained from Vault')

        // 2. Start local callback server and open browser
        const callbackUrl = new URL(this.config.redirectUri)
        const { code } = await this.waitForCallback(callbackUrl, state, authUrl)

        console.log('[OIDC] Callback received with authorization code')

        // 3. Exchange code for Vault token
        const { token, ttl } = await this.exchangeCodeForToken(code, state, nonce)

        console.log(`[OIDC] Successfully obtained Vault token (TTL: ${ttl}s)`)

        return { token, ttl }
    }

    /**
     * Start OIDC auth flow - returns auth URL for client to open in popup
     * Starts callback server but doesn't open browser
     */
    async startAuthFlow(): Promise<string> {
        console.log('[OIDC] Starting OIDC auth flow (client popup mode)')

        // 1. Get auth URL from Vault
        const { authUrl, state, nonce } = await this.getAuthURL()

        console.log('[OIDC] Auth URL obtained from Vault')

        // 2. Store state for later use
        this.authState = {
            authUrl,
            state,
            nonce,
            callbackUrl: new URL(this.config.redirectUri)
        }

        // 3. Start callback server but don't open browser
        const callbackUrl = new URL(this.config.redirectUri)
        this.authState.callbackUrl = callbackUrl
        this.authState.callbackPromise = this.startCallbackServer(callbackUrl, state)

        return authUrl
    }

    /**
     * Wait for OIDC callback to complete and exchange for token
     */
    async waitForCompletion(): Promise<{ token: string, ttl: number }> {
        if (!this.authState.callbackPromise || !this.authState.state || !this.authState.nonce) {
            throw new Error('OIDC auth flow not started. Call startAuthFlow first.')
        }

        console.log('[OIDC] Waiting for callback...')

        // Wait for callback
        const { code } = await this.authState.callbackPromise

        console.log('[OIDC] Callback received with authorization code')

        // Exchange code for Vault token
        const { token, ttl } = await this.exchangeCodeForToken(
            code,
            this.authState.state,
            this.authState.nonce
        )

        // Clean up callback server and state
        this.stopCallbackServer()
        this.authState = {}

        console.log(`[OIDC] Successfully obtained Vault token (TTL: ${ttl}s)`)

        return { token, ttl }
    }

    /**
     * Request auth URL from Vault
     */
    private async getAuthURL(): Promise<{ authUrl: string, state: string, nonce: string }> {
        const mount = this.normalizeMount(this.config.oidcMount)
        const url = `${this.config.vaultAddr}/v1/auth/${mount}/oidc/auth_url`

        const response = await this.httpClient.post<VaultAuthURLResponse>(url, {
            role: this.config.oidcRole,
            redirect_uri: this.config.redirectUri
        })

        const authUrl = response.data.data.auth_url
        if (!authUrl) {
            throw new Error('No auth_url in Vault response')
        }

        // Extract state and nonce from auth URL
        const parsed = new URL(authUrl)
        const state = parsed.searchParams.get('state')
        const nonce = parsed.searchParams.get('nonce')

        if (!state || !nonce) {
            throw new Error('Auth URL missing state or nonce parameters')
        }

        return { authUrl, state, nonce }
    }

    /**
     * Start local server and wait for OIDC callback
     */
    private async waitForCallback(
        callbackUrl: URL,
        expectedState: string,
        authUrl: string
    ): Promise<{ code: string }> {
        // Start callback server
        const codePromise = this.startCallbackServer(callbackUrl, expectedState)
        
        // Open browser
        console.log(`[OIDC] Callback server listening on ${this.config.redirectUri}`)
        console.log('[OIDC] Opening browser for authentication...')
        open(authUrl).catch(err => {
            console.error('[OIDC] Failed to open browser:', err)
            console.log(`[OIDC] Please manually open: ${authUrl}`)
        })
        
        // Wait for callback
        return codePromise
    }

    /**
     * Start callback server (without opening browser)
     */
    private async startCallbackServer(
        callbackUrl: URL,
        expectedState: string
    ): Promise<{ code: string }> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.stopCallbackServer()
                reject(new Error('OIDC callback timed out after 2 minutes'))
            }, 120000) // 2 minutes

            this.callbackServer = createServer((req: IncomingMessage, res: ServerResponse) => {
                if (req.url?.startsWith(callbackUrl.pathname)) {
                    const url = new URL(req.url, `http://${req.headers.host}`)
                    const code = url.searchParams.get('code')
                    const state = url.searchParams.get('state')
                    const error = url.searchParams.get('error')
                    const errorDesc = url.searchParams.get('error_description')

                    // Check for errors
                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html' })
                        res.end(this.getErrorPage(error, errorDesc || 'No description provided'))
                        clearTimeout(timeout)
                        this.stopCallbackServer()
                        reject(new Error(`OIDC error: ${error} - ${errorDesc}`))
                        return
                    }

                    // Validate state
                    if (!state || state !== expectedState) {
                        res.writeHead(400, { 'Content-Type': 'text/html' })
                        res.end(this.getErrorPage('invalid_state', 'State parameter mismatch'))
                        clearTimeout(timeout)
                        this.stopCallbackServer()
                        reject(new Error('State parameter mismatch'))
                        return
                    }

                    // Validate code
                    if (!code) {
                        res.writeHead(400, { 'Content-Type': 'text/html' })
                        res.end(this.getErrorPage('missing_code', 'Authorization code not provided'))
                        clearTimeout(timeout)
                        this.stopCallbackServer()
                        reject(new Error('Missing authorization code'))
                        return
                    }

                    // Success - send response and resolve
                    res.writeHead(200, { 'Content-Type': 'text/html' })
                    res.end(this.getSuccessPage())
                    clearTimeout(timeout)
                    this.stopCallbackServer()
                    resolve({ code })
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' })
                    res.end('Not Found')
                }
            })

            this.callbackServer.listen(parseInt(callbackUrl.port || '8250'), callbackUrl.hostname, () => {
                console.log(`[OIDC] Callback server listening on ${this.config.redirectUri}`)
            })

            this.callbackServer.on('error', (err) => {
                clearTimeout(timeout)
                this.stopCallbackServer()
                reject(new Error(`Callback server error: ${err.message}`))
            })
        })
    }

    /**
     * Exchange authorization code for Vault token
     */
    private async exchangeCodeForToken(
        code: string,
        state: string,
        nonce: string
    ): Promise<{ token: string, ttl: number }> {
        const mount = this.normalizeMount(this.config.oidcMount)
        const url = `${this.config.vaultAddr}/v1/auth/${mount}/oidc/callback`

        const params = new URLSearchParams({
            code,
            state,
            nonce
        })

        const response = await this.httpClient.get<VaultLoginResponse>(`${url}?${params}`)

        const token = response.data.auth.client_token
        const ttl = response.data.auth.lease_duration

        if (!token) {
            throw new Error('No client_token in Vault login response')
        }

        return { token, ttl }
    }

    /**
     * Stop the callback server if running
     */
    private stopCallbackServer(): void {
        if (this.callbackServer) {
            this.callbackServer.close()
            this.callbackServer = null
        }
    }

    /**
     * Normalize mount path (remove auth/ prefix and trailing slash)
     */
    private normalizeMount(mount: string): string {
        return mount.replace(/^auth\//, '').replace(/\/$/, '')
    }

    /**
     * HTML page for successful authentication
     */
    private getSuccessPage(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Successful</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 60px 40px;
      text-align: center;
      max-width: 500px;
      animation: slideIn 0.5s ease-out;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .checkmark {
      width: 80px;
      height: 80px;
      margin: 0 auto 30px;
      background: #4CAF50;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: scaleIn 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55) 0.2s backwards;
    }
    @keyframes scaleIn {
      from { transform: scale(0); }
      to { transform: scale(1); }
    }
    .checkmark svg {
      width: 50px;
      height: 50px;
      stroke: white;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 15px;
      font-weight: 600;
    }
    p {
      color: #666;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 30px;
    }
    .info {
      background: #f5f5f5;
      border-left: 4px solid #667eea;
      padding: 15px;
      text-align: left;
      border-radius: 4px;
      font-size: 14px;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <svg viewBox="0 0 24 24">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h1>Login Successful</h1>
    <p>Your identity has been verified and authenticated with Vault.</p>
    <div class="info">
      <strong>Next step:</strong> You can safely close this window and return to Hashi Lens.
    </div>
  </div>
</body>
</html>`
    }

    /**
     * HTML page for authentication errors
     */
    private getErrorPage(error: string, description: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Failed</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 60px 40px;
      text-align: center;
      max-width: 500px;
    }
    .error-icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 30px;
      background: #f44336;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .error-icon svg {
      width: 50px;
      height: 50px;
      stroke: white;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
    }
    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 15px;
      font-weight: 600;
    }
    p {
      color: #666;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 20px;
    }
    .error-details {
      background: #ffebee;
      border-left: 4px solid #f44336;
      padding: 15px;
      text-align: left;
      border-radius: 4px;
      font-size: 14px;
      color: #c62828;
      margin-bottom: 20px;
    }
    .error-code {
      font-family: monospace;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">
      <svg viewBox="0 0 24 24">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </div>
    <h1>Authentication Failed</h1>
    <p>Unable to complete the authentication process.</p>
    <div class="error-details">
      <div><span class="error-code">${error}</span></div>
      <div style="margin-top: 8px;">${description}</div>
    </div>
    <p style="font-size: 14px; color: #999;">Please close this window and try again.</p>
  </div>
</body>
</html>`
    }
}
