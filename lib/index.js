/**
 * Quota meter for DeepSeek Harness — host half.
 *
 * One self-contained plugin that answers "how much is left, and when does it
 * reset" for the three providers whose quota is not visible anywhere else in the
 * app:
 *
 *   * **OpenAI Codex** — the ChatGPT-plan windows behind every Codex model. The
 *     harness talks to `https://chatgpt.com/backend-api` with the same OAuth
 *     grant, but only ever learns a quota *failure* from the response; it never
 *     asks how much is left. The answer lives behind the Codex backend's own
 *     usage endpoint, which this plugin calls with the access token the
 *     credentials service already holds.
 *   * **OpenRouter** — the prepaid credit balance behind every OpenRouter
 *     model, which no harness surface reports either.
 *   * **DeepSeek** — the Platform wallet balance, read through the harness's own
 *     account service so the plugin never touches the grant itself.
 *
 * It shares no code with the harness: it owns its transport (exact Fetch routes
 * on the shared `/api` channel), its cache, its token refresh and its state
 * file. An incompatible harness leaves the plugin inert rather than breaking
 * the boot — every service it needs is resolved defensively.
 *
 * @module dsh-usage-meter
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin id; the patch row mounts this host half under the same id. */
export const name = 'usage-meter'
/** The Connection carrier is the only service this plugin requires. */
export const inject = ['connection']
/** Plugin version, recorded with the activation breadcrumb. */
const VERSION = '0.6.1'

/** Endpoint prefix the browser sends; the host owns one exact route per endpoint. */
const ROUTE = 'usage-meter'
/** Absolute path prefix of the Fetch routes this plugin owns under `/api`. */
const ROUTE_BASE = `/api/${ROUTE}`
/** Endpoints served under {@link ROUTE_BASE}; the path suffix doubles as the endpoint name. */
const ENDPOINTS = ['usage', 'refresh', 'preferences']

/** The Codex backend's usage endpoint. Same origin the Codex provider itself uses. */
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
/** Codex OAuth token endpoint, used only when the stored access token died. */
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Codex public OAuth client id. Published in the harness's own Codex adapter. */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** The credential record that owns the Codex grant, as its key spells it. */
const CODEX_CREDENTIAL_KEY = 'llm-pi-ai/openai-codex'
/** Anything ending in this segment is accepted as the Codex grant. */
const CODEX_CREDENTIAL_SUFFIX = '/openai-codex'

/** OpenRouter's prepaid balance endpoint. */
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits'
/** The credential reference the Models settings page writes the OpenRouter key to. */
const OPENROUTER_CREDENTIAL_REF = 'OPENROUTER_API_KEY'

/** Google Antigravity models endpoint returning live model quotas. */
const GOOGLE_MODELS_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
/** Google OAuth token endpoint used when access token requires refresh. */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** Google Antigravity User-Agent. */
const GOOGLE_USER_AGENT = 'antigravity/1.1.24 darwin/arm64'

/**
 * The client identity every DeepSeek Platform call carries.
 *
 * Platform reads these three as request headers — `x-client-version`,
 * `x-client-locale` and `x-client-timezone-offset` — so a Host-side caller owes
 * them the same fields a browser would send: its own version, the *requesting
 * UI's* active language, and the offset in whole seconds east of UTC.
 */
const DEEPSEEK_CLIENT_VERSION = `dsh-usage-meter@${VERSION}`

/** Committed defaults; every one of them is overridable from the row config. */
const DEFAULTS = {
  /** A snapshot younger than this is served without touching the network. */
  cacheMs: 60_000,
  /** One provider call may take at most this long before it is a failure. */
  requestTimeoutMs: 20_000,
  /** A grant expiring within this is refreshed before the first call. */
  refreshSkewMs: 60_000,
  /** A wallet balance changes slowly, so it is re-read far less often than a rate-limit window. */
  deepseekCacheMs: 300_000,
  /** Codex usage is also mirrored to disk so an offline start still shows numbers. */
  persistLastGood: true,
  /** Which providers the meter shows, until the Plugins page says otherwise. */
  visible: { codex: true, openrouter: true, deepseek: true, gemini: true },
}

/** The providers the meter can show, in row order. */
const PROVIDERS = ['codex', 'openrouter', 'deepseek', 'gemini']

/** A failure the browser is allowed to see, with a stable code. */
class UsageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UsageError'
    this.code = code
  }
}

