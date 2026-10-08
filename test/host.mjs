/**
 * Host-half checks: route registration, the channel protocol, the Codex usage
 * normalization, the OpenRouter balance, token refresh, caching and the state
 * file.
 *
 * The module is imported with a temporary DSH_HOME so the state file never
 * touches the real harness home, and `globalThis.fetch` is stubbed so no request
 * leaves the machine.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'usage-meter-'))
process.env.DSH_HOME = home

mkdirSync(join(home, 'antigravity-proxy', 'auth'), { recursive: true })
writeFileSync(
  join(home, 'antigravity-proxy', 'auth', 'antigravity-test.json'),
  JSON.stringify({
    access_token: 'goog-live-token',
    refresh_token: 'goog-refresh-token',
    project_id: 'test-project',
    timestamp: Date.now(),
    expires_in: 3600,
  }),
)

const plugin = await import('../lib/index.js')
const { apply, Config, inject, name } = plugin

assert.equal(name, 'usage-meter', 'the plugin id matches the bundle patch id')
assert.deepEqual(inject, ['connection'], 'only the Connection carrier is required')
assert.equal(Config, void 0, 'the host module ships no lazy schema: it must import without top-level await')

/** One live Codex grant, valid for an hour. */
const LIVE_GRANT = {
  kind: 'oauth',
  payload: {
    type: 'oauth',
    access: 'live-access-token',
    refresh: 'live-refresh-token',
    expires: Date.now() + 3_600_000,
    accountId: 'acct-1',
  },
}

/** The usage body the Codex backend answers with. */
const CODEX_BODY = {
  plan_type: 'plus',
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 1170, reset_at: 1790861660 },
    secondary_window: { used_percent: 66, limit_window_seconds: 604800, reset_after_seconds: 249883, reset_at: 1791110373 },
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  model_usage: { 'gpt-6-astra': { available: false, available_at: '2026-10-01T13:34:21Z' } },
  rate_limit_reset_credits: { available_count: 4 },
}

const GOOGLE_MODELS_BODY = {
  models: {
    'gemini-3.1-pro-high': {
      displayName: 'Gemini 3.1 Pro (High)',
      quotaInfo: {
        remainingFraction: 0.85,
        resetTime: '2026-10-08T18:37:35Z',
      },
    },
    'claude-sonnet-5-5-high': {
      displayName: 'Claude Sonnet 5.5 (High)',
      quotaInfo: {
        remainingFraction: 0.95,
        resetTime: '2026-10-08T20:31:33Z',
      },
    },
  },
}

/**
 * A stubbed global fetch that records every call and answers the provider
 * endpoints plus token endpoints.
 * @param options - `codexStatus`, `openrouterStatus`, `geminiStatus`.
 * @returns the recorded calls and a restore function.
 */
