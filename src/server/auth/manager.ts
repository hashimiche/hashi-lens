/**
 * Vault Authentication Manager
 * 
 * Coordinates authentication flow:
 * 1. Check for cached valid token
 * 2. If none, perform OIDC authentication
 * 3. Cache the resulting token
 * 4. Provide token to vault-mcp-server
 */

import dotenv from 'dotenv'
import axios from 'axios'
import https from 'https'
import { OIDCAuthenticator, OIDCConfig } from './oidc.js'
import { TokenCache } from './token-cache.js'

dotenv.config()

export interface AuthConfig {
    // OIDC redirect URI (server callback endpoint)
    oidcRedirectUri: string
}

export interface ClusterConnection {
    vaultAddr: string
    oidcMount?: string
    oidcRole?: string
    skipVerify?: boolean
    token?: string  // If provided, use token auth instead of OIDC
}

export class VaultAuthManager {
    private config: AuthConfig
    private tokenCache: TokenCache
    private currentToken: string | null = null
    private currentCluster: ClusterConnection

    constructor(config: AuthConfig) {
        this.config = config

        // Initialize memory-only token cache
        this.tokenCache = new TokenCache()

        const envVaultAddr = process.env.VAULT_ADDR || ''
        const envVaultToken = process.env.VAULT_TOKEN || undefined
        const envSkipVerify = (process.env.VAULT_SKIP_VERIFY || '').toLowerCase() === 'true'

        // Set initial cluster (must be configured via UI)
        this.currentCluster = {
            vaultAddr: envVaultAddr,
            oidcMount: 'oidc',
            oidcRole: 'default',
            skipVerify: envSkipVerify,
            token: envVaultToken,
        }

        if (envVaultAddr) {
            console.log(`[Auth] Bootstrapped Vault address from environment: ${envVaultAddr}`)
        }
        if (envVaultToken) {
            console.log('[Auth] Bootstrapped Vault token from environment')
            this.currentToken = envVaultToken
        }
    }

    /**
     * Return best-effort token for CLI context without triggering authentication.
     * Order: in-memory token -> explicit token-auth value -> cached token.
     */
    async getTokenForCliContext(): Promise<string | null> {
        if (this.currentToken) {
            return this.currentToken
        }

        if (this.currentCluster.token) {
            return this.currentCluster.token
        }

        if (!this.currentCluster.vaultAddr) {
            return null
        }

        return await this.tokenCache.getToken(this.currentCluster.vaultAddr)
    }

    /**
     * Get current cluster address
     */
    getCurrentCluster(): ClusterConnection {
        return { ...this.currentCluster }
    }

    /**
     * Switch to a different cluster
     * Optionally provide oidcMount, oidcRole, skipVerify, or token for direct token auth
     */
    async switchCluster(vaultAddr: string, oidcMount?: string, oidcRole?: string, skipVerify?: boolean, token?: string): Promise<void> {
        console.log(`[Auth] Switching cluster to ${vaultAddr}`)

        // Check if we have cached token metadata for this cluster
        const metadata = await this.tokenCache.getTokenMetadata(vaultAddr)

        this.currentCluster = {
            vaultAddr,
            oidcMount: oidcMount || metadata?.oidcMount || 'oidc',
            oidcRole: oidcRole || metadata?.oidcRole || 'default',
            skipVerify: skipVerify !== undefined ? skipVerify : (metadata?.skipVerify ?? false),
            token: token  // If token provided, use token auth
        }

        // Clear current token (will need to re-fetch from cache or authenticate)
        this.currentToken = null

        console.log(`[Auth] Switched to cluster ${vaultAddr}`)
    }