/** @returns the harness home, honouring `DSH_HOME` like every other plugin. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

/** @returns the state file path holding the last good snapshot and the breadcrumbs. */
function statePath() {
  return join(dshHome(), 'usage-meter.json')
}

/**
 * Read the persisted state. A missing, unreadable or malformed file is a normal
 * state, never a failure: the caller then simply has no snapshot to fall back on.
 * @returns the stored object, or undefined.
 */
function readState() {
  try {
    const path = statePath()
    if (!existsSync(path)) return void 0
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : void 0
  } catch {
    return void 0
  }
}

/**
 * Merge a patch into the persisted state.
 * @param patch - fields to write.
 * @returns the merged state after the write attempt.
 */
function writeState(patch) {
  const next = { ...(readState() ?? {}), ...patch }
  try {
    const path = statePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw new UsageError('state-unwritable', `Could not save the usage meter state: ${messageOf(error)}`)
  }
  return next
}

/** @param error - anything thrown. @returns a printable message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param value - candidate. @returns whether it is a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param value - candidate. @returns a trimmed string, or undefined. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : void 0
}

/** @param value - candidate. @returns a finite number, or undefined. */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Resolve the effective configuration: committed defaults, then the row config.
 * @param config - raw row configuration, possibly undefined.
 * @returns the effective configuration.
 */
function settingsOf(config) {
  const row = isRecord(config) ? config : {}
  const pick = (key) => number(row[key]) ?? DEFAULTS[key]
  return {
    cacheMs: pick('cacheMs'),
    requestTimeoutMs: pick('requestTimeoutMs'),
    refreshSkewMs: pick('refreshSkewMs'),
    deepseekCacheMs: pick('deepseekCacheMs'),
    persistLastGood: row.persistLastGood !== false,
    visible: visibilityOf(row.visible),
  }
}

/**
 * Resolve the visibility defaults: all three on unless the row config names
 * otherwise. A malformed entry falls back to on rather than silently hiding a
 * provider nobody asked to hide.
 * @param configured - the row's `visible` record, possibly undefined.
 * @returns the default visibility.
 */
function visibilityOf(configured) {
  const visible = { ...DEFAULTS.visible }
  if (!isRecord(configured)) return visible
  for (const provider of PROVIDERS) {
    if (typeof configured[provider] === 'boolean') visible[provider] = configured[provider]
  }
  return visible
}

/**
 * The visibility in force: what the Plugins page last chose, else the row
 * defaults. An off provider is not merely hidden — it is never read.
 * @param settings - effective configuration.
 * @returns the effective visibility.
 */
function visibleOf(settings) {
  const stored = readState()?.preferences
  return isRecord(stored) ? visibilityOf(stored) : { ...settings.visible }
}

/**
 * Read one credential behind a reference. A rotated key reaches the next fetch
 * without a restart, and a missing store falls back to the process environment.
 * @param ctx - plugin context, which may compose no credentials service.
 * @param ref - POSIX shell identifier naming the secret.
 * @returns the stored value, or undefined.
 */
async function readRef(ctx, ref) {
  let stored
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : void 0
    stored = credentials !== void 0 ? await credentials.resolve(ref) : void 0
  } catch {
    stored = void 0
  }
  return text(stored?.value) ?? text(process.env[ref])
}

/**
 * Find the Codex OAuth record in the credentials store.
 *
 * The key is branded by the credentials package, but the store itself is a plain
 * string map, and the owner prefix has changed across harness releases. The
 * exact key is tried first; then the store is enumerated for any record whose
 * key ends in the Codex segment, so a renamed owner still resolves.
 * @param ctx - plugin context.
 * @returns `{ key, record }`, or undefined when no Codex grant is stored.
 */
async function findCodexRecord(ctx) {
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : void 0
  if (credentials === void 0) return void 0
  let exact
  try {
    exact = await credentials.readRecord(CODEX_CREDENTIAL_KEY)
  } catch {
    exact = void 0
  }
  if (exact !== void 0) return { key: CODEX_CREDENTIAL_KEY, record: exact }
  let entries
  try {
    entries = await credentials.listRecords()
  } catch {
    return void 0
  }
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = text(entry?.key)
    if (key === void 0 || !key.endsWith(CODEX_CREDENTIAL_SUFFIX)) continue
    const record = await credentials.readRecord(key)
    if (record !== void 0) return { key, record }
  }
  return void 0
}

/**
 * Pull one field out of an OAuth payload, tolerating every spelling a past
 * harness release may have written.
 * @param payload - the record payload.
 * @param names - accepted field names, in order.
 * @returns the first string value found, or undefined.
 */