function stubFetch({ codexStatus = 200, openrouterStatus = 200, geminiStatus = 200 } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, init })
    if (href.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (href.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'goog-refreshed', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (href.includes('/wham/usage')) {
      if (codexStatus !== 200) return new Response('nope', { status: codexStatus })
      return new Response(JSON.stringify(CODEX_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/api/v1/credits')) {
      if (openrouterStatus !== 200) return new Response('nope', { status: openrouterStatus })
      return new Response(JSON.stringify({ data: { total_credits: 60, total_usage: 51.272380757 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (href.includes('/v1internal:fetchAvailableModels')) {
      if (geminiStatus !== 200) return new Response('nope', { status: geminiStatus })
      return new Response(JSON.stringify(GOOGLE_MODELS_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected request to ${href}`)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A credentials store backed by one record and one plain reference. `record: null` means "no grant stored". */
function credentialsStore({ record = LIVE_GRANT, key = 'llm-pi-ai/openai-codex', openrouterKey = 'sk-or-test' } = {}) {
  const records = new Map()
  if (record != null) records.set(key, record)
  const writes = []
  return {
    writes,
    records,
    async resolve(ref) {
      if (ref !== 'OPENROUTER_API_KEY' || openrouterKey === void 0) return void 0
      return { value: openrouterKey, source: 'file' }
    },
    async readRecord(requested) {
      return records.get(requested)
    },
    async listRecords() {
      return [...records.keys()].map((entry) => ({ key: entry, kind: 'oauth' }))
    },
    async modifyRecord(requested, mutate) {
      const next = await mutate(records.get(requested))
      writes.push({ key: requested, next })
      if (next === void 0) records.delete(requested)
      else records.set(requested, next)
      return next
    },
  }
}

/**
 * The DeepSeek account service, as the harness composes it: a signed-in
 * balance, or the three ways there is nothing to show.
 */
function deepseekAccount(result) {
  const seen = []
  return {
    seen,
    async getBalance(client) {
      seen.push(client)
      if (result instanceof Error) throw result
      return result
    },
  }
}

/** A signed-in Platform balance in both currencies, with a bonus wallet. */
const DEEPSEEK_READY = {
  status: 'ready',
  value: [
    { currency: 'CNY', balance: '18.40' },
    { currency: 'USD', balance: '4.25' },
  ],
  bonusWallets: [{ currency: 'USD', balance: '2.00' }],
}

/**
 * Mount the host half against the harness services it asks for, and expose the
 * registered routes as a plain `handler(endpoint, payload)`.
 */
function mount({ credentials: store, account, rowConfig } = {}) {
  const routes = new Map()
  const disposers = []
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
        }
      },
    },
  }
  const ctx = {
    get: (service) => {
      if (service === 'credentials') return store
      if (service === 'deepseekAccount') return account
      return void 0
    },
    inject(services, callback) {
      assert.deepEqual(services, ['connection'], 'the plugin injects the carrier')
      const inner = {
        get: ctx.get,
        connection,
        effect: (run) => {
          disposers.push(run())
        },
      }
      callback(inner)
      return inner
    },
  }
  apply(ctx, rowConfig)
  assert.equal(routes.size, 3, 'one exact Fetch route per endpoint')
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/api/usage-meter/preferences', '/api/usage-meter/refresh', '/api/usage-meter/usage'],
    'every route sits under the shared /api channel',
  )
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['POST'], 'routes accept POST only')
    assert.equal(route.requestBody, 'buffered', 'routes read one buffered JSON body')
  }
  const handler = async (endpoint, payload, signal) => {
    const route = routes.get(`/api/usage-meter/${endpoint}`)
    if (route === void 0) throw new Error(`no route for ${endpoint}`)
    const request = new Request(`http://127.0.0.1:19387/api/usage-meter/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: `usage-meter/${endpoint}`, payload }),
      signal,
    })
    return (await (await route.fetch(request)).json()).result
  }
  return { routes, disposers, handler }
}

/** The activation breadcrumbs the plugin leaves in the state file. */
function state() {
  return JSON.parse(readFileSync(join(home, 'usage-meter.json'), 'utf8'))
}

// --- every provider, one snapshot ------------------------------------------
{
  const store = credentialsStore()
  const account = deepseekAccount(DEEPSEEK_READY)
  const { handler, disposers } = mount({ credentials: store, account })
  const net = stubFetch()

  const result = await handler('usage', { force: true, locale: 'ru-RU', timezoneOffsetSeconds: 10800 })
  net.restore()

  assert.equal(result.ok, true, `usage answered: ${JSON.stringify(result.error)}`)
  const { snapshot } = result.value
  assert.equal(snapshot.errors.codex, null, 'the Codex call succeeded')
  assert.equal(snapshot.errors.openrouter, null, 'the OpenRouter call succeeded')
  assert.equal(snapshot.errors.deepseek, null, 'the DeepSeek call succeeded')
  assert.equal(snapshot.errors.gemini, null, 'the Gemini call succeeded')
  assert.equal(snapshot.gemini.gemini.remainingPercent, 85, 'Gemini remaining percentage parsed')
  assert.equal(snapshot.gemini.claude.remainingPercent, 95, 'Claude remaining percentage parsed')

  assert.equal(snapshot.codex.plan, 'plus', 'the plan comes through')
  assert.equal(snapshot.codex.limitReached, true, 'an exhausted plan is reported as such')
  assert.equal(snapshot.codex.windows.length, 2, 'both windows survive normalization')
  assert.deepEqual(
    snapshot.codex.windows.map((window) => window.usedPercent),
    [100, 66],
    'both used percentages survive normalization',
  )
  assert.equal(snapshot.codex.windows[0].windowSeconds, 18000, 'the short window keeps its length')
  assert.equal(snapshot.codex.windows[0].resetAt, 1790861660000, 'a unix reset becomes epoch milliseconds')
  assert.equal(snapshot.codex.windows[1].resetAt, 1791110373000, 'the weekly reset becomes epoch milliseconds')
  assert.equal(snapshot.codex.resetsAvailable, 4, 'the extra limit resets are reported')
  assert.deepEqual(snapshot.codex.unreachableModels, ['gpt-6-astra'], 'a model that is out of quota is listed')
  assert.equal(snapshot.codex.credits.balance, 0, 'the credit balance is a number, not a string')

  assert.equal(snapshot.openrouter.remaining, 8.727619243, 'the remaining balance is total minus usage')

  assert.deepEqual(
    snapshot.deepseek.wallets,
    [
      { currency: 'CNY', balance: 18.4 },
      { currency: 'USD', balance: 4.25 },
    ],
    'every Platform wallet survives, with its balance as a number',
  )
  assert.deepEqual(snapshot.deepseek.bonusWallets, [{ currency: 'USD', balance: 2 }], 'bonus wallets are kept apart')
  assert.ok(snapshot.deepseekFetchedAt > 0, 'the wallet read carries its own timestamp')
  assert.deepEqual(
    account.seen[0],
    { version: 'dsh-usage-meter@0.6.1', locale: 'ru-RU', timezoneOffsetSeconds: 10800 },
    'Platform is told the requesting UI, not the host process',
  )

  const usage = net.calls.find((call) => call.href.includes('/wham/usage'))
  assert.equal(usage.init.headers.authorization, 'Bearer live-access-token', 'the stored grant authorizes the call')
  assert.equal(usage.init.headers['chatgpt-account-id'], 'acct-1', 'the account id rides along as its own header')
  const credits = net.calls.find((call) => call.href.includes('/api/v1/credits'))
  assert.equal(credits.init.headers.authorization, 'Bearer sk-or-test', 'the OpenRouter key authorizes its call')

  for (const dispose of disposers) dispose()
}

// --- a provider that is switched off is never read ------------------------
{
  const store = credentialsStore()
  const account = deepseekAccount(DEEPSEEK_READY)
  const { handler, disposers } = mount({ credentials: store, account })
  const net = stubFetch()

  const chosen = await handler('preferences', { visible: { openrouter: false } })
  net.restore()
  assert.equal(chosen.ok, true, 'the preference is accepted')
  assert.deepEqual(chosen.value.visible, { codex: true, openrouter: false, deepseek: true, gemini: true }, 'and answered in full')

  const net2 = stubFetch()
  const snapshot = (await handler('usage', { force: true })).value.snapshot
  const calls = net2.calls.map((call) => call.href)
  net2.restore()

  assert.equal(snapshot.openrouter, null, 'the switched-off provider reports nothing')
  assert.equal(snapshot.errors.openrouter, null, 'and no failure, because it was never asked')
  assert.equal(
    calls.some((href) => href.includes('/api/v1/credits')),
    false,
    'and its request is never made — the key is not even read',
  )
  assert.ok(snapshot.codex !== null, 'the providers left on are unaffected')
  assert.ok(snapshot.deepseek !== null, 'all of them')
  assert.deepEqual(snapshot.visible, { codex: true, openrouter: false, deepseek: true, gemini: true }, 'the snapshot carries the choice')

  for (const dispose of disposers) dispose()
}

// --- the choice outlives the process ---------------------------------------
{
  const store = credentialsStore()
  const first = mount({ credentials: store })
  const net = stubFetch()
  assert.equal((await first.handler('preferences', { visible: { deepseek: false } })).value.visible.deepseek, false)
  net.restore()
  for (const dispose of first.disposers) dispose()

  // A fresh handler reads the persisted choice rather than the row defaults.
  const account = deepseekAccount(DEEPSEEK_READY)
  const second = mount({ credentials: store, account })
  const net2 = stubFetch()
  const snapshot = (await second.handler('usage', { force: true })).value.snapshot
  net2.restore()
  assert.equal(snapshot.deepseek, null, 'a restart keeps the provider off')
  assert.equal(account.seen.length, 0, 'and keeps not reading it')
  for (const dispose of second.disposers) dispose()

  reset_choices()
}

// --- the row config seeds the defaults -------------------------------------
{
  const store = credentialsStore()
  const { handler, disposers } = mount({ credentials: store, rowConfig: { visible: { codex: false } } })
  const net = stubFetch()
  const snapshot = (await handler('usage', { force: true })).value.snapshot
  net.restore()
  assert.equal(snapshot.codex, null, 'a row config can start a provider switched off')
  assert.equal(snapshot.openrouter !== null, true, 'and leave the rest alone')
  for (const dispose of disposers) dispose()
  reset_choices()
}

/**
 * Put the stored choice back to the shipped defaults, so the tests that follow
 * read a state file as a first run would leave it. The file itself stays: the
 * activation breadcrumbs it carries are asserted at the end of this suite.
 */
function reset_choices() {
  const path = join(home, 'usage-meter.json')
  if (!existsSync(path)) return
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  delete parsed.preferences
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
}

// --- an account that is absent or empty is not an error --------------------
for (const [label, result] of [
  ['no account service', void 0],
  ['nobody signed in', null],
  ['a failed read', { status: 'failed' }],
  ['an empty balance', { status: 'ready', value: [], bonusWallets: [] }],
]) {
  const store = credentialsStore()
  const { handler, disposers } = mount({
    credentials: store,
    account: result === void 0 ? void 0 : deepseekAccount(result),
  })
  const net = stubFetch()
  const snapshot = (await handler('usage', { force: true })).value.snapshot
  net.restore()

  assert.equal(snapshot.deepseek, null, `${label}: there is no balance to show`)
  assert.equal(snapshot.errors.deepseek, null, `${label}: and no failure to report either`)
  assert.ok(snapshot.openrouter !== null, `${label}: the other providers are unaffected`)

  for (const dispose of disposers) dispose()
}

// --- a read that actually broke is reported, not swallowed ------------------
{
  const store = credentialsStore()
  const { handler, disposers } = mount({ credentials: store, account: deepseekAccount(new Error('network down')) })
  const net = stubFetch()
  const result = await handler('usage', { force: true })
  net.restore()

  assert.equal(result.value.snapshot.deepseek, null, 'no balance is claimed')
  assert.equal(result.value.snapshot.errors.deepseek.code, 'internal', 'the failure carries its code')
  assert.match(result.value.snapshot.errors.deepseek.message, /network down/, 'and its message')
  assert.ok(result.value.snapshot.codex !== null, 'the other providers are unaffected')

  for (const dispose of disposers) dispose()
}

// --- a wallet balance is re-read far less often than a rate-limit window ----
{
  const store = credentialsStore()
  const account = deepseekAccount(DEEPSEEK_READY)
  const { handler, disposers } = mount({ credentials: store, account })
  const net = stubFetch()

  await handler('usage', { force: true })
  assert.equal(account.seen.length, 1, 'the first read happens once')
  const readsAfterFirst = net.calls.length

  // `force` bypasses the snapshot cache but not the wallet's own, slower one.
  await handler('usage', { force: true })
  assert.equal(account.seen.length, 1, 'a forced refresh inside the wallet TTL reuses the reading')
  assert.ok(net.calls.length > readsAfterFirst, 'while the rate-limit windows are still re-read')

  net.restore()
  for (const dispose of disposers) dispose()
}

// --- one provider failing never hides the other ----------------------------
{
  const store = credentialsStore()
  const { handler, disposers } = mount({ credentials: store })
  const net = stubFetch({ codexStatus: 401 })
  const result = await handler('usage', { force: true })
  net.restore()

  assert.equal(result.ok, true, 'a failing provider is data, not a failed call')
  assert.equal(result.value.snapshot.codex, null, 'no Codex numbers when Codex refused')
  assert.ok(result.value.snapshot.errors.codex, 'the Codex failure is reported with its code')
  assert.ok(result.value.snapshot.openrouter !== null, 'the OpenRouter balance still arrives')

  for (const dispose of disposers) dispose()
}

// --- a missing Codex grant is not an error ---------------------------------
{
  const store = credentialsStore({ record: null })
  const { handler, disposers } = mount({ credentials: store })
  const net = stubFetch()
  const result = await handler('usage', { force: true })
  net.restore()

  assert.equal(result.value.snapshot.codex, null, 'an unconfigured provider reports nothing')
  assert.equal(result.value.snapshot.errors.codex, null, 'and reports no error either')
  assert.equal(
    net.calls.some((call) => call.href.includes('/wham/usage')),
    false,
    'no request is made for a provider that is not configured',
  )

  for (const dispose of disposers) dispose()
}

// --- an expired grant is refreshed, and the refresh is written back ---------
{
  const store = credentialsStore({
    record: { kind: 'oauth', payload: { access: 'stale', refresh: 'live-refresh-token', expires: Date.now() - 1000, accountId: 'acct-1' } },
  })
  const { handler, disposers } = mount({ credentials: store })
  const net = stubFetch()
  const result = await handler('usage', { force: true })
  net.restore()

  assert.equal(result.ok, true, 'the refreshed grant is used transparently')
  assert.ok(net.calls.some((call) => call.href.includes('/oauth/token')), 'an expired grant is refreshed first')
  assert.equal(net.calls.find((call) => call.href.includes('/wham/usage')).init.headers.authorization, 'Bearer refreshed-access', 'the new token is used')
  assert.equal(store.writes.length, 1, 'the refreshed grant is written back exactly once')
  assert.equal(store.writes[0].next.payload.access, 'refreshed-access', 'the new access token is persisted')

  for (const dispose of disposers) dispose()
}

// --- the owner prefix does not matter --------------------------------------
{
  const store = credentialsStore({ key: 'some-future-owner/openai-codex' })
  const { handler, disposers } = mount({ credentials: store })
  const net = stubFetch()
  const result = await handler('usage', { force: true })
  net.restore()

  assert.ok(result.value.snapshot.codex !== null, 'the record is found under a renamed owner too')

  for (const dispose of disposers) dispose()
}

// --- caching and the forced refresh ----------------------------------------
{
  const store = credentialsStore()
  const { handler, disposers } = mount({ credentials: store })
  const net = stubFetch()

  await handler('usage', { force: true })
  const afterFirst = net.calls.length
  const cached = await handler('usage', {})
  assert.equal(net.calls.length, afterFirst, 'a fresh snapshot is served without touching the network')
  assert.equal(cached.value.cached, true, 'the browser is told it is cached')
  assert.deepEqual(cached.value.snapshot.codex.windows.map((window) => window.usedPercent), [100, 66], 'the cached snapshot is the same one')

  await handler('refresh', {})
  assert.ok(net.calls.length > afterFirst, 'the refresh endpoint always goes out')

  net.restore()
  for (const dispose of disposers) dispose()
}

// --- the browser protocol ---------------------------------------------------
{
  const store = credentialsStore()
  const { routes, disposers } = mount({ credentials: store })
  const net = stubFetch()
  const route = routes.get('/api/usage-meter/usage')

  const mismatched = await (
    await route.fetch(
      new Request('http://127.0.0.1:19387/api/usage-meter/usage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'usage-meter/refresh', payload: {} }),
      }),
    )
  ).json()
  assert.equal(mismatched.result.ok, false, 'a method that does not match the route is refused')
  assert.equal(mismatched.result.error.code, 'bad-request', 'with a stable code')

  const garbage = await route.fetch(
    new Request('http://127.0.0.1:19387/api/usage-meter/usage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }),
  )
  assert.equal(garbage.status, 400, 'a body that is not JSON is a 400, not a crash')

  const framed = await (
    await route.fetch(
      new Request('http://127.0.0.1:19387/api/usage-meter/usage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'usage-meter/usage', payload: { force: true } }),
      }),
    )
  ).json()
  assert.equal(framed.type, 'server-response', 'the response carries the carrier envelope')
  assert.equal(framed.rpcId, 'r2', 'the response answers the request rpcId')

  net.restore()
  for (const dispose of disposers) dispose()
}

// --- the state file is the activation breadcrumb ----------------------------
{
  const recorded = state()
  assert.equal(recorded.hostVersion, '0.6.1', 'the state file carries the plugin version')
  assert.ok(recorded.imported, 'the module-evaluation stage is recorded')
  assert.ok(recorded.applied, 'the applied stage is recorded')
  assert.ok(recorded.injected, 'the injected stage is recorded')
  assert.ok(recorded.registered, 'the registered stage is recorded')
  assert.equal(recorded.base, '/api/usage-meter', 'the mounted routes are named in the state file')
  assert.ok(recorded.snapshot !== void 0, 'the last good snapshot is persisted so an offline start still shows numbers')
}

rmSync(home, { recursive: true, force: true })
console.log('host: ok')