    /**
     * Get a valid Vault token for current cluster
     * Returns cached token if valid, otherwise performs authentication
     */
    async getToken(): Promise<string> {
        if (!this.currentCluster.vaultAddr) {
            throw new Error('No Vault cluster configured. Please connect via the UI first.')
        }

        // If we have a current token in memory, return it
        if (this.currentToken) {
            return this.currentToken
        }

        // If a token was provided directly (token auth), use it
        if (this.currentCluster.token) {
            console.log('[Auth] Using provided token for authentication')
            this.currentToken = this.currentCluster.token
            return this.currentToken
        }

        // Try to get cached token for current cluster
        const cachedToken = await this.tokenCache.getToken(this.currentCluster.vaultAddr)
        if (cachedToken) {
            const remaining = await this.tokenCache.getTimeRemaining(this.currentCluster.vaultAddr)
            console.log(`[Auth] Using cached token for ${this.currentCluster.vaultAddr} (${remaining}s remaining)`)
            this.currentToken = cachedToken
            return cachedToken
        }

        // No valid cached token - throw error so frontend can prompt for re-authentication
        console.log(`[Auth] No valid cached token found for ${this.currentCluster.vaultAddr}`)
        throw new Error('Authentication required. Please log in again.')
    }

    /**
     * Perform OIDC authentication and cache the token
     */
    async authenticate(): Promise<string> {
        if (!this.currentCluster.vaultAddr) {
            throw new Error('No Vault cluster configured')
        }

        // If using token auth, just return the token
        if (this.currentCluster.token) {
            console.log('[Auth] Using token-based authentication')
            this.currentToken = this.currentCluster.token
            return this.currentToken
        }

        // Create OIDC authenticator with current cluster settings
        const oidcConfig: OIDCConfig = {
            vaultAddr: this.currentCluster.vaultAddr,
            oidcMount: this.currentCluster.oidcMount || 'oidc',
            oidcRole: this.currentCluster.oidcRole || 'default',
            redirectUri: this.config.oidcRedirectUri,
            skipVerify: this.currentCluster.skipVerify || false
        }
        const oidcAuthenticator = new OIDCAuthenticator(oidcConfig)

        console.log('[Auth] Starting OIDC authentication flow...')
        console.log('[Auth] Your browser will open for authentication')

        const { token, ttl } = await oidcAuthenticator.authenticate()

        // Cache the token with cluster address and OIDC settings
        await this.tokenCache.setToken(
            this.currentCluster.vaultAddr,
            token,
            ttl,
            this.currentCluster.oidcMount,
            this.currentCluster.oidcRole,
            this.currentCluster.skipVerify
        )

        // Store in memory
        this.currentToken = token

        console.log(`[Auth] Authentication successful for ${this.currentCluster.vaultAddr} (token TTL: ${ttl}s)`)

        return token
    }

    // For client-side popup flow: store authenticator instance
    private pendingOIDCAuth: OIDCAuthenticator | null = null

    /**
     * Get OIDC auth URL for client to open in popup
     * Returns the URL without opening browser
     */
    async getOIDCAuthUrl(): Promise<string> {
        if (!this.currentCluster.vaultAddr) {
            throw new Error('No Vault cluster configured')
        }

        // Create OIDC authenticator
        const oidcConfig: OIDCConfig = {
            vaultAddr: this.currentCluster.vaultAddr,
            oidcMount: this.currentCluster.oidcMount || 'oidc',
            oidcRole: this.currentCluster.oidcRole || 'default',
            redirectUri: this.config.oidcRedirectUri,
            skipVerify: this.currentCluster.skipVerify || false
        }
        this.pendingOIDCAuth = new OIDCAuthenticator(oidcConfig)

        // Get auth URL and start callback server (but don't open browser)
        const authUrl = await this.pendingOIDCAuth.startAuthFlow()

        console.log('[Auth] OIDC auth URL generated, waiting for client popup...')

        return authUrl
    }