function oauthField(payload, names) {
  for (const name of names) {
    const value = text(payload?.[name])
    if (value !== void 0) return value
  }
  return void 0
}

/**
 * Read a stored expiry into epoch milliseconds.
 * @param payload - the record payload.
 * @returns expiry in ms, or undefined when absent or unparsable.
 */
function oauthExpiry(payload) {
  const raw = payload?.expires ?? payload?.expiresAt ?? payload?.expires_at
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e11 ? raw : raw * 1000
  }
  const parsed = Date.parse(String(raw ?? ''))
  return Number.isNaN(parsed) ? void 0 : parsed
}

/**
 * The live Codex grant, read from the credentials store.
 * @param ctx - plugin context.
 * @returns `{ key, record, access, refresh, accountId, expiresAt }`, or undefined.
 */
async function codexGrant(ctx) {
  const found = await findCodexRecord(ctx)
  if (found === void 0) return void 0
  const payload = isRecord(found.record?.payload) ? found.record.payload : {}
  const access = oauthField(payload, ['access', 'accessToken', 'access_token'])
  const refresh = oauthField(payload, ['refresh', 'refreshToken', 'refresh_token'])
  const accountId = oauthField(payload, ['accountId', 'account_id'])
  if (access === void 0 && refresh === void 0) return void 0
  return { key: found.key, record: found.record, access, refresh, accountId, expiresAt: oauthExpiry(payload) }
}

/**
 * Exchange the stored refresh token for a fresh access token and write the
 * result back into the same record, so the harness provider sees it too.
 *
 * The harness refreshes the grant on its own whenever it makes a Codex request;
 * this path exists only for the case where the grant went quiet long enough for
 * the access token to die before the meter ever asked.
 * @param ctx - plugin context.
 * @param grant - the current grant, carrying `key` and `refresh`.
 * @param settings - effective configuration.
 * @returns the updated grant.
 */
async function refreshCodexGrant(ctx, grant, settings) {
  if (grant.refresh === void 0) {
    throw new UsageError('codex-reauth', 'The Codex grant has expired and carries no refresh token — sign in to OpenAI Codex again')
  }
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : void 0
  let response
  try {
    response = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: grant.refresh,
        client_id: CODEX_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
    })
  } catch (error) {
    throw new UsageError('codex-network', `Could not refresh the Codex token: ${messageOf(error)}`)
  }
  const raw = await response.text()
  if (!response.ok) {
    const reported = text(tryParse(raw)?.error_description) ?? text(tryParse(raw)?.error)
    throw new UsageError(
      'codex-reauth',
      `Refreshing the Codex token failed (HTTP ${response.status})${reported === void 0 ? '' : `: ${reported}`} — sign in to OpenAI Codex again`,
    )
  }
  const payload = tryParse(raw)
  const access = text(payload?.access_token)
  if (access === void 0) {
    throw new UsageError('codex-reauth', `The Codex token endpoint returned no access token: ${raw.slice(0, 200)}`)
  }
  const refresh = text(payload?.refresh_token) ?? grant.refresh
  const expiresIn = number(payload?.expires_in)
  const expiresAt = expiresIn === void 0 ? void 0 : Date.now() + expiresIn * 1000
  if (credentials !== void 0) {
    try {
      await credentials.modifyRecord(grant.key, async (current) => {
        if (current === void 0) return void 0
        const payload = isRecord(current.payload) ? current.payload : {}
        return {
          ...current,
          payload: {
            ...payload,
            access,
            refresh,
            ...(expiresAt === void 0 ? {} : { expires: expiresAt }),
          },
        }
      })
    } catch (error) {
      // The refreshed token still works for this and every later call; a store
      // that refused the write must not fail the fetch it enabled.
      console.warn('[usage-meter] could not persist the refreshed Codex token', error)
    }
  }
  return { ...grant, access, refresh, expiresAt }
}

/**
 * @param raw - response text.
 * @returns the parsed body, or undefined when it is not JSON.
 */
function tryParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return void 0
  }
}

/**
 * Normalize one rate-limit window.
 * @param key - `primary` (the rolling short window) or `secondary`.
 * @param window - the window object reported by the backend.
 * @returns the window the browser renders, or undefined when the window is absent.
 */
