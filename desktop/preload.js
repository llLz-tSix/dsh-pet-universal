/**
 * Bridge for the floating pet page. Context isolation is on, so the page gets
 * exactly these verbs and nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petWindow', {
  /**
   * Begin and end a window drag.
   *
   * The page reports only the press and the release. Movement is produced in the
   * main process by sampling the real cursor, because a window dragged out from
   * under the pointer stops receiving mousemove within a few pixels and the pet
   * freezes mid-drag with a half-finished move.
   */
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  /** End the pet. */
  close: () => ipcRenderer.send('pet:close'),
  /** Which sprite to show; the main process relays the plugin's state here. */
  onState: handler => {
    const listener = (_event, state) => handler(state)
    ipcRenderer.on('pet:state', listener)
    return () => ipcRenderer.removeListener('pet:state', listener)
  },
  /** The pet was clicked; react visibly even if nothing else changes. */
  onFlash: handler => {
    const listener = () => handler()
    ipcRenderer.on('pet:flash', listener)
    return () => ipcRenderer.removeListener('pet:flash', listener)
  },
  /** The pet was let go after being carried, so it can land with a squash. */
  onDropped: handler => {
    const listener = () => handler()
    ipcRenderer.on('pet:dropped', listener)
    return () => ipcRenderer.removeListener('pet:dropped', listener)
  },
  /** Which way it is being carried, so it can face that way. */
  onFacing: handler => {
    const listener = (_event, facing) => handler(facing)
    ipcRenderer.on('pet:facing', listener)
    return () => ipcRenderer.removeListener('pet:facing', listener)
  },
})