    /**
     * Complete OIDC authentication after client opened popup
     * Waits for callback and exchanges code for token
     */
    async completeOIDCAuth(): Promise<string> {
        if (!this.pendingOIDCAuth) {
            throw new Error('No pending OIDC authentication. Call getOIDCAuthUrl first.')
        }

        console.log('[Auth] Waiting for OIDC callback...')

        const { token, ttl } = await this.pendingOIDCAuth.waitForCompletion()

        // Cache the token
        await this.tokenCache.setToken(
            this.currentCluster.vaultAddr,
            token,
            ttl,
            this.currentCluster.oidcMount,
            this.currentCluster.oidcRole,
            this.currentCluster.skipVerify
        )

        // Store in memory
        this.currentToken = token
        this.pendingOIDCAuth = null

        console.log(`[Auth] Authentication successful for ${this.currentCluster.vaultAddr} (token TTL: ${ttl}s)`)

        return token
    }

    /**
     * Check if current token should be renewed
     */
    async shouldRenew(): Promise<boolean> {
        // No cluster configured - nothing to renew
        if (!this.currentCluster.vaultAddr) {
            return false
        }

        if (this.currentCluster.token) {
            return false // Token auth doesn't support renewal
        }

        return await this.tokenCache.shouldRenew(this.currentCluster.vaultAddr)
    }

    /**
     * Renew the token if needed
     * NOTE: Does NOT automatically re-authenticate with browser
     * After token expires, frontend must prompt user to log in again
     */
    async renewIfNeeded(): Promise<void> {
        // Don't attempt renewal if no cluster is configured
        if (!this.currentCluster.vaultAddr) {
            return
        }

        if (await this.shouldRenew()) {
            console.log('[Auth] Token renewal needed - clearing token, user must re-authenticate')
            this.currentToken = null
            // Do NOT call authenticate() - let the frontend handle re-authentication
            // This prevents automatic browser popups and server crashes
        }
    }

    /**
     * Revoke the current token in Vault
     */
    async revokeToken(): Promise<void> {
        const token = this.currentToken || await this.tokenCache.getToken(this.currentCluster.vaultAddr)

        if (!token) {
            console.log('[Auth] No token to revoke')
            return
        }

        // Don't revoke if using token auth (tokens managed externally)
        if (this.currentCluster.token) {
            console.log('[Auth] Skipping revocation of externally-managed token')
            return
        }

        try {
            console.log(`[Auth] Revoking token for ${this.currentCluster.vaultAddr}...`)

            const httpsAgent = this.currentCluster.skipVerify
                ? new https.Agent({ rejectUnauthorized: false })
                : undefined

            await axios.post(
                `${this.currentCluster.vaultAddr}/v1/auth/token/revoke-self`,
                {},
                {
                    headers: {
                        'X-Vault-Token': token
                    },
                    httpsAgent
                }
            )

            console.log('[Auth] Token successfully revoked in Vault')
        } catch (error) {
            // Log but don't fail - token might already be expired/invalid
            console.warn('[Auth] Failed to revoke token (may already be invalid):',
                error instanceof Error ? error.message : 'Unknown error'
            )
        }
    }

    /**
     * Clear cached token for current cluster (useful for logout)
     * Revokes the token in Vault before clearing from cache
     */
    async clearToken(): Promise<void> {
        console.log(`[Auth] Logging out from ${this.currentCluster.vaultAddr}...`)

        // First, revoke the token in Vault
        await this.revokeToken()

        // Then clear from memory and cache
        this.currentToken = null
        await this.tokenCache.clearToken(this.currentCluster.vaultAddr)

        console.log('[Auth] Logout complete - token revoked and cleared')
    }

    /**
     * Lookup token details from Vault for current cluster
     */
    async lookupToken(): Promise<{ policies: string[], entity_id: string | null } | null> {
        const token = this.currentToken || await this.tokenCache.getToken(this.currentCluster.vaultAddr)

        if (!token) {
            return null
        }

        try {
            const httpsAgent = this.currentCluster.skipVerify
                ? new https.Agent({ rejectUnauthorized: false })
                : undefined

            const response = await axios.get(
                `${this.currentCluster.vaultAddr}/v1/auth/token/lookup-self`,
                {
                    headers: {
                        'X-Vault-Token': token
                    },
                    httpsAgent
                }
            )

            return {
                policies: response.data.data?.policies || [],
                entity_id: response.data.data?.entity_id || null
            }
        } catch (error) {
            console.warn('[Auth] Failed to lookup token details:',
                error instanceof Error ? error.message : 'Unknown error'
            )
            return null
        }
    }