function normalizeWindow(key, window) {
  if (!isRecord(window)) return void 0
  const usedPercent = number(window.used_percent) ?? number(window.usedPercent)
  if (usedPercent === void 0) return void 0
  const resetAt = number(window.reset_at) ?? number(window.resetAt)
  const resetAfter = number(window.reset_after_seconds) ?? number(window.resetAfterSeconds)
  return {
    key,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowSeconds: number(window.limit_window_seconds) ?? number(window.limitWindowSeconds) ?? 0,
    resetAt: resetAt === void 0 ? void 0 : resetAt * 1000,
    resetAfterSeconds: resetAfter ?? (resetAt === void 0 ? void 0 : Math.max(0, Math.round(resetAt - Date.now() / 1000))),
  }
}

/**
 * Fetch and normalize the Codex plan quota.
 * @param ctx - plugin context.
 * @param settings - effective configuration.
 * @param signal - caller cancellation.
 * @returns the Codex view, or undefined when no Codex grant is stored.
 */
async function fetchCodex(ctx, settings, signal) {
  let grant = await codexGrant(ctx)
  if (grant === void 0) return void 0
  if (grant.access === void 0 || (grant.expiresAt !== void 0 && grant.expiresAt - Date.now() < settings.refreshSkewMs)) {
    grant = await refreshCodexGrant(ctx, grant, settings)
  }

  const call = async () => {
    const headers = { accept: 'application/json' }
    headers.authorization = `Bearer ${grant.access}`
    if (grant.accountId !== void 0) headers['chatgpt-account-id'] = grant.accountId
    const deadline = AbortSignal.timeout(settings.requestTimeoutMs)
    return fetch(CODEX_USAGE_URL, {
      headers,
      signal: signal === void 0 || signal === null ? deadline : AbortSignal.any([signal, deadline]),
    })
  }

  let response = await call()
  if (response.status === 401 || response.status === 403) {
    // The stored access token died without its expiry being recorded. One
    // refresh-and-retry is worth it; a second refusal means a real re-login.
    if (grant.refresh !== void 0) {
      grant = await refreshCodexGrant(ctx, grant, settings)
      response = await call()
    }
  }
  const raw = await response.text()
  if (!response.ok) {
    const reported = text(tryParse(raw)?.detail) ?? text(tryParse(raw)?.message)
    throw new UsageError(
      response.status === 401 || response.status === 403 ? 'codex-reauth' : 'codex-failed',
      `Codex usage failed (HTTP ${response.status})${reported === void 0 ? '' : `: ${reported}`}`,
    )
  }
  const payload = tryParse(raw)
  if (!isRecord(payload)) {
    throw new UsageError('codex-failed', `Codex usage returned a non-JSON body: ${raw.slice(0, 200)}`)
  }

  const limit = isRecord(payload.rate_limit) ? payload.rate_limit : {}
  const windows = [normalizeWindow('primary', limit.primary_window), normalizeWindow('secondary', limit.secondary_window)]
    .filter((window) => window !== void 0)
  if (windows.length === 0) {
    throw new UsageError('codex-failed', 'Codex usage returned no rate-limit windows')
  }
  const credits = isRecord(payload.credits) ? payload.credits : {}
  const balance = number(Number.parseFloat(String(credits.balance ?? '')))
  const unreachable = []
  if (isRecord(payload.model_usage)) {
    for (const [model, state] of Object.entries(payload.model_usage)) {
      if (isRecord(state) && state.available === false) unreachable.push(model)
    }
  }
  return {
    plan: text(payload.plan_type) ?? 'unknown',
    limitReached: limit.limit_reached === true || limit.allowed === false,
    windows,
    resetsAvailable: number(payload.rate_limit_reset_credits?.available_count) ?? 0,
    credits: {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: balance === void 0 || Number.isNaN(balance) ? void 0 : balance,
    },
    unreachableModels: unreachable,
  }
}

/**
 * Fetch and normalize the OpenRouter prepaid balance.
 * @param ctx - plugin context.
 * @param settings - effective configuration.
 * @param signal - caller cancellation.
 * @returns the OpenRouter view, or undefined when no key is stored.
 */
async function fetchOpenRouter(ctx, settings, signal) {
  const key = await readRef(ctx, OPENROUTER_CREDENTIAL_REF)
  if (key === void 0) return void 0
  const deadline = AbortSignal.timeout(settings.requestTimeoutMs)
  let response
  try {
    response = await fetch(OPENROUTER_CREDITS_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: signal === void 0 || signal === null ? deadline : AbortSignal.any([signal, deadline]),
    })
  } catch (error) {
    throw new UsageError('openrouter-network', `Could not reach OpenRouter: ${messageOf(error)}`)
  }
  const raw = await response.text()
  if (!response.ok) {
    throw new UsageError('openrouter-failed', `OpenRouter credits failed (HTTP ${response.status})`)
  }
  const payload = tryParse(raw)
  const totalCredits = number(payload?.data?.total_credits)
  const totalUsage = number(payload?.data?.total_usage)
  if (totalCredits === void 0 || totalUsage === void 0) {
    throw new UsageError('openrouter-failed', `OpenRouter credits returned an unexpected body: ${raw.slice(0, 200)}`)
  }
  return { totalCredits, totalUsage, remaining: Math.max(0, totalCredits - totalUsage) }
}

