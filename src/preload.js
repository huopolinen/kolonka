'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (fn) => {
  const h = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('kolonka', {
  init: () => ipcRenderer.invoke('init'),
  snapshot: (id) => ipcRenderer.invoke('snapshot', id),
  cmd: (name, args) => ipcRenderer.invoke('cmd', name, args),
  log: (level, ...parts) => ipcRenderer.send('log', level, parts.filter(Boolean).join('\n')),
  input: (id, data) => ipcRenderer.send('pty:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  dictation: {
    warm: () => ipcRenderer.invoke('dictation:warm'),
    install: () => ipcRenderer.invoke('dictation:install'),
    transcribe: (wav) => ipcRenderer.invoke('dictation:transcribe', wav),
    onProgress: on('dictation:progress'),
  },
  onData: on('pty:data'),
  onExit: on('pty:exit'),
  onClosed: on('pty:closed'),
  onState: on('state'),
  onToast: on('toast'),
  onWindowFocus: on('window:focus'),
  onWindowAction: on('window:action'),
});
