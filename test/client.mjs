/**
 * Browser-half checks.
 *
 * `lib/client.js` is a loader bundle, not an ES module: it hands a factory to
 * `window.__ModuleLoader__`. This harness runs that bundle against a fake
 * loader and materializes it with the real React and the real DSH primitives,
 * so the shipped code — not a copy of it — is what gets tested. jsdom supplies
 * the DOM and the Connection channel is faked deterministically.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)

/** Install jsdom on the Node globals. */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1:19387/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: window.ResizeObserver,
    IntersectionObserver: window.IntersectionObserver,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  return window
}

installDom()

/** Evaluate the client bundle and materialize its factory. */
async function loadClient() {
  const primitives = await import('@deepseek-ai/dsh-client-ui-primitives')
  const table = new Map()
  globalThis.window.__ModuleLoader__ = { load: (descriptor) => table.set(descriptor.id, descriptor) }
  await import('../lib/client.js')
  const descriptor = table.get('dsh-usage-meter')
  assert.ok(descriptor, 'the bundle registers its module id')
  const exports = descriptor.factory((id) => {
    if (id === 'react') return require('react')
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (id === 'react-dom') return require('react-dom')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected client require: ${id}`)
  })
  return { exports, descriptor }
}

const { exports, descriptor } = await loadClient()
const { internals } = exports

// --- the module's own shape -----------------------------------------------
assert.equal(internals.NS, 'usage-meter')
assert.equal(internals.API_CHANNEL, '/api', 'browser RPC rides the shared channel')
assert.equal(internals.ROUTE, 'usage-meter', 'the plugin owns one endpoint prefix under /api')
assert.deepEqual(exports.inject, ['connection', 'slots', 'locale'], 'the browser half asks for exactly what it uses')
assert.ok(internals.en !== undefined && internals.ru !== undefined, 'both dictionaries ship')

// --- pure helpers ----------------------------------------------------------
assert.equal(internals.toneOf(10), 'is-ok', 'a fresh window reads calm')
assert.equal(internals.toneOf(70), 'is-warn', 'a spent window warns')
assert.equal(internals.toneOf(100), 'is-error', 'an exhausted window errors')
assert.equal(internals.humanDuration(19 * 60_000, (key) => internals.en[key]), '19 min', 'minutes read compactly')
assert.equal(internals.humanDuration(174 * 60_000, (key) => internals.en[key]), '2 h 54 min', 'hours carry the leftover minutes')
assert.equal(internals.humanDuration(50 * 3_600_000, (key) => internals.en[key]), '2 d 2 h', 'days carry the leftover hours')
assert.equal(internals.moneyOf(8.727619243, 'USD'), '$8.73', 'a balance reads as money')
assert.equal(internals.moneyOf(18.4, 'CNY'), '¥18.40', 'the Platform currency signs are owned')
assert.equal(internals.moneyOf(4.25, 'EUR'), 'EUR 4.25', 'an unknown currency falls back to its code')
assert.equal(internals.moneyOf(1204.5, 'USD'), '$1205', 'a large amount drops its decimals')
assert.equal(internals.moneyOf(Number.NaN, 'USD'), null, 'a non-number is not money')
assert.equal(internals.interpolate('Reset {time}', { time: '5 min' }), 'Reset 5 min', 'templates fill')
assert.equal(internals.interpolate('Reset {time}', {}), 'Reset {time}', 'an absent value keeps the marker')
assert.equal(
  internals.shortestWindow({
    windows: [
      { key: 'primary', windowSeconds: 18000, usedPercent: 12 },
      { key: 'secondary', windowSeconds: 604800, usedPercent: 66 },
    ],
  }).key,
  'primary',
  'the row asks for the shortest window, not for a label',
)
assert.equal(internals.shortestWindow({ windows: [] }), null, 'no windows means no window')
assert.equal(internals.shortestWindow(null), null, 'no Codex view means no window')

// --- a full snapshot -------------------------------------------------------
const NOW = Date.now()
const SNAPSHOT = {
  codex: {
    plan: 'plus',
    limitReached: true,
    // A window that has just reset: 5% used, so 95% is left. Reading the
    // backend's `used_percent` verbatim here would print a 5% quota, which is
    // the exact confusion this snapshot exists to catch.
    windows: [
      { key: 'primary', usedPercent: 5, windowSeconds: 18000, resetAt: NOW + 19 * 60_000 },
      { key: 'secondary', usedPercent: 66, windowSeconds: 604800, resetAt: NOW + 3 * 3_600_000 },
    ],
    resetsAvailable: 4,
    credits: { hasCredits: false, unlimited: false, balance: 0 },
    unreachableModels: ['gpt-6-astra'],
  },
  openrouter: { totalCredits: 60, totalUsage: 51.272380757, remaining: 8.727619243 },
  // The shape Platform actually reports: a recharge wallet that is empty and a
  // granted wallet that holds the money.
  deepseek: {
    wallets: [{ currency: 'USD', balance: 0 }],
    bonusWallets: [
      { currency: 'USD', balance: 0 },
      { currency: 'CNY', balance: 1.26760384 },
    ],
  },
  gemini: {
    gemini: { key: 'gemini', remainingPercent: 85, usedPercent: 15, windowSeconds: 86400, resetAt: NOW + 120 * 60_000, resetAfterSeconds: 7200 },
    argon: { key: 'argon', remainingPercent: 40, usedPercent: 60, windowSeconds: 86400, resetAt: NOW + 240 * 60_000, resetAfterSeconds: 14400 },
    claude: { key: 'claude', remainingPercent: 95, usedPercent: 5, windowSeconds: 86400, resetAt: NOW + 180 * 60_000, resetAfterSeconds: 10800 },
  },
  errors: { codex: null, openrouter: null, deepseek: null, gemini: null },
  fetchedAt: NOW,
}

/**
 * A Connection stub answering the host's usage envelope. It remembers what the
 * page wrote, so a toggle is observed the way the real Host observes it: in the
 * `visible` the next snapshot carries.
 */
function fakeConnection(snapshot = SNAPSHOT) {
  const calls = []
  let visible = snapshot.visible ?? null
  internals.runtime.ctx = {
    locale: { getLocale: () => ({ active: 'ru-RU', locales: [], revision: 1 }) },
    connection: {
      rpc: {
        async call(_channel, method, payload) {
          calls.push({ method, payload })
          if (method === 'usage-meter/preferences') {
            visible = { codex: true, openrouter: true, deepseek: true, gemini: true, ...(visible ?? {}), ...payload.visible }
            return { ok: true, value: { visible } }
          }
          return { ok: true, value: { snapshot: { ...snapshot, visible }, cached: false } }
        },
      },
    },
  }
  return calls
}

/** Mount one component into a fresh jsdom container. */
async function mount(Component, props) {
  const { createRoot } = await import('react-dom/client')
  const react = await import('react')
  const act = typeof react.act === 'function' ? react.act : (await import('react-dom/test-utils')).act
  const container = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(react.createElement(Component, props))
  })
  return {
    container,
    act,
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** @param act - React act. @param element - element with a click handler. */
async function click(act, element) {
  assert.ok(element, 'the clicked element exists')
  await act(async () => {
    element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/**
 * React synthesizes enter/leave from the bubbling pair, so a `pointerover` with
 * an outside `relatedTarget` is what a real hover dispatches.
 * @param act - React act.
 * @param element - the element under the pointer.
 */
async function hover(act, element) {
  assert.ok(element, 'the hovered element exists')
  await act(async () => {
    element.dispatchEvent(
      new globalThis.window.MouseEvent('pointerover', { bubbles: true, cancelable: true, relatedTarget: null }),
    )
  })
}

/** @param act - React act. Let the mounted effects and the RPC round trip land. */
async function settle(act) {
  for (let round = 0; round < 6; round++) {
    await act(async () => {
      await Promise.resolve()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const t = (key, values) => internals.interpolate(internals.en[key] ?? key, values)
const panel = () => globalThis.document.querySelector('.um_panel')

// --- the row is always there, whatever the session is doing ----------------
{
  const calls = fakeConnection()
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)

  const badge = view.container.querySelector('.um_badge')
  assert.ok(badge, 'the row renders in the sidebar foot')
  assert.equal(view.container.querySelector('.um_layer').className, 'um_layer', 'the expanded variant is the default')
  assert.ok(calls.length >= 1, 'the host is asked once the row mounts')
  assert.equal(calls[0].method, 'usage-meter/usage', 'the call rides this plugin route on the shared channel')
  assert.equal(calls[0].payload.locale, 'ru-RU', 'the browser reports its own locale to Platform')
  assert.equal(calls[0].payload.timezoneOffsetSeconds, -new Date().getTimezoneOffset() * 60, 'and its offset east of UTC')
  assert.equal(calls[0].payload.force, true, 'the first read is forced')

  // Four figures, each introduced by its own mark and named by no letters at all.
  const figures = [...badge.querySelectorAll('.um_figure')]
  assert.equal(figures.length, 4, 'Codex, Gemini, OpenRouter and DeepSeek each get a figure')
  assert.deepEqual(
    figures.map((figure) => figure.textContent),
    ['95%', '85%', '$8.73', '¥1.27'],
    'and each reads as the number it stands for — 95%, because the window has 5% used',
  )
  assert.equal(view.container.querySelectorAll('.um_badge').length, 1, 'exactly one row')

  const marks = [...badge.querySelectorAll('.um_figure > .um_icon > svg')]
  assert.equal(marks.length, 4, 'each figure is introduced by a brand mark')
  for (const mark of marks) {
    assert.equal(mark.getAttribute('viewBox'), '0 0 24 24', 'a mark keeps the 24-unit grid it was drawn on')
    assert.equal(mark.getAttribute('width'), '14', 'and renders at the shell icon size')
    assert.equal(mark.getAttribute('fill'), 'currentColor', 'and takes the theme colour rather than a baked-in one')
    const path = mark.querySelector('path')
    assert.ok(path !== null, 'and it is a real outline, not a placeholder')
    assert.ok(path.getAttribute('d').length > 100, 'carrying a full brand path')
    assert.equal(mark.innerHTML.includes('fill="#'), false, 'with no hardcoded brand colour left in')
  }
  // Four distinct marks, not one drawn multiple times.
  const distinct = new Set(marks.map((mark) => mark.innerHTML))
  assert.equal(distinct.size, 4, 'Codex, Gemini, OpenRouter and DeepSeek each carry their own mark')
  assert.doesNotMatch(badge.textContent, /OR|DS/, 'the two-letter marks are gone')
  assert.match(badge.getAttribute('aria-label'), /Codex 95% left/, 'the accessible name spells out what is left')

  // Every mark is the same neutral grey: no state colour rides on an icon that
  // only says which provider a figure belongs to.
  for (const icon of badge.querySelectorAll('.um_icon')) {
    assert.equal(icon.getAttribute('class'), 'um_icon', 'a mark carries no tone of its own')
  }

  await view.unmount()
}

// --- the rail variant drops the figures ------------------------------------
{
  fakeConnection()
  const view = await mount(internals.UsageMeter, { wide: false, t })
  await settle(view.act)

  assert.equal(view.container.querySelector('.um_layer').className, 'um_layer is-rail', 'a collapsed rail gets the rail variant')
  const badge = view.container.querySelector('.um_badge')
  assert.match(badge.textContent, /95%/, 'the percentage still reads in the rail')
  assert.equal(badge.querySelectorAll('.um_figure').length, 1, 'the two balances have no room and are dropped')
  assert.equal(panel(), null, 'and no panel is left behind')

  await view.unmount()
}

// --- hovering opens the full picture ---------------------------------------
{
  fakeConnection()
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)
  const badge = view.container.querySelector('.um_badge')

  await hover(view.act, badge)
  // The open is deliberately delayed, so the panel must not be there yet.
  assert.equal(panel(), null, 'a passing pointer does not open the panel')
  await view.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320))
  })

  const opened = panel()
  assert.ok(opened, 'resting on the row opens the panel')
  assert.equal(opened.getAttribute('role'), 'dialog', 'the panel is a dialog')
  // A panel that exists but was never positioned renders invisible, which is
  // exactly what an unanchored row looks like from the outside.
  assert.notEqual(opened.style.visibility, 'hidden', 'the panel is actually placed, not parked off-screen')
  assert.ok(opened.getAttribute('style') !== '', 'it carries a computed position')
  assert.ok(
    globalThis.document.querySelector('.um_badge') !== null && opened.parentElement === globalThis.document.body,
    'the panel is portaled to the body rather than trapped inside the sidebar',
  )
  const body = opened.textContent
  assert.match(body, /OpenAI Codex/, 'the panel names the provider')
  assert.doesNotMatch(body, /Plan plus/, 'and no plan name: it says nothing a quota meter cannot act on')
  assert.match(body, /5h/, 'the short window is named as the short window')
  assert.match(body, /weekly/, 'the weekly window is named as the weekly window')
  assert.match(body, /95% left/, 'the fresh window says how much of it is left')
  assert.match(body, /34% left/, 'and so does the weekly one, at its own figure')
  assert.match(body, /Resets .+ · in 19 min/, 'each window says when it resets, absolutely and relatively')
  assert.match(body, /Resets .+ · in 3 h/, 'and so does the weekly one, on its own clock')
  assert.match(body, /4 limit resets available/, 'the extra resets are surfaced')
  assert.match(body, /Google Gemini \(AI Pro\)/, 'the panel names the Gemini provider')
  assert.match(body, /Gemini \(Flash & Pro\)/, 'the Gemini window is named')
  assert.match(body, /85% left/, 'the Gemini window says what is left')
  assert.match(body, /Claude \(Opus, Sonnet\) & GPT-OSS/, 'the third-party window is named with Opus')
  const windows = [...opened.querySelectorAll('.um_meterBody')]
  assert.deepEqual(
    windows.map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]),
    [
      ['5h', '95% left'],
      ['weekly', '34% left'],
      ['Gemini (Flash & Pro)', '85% left'],
      ['Argon', '40% left'],
      ['Claude (Opus, Sonnet) & GPT-OSS', '95% left'],
    ],
    'all five quota windows retain their own title and remaining percentage',
  )
  assert.deepEqual(
    windows.map((row) => row.querySelector('.um_segment').style.width),
    ['5%', '66%', '15%', '60%', '5%'],
    'each window has its own used bar rather than sharing the Gemini quota',
  )
  const geminiResets = [SNAPSHOT.gemini.gemini, SNAPSHOT.gemini.argon, SNAPSHOT.gemini.claude]
  for (const [index, quota] of geminiResets.entries()) {
    const note = windows[index + 2].querySelector('.um_note').textContent
    assert.equal(
      note,
      `Resets ${internals.clockOf(quota.resetAt)} · in ${internals.humanDuration(quota.resetAt - NOW, t)}`,
      'each Gemini quota window keeps its own absolute reset and countdown',
    )
  }
  assert.ok(opened.querySelector('button.um_refresh'), 'the panel provides a manual refresh button beside the timestamp')
  // The providers are peers: one caption style, no lamp, no bold header.
  const captions = [...opened.querySelectorAll('.um_caption')]
  assert.deepEqual(
    captions.map((node) => node.textContent),
    ['OpenAI Codex', 'Google Gemini (AI Pro)', 'OpenRouter credits', 'DeepSeek balance'],
    'every provider group is titled the same way',
  )
  assert.equal(opened.querySelectorAll('.um_title').length, 0, 'none of them is promoted over the others')
  assert.equal(opened.querySelectorAll('.um_swatch').length, 0, 'and none of them carries a coloured lamp')
  assert.match(body, /left of \$60\.00.*\$8\.73/s, 'the OpenRouter balance reads out of the total')
  assert.match(body, /Spent.*\$51\.27/s, 'and what was spent')
  assert.match(body, /Recharge wallet · USD\$0\.00/, 'the empty recharge wallet is listed, empties included')
  assert.match(body, /Granted balance · CNY¥1\.27/, 'the granted balance is listed under its own name')
  assert.match(body, /Granted balance · USD\$0\.00/, 'and so is every granted wallet')
  assert.match(body, /Updated /, 'the panel says how fresh it is')
  assert.equal(view.container.querySelectorAll('.um_segment').length, 0, 'the bars live in the panel, not the row')

  await view.unmount()
  opened.remove()
}

// --- older snapshots omit Argon without changing the other windows ---------
for (const argon of [undefined, null]) {
  const { argon: _argon, ...legacyGemini } = SNAPSHOT.gemini
  fakeConnection({ ...SNAPSHOT, gemini: argon === undefined ? legacyGemini : { ...legacyGemini, argon } })
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)
  await click(view.act, view.container.querySelector('.um_badge'))

  const group = [...panel().querySelectorAll('.um_group')].find((node) =>
    node.querySelector('.um_caption')?.textContent === 'Google Gemini (AI Pro)',
  )
  assert.deepEqual(
    [...group.querySelectorAll('.um_meterBody')].map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]),
    [['Gemini (Flash & Pro)', '85% left'], ['Claude (Opus, Sonnet) & GPT-OSS', '95% left']],
    'missing or null Argon adds no placeholder and leaves the existing quotas intact',
  )
  await view.unmount()
}

// --- an exhausted Argon does not exhaust Flash/Pro or third-party models ----
{
  fakeConnection({
    ...SNAPSHOT,
    gemini: { ...SNAPSHOT.gemini, argon: { ...SNAPSHOT.gemini.argon, remainingPercent: 0, usedPercent: 100, limitReached: true } },
  })
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)
  await click(view.act, view.container.querySelector('.um_badge'))

  const rows = [...panel().querySelectorAll('.um_meterBody')]
  const argon = rows.find((row) => row.querySelector('dt').textContent === 'Argon')
  assert.equal(argon.querySelector('dd').textContent, 'Limit reached · 0%', 'Argon reports its own exhaustion')
  assert.equal(argon.querySelector('.um_segment').className, 'um_segment is-error', 'only its bar turns exhausted')
  assert.equal(argon.querySelector('.um_segment').style.width, '100%', 'Argon is fully used')
  for (const title of ['Gemini (Flash & Pro)', 'Claude (Opus, Sonnet) & GPT-OSS']) {
    const row = rows.find((node) => node.querySelector('dt').textContent === title)
    assert.equal(row.querySelector('.um_segment').className, 'um_segment is-ok', 'the other Gemini windows stay healthy')
    assert.match(row.querySelector('dd').textContent, /% left$/, 'the other quotas remain available')
  }
  assert.equal(view.container.querySelectorAll('.um_figure')[1].textContent, '85%', 'the sidebar still summarizes Flash/Pro')
  await view.unmount()
}

// --- a click pins the panel ------------------------------------------------
{
  fakeConnection()
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)
  const badge = view.container.querySelector('.um_badge')

  await click(view.act, badge)
  assert.ok(panel(), 'a click opens the panel at once, without waiting for a hover')
  assert.notEqual(panel().style.visibility, 'hidden', 'and the click puts it somewhere you can see')
  assert.equal(badge.getAttribute('aria-expanded'), 'true', 'the row announces the panel is open')

  await click(view.act, badge)
  assert.equal(panel(), null, 'and a second click closes it')

  await view.unmount()
}

// --- a provider that is not configured leaves no row -----------------------
{
  fakeConnection({ codex: null, openrouter: null, deepseek: null, errors: { codex: null, openrouter: null, deepseek: null }, fetchedAt: NOW })
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)

  assert.equal(view.container.innerHTML, '', 'an empty quota row beside Settings would say nothing')
  await view.unmount()
}

// --- a quota that cannot be read still says something ----------------------
{
  internals.runtime.ctx = {
    locale: { getLocale: () => ({ active: 'en', locales: [], revision: 1 }) },
    connection: {
      rpc: {
        async call() {
          return { ok: false, error: { code: 'codex-reauth', message: 'sign in again' } }
        },
      },
    },
  }
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)

  const badge = view.container.querySelector('.um_badge')
  assert.ok(badge, 'the row stays')
  assert.ok(badge.querySelector('.um_icon'), 'a broken read still shows which provider failed')
  assert.match(badge.textContent, /—%/, 'without inventing a number')
  assert.match(badge.getAttribute('aria-label'), /Sign in to OpenAI Codex again/, 'while naming what went wrong')

  await view.unmount()
}

// --- the Plugins page: the figures, and a switch per provider --------------
{
  const calls = fakeConnection()
  const view = await mount(internals.MeterSettings, { wide: true, t })
  await settle(view.act)

  const page = view.container.querySelector('.um_page')
  assert.ok(page, 'the Plugins page renders')
  assert.deepEqual(
    [...page.querySelectorAll('.um_pageLabel')].map((node) => node.textContent),
    ['Codex', 'Gemini', 'OpenRouter', 'DeepSeek'],
    'one row per provider, named',
  )
  assert.deepEqual(
    [...page.querySelectorAll('.um_pageValue')].map((node) => node.textContent),
    ['95%', '85%', '$8.73', '¥1.27'],
    'each row shows what the sidebar row shows',
  )
  assert.match(page.textContent, /95% left/, 'the window is spelled out in words, not only as a number')

  const switches = [...page.querySelectorAll('button[role="switch"]')]
  assert.equal(switches.length, 4, 'every provider has a switch')
  for (const control of switches) {
    assert.equal(control.getAttribute('aria-checked'), 'true', 'and starts checked')
    assert.ok(control.getAttribute('aria-label'), 'with a name that says which provider it belongs to')
  }

  // Switching one off writes through the host and re-reads.
  const before = calls.length
  await click(view.act, switches[2])
  await settle(view.act)
  const write = calls.slice(before).find((call) => call.method === 'usage-meter/preferences')
  assert.ok(write !== void 0, 'the choice is written through the host, not kept in the browser')
  assert.deepEqual(write.payload.visible, { openrouter: false }, 'and carries just that provider')

  const reread = calls.slice(before).find((call) => call.method === 'usage-meter/usage')
  assert.ok(reread !== void 0, 'the page re-reads so the row and the page agree')
  assert.equal(page.querySelectorAll('button[role="switch"]')[2].getAttribute('aria-checked'), 'false', 'and the switch shows the choice')

  await view.unmount()
}

// --- the row honours the same choice ---------------------------------------
{
  fakeConnection({ ...SNAPSHOT, visible: { codex: true, openrouter: false, deepseek: true, gemini: false } })
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)
  const figures = [...view.container.querySelectorAll('.um_figure')].map((f) => f.textContent)
  assert.deepEqual(figures, ['95%', '¥1.27'], 'the switched-off provider is gone from the row')
  await view.unmount()
}

// --- everything off: the row hides itself and says why ---------------------
{
  fakeConnection({ ...SNAPSHOT, visible: { codex: false, openrouter: false, deepseek: false, gemini: false } })
  const view = await mount(internals.UsageMeter, { wide: true, t })
  await settle(view.act)
  assert.equal(view.container.innerHTML, '', 'the sidebar row is not drawn when nothing is switched on')

  const page = await mount(internals.MeterSettings, { wide: true, t })
  await settle(page.act)
  assert.match(page.container.textContent, /Every provider is off/, 'and the page says where it went')
  await view.unmount()
  await page.unmount()
}

// --- the Plugins card: the one-liner and the page it opens ------------------
{
  const calls = fakeConnection()
  const card = await mount(internals.MeterSettings, { view: 'summary', t })
  await settle(card.act)
  const line = card.container.querySelector('.um_summary')
  assert.ok(line, 'the card renders its one-liner')
  assert.deepEqual(
    [...line.querySelectorAll('.um_summaryFigure')].map((node) => node.textContent),
    ['95%', '85%', '$8.73', '¥1.27'],
    'and it carries the same figures the sidebar row does',
  )
  assert.equal(line.querySelectorAll('.um_summaryFigure svg').length, 4, 'each behind its provider mark')
  assert.equal(card.container.querySelector('.um_page'), null, 'the one-liner is not the whole page')
  await card.unmount()
}

// --- a card whose providers are all off says so rather than lying ----------
{
  fakeConnection({ codex: null, openrouter: null, deepseek: null, gemini: null, errors: { codex: null, openrouter: null, deepseek: null, gemini: null }, visible: { codex: false, openrouter: false, deepseek: false, gemini: false }, fetchedAt: NOW })
  const card = await mount(internals.MeterSettings, { view: 'summary', t })
  await settle(card.act)
  assert.equal(card.container.querySelectorAll('.um_summaryFigure').length, 0, 'no figure is invented')
  assert.match(card.container.textContent, /not available/, 'and the card says there is nothing to show')
  await card.unmount()
}

// --- mount registers exactly the intended slots ---------------------------
{
  const injected = []
  const registered = []
  const mockCtx = {
    effect: (fn) => fn(),
    locale: { register: () => {} },
    slots: {
      inject: (name, fn) => {
        injected.push(name)
        fn()
      },
      register: (descriptor, component) => {
        registered.push({ descriptor, component })
      },
    },
  }
  const dispose = exports.apply(mockCtx)
  assert.ok(injected.includes('sidebar.footer.action'), 'injects sidebar footer')
  assert.ok(injected.includes('plugins.bundle.config'), 'injects bundle config for installed plugins')
  assert.ok(!injected.includes('settings.plugins.tab'), 'does NOT inject into Built-in Plugins tab')
  assert.ok(!injected.includes('plugins.item'), 'does NOT inject into official plugins items')

  const bundleConfig = registered.find((r) => r.descriptor.name === 'plugins.bundle.config')
  assert.ok(bundleConfig, 'registers plugins.bundle.config')
  assert.equal(bundleConfig.descriptor.key, 'dsh-usage-meter', 'with key matching package name')
  assert.equal(bundleConfig.component, internals.MeterSettings, 'with MeterSettings component')

  dispose()
}

internals.runtime.ctx = null
console.log('client: ok')

// jsdom's visual loop keeps timers alive; the checks are done.
process.exit(0)
