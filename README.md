# dsh-usage-meter

Plan and credit meter for DeepSeek Harness: a row in the sidebar foot, under
your avatar, carrying your Codex rate-limit windows, your Google Gemini (AI Pro)
quota, your OpenRouter balance and your DeepSeek wallets — with the full picture
one hover away.

It answers for the providers whose quota the harness never surfaces:

| Provider | Source | What it shows |
| --- | --- | --- |
| **OpenAI Codex** | `GET https://chatgpt.com/backend-api/wham/usage` | both plan windows (5-hour and weekly) as the share left, their reset countdowns, the plan name, the extra limit resets, and any model currently out of quota |
| **Google Gemini (AI Pro)** | `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | independent remaining quota percentages and reset countdowns for Gemini (Flash & Pro), Argon, and third-party subscription models (Claude & GPT-OSS) |
| **OpenRouter** | `GET https://openrouter.ai/api/v1/credits` | the prepaid balance out of the total |
| **DeepSeek** | the harness's own `deepseekAccount` service | the recharge wallet and every granted bonus wallet |

The harness talks to the Codex backend with the same OAuth grant but only ever
learns a quota *failure* from a response — it never asks how much is left. The
answer lives behind the Codex backend's own usage endpoint, which this plugin
calls with the access token the credentials service already holds.

Google quota requests use `antigravity/hub/2.23.0 darwin/arm64`; older client versions hide Argon buckets. Quotas are read from the daily generation backend, never substituted with the production backend's different pools. Each bucket's explicit `remainingFraction` and `resetTime` stay together; absent or invalid Argon data is not guessed from Flash or Claude.

## What you see

A full-width row in the foot of the sidebar, directly above Settings:

```
[openai] 95%         [openrouter] $8.73   [deepseek] ¥1.27
```

- the **OpenAI** mark reports the share of the *five-hour* Codex window that is
  **left** — the window that will actually stop your next request. The backend
  reports the used share, so the row reads the complement: just after a reset it
  says 95%, not 5%;
- the **OpenRouter** and **DeepSeek** marks carry their balances. The three
  marks are the Simple Icons paths for OpenAI, OpenRouter and DeepSeek — the
  shell's own icon set has no brand glyph for anyone, and a hand-drawn guess at
  a logo is worse than the real thing. They are filled shapes rather than the
  shell's stroked outlines, which is how every brand mark is set anywhere, and
  they take `currentColor` so they follow the theme. All three are the same
  neutral grey: an icon only says *which* provider a figure belongs to, and the
  state colours — calm, warning, exhausted — stay on the panel's bars where the
  window itself is drawn;
- the **DeepSeek** figure is the balance: Platform keeps two kinds of wallet, the
  *recharge* one a paid top-up lands in and the *granted* bonus one, and plenty of
  accounts hold money in only one of them. The row shows the first wallet that
  actually holds something, and the panel breaks down both kinds by name —
  listing the empty one is what tells you the money you have is granted money.
- collapsing the sidebar to the rail keeps the ring and the percentage and drops
  the two balances, which have no room in 36 pixels;
- if nothing at all is configured, the row is not drawn — an empty quota row
  beside Settings would say nothing.

**Hovering** the row opens a panel with everything, in four equal groups — one
per provider, each with the same caption and the same rows, none promoted over
the others:

- **OpenAI Codex**: `5h` and `weekly` by name, each with its bar, what is left,
  and `Resets 10/01, 08:37 PM · in 2 d 22 h` — the wall-clock moment first,
  because that is the one you can plan around, and how far off it is right after;
  plus the number of extra limit resets and, only when it happens, that a limit
  was reached;
- **Google Gemini (AI Pro)**: separate `Gemini (Flash & Pro)`, `Argon`, and
  `Claude (Opus, Sonnet) & GPT-OSS` windows, each with its own remaining quota,
  bar, and reset countdown. Older snapshots without Argon simply omit that window;
  the sidebar and Plugins summary continue to show the Flash & Pro quota;
- **OpenRouter credits**: the balance out of the total, and what was spent;
- **DeepSeek balance**: every wallet under its own name, empties included.

The refresh control sits once in the panel's foot, beside the timestamp. There
is no plan name and no coloured lamp: neither tells you anything you can act
on, and both made one provider look like the subject of the panel.

A **click** pins the panel open, so you can move the pointer away; Escape and a
click outside close it again.

## Choosing what it shows

The plugin is listed in the **Plugins** panel under the **Installed** section:
opening it gives the plugin's configuration page (`plugins.bundle.config`) —
the figures at a readable size, a switch per provider, and a refresh control.

A provider you switch off is **not read at all**: the host stops requesting it,
stops resolving its credential, and reports no error for it. The choice is
written through the host into `~/.dsh/usage-meter.json`, so it survives a
restart, and the sidebar row redraws on the toggle rather than on the next poll.

