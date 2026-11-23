// 小鱼钟（fish-clock）· 网页半边
//
// 只干一件事：在「插件 → 已安装 → fish-clock」的详情里摆一块设置面板，
// 让人不用手改 JSON 就能：开关、改每天必发的时段、改随机补几次、改安静时段、改她开口那句话。
//
// 数据全走宿主半边（index.js）注册的本机接口 /fish-clock/*，这里不碰会话、不发消息。
//
// 宿主装载契约（照 dsh-onebot-qq / dsh-speak-up 的写法，别改）：
//   - CJS 包裹：window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
//   - 导出 inject（客户端服务名）与 apply(ctx)
//   - 面板：ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name, key }, render))

window.__ModuleLoader__.load({
  id: 'fish-clock',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/fish-clock'
    const h = React.createElement

    const get = (p) =>
      fetch(B + p, { cache: 'no-store', headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .catch(() => null)

    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    // ── 样式：跟着宿主主题变量走，换个皮肤也不会花 ──────────────────────
    const CSS = `
.fc-wrap{font-size:13px;line-height:1.7;color:var(--dsw-alias-fg-l1,#1f2328);max-width:760px}
.fc-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:12px;
  padding:14px 16px;margin:0 0 12px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.62))}
.fc-head{display:flex;align-items:center;gap:10px;margin:0 0 10px}
.fc-title{font-size:14px;font-weight:600;margin:0}
.fc-dim{opacity:.62;font-size:12px}
.fc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}
.fc-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;
  font-size:12px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.10));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03))}
.fc-chip b{font-weight:600;font-variant-numeric:tabular-nums}
.fc-chip.is-done{opacity:.55;text-decoration:line-through}
.fc-chip.is-next{border-color:var(--dsw-alias-accent,#3b82f6);color:var(--dsw-alias-accent,#3b82f6)}
.fc-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-accent,#3b82f6)}
.fc-chip.is-done .fc-dot{background:currentColor}
.fc-field{display:flex;align-items:center;gap:8px;margin:8px 0;flex-wrap:wrap}
.fc-field>label{min-width:96px;opacity:.8}
.fc-in,.fc-sel{font:inherit;color:inherit;padding:4px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.16));
  background:var(--dsw-alias-bg-layer-1,#fff)}
.fc-in[type=time]{width:104px}
.fc-in[type=number]{width:76px}
.fc-ta{width:100%;min-height:64px;resize:vertical;font:inherit;color:inherit;padding:8px 10px;
  border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.16));
  background:var(--dsw-alias-bg-layer-1,#fff)}
.fc-btn{font:inherit;cursor:pointer;padding:5px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.16));
  background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}
.fc-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.fc-btn.fc-primary{background:var(--dsw-alias-accent,#3b82f6);border-color:transparent;color:#fff}
.fc-btn.fc-primary:disabled{opacity:.45;cursor:not-allowed}
.fc-btn.fc-ghost{border-color:transparent;background:transparent;opacity:.7;padding:2px 8px}
.fc-btn.fc-ghost:hover{opacity:1}
.fc-foot{display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap}
.fc-ok{color:var(--dsw-alias-success,#16a34a);font-size:12px}
.fc-err{color:var(--dsw-alias-danger,#dc2626);font-size:12px}
.fc-log{max-height:180px;overflow:auto;margin:8px 0 0;padding:8px 10px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap}
.fc-sw{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.fc-sw input{width:16px;height:16px;cursor:pointer}
`

    // ── 小零件 ─────────────────────────────────────────────────────────
    function 开关(props) {
      return h(
        'label',
        { className: 'fc-sw' },
        h('input', { type: 'checkbox', checked: props.on, onChange: (e) => props.onChange(e.target.checked) }),
        h('span', null, props.on ? '开着' : '关了'),
      )
    }

    function 时段行(props) {
      const v = props.value || ['09:00', '10:00']
      const 改 = (i) => (e) => {
        const 下一个 = [v[0], v[1]]
        下一个[i] = e.target.value
        props.onChange(下一个)
      }
      return h(
        'div',
        { className: 'fc-field' },
        h('input', { className: 'fc-in', type: 'time', value: v[0], onChange: 改(0) }),
        h('span', { className: 'fc-dim' }, '到'),
        h('input', { className: 'fc-in', type: 'time', value: v[1], onChange: 改(1) }),
        props.onRemove
          ? h('button', { className: 'fc-btn fc-ghost', type: 'button', onClick: props.onRemove, title: '删掉这一段' }, '删掉')
          : null,
      )
    }

    function 状态标签(项, 下一个) {
      const 类 = 项.类 === '固定' ? '必发' : 项.类 === '额外' ? '随机' : '手动'
      const 名 = ['fc-chip', 项.已发 ? 'is-done' : '', 项.时间 === 下一个 ? 'is-next' : ''].filter(Boolean).join(' ')
      const 说 = 项.已发 ? '已经发过了' : 项.已过 ? '这个点过了（在等补发窗口）' : '还没到'
      return h(
        'span',
        { className: 名, key: 项.时间 + 项.类, title: 说 },
        h('span', { className: 'fc-dot' }),
        h('b', null, 项.时间),
        h('span', { className: 'fc-dim' }, 类),
        h('span', { className: 'fc-dim' }, 项.已发 ? '✓' : ''),
      )
    }

    // ── 主面板 ─────────────────────────────────────────────────────────
    function 面板() {
      const [状态, 设状态] = React.useState(null)
      const [草稿, 设草稿] = React.useState(null)
      const [说, 设说] = React.useState('')
      const [错, 设错] = React.useState('')
      const [忙, 设忙] = React.useState(false)
      const [开日志, 设开日志] = React.useState(false)

      const 装 = React.useCallback((数据) => {
        if (!数据 || !数据.配置) return
        设状态(数据)
        设草稿(JSON.parse(JSON.stringify(数据.配置)))
      }, [])

      React.useEffect(() => {
        void get('/state').then(装)
      }, [装])

      if (!状态 || !草稿) return h('div', { className: 'fc-wrap' }, h('div', { className: 'fc-dim' }, '正在读配置…'))

      const 脏 = JSON.stringify(草稿) !== JSON.stringify(状态.配置)

      const 改 = (字段, 值) => 设草稿(Object.assign({}, 草稿, { [字段]: 值 }))

      const 保存 = async () => {
        设忙(true); 设错(''); 设说('')
        const 回 = await post('/save', { 配置: 草稿 })
        设忙(false)
        if (回 && 回.ok) { 装(回); 设说('已保存，下一分钟就按新表走') } else { 设错((回 && 回.说) || '保存失败') }
      }

      const 试一条 = async () => {
        if (!window.confirm('现在就叫她开口一次？\n会用掉一点余额，大概几十秒后你 QQ 上就能看到。')) return
        设忙(true); 设错(''); 设说('')
        const 回 = await post('/send', {})
        设忙(false)
        if (回 && 回.ok) { if (回.状态) 装(回.状态); 设说(回.说 || '已经交给她了') } else { 设错((回 && 回.说) || '没送成') }
      }

      const 固定窗口 = Array.isArray(草稿.固定窗口) ? 草稿.固定窗口 : []
      const 额外次数 = Array.isArray(草稿.额外次数) ? 草稿.额外次数 : [1, 2]
      const 额外时段 = Array.isArray(草稿.额外时段) ? 草稿.额外时段 : ['09:00', '23:00']

      return h(
        'div',
        { className: 'fc-wrap' },

        // 顶栏：开关 + 一句话状态
        h(
          'div',
          { className: 'fc-card' },
          h(
            'div',
            { className: 'fc-head' },
            h('h3', { className: 'fc-title' }, '小鱼钟'),
            h('span', { className: 'fc-dim' }, 'v' + (状态.版本 || '1.0.0')),
            h('span', { style: { flex: 1 } }),
            开关({ on: 草稿.总开关 !== false, onChange: (v) => 改('总开关', v) }),
          ),
          h('div', { className: 'fc-dim' }, '到点叫她主动找你。跟你们昨天聊没聊过完全无关 —— 三个时段每天都发。'),
          h(
            'div',
            { className: 'fc-dim', style: { marginTop: 4 } },
            状态.安静中
              ? '现在是安静时段（' + 状态.配置.安静起 + ' 点到 ' + 状态.配置.安静止 + ' 点），一条都不会发。'
              : '下一个：' + (状态.下一个 || '今天没有了'),
          ),
        ),

        // 今天的表
        h(
          'div',
          { className: 'fc-card' },
          h('div', { className: 'fc-head' }, h('h3', { className: 'fc-title' }, '今天的表'), h('span', { className: 'fc-dim' }, 状态.哪天 || '')),
          h('div', { className: 'fc-row' }, (状态.计划 || []).map((项) => 状态标签(项, 状态.下一个))),
          (状态.计划 || []).length === 0 ? h('div', { className: 'fc-dim' }, '还没排表（插件刚起来，等下一分钟）。') : null,
          h('div', { className: 'fc-dim', style: { marginTop: 6 } }, '时间点每天重新随机，固定时段落在你上面设的窗口里。'),
        ),

        // 每天必发的时段
        h(
          'div',
          { className: 'fc-card' },
          h('div', { className: 'fc-head' }, h('h3', { className: 'fc-title' }, '每天必发的时段')),
          h('div', { className: 'fc-dim', style: { marginBottom: 4 } }, '每个时段里随机挑一分钟，保证那天一定有一句。'),
          固定窗口.map((窗, i) =>
            时段行({
              key: 'w' + i,
              value: 窗,
              onChange: (v) => {
                const 新 = 固定窗口.slice()
                新[i] = v
                改('固定窗口', 新)
              },
              onRemove: 固定窗口.length <= 1 ? null : () => 改('固定窗口', 固定窗口.filter((_, j) => j !== i)),
            }),
          ),
          h(
            'button',
            {
              className: 'fc-btn',
              type: 'button',
              onClick: () => 改('固定窗口', 固定窗口.concat([['21:00', '21:30']])),
            },
            '+ 再加一个时段',
          ),
        ),

        // 白天随机补
        h(
          'div',
          { className: 'fc-card' },
          h('div', { className: 'fc-head' }, h('h3', { className: 'fc-title' }, '白天再随机补几次')),
          h(
            'div',
            { className: 'fc-field' },
            h('label', null, '补'),
            h(
              'select',
              {
                className: 'fc-sel',
                value: String(额外次数[0]) + '-' + String(额外次数[1]),
                onChange: (e) => 改('额外次数', e.target.value.split('-').map(Number)),
              },
              ['0-0', '1-1', '1-2', '2-2', '2-3'].map((x) => h('option', { key: x, value: x }, x + ' 次')),
            ),
            h('span', { className: 'fc-dim' }, '在'),
            h('input', {
              className: 'fc-in',
              type: 'time',
              value: 额外时段[0],
              onChange: (e) => 改('额外时段', [e.target.value, 额外时段[1]]),
            }),
            h('span', { className: 'fc-dim' }, '到'),
            h('input', {
              className: 'fc-in',
              type: 'time',
              value: 额外时段[1],
              onChange: (e) => 改('额外时段', [额外时段[0], e.target.value]),
            }),
          ),
          h(
            'div',
            { className: 'fc-field' },
            h('label', null, '离必发时段'),
            h('input', {
              className: 'fc-in',
              type: 'number',
              min: 0,
              max: 180,
              value: 草稿.额外避开分钟,
              onChange: (e) => 改('额外避开分钟', Number(e.target.value)),
            }),
            h('span', { className: 'fc-dim' }, '分钟以内不补，免得刚说完又来一句'),
          ),
        ),

        // 别打扰
        h(
          'div',
          { className: 'fc-card' },
          h('div', { className: 'fc-head' }, h('h3', { className: 'fc-title' }, '别打扰的时段')),
          h(
            'div',
            { className: 'fc-field' },
            h('label', null, '从'),
            h('input', {
              className: 'fc-in',
              type: 'number',
              min: 0,
              max: 23,
              value: 草稿.安静起,
              onChange: (e) => 改('安静起', Number(e.target.value)),
            }),
            h('span', { className: 'fc-dim' }, '点 到'),
            h('input', {
              className: 'fc-in',
              type: 'number',
              min: 0,
              max: 23,
              value: 草稿.安静止,
              onChange: (e) => 改('安静止', Number(e.target.value)),
            }),
            h('span', { className: 'fc-dim' }, '点，一条都不发'),
          ),
          h('div', { className: 'fc-dim' }, '可以跨夜，比如 23 点到 9 点。'),
        ),

        // 每日复盘
        h(
          'div',
          { className: 'fc-card' },
          h('div', { className: 'fc-head' }, h('h3', { className: 'fc-title' }, '每日复盘')),
          h(
            'div',
            { className: 'fc-row' },
            h('label', null, '每天'),
            h('input', {
              className: 'fc-in',
              type: 'time',
              value: (草稿.复盘时间 || ''),
              onChange: (e) => 改('复盘时间', e.target.value),
            }),
            h('span', { className: 'fc-dim' }, '点让她自己写今天的复盘（留空 = 关掉）'),
          ),
          h('div', { className: 'fc-dim' }, '复盘只写文件、不发消息：写进 学习\\每日复盘\\<日期>.md，值得长期留的再追加到 MEMORY.md。'),
        ),

        // 她开口那句
        h(
          'div',
          { className: 'fc-card' },
          h('div', { className: 'fc-head' }, h('h3', { className: 'fc-title' }, '她开口那句话')),
          h('textarea', {
            className: 'fc-ta',
            value: 草稿.触发文案,
            onChange: (e) => 改('触发文案', e.target.value),
          }),
          h('div', { className: 'fc-dim' }, '这只是"心里冒出来的念头"，具体怎么说她自己会展开。'),
        ),

        // 底部操作
        h(
          'div',
          { className: 'fc-foot' },
          h('button', { className: 'fc-btn fc-primary', type: 'button', disabled: 忙 || !脏, onClick: 保存 }, 忙 ? '处理中…' : 脏 ? '保存' : '已保存'),
          h('button', { className: 'fc-btn', type: 'button', disabled: 忙, onClick: 试一条 }, '现在试一条'),
          h('button', {
            className: 'fc-btn fc-ghost',
            type: 'button',
            onClick: () => { void get('/state').then(装) },
          }, '刷新状态'),
          说 ? h('span', { className: 'fc-ok' }, 说) : null,
          错 ? h('span', { className: 'fc-err' }, 错) : null,
        ),

        // 日志
        h(
          'div',
          { className: 'fc-card' },
          h(
            'button',
            {
              className: 'fc-btn fc-ghost',
              type: 'button',
              onClick: () => 设开日志(!开日志),
            },
            (开日志 ? '▾ ' : '▸ ') + '最近发生了什么（' + ((状态.日志 || []).length) + ' 行）',
          ),
          开日志 ? h('pre', { className: 'fc-log' }, (状态.日志 || []).join('\n') || '还没有日志') : null,
          h('div', { className: 'fc-dim', style: { marginTop: 6 } }, '配置文件：' + (状态.配置文件 || '')),
        ),
      )
    }

    /** 宿主先问一句「卡片上写什么」，再决定要不要展开整块面板。 */
    function 渲染(props) {
      if (props && props.view === 'summary') {
        return '按时刻表叫 AI 主动找你：每天几个固定时段内必发一次，白天再随机补 1~2 次，夜里静音。'
      }
      return React.createElement(面板, props)
    }

    async function apply(ctx) {
      ctx.effect(
        () => {
          const 标签 = document.createElement('style')
          标签.dataset.plugin = 'fish-clock'
          标签.textContent = CSS
          document.head.appendChild(标签)
          return () => 标签.remove()
        },
        'fish-clock: style',
      )

      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'fish-clock' }, 渲染),
      )

      return function () {}
    }

    exports.inject = inject
    exports.apply = apply
    exports.面板 = 面板
    return module.exports
  },
})
