/**
 * Tiny declarative control panel. Builds DOM from a spec, keeps a plain state
 * object in sync, and calls back with (key, value, state) on every change.
 */

const fmt = {
  deg: (v) => `${v.toFixed(0)}°`,
  deg1: (v) => `${v.toFixed(1)}°`,
  pct: (v) => `${Math.round(v * 100)}%`,
  num: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2)),
  px: (v) => `${v}px`,
  dps: (v) => `${v.toFixed(1)}°/s`,
}

export class Panel {
  /**
   * @param {HTMLElement} host
   * @param {Array} groups  [{ title, open, items: [...] }]
   * @param {(key: string, value: any, state: object) => void} onChange
   */
  constructor(host, groups, onChange) {
    this.state = {}
    this.inputs = new Map()
    this.readouts = new Map()
    this.onChange = onChange
    this.host = host

    for (const group of groups) {
      const section = document.createElement('section')
      section.className = 'panel-group'
      if (group.open !== false) section.classList.add('open')

      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'panel-head'
      head.innerHTML = `<span>${group.title}</span><i aria-hidden="true"></i>`
      head.addEventListener('click', () => section.classList.toggle('open'))
      section.append(head)

      const body = document.createElement('div')
      body.className = 'panel-body'
      for (const item of group.items) body.append(this._row(item))
      section.append(body)
      host.append(section)
    }
  }

  _row(item) {
    const row = document.createElement('div')
    row.className = `row row-${item.type}`

    if (item.type === 'button') {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'act'
      b.textContent = item.label
      b.addEventListener('click', () => this.onChange(item.key, true, this.state))
      row.append(b)
      return row
    }

    const label = document.createElement('label')
    label.textContent = item.label
    label.htmlFor = `ctl-${item.key}`
    row.append(label)

    if (item.type === 'toggle') {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.id = `ctl-${item.key}`
      input.className = 'switch'
      input.checked = !!item.value
      this.state[item.key] = !!item.value
      input.addEventListener('change', () => {
        this.state[item.key] = input.checked
        this.onChange(item.key, input.checked, this.state)
      })
      this.inputs.set(item.key, input)
      row.append(input)
      return row
    }

    if (item.type === 'select') {
      const select = document.createElement('select')
      select.id = `ctl-${item.key}`
      for (const opt of item.options) {
        const o = document.createElement('option')
        o.value = String(opt.value)
        o.textContent = opt.label
        select.append(o)
      }
      select.value = String(item.value)
      this.state[item.key] = item.value
      select.addEventListener('change', () => {
        const raw = select.value
        const value = item.options.find((o) => String(o.value) === raw).value
        this.state[item.key] = value
        this.onChange(item.key, value, this.state)
      })
      this.inputs.set(item.key, select)
      row.append(select)
      return row
    }

    // range
    const out = document.createElement('output')
    const format = typeof item.format === 'function' ? item.format : (fmt[item.format] ?? fmt.num)
    const input = document.createElement('input')
    input.type = 'range'
    input.id = `ctl-${item.key}`
    input.min = item.min
    input.max = item.max
    input.step = item.step ?? 0.01
    input.value = item.value
    this.state[item.key] = item.value
    out.textContent = format(item.value)

    const emit = (final) => {
      const value = parseFloat(input.value)
      this.state[item.key] = value
      out.textContent = format(value)
      // Heavy rebuilds (subdivision) only fire when the drag ends.
      if (!item.lazy || final) this.onChange(item.key, value, this.state)
    }
    input.addEventListener('input', () => emit(false))
    input.addEventListener('change', () => emit(true))

    this.inputs.set(item.key, input)
    this.readouts.set(item.key, { out, format })
    row.append(out, input)
    return row
  }

  /** Programmatic update that does not re-fire onChange (used by the camera). */
  set(key, value) {
    const input = this.inputs.get(key)
    if (!input) return
    this.state[key] = value
    if (input.type === 'checkbox') input.checked = !!value
    else input.value = String(value)
    const readout = this.readouts.get(key)
    if (readout) readout.out.textContent = readout.format(value)
  }
}

export { fmt }