/**
 * Normalize one Platform wallet list into `{ currency, balance }` numbers.
 * @param wallets - the array as the account service reports it.
 * @returns the parsed wallets.
 */
function normalizeWallets(wallets) {
  const rows = []
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    const currency = text(wallet?.currency)
    const amount = number(Number.parseFloat(String(wallet?.balance ?? '')))
    if (currency === void 0 || amount === void 0 || Number.isNaN(amount)) continue
    rows.push({ currency, balance: amount })
  }
  return rows
}

/**
 * Read the DeepSeek wallet balance through the harness's own account service.
 *
 * Going through the service rather than the Platform API by hand is deliberate:
 * it already owns the sign-in state and the credential refresh, so this plugin
 * neither needs the grant nor can outlive it. Every way this can be unavailable
 * — no account service composed, nobody signed in, a failed read — is an
 * ordinary "no balance to show", never a crash.
 * @param ctx - plugin context.
 * @param identity - the requesting UI's locale and UTC offset, as the browser reports them.
 * @returns the DeepSeek view, or undefined when there is nothing to show.
 */
async function fetchDeepSeek(ctx, identity) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : void 0
  if (account === void 0 || typeof account.getBalance !== 'function') return void 0
  const metadata = {
    version: DEEPSEEK_CLIENT_VERSION,
    locale: text(identity?.locale) ?? 'en',
    timezoneOffsetSeconds:
      number(identity?.timezoneOffsetSeconds) ?? -Math.round(new Date().getTimezoneOffset() * 60),
  }
  const result = await account.getBalance(metadata)
  if (!isRecord(result) || result.status !== 'ready') return void 0
  const wallets = normalizeWallets(result.value)
  const bonusWallets = normalizeWallets(result.bonusWallets)
  if (wallets.length === 0 && bonusWallets.length === 0) return void 0
  return { wallets, bonusWallets }
}

/**
 * Locate the Antigravity OAuth credentials file on disk.
 * @returns the absolute file path, or undefined when absent.
 */
function findAntigravityAuthFile() {
  const authDir = join(dshHome(), 'antigravity-proxy', 'auth')
  if (!existsSync(authDir)) return void 0
  try {
    const files = readdirSync(authDir).filter((file) => file.endsWith('.json'))
    if (files.length === 0) return void 0
    return join(authDir, files[0])
  } catch {
    return void 0
  }
}

/**
 * Refresh an expired Antigravity OAuth access token via Google token endpoint.
 * @param filePath - path to the auth file to update.
 * @param authData - current auth record.
 * @param settings - effective settings with timeout limits.
 * @returns updated auth record.
 */
async function refreshAntigravityToken(filePath, authData, settings) {
  const refreshToken = text(authData.refresh_token)
  if (refreshToken === void 0) {
    throw new UsageError('gemini-reauth', 'Antigravity OAuth carries no refresh token')
  }
  const clientId =
    text(process.env.ANTIGRAVITY_CLIENT_ID) ??
    text(process.env.GOOGLE_CLIENT_ID) ??
    text(authData.client_id)
  const clientSecret =
    text(process.env.ANTIGRAVITY_CLIENT_SECRET) ??
    text(process.env.GOOGLE_CLIENT_SECRET) ??
    text(authData.client_secret)
  if (!clientId || !clientSecret) {
    throw new UsageError(
      'gemini-reauth',
      'Antigravity OAuth refresh requires ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET environment variables or auth credentials',
    )
  }
  let response
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
    })
  } catch (error) {
    throw new UsageError('gemini-network', `Could not refresh Google token: ${messageOf(error)}`)
  }
  const raw = await response.text()
  if (!response.ok) {
    throw new UsageError('gemini-reauth', `Google token refresh failed (HTTP ${response.status})`)
  }
  const payload = tryParse(raw)
  const access = text(payload?.access_token)
  if (access === void 0) {
    throw new UsageError('gemini-reauth', 'Google token endpoint returned no access token')
  }
  const expiresIn = number(payload?.expires_in) ?? 3600
  authData.access_token = access
  authData.expires_in = expiresIn
  authData.timestamp = Date.now()
  authData.expired = new Date(Date.now() + expiresIn * 1000).toISOString()
  if (text(payload?.refresh_token)) {
    authData.refresh_token = payload.refresh_token
  }
  try {
    writeFileSync(filePath, JSON.stringify(authData, null, 2), { mode: 0o600 })
  } catch (error) {
    console.warn('[usage-meter] could not persist refreshed Antigravity token', error)
  }
  return authData
}

