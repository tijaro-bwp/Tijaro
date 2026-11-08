import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { THEME_ACCENTS, THEME_MODES, useTheme } from '../../context/ThemeContext'
import { Badge, Button, Card } from '../ui'

const MODE_ICONS = { light: Sun, dark: Moon, system: Monitor }

// Settings → Appearance. Changes apply live and are written straight to
// shop_settings_${shopId} by ThemeProvider (no Save button needed).
export default function AppearanceSection({ title, desc, onThemeChange }) {
  const { mode, accent, resolvedMode, setTheme } = useTheme()

  const update = (patch) => {
    setTheme(patch)
    onThemeChange?.({ mode: patch.mode || mode, accent: patch.accent || accent })
  }

  return (
    <Card className="overflow-hidden">
      <div className="bg-surface-2 px-6 py-4 border-b border-line">
        <h2 className="font-bold text-fg-2">{title}</h2>
        <p className="text-xs text-fg-subtle">{desc}</p>
      </div>

      <div className="p-4 sm:p-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-6 min-w-0">
          <fieldset>
            <legend className="label">Colour mode</legend>
            <div role="radiogroup" aria-label="Colour mode" className="grid grid-cols-3 gap-2">
              {THEME_MODES.map(m => {
                const Icon = MODE_ICONS[m.id]
                const active = mode === m.id
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => update({ mode: m.id })}
                    className={`min-h-16 rounded-control border-2 px-2 py-3 flex flex-col items-center justify-center gap-1.5 text-sm font-bold transition cursor-pointer ${
                      active
                        ? 'border-primary bg-primary-soft text-primary-strong'
                        : 'border-line bg-surface text-fg-3 hover:border-line-strong hover:text-fg'
                    }`}
                  >
                    <Icon size={20} aria-hidden="true" />
                    {m.label}
                  </button>
                )
              })}
            </div>
            {mode === 'system' && (
              <p className="mt-2 text-xs text-fg-muted">Following this device: currently <b className="text-fg-2">{resolvedMode}</b>.</p>
            )}
          </fieldset>

          <fieldset>
            <legend className="label">Brand colour</legend>
            <div role="radiogroup" aria-label="Brand colour" className="grid grid-cols-2 2xl:grid-cols-4 gap-2">
              {THEME_ACCENTS.map(a => {
                const active = accent === a.id
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={a.label}
                    onClick={() => update({ accent: a.id })}
                    className={`min-h-14 rounded-control border-2 px-3 py-2 flex items-center gap-2.5 text-sm font-bold transition cursor-pointer ${
                      active ? 'border-primary bg-primary-soft text-fg' : 'border-line bg-surface text-fg-3 hover:border-line-strong hover:text-fg'
                    }`}
                  >
                    <span className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-white ring-2 ring-surface shadow-sm" style={{ background: a.swatch }}>
                      {active && <Check size={15} strokeWidth={3} aria-hidden="true" />}
                    </span>
                    <span className="truncate">{a.label}</span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-fg-muted">
              Wholesale stays amber and Quotation stays purple in every theme, so those modes are always easy to spot.
            </p>
          </fieldset>

          <p className="text-xs text-fg-subtle">
            Saved automatically for this shop on this device. Printed bills and receipts are not affected.
          </p>
        </div>

        {/* Live preview */}
        <div aria-label="Theme preview" className="rounded-card border border-line bg-app p-3 space-y-3 min-w-0">
          <p className="text-[10px] font-black uppercase tracking-widest text-fg-subtle">Live preview</p>
          <div className="card p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-black text-fg truncate">PVC Pipe 1&quot; (10 ft)</p>
                <p className="text-xs text-fg-muted">SKU 10045 · 32 in stock</p>
              </div>
              <span className="text-base font-black text-primary-fg shrink-0">Rs. 850</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="success">Paid</Badge>
              <Badge tone="warning">Low stock</Badge>
              <Badge tone="danger">Out</Badge>
              <Badge tone="info">Quotation</Badge>
              <Badge tone="wholesale">Wholesale</Badge>
            </div>
            <input className="input" placeholder="Scan barcode or search…" aria-label="Preview search field" readOnly />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" tabIndex={-1}>Hold</Button>
              <Button variant="primary" size="sm" tabIndex={-1}>Pay Rs. 850</Button>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-control bg-sidebar px-3 py-2">
            <span className="text-xs font-bold text-sidebar-fg">Sidebar</span>
            <span className="text-xs font-bold text-white bg-primary rounded-lg px-2 py-1">Active</span>
          </div>
        </div>
      </div>
    </Card>
  )
}