The row's defaults live in the profile patch, if you would rather start a
provider switched off:

```yaml
- insert:
    - id: usage-meter
      name: 'dsh-usage-meter'
      visible:
        openrouter: false
```

Turning every provider off hides the sidebar row outright — the page says so,
which is where you turn one back on.

## Where the numbers come from

Everything is read from the harness's own credential store — the plugin never
opens `~/.codex/auth.json`:

- the Codex grant is the `llm-pi-ai/openai-codex` credential record (any owner
  prefix ending in `/openai-codex` is accepted, so a renamed owner still
  resolves);
- when the stored access token is expired — or comes back 401 — the plugin
  exchanges the refresh token at `https://auth.openai.com/oauth/token` and
  writes the new grant back, so the harness provider sees it too;
- the OpenRouter key is the `OPENROUTER_API_KEY` reference the Models settings
  page already writes;
- DeepSeek goes through `ctx.deepseekAccount`, so the plugin never touches the
  grant: the harness owns the sign-in state and the credential refresh. Every
  way that can be unavailable — no account service, nobody signed in, an empty
  balance — is an ordinary "nothing to show", while a read that actually broke is
  reported. Platform returns `normal_wallets` and `bonus_wallets` as strings
  with their own decimal grammar; the plugin parses both into numbers, and never
  turns a failed read into a zero balance.

Platform is told the *requesting UI*, not the host process: the browser sends
its active locale and its offset east of UTC with every read, because those
become the `x-client-locale` and `x-client-timezone-offset` request headers.

A wallet balance moves on the scale of a purchase, not of a minute, so it is
re-read at most once every five minutes while the rate-limit windows refresh
every minute. Force-refreshing the panel bypasses the window cache but not the
wallet's own.

## Wiring

Add the package to the profile's dependencies and bundle list:

```json
// package.json
"dependencies": {
  "dsh-usage-meter": "link:../dsh-usage-meter"
},
"dsh": {
  "profile": {
    "bundles": [
      "dsh-usage-meter"
    ]
  }
}
```

The bundle layer loads the plugin's `cordis.patch.yml` automatically. Default visibility
can also be overridden in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: usage-meter
      name: 'dsh-usage-meter'
      visible:
        openrouter: false
```

## Endpoints

The host owns two exact Fetch routes on the shared `/api` channel:

- `POST /api/usage-meter/usage` — the snapshot, cached for 60s; `{ force: true }`
  bypasses the window cache
- `POST /api/usage-meter/refresh` — always goes out
- `POST /api/usage-meter/preferences` — writes the provider visibility and
  answers with the whole choice

A snapshot looks like this:

```json
{
  "codex": {
    "plan": "plus",
    "limitReached": true,
    "windows": [
      { "key": "primary", "usedPercent": 100, "windowSeconds": 18000, "resetAt": 1790861660000 },
      { "key": "secondary", "usedPercent": 66, "windowSeconds": 604800, "resetAt": 1791110373000 }
    ],
    "resetsAvailable": 4,
    "credits": { "hasCredits": false, "unlimited": false, "balance": 0 },
    "unreachableModels": ["gpt-6-astra"]
  },
  "openrouter": { "totalCredits": 60, "totalUsage": 51.272380757, "remaining": 8.727619243 },
  "deepseek": {
    "wallets": [{ "currency": "USD", "balance": 0 }],
    "bonusWallets": [{ "currency": "USD", "balance": 0 }, { "currency": "CNY", "balance": 1.26760384 }]
  },
  "deepseekFetchedAt": 1790860490000,
  "errors": { "codex": null, "openrouter": null, "deepseek": null },
  "visible": { "codex": true, "openrouter": true, "deepseek": true },
  "fetchedAt": 1790860490000
}
```

The three providers are independent by construction, so one failure never hides
the others' numbers: each carries its own entry in `errors`.

## State and breadcrumbs

`~/.dsh/usage-meter.json` holds the last good snapshot — so an offline start
still shows numbers instead of an empty row — together with the activation
breadcrumbs `imported` → `applied` → `injected` → `registered`, which are the
first thing to look at when a profile change has to be diagnosed from a
terminal.

## Tests

```
node test/host.mjs                                # routes, protocol, normalization, refresh, cache, DeepSeek
node --import ./test/register.mjs test/client.mjs # rendering, rail variant, hover, pinning, gating, helpers
```

The host tests import the module with a temporary `DSH_HOME` and a stubbed
`globalThis.fetch`, so nothing leaves the machine. The client tests materialize
the shipped loader bundle with the real React and the real DSH primitives in
jsdom, so the shipped code — not a copy — is what gets tested.