/**
 * Fetch and normalize Google Gemini / Antigravity model quotas.
 * @param ctx - plugin context.
 * @param settings - effective configuration.
 * @param signal - caller cancellation.
 * @returns the Gemini view with gemini and claude windows, or undefined when not configured.
 */
async function fetchGemini(ctx, settings, signal) {
  const authFile = findAntigravityAuthFile()
  if (authFile === void 0) return void 0
  let authData
  try {
    authData = JSON.parse(readFileSync(authFile, 'utf8'))
  } catch {
    return void 0
  }
  if (!isRecord(authData)) return void 0

  const expiry =
    authData.timestamp && authData.expires_in
      ? Number(authData.timestamp) + Number(authData.expires_in) * 1000
      : void 0
  if (!authData.access_token || (expiry !== void 0 && expiry - Date.now() < settings.refreshSkewMs)) {
    authData = await refreshAntigravityToken(authFile, authData, settings)
  }

  const call = async (token) => {
    const deadline = AbortSignal.timeout(settings.requestTimeoutMs)
    return fetch(GOOGLE_MODELS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': GOOGLE_USER_AGENT,
      },
      body: JSON.stringify({ project: text(authData.project_id) ?? '' }),
      signal: signal === void 0 || signal === null ? deadline : AbortSignal.any([signal, deadline]),
    })
  }

  let response
  try {
    response = await call(authData.access_token)
  } catch (error) {
    throw new UsageError('gemini-network', `Could not reach Google models endpoint: ${messageOf(error)}`)
  }

  if (response.status === 401 || response.status === 403) {
    if (authData.refresh_token) {
      authData = await refreshAntigravityToken(authFile, authData, settings)
      try {
        response = await call(authData.access_token)
      } catch (error) {
        throw new UsageError('gemini-network', `Could not reach Google models endpoint: ${messageOf(error)}`)
      }
    }
  }

  if (!response.ok) {
    throw new UsageError('gemini-failed', `Google models endpoint failed (HTTP ${response.status})`)
  }

  const raw = await response.text()
  const payload = tryParse(raw)
  if (!isRecord(payload) || !isRecord(payload.models)) {
    throw new UsageError('gemini-failed', 'Google models endpoint returned invalid payload')
  }

  const models = payload.models
  let geminiQuota = null
  let claudeQuota = null

  for (const [id, m] of Object.entries(models)) {
    if (m?.quotaInfo !== undefined && m?.quotaInfo !== null) {
      if (id.startsWith('gemini-') && !geminiQuota) {
        geminiQuota = m.quotaInfo
      } else if ((id.startsWith('claude-') || id.startsWith('gpt-')) && !claudeQuota) {
        claudeQuota = m.quotaInfo
      }
    }
  }

  if (!geminiQuota && !claudeQuota) {
    throw new UsageError('gemini-failed', 'No quota information found in Google models response')
  }

  const normalizeQuota = (key, quota) => {
    if (!quota) return null
    const frac = number(quota.remainingFraction) ?? 0
    const resetTimeStr = text(quota.resetTime)
    const resetAt = resetTimeStr ? Date.parse(resetTimeStr) : void 0
    const resetAfterSeconds = resetAt ? Math.max(0, Math.round((resetAt - Date.now()) / 1000)) : void 0
    const remainingPercent = Math.min(100, Math.max(0, Math.round(frac * 100)))
    return {
      key,
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      limitReached: remainingPercent === 0,
      windowSeconds: 86400,
      resetAt: Number.isNaN(resetAt) ? void 0 : resetAt,
      resetAfterSeconds,
    }
  }

  return {
    gemini: normalizeQuota('gemini', geminiQuota),
    claude: normalizeQuota('claude', claudeQuota),
  }
}