    /**
     * Get cluster information from Vault for current cluster
     */
    async getClusterInfo(): Promise<{
        vaultAddr: string
        clusterId: string | null
        clusterName: string | null
        sealed: boolean
        initialized: boolean
        standby: boolean
        version: string | null
        replicationPerfMode: string | null
        replicationDrMode: string | null
    } | null> {
        if (!this.currentCluster.vaultAddr) {
            return null
        }

        try {
            const httpsAgent = this.currentCluster.skipVerify
                ? new https.Agent({ rejectUnauthorized: false })
                : undefined

            // Get health status (doesn't require auth)
            const healthResponse = await axios.get(
                `${this.currentCluster.vaultAddr}/v1/sys/health`,
                {
                    httpsAgent,
                    validateStatus: () => true // Accept all status codes
                }
            )

            // Extract cluster info from health response
            const clusterId = healthResponse.data?.cluster_id || null
            const clusterName = healthResponse.data?.cluster_name || null

            return {
                vaultAddr: this.currentCluster.vaultAddr,
                clusterId,
                clusterName,
                sealed: healthResponse.data?.sealed || false,
                initialized: healthResponse.data?.initialized || false,
                standby: healthResponse.data?.standby || false,
                version: healthResponse.data?.version || null,
                replicationPerfMode: healthResponse.data?.replication_performance_mode || null,
                replicationDrMode: healthResponse.data?.replication_dr_mode || null
            }
        } catch (error) {
            console.warn('[Auth] Failed to get cluster info:',
                error instanceof Error ? error.message : 'Unknown error'
            )
            return null
        }
    }

    /**
     * Get token status information for current cluster
     */
    async getStatus(): Promise<{
        authenticated: boolean
        usingOIDC: boolean
        usingToken: boolean
        timeRemaining: number | null
        shouldRenew: boolean
        policies: string[] | null
        entityId: string | null
        cachedClusters: string[]
        cluster: {
            vaultAddr: string
            clusterId: string | null
            clusterName: string | null
            sealed: boolean
            initialized: boolean
            standby: boolean
            version: string | null
            replicationPerfMode: string | null
            replicationDrMode: string | null
        } | null
    }> {
        const usingToken = !!this.currentCluster.token
        const authenticated = this.currentToken !== null ||
            (await this.tokenCache.getToken(this.currentCluster.vaultAddr)) !== null ||
            usingToken

        // Lookup token details if authenticated
        let policies: string[] | null = null
        let entityId: string | null = null
        if (authenticated) {
            const tokenInfo = await this.lookupToken()
            if (tokenInfo) {
                policies = tokenInfo.policies
                entityId = tokenInfo.entity_id
            }
        }

        // Get cluster information
        const cluster = await this.getClusterInfo()

        // Get list of cached clusters
        const cachedClusters = await this.tokenCache.getCachedClusters()

        // Determine auth method being used (usingToken already computed above)
        const usingOIDC = authenticated && !usingToken

        return {
            authenticated,
            usingOIDC,
            usingToken,
            timeRemaining: await this.tokenCache.getTimeRemaining(this.currentCluster.vaultAddr),
            shouldRenew: await this.shouldRenew(),
            policies,
            entityId,
            cachedClusters,
            cluster
        }
    }

    /**
     * Create auth manager from environment variables
     * Note: Vault address and auth method must be configured via UI
     * OIDC mount and role are hard-coded defaults (overridable per-cluster in UI)
     */
    static fromEnv(): VaultAuthManager {
        const config: AuthConfig = {
            oidcRedirectUri: process.env.VAULT_OIDC_REDIRECT_URI || 'http://localhost:8250/oidc/callback'
        }

        return new VaultAuthManager(config)
    }
}
