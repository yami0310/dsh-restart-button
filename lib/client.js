/**
 * dsh-restart-button · 网页半边
 * ============================================================================
 * 往侧栏底部（`sidebar.footer.action`）注册一个「重新启动」按钮。
 *
 * 这个文件是**自注册脚本**，不是 ESM：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 * `id` 必须等于 package.json 的 name，否则宿主不认。
 *
 * 交互：点一下 → 变成「确认重启?」→ 3 秒内再点才真的重启。
 * 为什么不是点一下就重启：这个按钮会立刻掐断当前会话（进程被杀），
 * 侧栏底部又紧挨着设置入口，手滑一下代价太大。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const API = '/api/dsh-restart-button'
    const CONFIRM_MS = 3000

    /** 圆环箭头。用 currentColor，跟着主题令牌走。 */
    const RestartIcon = ({ size }) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M13.2 6.4A5.4 5.4 0 1 0 13 10',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.4 3.2v3.4h-3.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )

    const styles = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        minWidth: 28,
        padding: '0 6px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1,
        justifyContent: 'center',
        flex: 'none',
      },
      confirming: {
        color: 'var(--dsw-alias-state-warning-primary, #d98b2b)',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
      },
      busy: {
        opacity: 0.65,
        cursor: 'default',
      },
      label: {
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
    }

    /**
     * @param {{ wide?: boolean }} props 侧栏传下来的展开态。
     *   展开时显示文字，收成 56px 竖条时只剩图标。
     */
    function RestartButton(props) {
      const wide = props?.wide === true
      const [phase, setPhase] = useState('idle') // idle | confirm | restarting | error
      const [message, setMessage] = useState('')
      const timer = useRef(null)

      useEffect(
        () => () => {
          if (timer.current !== null) clearTimeout(timer.current)
        },
        [],
      )

      const restart = async () => {
        setPhase('restarting')
        setMessage('正在重启…')
        try {
          const res = await fetch(API + '/restart', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok !== true) {
            throw new Error(body.error || 'HTTP ' + res.status)
          }
        } catch (error) {
          setPhase('error')
          setMessage('重启失败：' + (error?.message ?? String(error)))
          return
        }

        // 进程马上就会消失，页面也会跟着关掉；这里只负责把话说清楚。
        // 万一宿主只是重启了服务端而页面还在，轮询到接口恢复就自动刷新。
        const startedAt = Date.now()
        const poll = async () => {
          if (Date.now() - startedAt > 180_000) {
            setPhase('error')
            setMessage('等了 3 分钟没回来，请手动打开 DSH')
            return
          }
          try {
            const res = await fetch(API + '/status', { credentials: 'same-origin', cache: 'no-store' })
            if (res.ok) {
              window.location.reload()
              return
            }
          } catch {
            /* 连不上 = 正在重启，继续等 */
          }
          timer.current = setTimeout(poll, 1500)
        }
        timer.current = setTimeout(poll, 1500)
      }

      const onClick = () => {
        if (phase === 'restarting') return
        if (phase === 'confirm') {
          if (timer.current !== null) clearTimeout(timer.current)
          restart()
          return
        }
        setPhase('confirm')
        setMessage('确认重启？')
        timer.current = setTimeout(() => {
          setPhase('idle')
          setMessage('')
        }, CONFIRM_MS)
      }

      const text =
        message ||
        (phase === 'confirm' ? '确认重启？' : '重新启动')

      const style = {
        ...styles.button,
        ...(phase === 'confirm' ? styles.confirming : null),
        ...(phase === 'restarting' ? styles.busy : null),
      }

      return h(
        'button',
        {
          type: 'button',
          style,
          title: '重新启动 DeepSeek Harness（会中断当前会话）',
          'aria-label': '重新启动 DeepSeek Harness',
          'data-dsh-restart-button': '',
          onClick,
          onBlur: () => {
            if (phase !== 'confirm') return
            if (timer.current !== null) clearTimeout(timer.current)
            setPhase('idle')
            setMessage('')
          },
        },
        h(RestartIcon, { size: 15 }),
        wide ? h('span', { style: styles.label }, text) : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('sidebar.footer.action', () =>
        slots.register(
          { name: 'sidebar.footer.action', id: 'restart-button', order: 10 },
          RestartButton,
        ),
      )
    }

    return { inject, apply }
  },
})
