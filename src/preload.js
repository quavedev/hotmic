const { contextBridge, ipcRenderer } = require('electron');

// Expose API to renderer
contextBridge.exposeInMainWorld('api', {
  // Settings
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),
  getShortcut: () => ipcRenderer.invoke('get-shortcut'),
  setShortcut: (shortcut) => ipcRenderer.invoke('set-shortcut', shortcut),

  // Recording
  sendAudioData: (buffer) => ipcRenderer.invoke('audio-data', buffer),
  sendAudioLevel: (level) => ipcRenderer.invoke('audio-level', level),

  // Events
  onStartRecording: (callback) => {
    ipcRenderer.on('start-recording', callback);
    return () => ipcRenderer.removeListener('start-recording', callback);
  },
  onStopRecording: (callback) => {
    ipcRenderer.on('stop-recording', callback);
    return () => ipcRenderer.removeListener('stop-recording', callback);
  },
  onAudioLevel: (callback) => {
    ipcRenderer.on('audio-level', (_, level) => callback(level));
    return () => ipcRenderer.removeListener('audio-level', callback);
  },
  onTranscriptionProgress: (callback) => {
    ipcRenderer.on('transcription-progress', (_, data) => callback(data));
    return () => ipcRenderer.removeListener('transcription-progress', callback);
  }
});
