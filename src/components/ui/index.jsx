// Shared UI primitives backed by the theme tokens in src/index.css.
// They are thin wrappers over the .btn / .input / .card / .badge / .modal-* classes,
// so pages can also use the classes directly while migrating incrementally.
import { useEffect, useId } from 'react'
import { X } from 'lucide-react'

const cx = (...parts) => parts.filter(Boolean).join(' ')

export function Button({ variant = 'primary', size, className, type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)}
      {...props}
    />
  )
}

export function Card({ as = 'div', className, ...props }) {
  const Tag = as
  return <Tag className={cx('card', className)} {...props} />
}

export function Badge({ tone = 'neutral', className, ...props }) {
  return <span className={cx('badge', `badge-${tone}`, className)} {...props} />
}

export function Input({ label, id, className, inputClassName, ...props }) {
  const autoId = useId()
  const inputId = id || autoId
  return (
    <div className={className}>
      {label && <label htmlFor={inputId} className="label">{label}</label>}
      <input id={inputId} className={cx('input', inputClassName)} {...props} />
    </div>
  )
}

// Phone-friendly modal: bottom sheet on small screens, centred dialog on sm+,
// bounded to 90dvh with an internally scrolling body and a visible close button.
export function Modal({ open, onClose, title, children, footer, maxWidth = 'max-w-lg' }) {
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} className={cx('modal-panel', maxWidth)}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 shrink-0">
          <h2 id={titleId} className="text-base font-black text-fg truncate">{title}</h2>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm !min-h-10 !w-10 !p-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 custom-scrollbar">{children}</div>
        {footer && (
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-line px-4 py-3 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
