// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { registerUnsavedWork, hasUnsavedWork } from './unsavedWork'

afterEach(() => { document.body.innerHTML = '' })

describe('hasUnsavedWork', () => {
  it('is false on a clean page', () => {
    expect(hasUnsavedWork()).toBe(false)
  })
  it('is true while a registered page is dirty, false after unregister', () => {
    let dirty = true
    const off = registerUnsavedWork(() => dirty)
    expect(hasUnsavedWork()).toBe(true)
    dirty = false
    expect(hasUnsavedWork()).toBe(false)
    dirty = true; off()
    expect(hasUnsavedWork()).toBe(false)
  })
  it('treats an open modal as busy', () => {
    document.body.innerHTML = '<div class="modal-overlay"></div>'
    expect(hasUnsavedWork()).toBe(true)
  })
  it('treats a filled form field as busy, an empty one as clean', () => {
    document.body.innerHTML = '<form><input type="text" value=""></form>'
    expect(hasUnsavedWork()).toBe(false)
    document.querySelector('input').value = 'Ram'
    expect(hasUnsavedWork()).toBe(true)
  })
  it('treats a focused field as busy', () => {
    document.body.innerHTML = '<input id="x">'
    document.getElementById('x').focus()
    expect(hasUnsavedWork()).toBe(true)
  })
})
