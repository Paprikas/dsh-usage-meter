/**
 * Browser half of `dsh-usage-meter`.
 *
 * The seat is `sidebar.footer.action` — the column of full-width rows above the
 * Settings trigger, immediately under the account button. That seat is frame
 * wide and root scoped, so the meter is drawn in every panel of every session,
 * not only in a conversation whose model happens to be a Codex one.
 *
 * The row carries three figures at a glance: the five-hour Codex window as a
 * ring and a percentage, then the OpenRouter balance and the DeepSeek wallet.
 * The panel behind it — opened on hover, pinned by a click — carries both Codex
 * windows with their countdowns, the extra limit resets, the OpenRouter total
 * and spend, and every DeepSeek wallet including the bonus ones.
 *
 * The geometry, tokens and dismissal behaviour are the shipped `cordis-panel`
 * footer action's verbatim: the same 42px row, the same rail variant, the same
 * menu elevation. Nothing here approximates the shell's look.
 *
 * @module dsh-usage-meter/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-meter',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const reactDom = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { useCallback, useEffect, useMemo, useRef, useState } = react
    // `jsx`'s third argument is a *key*, not a child, so every element here is
    // built with `createElement`, whose varargs really are the children.
    const { createElement: h } = react
    const { createPortal } = reactDom
    const { useAnchoredPosition, useDismissOnOutsidePointer, IconRefreshOutlineRegular, Button, Switch } = primitives

    //#region identity
    /** Dictionary namespace and CSS marker of this plugin. */
    const NS = 'usage-meter'
    /** Shared Connection channel every browser RPC rides on. */
    const API_CHANNEL = '/api'
    /** Endpoint prefix owned by the host half. */
    const ROUTE = 'usage-meter'
    /** Slot cell id inside `sidebar.footer.action`. */
    const SLOT_ID = 'quota'
    /** Tab cell id inside the Plugins settings section. */
    const PAGE_ID = 'usage-meter'
    /** Card cell id inside the Plugins panel. */
    const CARD_ID = 'usage-meter'
    /** How long the pointer must rest on the row before the panel opens. */
    const OPEN_DELAY_MS = 120
    /** How long the pointer may take to cross from the row into the panel. */
    const CLOSE_GRACE_MS = 200
    /** How often the row re-reads the host while the app is in the foreground. */
    const POLL_MS = 60_000
    //#endregion

    //#region styles
    /**
     * The shell's own footer-action rules under this plugin's prefix: the row
     * geometry, the rail variant, the menu elevation and the composer's own
     * meter ring, copied so the row matches its neighbours instead of
     * approximating them.
     */
    const css = [
      '.um_layer{flex:none;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative}',
      '.um_layer.is-rail{width:36px;height:36px;margin:0}',
      '.um_footerButtons{align-items:center;width:100%;display:flex}',
      '.um_layer.is-rail .um_footerButtons{flex-direction:column;gap:2px}',
      '.um_badge{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:12px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}',
      '.um_badge:hover,.um_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.um_layer.is-rail .um_badge{corner-shape:round;border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}',
      '.um_grow{flex:1;min-width:0}',
      '.um_figure{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;display:inline-flex;align-items:center;gap:5px}',
      '.um_icon{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;align-items:center}',
      '.um_value{color:var(--dsw-alias-label-primary)}',
      '.um_panel{isolation:isolate;z-index:1100;box-sizing:border-box;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:288px;max-width:calc(100vw - 24px);max-height:70vh;box-shadow:var(--dsw-elevation-prominent);border:0;border-radius:12px;position:fixed;overflow:hidden}',
      '.um_panel:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}',
      '.um_panelBody{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;padding:12px}',
      '.um_panelFoot{display:flex;align-items:center;gap:8px;margin-top:12px}',
      '.um_refresh{flex:none;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;padding:2px;display:inline-flex;align-items:center}',
      '.um_refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.um_refresh:disabled{opacity:.5;cursor:default}',
      '.um_group{margin-top:12px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.um_group:first-child{margin-top:0;padding-top:0;border-top:none}',
      '.um_caption{color:var(--dsw-alias-label-primary);font-weight:500;font-size:13px;margin:0 0 6px}',
      '.um_row{justify-content:space-between;align-items:center;gap:12px;display:flex}',
      '.um_row dt{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.um_row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0;flex:none}',
      '.um_bar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:4px;margin:6px 0 4px;overflow:hidden}',
      '.um_segment{border-radius:999px;height:100%;background:var(--dsw-alias-label-tertiary)}',
      '.um_segment.is-ok{background:var(--dsw-alias-state-success-primary)}',
      '.um_segment.is-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.um_segment.is-error{background:var(--dsw-alias-state-error-primary)}',
      '.um_meterBody{margin:0 0 10px}',
      '.um_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:8px 0 0}',
      '.um_note.is-error{color:var(--dsw-alias-state-error-primary)}',
      '.um_updated{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.um_summary{align-items:center;gap:12px;display:inline-flex;flex-wrap:wrap}',
      '.um_summaryFigure{align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;display:inline-flex}',
      '.um_page{box-sizing:border-box;width:100%;max-width:680px}',
      '.um_pageLead{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0 0 16px}',
      '.um_pageRows{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.um_pageRow{display:flex;align-items:center;gap:16px;padding:12px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}',
      '.um_pageRowIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);width:36px;height:36px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:inline-flex}',
      '.um_pageRowIcon .um_icon{display:inline-flex;align-items:center;justify-content:center;color:inherit}',
      '.um_pageRowIcon .um_icon svg{width:18px;height:18px}',
      '.um_pageBody{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.um_pageLabel{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;margin:0}',
      '.um_pageDetail{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.um_pageActions{display:flex;align-items:center;gap:16px;flex:none}',
      '.um_pageValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:13.5px;font-weight:500;line-height:20px;min-width:52px;text-align:right;flex:none}',
      '.um_pageFoot{display:flex;align-items:center;gap:12px;margin-top:16px}',
    ].join('')

    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${NS}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-usage-meter'
      style.dataset.pluginCss = NS
      style.textContent = css
      document.head.appendChild(style)
    }
    //#endregion

    //#region locales
    const en = {
      'row.aria': 'Plan usage: {summary}',
      'row.codex': 'Codex',
      'row.openrouter': 'OpenRouter',
      'row.deepseek': 'DeepSeek',
      'row.gemini': 'Gemini',
      'panel.aria': 'Plan and credit usage',
      'panel.codex': 'OpenAI Codex',
      'panel.gemini': 'Google Gemini (AI Pro)',
      'gemini.models': 'Gemini (Flash & Pro)',
      'gemini.argon': 'Argon',
      'gemini.thirdParty': 'Claude (Opus, Sonnet) & GPT-OSS',
      'window.5h': '5h',
      'window.week': 'weekly',
      'left': '{percent}% left',
      'resets.at': 'Resets {time}',
      'resets.in': 'in {time}',
      'resets.available': '{count} limit resets available',
      'limit.reached': 'Limit reached',
      'openrouter': 'OpenRouter credits',
      'openrouter.left': 'left of {total}',
      'openrouter.spent': 'Spent',
      'deepseek': 'DeepSeek balance',
      'deepseek.recharge': 'Recharge wallet',
      'deepseek.granted': 'Granted balance',
      'updated': 'Updated {time}',
      'refresh': 'Refresh the numbers',
      'unit.m': 'min',
      'unit.h': 'h',
      'unit.d': 'd',
      'error.reauth': 'Sign in to OpenAI Codex again',
      'error.codex': 'Could not read the Codex quota',
      'error.openrouter': 'Could not read the OpenRouter balance',
      'error.deepseek': 'Could not read the DeepSeek balance',
      'error.gemini': 'Could not read the Gemini quota',
      'error.generic': 'Could not read the quota',
      'empty': 'Nothing to show yet',
      'nothing': 'not available',
      'toggle': 'Show {name}',
      'page.tab': 'Quota meter',
      'card.label': 'Quota meter',
      'page.lead': 'The row in the sidebar foot, under your avatar. A provider you switch off is not read at all — no request is made and no key is touched.',
      'page.allOff': 'Every provider is off, so the sidebar row is hidden. Turn one on to bring it back.',
    }

    const ru = {
      'row.aria': 'Расход лимитов и кредитов: {summary}',
      'row.codex': 'Codex',
      'row.openrouter': 'OpenRouter',
      'row.deepseek': 'DeepSeek',
      'row.gemini': 'Gemini',
      'panel.aria': 'Лимиты и кредиты',
      'panel.codex': 'OpenAI Codex',
      'panel.gemini': 'Google Gemini (AI Pro)',
      'gemini.models': 'Gemini (Flash и Pro)',
      'gemini.argon': 'Argon',
      'gemini.thirdParty': 'Claude (Opus, Sonnet) и GPT-OSS',
      'window.5h': '5ч',
      'window.week': 'неделя',
      'left': 'осталось {percent}%',
      'resets.at': 'Сброс {time}',
      'resets.in': 'через {time}',
      'resets.available': 'Доступно сбросов лимита: {count}',
      'limit.reached': 'Лимит исчерпан',
      'openrouter': 'Кредиты OpenRouter',
      'openrouter.left': 'осталось из {total}',
      'openrouter.spent': 'Потрачено',
      'deepseek': 'Баланс DeepSeek',
      'deepseek.recharge': 'Пополняемый кошелёк',
      'deepseek.granted': 'Подарочный баланс',
      'updated': 'Обновлено {time}',
      'refresh': 'Обновить цифры',
      'unit.m': 'мин',
      'unit.h': 'ч',
      'unit.d': 'д',
      'error.reauth': 'Войдите в OpenAI Codex заново',
      'error.codex': 'Не удалось прочитать лимит Codex',
      'error.openrouter': 'Не удалось прочитать баланс OpenRouter',
      'error.deepseek': 'Не удалось прочитать баланс DeepSeek',
      'error.gemini': 'Не удалось прочитать квоту Gemini',
      'error.generic': 'Не удалось прочитать лимиты',
      'empty': 'Пока нечего показать',
      'nothing': 'нет данных',
      'toggle': 'Показывать {name}',
      'page.tab': 'Счётчик лимитов',
      'card.label': 'Счётчик лимитов',
      'page.lead': 'Строка в подвале сайдбара, под аватаркой. Выключенный провайдер не читается вообще: ни запроса, ни обращения к ключу.',
      'page.allOff': 'Все провайдеры выключены, поэтому строка в сайдбаре скрыта. Включите любой, чтобы вернуть её.',
    }
    //#endregion

    //#region helpers
    /** @param error - anything thrown. @returns a printable message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * Substitute `{name}` markers in a template.
     * @param template - raw template.
     * @param values - substitution map.
     * @returns the filled string.
     */
    function interpolate(template, values) {
      if (typeof template !== 'string' || values === void 0 || values === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : match,
      )
    }

    /**
     * A translation function that never throws: a slot owner without a locale
     * seat still renders the row, in English.
     * @param props - component props.
     * @returns the translate function.
     */
    function translator(props) {
      const t = props?.t
      if (typeof t === 'function') return t
      return (key, values) => interpolate(en[key] ?? key, values)
    }

    /** @param percent - a used percentage. @returns its tone class suffix. */
    function toneOf(percent) {
      if (percent >= 90) return 'is-error'
      if (percent >= 60) return 'is-warn'
      return 'is-ok'
    }

    /**
     * A compact "19 min" / "2 h 54 min" / "2 d 22 h" reading.
     *
     * The units are abbreviated rather than counted, because counting them would
     * force a plural rule per locale into the formatter; the abbreviation reads
     * the same in the row and in the panel.
     * @param milliseconds - remaining milliseconds.
     * @param t - translate function.
     * @returns the formatted duration.
     */
    function humanDuration(milliseconds, t) {
      const total = Math.max(0, Math.round(milliseconds / 60_000))
      if (total < 60) return `${total} ${t('unit.m')}`
      if (total < 60 * 24) {
        const minutes = total % 60
        const hours = `${Math.floor(total / 60)} ${t('unit.h')}`
        return minutes === 0 ? hours : `${hours} ${minutes} ${t('unit.m')}`
      }
      const hours = Math.floor(total / 60) % 24
      const days = `${Math.floor(total / (60 * 24))} ${t('unit.d')}`
      return hours === 0 ? days : `${days} ${hours} ${t('unit.h')}`
    }

    /** @param epochMs - absolute time. @returns the browser's local rendering. */
    function clockOf(epochMs) {
      return new Date(epochMs).toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    /** The currency signs the Platform reports. */
    const CURRENCY_SIGNS = { CNY: '¥', USD: '$' }

    /**
     * @param amount - a money amount.
     * @param currency - ISO currency code.
     * @param {number} [fractionDigits] - how many decimals to show.
     * @returns the rendering, or null when the amount is not a number.
     */
    function moneyOf(amount, currency, fractionDigits) {
      if (!Number.isFinite(amount)) return null
      const digits = fractionDigits ?? (Math.abs(amount) >= 100 ? 0 : 2)
      return `${CURRENCY_SIGNS[currency] ?? `${currency} `}${amount.toFixed(digits)}`
    }

    /**
     * The shortest window the backend reported — the rolling five-hour one, and
     * the one the row reads out.
     *
     * `primary` is the short window and `secondary` the long one, but a future
     * backend may order or lengthen them differently, so the row asks for the
     * shortest window it was handed rather than trusting the label.
     * @param codex - the Codex view.
     * @returns the window, or null.
     */
    function shortestWindow(codex) {
      const windows = Array.isArray(codex?.windows) ? codex.windows : []
      if (windows.length === 0) return null
      return windows.reduce((shortest, window) =>
        window.windowSeconds > 0 && window.windowSeconds < shortest.windowSeconds ? window : shortest,
      )
    }

    //#region marks
    /**
     * The three provider marks, taken from the Simple Icons set rather than
     * drawn here: the shell's own icon set has no brand glyph for anyone, and a
     * hand-drawn guess at a logo is worse than the real thing. Each is Simple
     * Icons' 24-unit path, rendered at the shell's icon size in `currentColor`,
     * so the marks follow the theme exactly as the sidebar's own icons do.
     *
     * They are filled shapes rather than the shell's stroked outlines, which is
     * how every brand mark is set anywhere; the 14px box carries the rest of the
     * fit, and every mark is the same neutral grey.
     */
    const GLYPH_CODEX = h('path', { fillRule: 'evenodd', d:
      "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" })
    const GLYPH_OPENROUTER = h('path', { d:
      "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" })
    const GLYPH_DEEPSEEK = h('path', { d:
      "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" })
    const GLYPH_GEMINI = h('path', { d:
      "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" })

    /**
     * One provider mark. Every mark is the same neutral grey: the icons
     * identify *who* a figure belongs to and nothing else, so a green Codex
     * mark would be spending colour on a fact the number next to it already
     * carries. The state colours stay where they belong — on the panel's bars.
     * @param props - `glyph`, `title`.
     * @returns the icon element.
     */
    function Mark({ glyph, title }) {
      return h(
        'span',
        { className: 'um_icon', title },
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 14,
            height: 14,
            fill: 'currentColor',
            stroke: 'none',
            'aria-hidden': 'true',
          },
          glyph,
        ),
      )
    }
    //#endregion

    /** The client runtime, kept module-level so the RPC helper can reach it. */
    const runtime = { ctx: null }
    //#endregion

    //#region transport
    /**
     * Call one of this plugin's host endpoints.
     * @param endpoint - endpoint name under the plugin's route.
     * @param payload - request payload.
     * @param signal - caller cancellation.
     * @returns the host's `{ ok, value }` / `{ ok, error }` envelope.
     */
    async function callRpc(endpoint, payload, signal) {
      const ctx = runtime.ctx
      const call = ctx?.connection?.rpc?.call
      if (typeof call !== 'function') {
        return { ok: false, error: { code: 'no-connection', message: 'the harness connection is unavailable' } }
      }
      try {
        const result = await call.call(ctx.connection.rpc, API_CHANNEL, `${ROUTE}/${endpoint}`, payload, signal)
        if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') return result
        return { ok: false, error: { code: 'bad-result', message: 'the host returned an unexpected result' } }
      } catch (error) {
        return { ok: false, error: { code: 'transport', message: messageOf(error) } }
      }
    }

    /**
     * The identity Platform expects on every call: the UI's language and its
     * offset east of UTC. Only the browser knows both.
     * @returns the client metadata.
     */
    function clientIdentity() {
      // `getLocale()` answers a snapshot — `{ active, locales, revision }` — not
      // a tag, so the id has to be read off `active`. Reading `.locale` here sent
      // Platform an undefined language and it fell back to its own default.
      const snapshot = runtime.ctx?.locale?.getLocale?.()
      const active = typeof snapshot === 'string' ? snapshot : snapshot?.active
      return {
        locale: typeof active === 'string' ? active : void 0,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
    }
    //#endregion

    //#region meter
    /**
     * One Codex quota window: what is left, the used bar, and when it comes
     * back — countdown first, absolute time beside it.
     * @param props - `window`, `title`, `now`, `t`.
     * @returns the row element.
     */
    function WindowRow({ window, title, now, t }) {
      const percent = Math.round(window.usedPercent)
      const remaining = window.resetAt === undefined ? undefined : window.resetAt - now
      const isExhausted = percent >= 100 || window.limitReached === true
      const statusText = isExhausted ? `${t('limit.reached')} · 0%` : t('left', { percent: 100 - percent })
      return h(
        'div',
        { className: 'um_meterBody' },
        h('div', { className: 'um_row' }, h('dt', null, title), h('dd', null, statusText)),
        h(
          'div',
          { className: 'um_bar' },
          h('div', {
            className: `um_segment ${toneOf(percent)}`,
            style: { width: `${percent > 0 ? Math.max(percent, 2) : 0}%` },
          }),
        ),
        remaining === undefined
          ? null
          : h('p', {
              className: `um_note${isExhausted ? ' is-error' : ''}`,
              // The wall-clock moment first, because that is the one you can plan
              // around, then how far off it is.
              children: `${t('resets.at', { time: clockOf(window.resetAt) })} · ${t('resets.in', { time: humanDuration(remaining, t) })}`,
            }),
      )
    }

    /**
     * A caption plus its `label: value` rows.
     * @param props - `caption` and `rows` of `{ key, label, value }`.
     * @returns the group element.
     */
    function Group({ caption, rows }) {
      if (rows.length === 0) return null
      return h(
        'div',
        { className: 'um_group' },
        h('p', { className: 'um_caption', children: caption }),
        ...rows.map((row) =>
          h(
            'div',
            { className: 'um_row', key: row.key },
            h('dt', { children: row.label }),
            h('dd', { children: row.value }),
          ),
        ),
      )
    }

    /**
     * The sidebar row: a ring and a percentage for the five-hour Codex window,
     * then the OpenRouter balance and the DeepSeek wallet. The panel behind it
     * — opened on hover, pinned by a click — carries everything.
     * @param props - the slot's standard props, including `wide`.
     * @returns the element, or null when there is nothing at all to show.
     */
    function UsageMeter(props) {
      const t = translator(props)
      const wide = props?.wide !== false

      const [snapshot, setSnapshot] = useState(null)
      const [failure, setFailure] = useState(null)
      const [loading, setLoading] = useState(false)
      const [open, setOpen] = useState(false)
      const [pinned, setPinned] = useState(false)
      const [now, setNow] = useState(() => Date.now())
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const openTimer = useRef(null)
      const closeTimer = useRef(null)

      const load = useCallback(async (force) => {
        setLoading(true)
        const result = await callRpc('usage', { ...clientIdentity(), ...(force === true ? { force: true } : {}) })
        if (result.ok) {
          setSnapshot(result.value.snapshot)
          setFailure(result.value.snapshot?.errors ?? null)
        } else {
          setFailure({ codex: { code: result.error?.code, message: result.error?.message } })
        }
        setLoading(false)
      }, [])

      useEffect(() => {
        void load(true)
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load(false)
        }, POLL_MS)
        const onVisible = () => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') void load(false)
        }
        document?.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document?.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      // One tick a second keeps the countdown in the panel honest without a
      // network round trip: only the rendering changes.
      useEffect(() => {
        if (!open) return undefined
        const tick = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(tick)
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          setOpen(false)
          setPinned(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open])

      useEffect(
        () => () => {
          clearTimeout(openTimer.current)
          clearTimeout(closeTimer.current)
        },
        [],
      )

      // Hover opens; leaving closes unless the row was pinned by a click. The
      // grace period is what lets the pointer cross from the row into the panel,
      // which is portaled and therefore outside the row's own events.
      const cancelTimers = useCallback(() => {
        clearTimeout(openTimer.current)
        clearTimeout(closeTimer.current)
        openTimer.current = null
        closeTimer.current = null
      }, [])
      const show = useCallback(() => {
        cancelTimers()
        setNow(Date.now())
        setOpen(true)
      }, [cancelTimers])
      const scheduleShow = useCallback(() => {
        if (open || pinned) return
        cancelTimers()
        openTimer.current = setTimeout(show, OPEN_DELAY_MS)
      }, [open, pinned, cancelTimers, show])
      const scheduleHide = useCallback(() => {
        if (pinned) return
        cancelTimers()
        closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS)
      }, [pinned, cancelTimers])

      const position = useAnchoredPosition({
        open,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        gap: 8,
        margin: 12,
      })
      useDismissOnOutsidePointer(rootRef, open, () => {
        setOpen(false)
        setPinned(false)
      }, panelRef)

      const codex = snapshot?.codex ?? null
      const openrouter = snapshot?.openrouter ?? null
      const deepseek = snapshot?.deepseek ?? null
      const gemini = snapshot?.gemini ?? null
      const errors = failure ?? {}
      // A provider switched off in the Plugins page is off here too, and the
      // host is not even reading it.
      const shows = snapshot?.visible ?? { codex: true, openrouter: true, deepseek: true, gemini: true }

      const shortWindow = useMemo(() => shortestWindow(codex), [codex])
      const openrouterRow = openrouter === null ? null : moneyOf(openrouter.remaining, 'USD')
      const geminiRemaining = gemini?.gemini?.remainingPercent

      // Platform splits the balance in two: the *recharge* wallets, which are
      // what a paid top-up lands in, and the *granted* bonus wallets, which is
      // where a gifted balance lands. Plenty of accounts hold money in only one
      // of them, so the row shows the first wallet that actually holds some —
      // a row reading `$0.00` next to a real granted balance says nothing.
      const deepseekRow = useMemo(() => {
        const wallets = [
          ...(deepseek?.wallets ?? []).map((wallet) => ({ ...wallet, granted: false })),
          ...(deepseek?.bonusWallets ?? []).map((wallet) => ({ ...wallet, granted: true })),
        ]
        return (
          wallets.find((wallet) => wallet.balance > 0) ?? wallets.find((wallet) => Number.isFinite(wallet.balance))
        ) ?? null
      }, [deepseek])

      // The Codex backend reports the *used* share of a window; a quota meter
      // answers "how much is left". The row therefore reads the complement —
      // reporting `used_percent` verbatim would say 5% just after a window reset,
      // at the moment when 95% is exactly what is left.
      const used = shortWindow === null ? null : Math.round(shortWindow.usedPercent)
      const remaining = used === null ? null : 100 - used
      const deepseekMoney = deepseekRow === null ? null : moneyOf(deepseekRow.balance, deepseekRow.currency)

      // One place decides whether the row is drawn, so the sidebar and the
      // Plugins page can never disagree about it.
      const figures = {
        codex: { on: shows.codex, mark: GLYPH_CODEX, value: `${remaining ?? '—'}%` },
        gemini: { on: shows.gemini, mark: GLYPH_GEMINI, value: `${geminiRemaining ?? '—'}%` },
        openrouter: { on: shows.openrouter, mark: GLYPH_OPENROUTER, value: openrouterRow },
        deepseek: { on: shows.deepseek, mark: GLYPH_DEEPSEEK, value: deepseekMoney },
      }
      const showsAnything = [
        figures.codex.on && (codex !== null || errors.codex != null),
        figures.gemini.on && (gemini !== null || errors.gemini != null),
        figures.openrouter.on && openrouterRow !== null,
        figures.deepseek.on && deepseekMoney !== null,
      ].some(Boolean)

      // A row with nothing in it is noise in the foot: there is already a
      // Settings row there, and an empty quota row beside it says nothing.
      // Turning every provider off hides the row outright — which is also why
      // the Plugins page says so where the user turned it off.
      if (!showsAnything) return null

      const summary = [
        codex === null ? void 0 : `${t('row.codex')} ${t('left', { percent: remaining ?? '—' })}`,
        geminiRemaining === undefined || gemini === null ? void 0 : `${t('row.gemini')} ${t('left', { percent: geminiRemaining })}`,
        openrouterRow,
        deepseekMoney,
      ]
        .filter((part) => part !== void 0 && part !== null)
        .join(' · ')
      // With no figures at all the row is only saying something went wrong, so
      // the accessible name has to say *what*.
      const spoken =
        summary !== ''
          ? summary
          : errors.codex == null
            ? t('empty')
            : errors.codex.code === 'codex-reauth'
              ? t('error.reauth')
              : t('error.generic')

      // Providers, each introduced by its own mark.
      const badgeChildren = []
      // A provider that is on but has nothing to report still earns its place
      // when it failed: a silent gap is the one thing a quota meter must not do.
      const drawn = {
        codex: shows.codex && (codex !== null || errors.codex != null),
        gemini: shows.gemini && (gemini !== null || errors.gemini != null),
        openrouter: shows.openrouter && openrouterRow !== null,
        deepseek: shows.deepseek && deepseekMoney !== null,
      }
      if (drawn.codex) badgeChildren.push(figure('codex', figures.codex))
      if (drawn.gemini && (!drawn.codex || wide)) badgeChildren.push(figure('gemini', figures.gemini))
      if (wide) {
        if (drawn.openrouter) badgeChildren.push(figure('openrouter', figures.openrouter))
        if (drawn.deepseek) {
          // The mark says *which* wallet the number is, which is the whole
          // reason the two kinds are never summed.
          badgeChildren.push(
            figure('deepseek', {
              ...figures.deepseek,
              title: `${t('row.deepseek')} · ${deepseekRow.granted ? t('deepseek.granted') : t('deepseek.recharge')}`,
            }),
          )
        }
      }

      /** One figure: its provider mark, then the number it stands for. */
      function figure(key, spec) {
        return h(
          'span',
          { key, className: 'um_figure', title: spec.title },
          h(Mark, { key: 'mark', glyph: spec.mark, title: spec.title }),
          h('span', { key: 'value', className: 'um_value', children: spec.value }),
        )
      }

      const badge = h('button', {
        type: 'button',
        className: 'um_badge',
        // The row is the panel's anchor and its "inside" boundary: without this
        // the anchored position has nothing to measure and every pointerdown —
        // including the one that precedes a click on the row itself — counts as
        // an outside dismissal.
        ref: rootRef,
        'aria-label': interpolate(t('row.aria'), { summary: spoken }),
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'data-active': open || void 0,
        onClick: () => {
          cancelTimers()
          setNow(Date.now())
          setPinned((was) => !was)
          setOpen((was) => !was)
        },
        onPointerEnter: scheduleShow,
        onPointerLeave: scheduleHide,
        onFocus: show,
        onBlur: scheduleHide,
        children: badgeChildren,
      })

      // Three providers, three groups, one shape. The Codex group used to carry a
      // bold header, a plan name and a tinted lamp, which made it read as the
      // subject of the panel and the other two as footnotes; they are peers, so
      // all three get the same caption and the same rows.
      const groups = []
      if (codex !== null) {
        groups.push(
          h(
            'div',
            { className: 'um_group', key: 'codex' },
            h('p', { className: 'um_caption', children: t('panel.codex') }),
            codex.limitReached ? h('p', { className: 'um_note is-error', children: t('limit.reached') }) : null,
            ...codex.windows.map((window) =>
              h(WindowRow, {
                key: window.key,
                window,
                title: window.windowSeconds >= 604_800 ? t('window.week') : t('window.5h'),
                now,
                t,
              }),
            ),
            codex.resetsAvailable > 0
              ? h('p', { className: 'um_note', children: t('resets.available', { count: codex.resetsAvailable }) })
              : null,
            errors.codex == null
              ? null
              : h('p', {
                  className: 'um_note is-error',
                  children:
                    errors.codex.code === 'codex-reauth' ? t('error.reauth') : (errors.codex.message ?? t('error.codex')),
                }),
          ),
        )
      }
      if (gemini !== null) {
        const geminiWindows = []
        if (gemini.gemini) {
          geminiWindows.push(
            h(WindowRow, {
              key: 'gemini-models',
              window: gemini.gemini,
              title: t('gemini.models'),
              now,
              t,
            }),
          )
        }
        if (gemini.argon) {
          geminiWindows.push(
            h(WindowRow, {
              key: 'gemini-argon',
              window: gemini.argon,
              title: t('gemini.argon'),
              now,
              t,
            }),
          )
        }
        if (gemini.claude) {
          geminiWindows.push(
            h(WindowRow, {
              key: 'gemini-claude',
              window: gemini.claude,
              title: t('gemini.thirdParty'),
              now,
              t,
            }),
          )
        }
        groups.push(
          h(
            'div',
            { className: 'um_group', key: 'gemini' },
            h('p', { className: 'um_caption', children: t('panel.gemini') }),
            ...geminiWindows,
            errors.gemini == null
              ? null
              : h('p', { className: 'um_note is-error', children: errors.gemini.message ?? t('error.gemini') }),
          ),
        )
      }
      if (openrouter !== null) {
        groups.push(
          h(Group, {
            key: 'openrouter',
            caption: t('openrouter'),
            rows: [
              { key: 'left', label: t('openrouter.left', { total: moneyOf(openrouter.totalCredits, 'USD') ?? '—' }), value: moneyOf(openrouter.remaining, 'USD') ?? '—' },
              { key: 'spent', label: t('openrouter.spent'), value: moneyOf(openrouter.totalUsage, 'USD') ?? '—' },
            ],
          }),
        )
      }
      if (deepseek !== null) {
        // Both wallet kinds are listed, empties included: a zero recharge wallet
        // is what tells you that the money you have is granted money.
        const walletRows = (wallets, granted) =>
          wallets.map((wallet) => ({
            key: `${granted ? 'g' : 'r'}-${wallet.currency}`,
            label: granted
              ? `${t('deepseek.granted')} · ${wallet.currency}`
              : `${t('deepseek.recharge')} · ${wallet.currency}`,
            value: moneyOf(wallet.balance, wallet.currency) ?? '—',
          }))
        groups.push(
          h(Group, {
            key: 'deepseek',
            caption: t('deepseek'),
            rows: [
              ...walletRows(deepseek.wallets ?? [], false),
              ...walletRows(deepseek.bonusWallets ?? [], true),
            ],
          }),
        )
      }
      for (const [key, label] of [
        ['gemini', 'error.gemini'],
        ['openrouter', 'error.openrouter'],
        ['deepseek', 'error.deepseek'],
      ]) {
        if (errors[key] == null || (key === 'gemini' && gemini !== null)) continue
        groups.push(
          h('p', { className: 'um_note is-error', key: `${key}-error`, children: errors[key].message ?? t(label) }),
        )
      }

      const panel = h(
        'div',
        {
          ref: panelRef,
          className: 'um_panel',
          style: position ?? { visibility: 'hidden', left: 0, top: 0 },
          role: 'dialog',
          'aria-label': t('panel.aria'),
          onPointerEnter: cancelTimers,
          onPointerLeave: scheduleHide,
          children: h(
            'div',
            { className: 'um_panelBody' },
            groups.length === 0 ? h('p', { className: 'um_note', children: t('empty') }) : groups,
            h(
              'div',
              { className: 'um_row um_panelFoot' },
              snapshot?.fetchedAt === undefined
                ? h('span', null)
                : h('span', { className: 'um_updated', children: t('updated', { time: clockOf(snapshot.fetchedAt) }) }),
              h('button', {
                type: 'button',
                className: 'um_refresh',
                disabled: loading,
                title: t('refresh'),
                'aria-label': t('refresh'),
                onClick: (e) => {
                  e.stopPropagation()
                  void load(true)
                },
                children: h(IconRefreshOutlineRegular, { size: 14 }),
              }),
            ),
          ),
        },
      )

      return h(
        'div',
        { className: `um_layer${wide ? '' : ' is-rail'}` },
        h('div', { className: 'um_footerButtons' }, badge, open ? createPortal(panel, document.body) : null),
      )
    }
    //#endregion

    //#region page
    /**
     * The Plugins page: the same figures at a readable size, and a switch per
     * provider. The switches write straight through the host, so the choice
     * survives a restart and the host stops reading a provider the moment it is
     * switched off rather than merely hiding what it already fetched.
     */
    function MeterSettings(props) {
      const t = translator(props)
      // One component, two views: the Plugins card asks for a one-liner in its
      // summary and the full page once the card is opened.
      const summary = props?.view === 'summary'
      const [snapshot, setSnapshot] = useState(null)
      const [visible, setVisible] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)

      const load = useCallback(async () => {
        const result = await callRpc('usage', { ...clientIdentity(), force: true })
        if (result.ok) {
          setSnapshot(result.value.snapshot)
          setVisible(result.value.snapshot?.visible ?? null)
          setFailure(null)
        } else {
          setFailure(result.error?.message ?? t('error.generic'))
        }
      }, [t])

      useEffect(() => {
        void load()
      }, [load])

      const toggle = async (provider, next) => {
        setBusy(true)
        // Optimistic: a switch that waits for a round trip feels broken.
        const before = visible
        setVisible({ ...(visible ?? {}), [provider]: next })
        const result = await callRpc('preferences', { visible: { [provider]: next } })
        if (result.ok) setVisible(result.value.visible)
        else {
          setVisible(before)
          setFailure(result.error?.message ?? t('error.generic'))
        }
        await load()
        setBusy(false)
      }

      const codex = snapshot?.codex ?? null
      const openrouter = snapshot?.openrouter ?? null
      const deepseek = snapshot?.deepseek ?? null
      const gemini = snapshot?.gemini ?? null
      const errors = snapshot?.errors ?? {}
      const on = visible ?? { codex: true, openrouter: true, deepseek: true, gemini: true }
      const shortWindow = shortestWindow(codex)
      // Platform keeps the recharge and the granted wallets apart; the headline
      // is the first one that actually holds money, for the same reason the
      // sidebar row works that way.
      const deepseekFigure = (() => {
        const wallets = (deepseek?.wallets ?? []).concat((deepseek?.bonusWallets ?? []).map((wallet) => ({ ...wallet, granted: true })))
        const chosen = wallets.find((wallet) => wallet.balance > 0) ?? wallets[0]
        return chosen === undefined ? '—' : (moneyOf(chosen.balance, chosen.currency) ?? '—')
      })()

      const rows = [
        {
          key: 'codex',
          mark: GLYPH_CODEX,
          label: t('row.codex'),
          detail: shortWindow === null
            ? errors.codex == null
              ? t('nothing')
              : (errors.codex.code === 'codex-reauth' ? t('error.reauth') : t('error.codex'))
            : t('left', { percent: 100 - Math.round(shortWindow.usedPercent) }),
          figure: shortWindow === null ? '—' : `${100 - Math.round(shortWindow.usedPercent)}%`,
        },
        {
          key: 'gemini',
          mark: GLYPH_GEMINI,
          label: t('row.gemini'),
          detail: gemini?.gemini == null
            ? errors.gemini == null
              ? t('nothing')
              : (errors.gemini.message ?? t('error.gemini'))
            : t('left', { percent: gemini.gemini.remainingPercent }),
          figure: gemini?.gemini == null ? '—' : `${gemini.gemini.remainingPercent}%`,
        },
        {
          key: 'openrouter',
          mark: GLYPH_OPENROUTER,
          label: t('row.openrouter'),
          detail: openrouter === null ? t('nothing') : t('openrouter.left', { total: moneyOf(openrouter.totalCredits, 'USD') ?? '—' }),
          figure: openrouter === null ? '—' : (moneyOf(openrouter.remaining, 'USD') ?? '—'),
        },
        {
          key: 'deepseek',
          mark: GLYPH_DEEPSEEK,
          label: t('row.deepseek'),
          detail: (deepseek?.wallets ?? []).concat((deepseek?.bonusWallets ?? []).map((wallet) => ({ ...wallet, granted: true })))
            .filter((wallet) => wallet.balance > 0)
            .map((wallet) => `${wallet.currency} ${moneyOf(wallet.balance, wallet.currency) ?? '—'}`)
            .join(' · ') || t('nothing'),
          figure: deepseekFigure,
        },
      ]

      const figures = [
        codex === null ? null : { mark: GLYPH_CODEX, value: `${100 - Math.round(shortWindow.usedPercent)}%` },
        gemini?.gemini == null ? null : { mark: GLYPH_GEMINI, value: `${gemini.gemini.remainingPercent}%` },
        openrouter === null ? null : { mark: GLYPH_OPENROUTER, value: moneyOf(openrouter.remaining, 'USD') ?? '—' },
        deepseek === null ? null : { mark: GLYPH_DEEPSEEK, value: deepseekFigure },
      ].filter((figure) => figure !== null)

      if (summary) {
        return h(
          'span',
          { className: 'um_summary' },
          figures.length === 0
            ? t('nothing')
            : figures.map((figure, index) =>
                h(
                  'span',
                  { className: 'um_summaryFigure', key: index },
                  h(Mark, { key: 'mark', glyph: figure.mark }),
                  h('span', { key: 'value', children: figure.value }),
                ),
              ),
        )
      }

      return h(
        'div',
        { className: 'um_page' },
        h(
          'p',
          { className: 'um_pageLead' },
          t('page.lead'),
        ),
        h(
          'div',
          { className: 'um_pageRows' },
          ...rows.map((row) =>
            h(
              'div',
              { className: 'um_pageRow', key: row.key },
              h(
                'div',
                { className: 'um_pageRowIcon' },
                h(Mark, { key: 'mark', glyph: row.mark, title: row.label }),
              ),
              h(
                'div',
                { key: 'body', className: 'um_pageBody' },
                h('p', { className: 'um_pageLabel', children: row.label }),
                h('p', { className: 'um_pageDetail', children: row.detail }),
              ),
              h(
                'div',
                { key: 'actions', className: 'um_pageActions' },
                h('span', { key: 'value', className: 'um_pageValue', children: row.figure }),
                h(Switch, {
                  key: 'switch',
                  checked: on[row.key] === true,
                  disabled: busy,
                  label: t('toggle', { name: row.label }),
                  title: t('toggle', { name: row.label }),
                  onChange: (next) => void toggle(row.key, next),
                }),
              ),
            ),
          ),
        ),
        failure === null ? null : h('p', { className: 'um_note is-error', children: failure }),
        Object.values(on).every((value) => value !== true)
          ? h('p', { className: 'um_note', children: t('page.allOff') })
          : null,
        h(
          'div',
          { className: 'um_pageFoot' },
          h(Button, {
            variant: 'outline',
            size: 'sm',
            icon: h(IconRefreshOutlineRegular, { size: 14 }),
            disabled: busy,
            onClick: () => void load(),
            children: t('refresh'),
          }),
          snapshot?.fetchedAt === undefined
            ? null
            : h('span', { className: 'um_updated', children: t('updated', { time: clockOf(snapshot.fetchedAt) }) }),
        ),
      )
    }
    //#endregion

    //#region mount
    /** Client services this bundle needs before it can mount anything. */
    const inject = ['connection', 'slots', 'locale']

    /**
     * Register the meter in the shipped seat beside the account button.
     * @param ctx - client runtime.
     * @returns the unmount disposer.
     */
    function apply(ctx) {
      runtime.ctx = ctx
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'usage-meter: locale dictionaries')
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: SLOT_ID, order: 10, locale: NS }, UsageMeter),
      )
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-usage-meter',
            locale: NS,
          },
          MeterSettings,
        ),
      )
      console.info(`[usage-meter] mounted ${new Date().toISOString()}`)
      return () => {
        runtime.ctx = null
        console.info(`[usage-meter] unmounted ${new Date().toISOString()}`)
      }
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    exports.internals = {
      NS,
      API_CHANNEL,
      ROUTE,
      SLOT_ID,
      en,
      ru,
      css,
      UsageMeter,
      MeterSettings,
      WindowRow,
      Group,
      callRpc,
      clientIdentity,
      toneOf,
      humanDuration,
      clockOf,
      moneyOf,
      shortestWindow,
      interpolate,
      runtime,
    }
    return module.exports
  },
})