/**
 * Read every provider once.
 *
 * The providers are independent by construction — one plan, one key, one signed-in
 * account — so one failure never hides the others' numbers: each is reported with
 * its own error and the browser renders what did arrive.
 * @param ctx - plugin context.
 * @param settings - effective configuration.
 * @param previous - the last snapshot, whose DeepSeek balance may still be fresh.
 * @param identity - the requesting UI's locale and UTC offset.
 * @param signal - caller cancellation.
 * @returns the snapshot.
 */
async function fetchAll(ctx, settings, previous, identity, signal, visible) {
  // A provider the user switched off is not read at all: no request, no
  // credential, no entry in `errors` — the row simply has nothing to draw.
  const wanted = (provider) => visible[provider] === true
  // A wallet balance moves on the scale of a purchase, not of a minute, so a
  // still-fresh reading is carried over instead of re-fetched.
  const deepseekFresh =
    previous?.deepseek !== void 0 &&
    previous?.deepseek !== null &&
    number(previous?.deepseekFetchedAt) !== void 0 &&
    Date.now() - previous.deepseekFetchedAt < settings.deepseekCacheMs
  const deepseekRead =
    !wanted('deepseek')
      ? Promise.resolve({ value: void 0 })
      : deepseekFresh
        ? Promise.resolve({ value: previous.deepseek })
        : fetchDeepSeek(ctx, identity).then(
            (value) => ({ value }),
            (error) => ({ error }),
          )
  const [codex, openrouter, deepseek, gemini] = await Promise.all([
    wanted('codex')
      ? fetchCodex(ctx, settings, signal).then((value) => ({ value }), (error) => ({ error }))
      : Promise.resolve({ value: void 0 }),
    wanted('openrouter')
      ? fetchOpenRouter(ctx, settings, signal).then((value) => ({ value }), (error) => ({ error }))
      : Promise.resolve({ value: void 0 }),
    deepseekRead,
    wanted('gemini')
      ? fetchGemini(ctx, settings, signal).then((value) => ({ value }), (error) => ({ error }))
      : Promise.resolve({ value: void 0 }),
  ])
  /** @param result - one settled provider call. @returns the error the browser renders. */
  const failureOf = (result) =>
    result.error === void 0
      ? null
      : { code: text(result.error.code) ?? 'internal', message: messageOf(result.error) }
  return {
    codex: codex.value ?? null,
    openrouter: openrouter.value ?? null,
    deepseek: deepseek.value ?? null,
    gemini: gemini.value ?? null,
    deepseekFetchedAt: deepseekFresh ? previous.deepseekFetchedAt : Date.now(),
    errors: {
      codex: failureOf(codex),
      openrouter: failureOf(openrouter),
      deepseek: failureOf(deepseek),
      gemini: failureOf(gemini),
    },
    visible: { ...visible },
    fetchedAt: Date.now(),
  }
}

/**
 * Build the channel handler: one cache, one in-flight promise, two endpoints.
 * @param ctx - plugin context.
 * @param config - raw row configuration.
 * @returns the plugin channel handler.
 */
function createHandler(ctx, config) {
  let cache
  let inFlight
  return async function handle(endpoint, payload, signal) {
    const settings = settingsOf(config)
    // The browser owns its own identity: Platform reports the *requesting UI*,
    // not the last caller the Host happened to see.
    const identity = { locale: payload?.locale, timezoneOffsetSeconds: payload?.timezoneOffsetSeconds }
    try {
      if (endpoint === 'preferences') {
        const visible = visibilityOf(payload?.visible)
        if (payload?.visible !== undefined) writeState({ preferences: visible })
        // What just changed must be read at once, so the row redraws on the very
        // toggle the user pressed rather than after the next poll.
        cache = void 0
        inFlight = void 0
        return ok({ visible })
      }
      if (endpoint === 'refresh') {
        cache = await fetchAll(ctx, settings, undefined, identity, signal, visibleOf(settings))
        if (settings.persistLastGood) writeState({ snapshot: cache })
        return ok({ snapshot: cache })
      }
      if (endpoint !== 'usage') return fail('unknown-endpoint', `Unknown usage meter endpoint ${JSON.stringify(endpoint)}`)

      const wanted = visibleOf(settings)
      const fresh =
        cache !== void 0 &&
        cache.visible !== void 0 &&
        PROVIDERS.every((provider) => cache.visible[provider] === wanted[provider]) &&
        Date.now() - cache.fetchedAt < settings.cacheMs
      if (fresh && payload?.force !== true) return ok({ snapshot: cache, cached: true })

      if (inFlight === void 0) {
        inFlight = fetchAll(ctx, settings, cache, identity, signal, visibleOf(settings))
          .then((snapshot) => {
            cache = snapshot
            return snapshot
          })
          .finally(() => {
            inFlight = void 0
          })
      }
      const snapshot = await inFlight
      if (settings.persistLastGood) writeState({ snapshot })
      return ok({ snapshot, cached: false })
    } catch (error) {
      if (error instanceof UsageError) return fail(error.code, error.message)
      return fail('internal', messageOf(error))
    }
  }
}

