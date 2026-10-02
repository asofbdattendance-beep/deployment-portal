import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/**
 * VirtualList — windowed long-list wrapper over @tanstack/react-virtual.
 *
 * Renders only the visible rows (+overscan) inside a bounded scroll
 * container, so 700–2000-row attendance lists stay smooth on a phone.
 * Rows are absolutely positioned; each row gets `data-index` for tests.
 *
 * Props:
 * - items: array
 * - estimateSize: px per row (default 64)
 * - overscan: extra rows above/below (default 6)
 * - maxHeight: scroll container cap (default min(70vh, 640px))
 * - renderRow(item, index): row JSX (must be a single element; the
 *   wrapper positions it, so rows must NOT carry their own margin that
 *   changes height — keep row heights near estimateSize).
 * - empty: rendered when items is empty.
 */
export default function VirtualList({
  items = [],
  estimateSize = 64,
  overscan = 6,
  maxHeight,
  renderRow,
  empty = null,
  ariaLabel,
}) {
  const parentRef = useRef(null)
  const list = Array.isArray(items) ? items : []

  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
  })

  if (list.length === 0) return empty

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      ref={parentRef}
      className="virt-list"
      role="list"
      aria-label={ariaLabel}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div
        className="virt-inner"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((v) => (
          <div
            key={v.key}
            data-index={v.index}
            role="listitem"
            className="virt-row"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${v.start}px)`,
            }}
          >
            {renderRow(list[v.index], v.index)}
          </div>
        ))}
      </div>
    </div>
  )
}
