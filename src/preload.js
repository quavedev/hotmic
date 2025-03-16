const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  transcribeAudio: (base64Audio) => ipcRenderer.invoke('transcribe-audio', base64Audio),
  updateRecordingState: (isRecording) => ipcRenderer.invoke('update-recording-state', isRecording),
  
  // Events from main to renderer
  onToggleRecording: (callback) => {
    ipcRenderer.on('toggle-recording', () => callback());
    return () => ipcRenderer.removeAllListeners('toggle-recording');
  },
  onRecordingStatus: (callback) => {
    ipcRenderer.on('recording-status', (_, value) => callback(value));
    return () => ipcRenderer.removeAllListeners('recording-status');
  },
  onTranscriptionComplete: (callback) => {
    ipcRenderer.on('transcription-complete', (_, text) => callback(text));
    return () => ipcRenderer.removeAllListeners('transcription-complete');
  },
  onError: (callback) => {
    ipcRenderer.on('error', (_, message) => callback(message));
    return () => ipcRenderer.removeAllListeners('error');
  }
});