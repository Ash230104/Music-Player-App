'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniApi', {
  restore: () => ipcRenderer.send('mini:restore'),
  hasSong: (v) => ipcRenderer.send('mini:has-song', !!v),
  dragStart: () => ipcRenderer.send('mini:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('mini:drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('mini:drag-end'),
});