/** @param value - handler value. @returns a Connection success envelope. */
function ok(value) {
  return { ok: true, value }
}

/**
 * @param code - stable machine code.
 * @param message - user-facing message.
 * @returns a Connection failure envelope.
 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Serve one {@link Request} of the browser RPC envelope.
 *
 * The browser carrier posts `{ type: 'client-request', rpcId, method, payload }`
 * and reads `{ type: 'server-response', rpcId, result }`, where `result` is the
 * very envelope this plugin already answers with.
 * @param request - the carrier's buffered POST.
 * @param wire - the endpoint name the browser sends, prefix included.
 * @param endpoint - bare endpoint name this route dispatches on.
 * @param handler - plugin channel handler.
 * @returns the framed response.
 */
async function serveEnvelope(request, wire, endpoint, handler) {
  let body
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  if (!isRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string') {
    return new Response('invalid client-request envelope', { status: 400 })
  }
  if (body.method !== wire) {
    return Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: fail('bad-request', `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(wire)}`),
    })
  }
  let result
  try {
    result = await handler(endpoint, body.payload, request.signal)
  } catch (error) {
    result = fail('internal', messageOf(error))
  }
  return Response.json({ type: 'server-response', rpcId: body.rpcId, result })
}

/**
 * Mount the plugin.
 *
 * The browser is served through **exact Fetch routes under `/api`**: that is the
 * one extension point a third-party plugin can own. A custom RPC *channel*
 * cannot be used in the desktop app — the carrier registers a channel as a
 * physical route through `owner.webServer`, whose owning context does not inject
 * the web server, so `rpc.handle` throws and the browser sees `HTTP 405`. Exact
 * Fetch routes (`connection.fetch.register`) avoid `webServer` entirely and are
 * consulted by the shared `/api` handler before the gateway interceptor.
 * @param ctx - plugin context.
 * @param config - raw row configuration.
 */
export function apply(ctx, config) {
  markStage('applied')
  ctx.inject(['connection'], (inner) => {
    markStage('injected')
    const registry = inner.connection?.fetch
    if (typeof registry?.register !== 'function') {
      markStage('inert', { reason: 'the Connection carrier exposes no Fetch route registry' })
      console.warn('[usage-meter] the harness Connection carrier exposes no Fetch route registry; the plugin stays inert')
      return
    }
    const handler = createHandler(inner, config)
    const disposers = []
    try {
      for (const endpoint of ENDPOINTS) {
        const dispose = registry.register({
          path: `${ROUTE_BASE}/${endpoint}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => serveEnvelope(request, `${ROUTE}/${endpoint}`, endpoint, handler),
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      markStage('registered', { routes: ENDPOINTS.length, base: ROUTE_BASE })
      inner.effect(
        () => () => {
          for (const dispose of disposers) {
            try {
              const released = dispose()
              if (released !== void 0 && typeof released.then === 'function') released.catch(() => void 0)
            } catch (error) {
              console.warn('[usage-meter] could not release a Fetch route', error)
            }
          }
        },
        'usage-meter: Fetch routes',
      )
    } catch (error) {
      markStage('failed', { reason: messageOf(error) })
      console.warn('[usage-meter] could not register the Fetch routes', error)
    }
  })
}

/**
 * Best-effort activation breadcrumb in the plugin's own state file.
 *
 * It is the only externally visible proof of how far the host half got, which
 * matters when a profile change is diagnosed from a terminal. A read-only home
 * must never break activation, so every failure is swallowed.
 * @param stage - short stage name, recorded with its time and optional detail.
 * @param extra - extra fields merged into the state file.
 */
function markStage(stage, extra = {}) {
  try {
    writeState({ hostVersion: VERSION, [stage]: new Date().toISOString(), ...extra })
  } catch (error) {
    console.warn(`[usage-meter] could not record stage ${stage}`, error)
  }
}

// Module-evaluation breadcrumb: with `applied`, `injected` and `registered`
// beside it, the state file shows exactly how far the host half got after a
// profile change, without asking anyone to read a process console.
markStage('imported')