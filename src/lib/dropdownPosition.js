// Pure placement maths for anchored dropdown menus (DeptDropdown).
// Kept free of DOM access so it can be unit-tested directly.

export const MENU_GUTTER = 8 // min gap to any viewport edge
export const MENU_OFFSET = 4 // gap between trigger and menu
export const MENU_MAX_HEIGHT = 360
export const MENU_MIN_HEIGHT = 140
export const MENU_MIN_WIDTH = 260
export const MENU_MAX_WIDTH = 360

/**
 * Place a menu under (or above) its trigger, sized to the room available.
 *
 * @param {{ top: number, bottom: number, left: number, width: number }} rect trigger rect
 * @param {{ width: number, height: number }} viewport
 * @returns {{ top: number, left: number, width: number, maxHeight: number, above: boolean }}
 */
export function computeMenuPosition(rect, viewport) {
  const spaceBelow = viewport.height - rect.bottom - MENU_OFFSET - MENU_GUTTER
  const spaceAbove = rect.top - MENU_OFFSET - MENU_GUTTER
  // Flip up only when below is too cramped AND above genuinely has more room.
  const above = spaceBelow < Math.min(MENU_MAX_HEIGHT, MENU_MIN_HEIGHT * 2) && spaceAbove > spaceBelow
  const room = above ? spaceAbove : spaceBelow
  const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, room))

  const availableWidth = Math.max(0, viewport.width - MENU_GUTTER * 2)
  const width = Math.min(Math.max(rect.width, MENU_MIN_WIDTH), MENU_MAX_WIDTH, availableWidth)
  const maxLeft = viewport.width - width - MENU_GUTTER
  const left = Math.max(MENU_GUTTER, Math.min(rect.left, maxLeft))

  const top = above
    ? Math.max(MENU_GUTTER, rect.top - MENU_OFFSET - maxHeight)
    : rect.bottom + MENU_OFFSET

  return { top, left, width, maxHeight, above }
}

/** True when the trigger has scrolled completely out of the viewport. */
export function isRectOffscreen(rect, viewport) {
  return rect.bottom < 0 || rect.top > viewport.height || rect.right < 0 || rect.left > viewport.width
}

/** Case-insensitive name filter for dropdown items. */
export function filterItems(items, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return items
  return items.filter(it => (it.name || '').toLowerCase().includes(q))
}
