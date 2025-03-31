/**
 * HotMic Main Process
 *
 * This file handles the main Electron process:
 * - Window management
 * - Recording and transcription
 * - Communication with renderer processes
 * - Global shortcuts
 * - Tray icon
 */

import { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, clipboard, nativeImage, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import FormData from 'form-data';
import fs from 'node:fs';
import os from 'node:os';
import Store from 'electron-store';
// Import fetch API for Node.js (available in modern Node.js)
import { fetch } from 'undici';

// Fix __dirname and __filename which aren't available in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Application Configuration
 */
// Initialize persistent store for app settings
const store = new Store();

// Define temp directory for audio files
const tempDir = path.join(os.tmpdir(), 'hot-mic');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Define recordings directory for persistent storage
const recordingsDir = path.join(app.getPath('userData'), 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// Default prompt for email formatting
const DEFAULT_PROMPT = 'Please format this transcript as a professional email with a greeting and sign-off. Make it concise and clear while maintaining the key information.';

/**
 * Audio Processing
 */
// Create a properly formatted WAV file from raw audio data
function formatWavFile(audioData) {
  try {
    console.log("Formatting audio data, size:", audioData.length);
    
    // Convert to Buffer if not already
    const buffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
    
    // Basic WAV parameters
    const numChannels = 1; // Mono
    const sampleRate = 44100; // 44.1kHz
    const bitsPerSample = 16; // 16-bit
    
    // Calculate derived values
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = buffer.length;
    const fileSize = 36 + dataSize; // Total file size - 8
    
    // Create header buffer
    const header = Buffer.alloc(44);
    
    // RIFF chunk descriptor
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);
    
    // "fmt " sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1 size (16 bytes)
    header.writeUInt16LE(1, 20); // AudioFormat: PCM = 1
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    
    // "data" sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    
    // Combine header and audio data
    return Buffer.concat([header, buffer]);
  } catch (error) {
    console.error('Error formatting WAV file:', error);
    // Return original data if formatting fails
    return audioData;
  }
}

/**
 * Application State
 */
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isRecording = false;
let audioData = [];

/**
 * History Management
 */
function cleanupOldHistory() {
  const history = store.get('history', []);
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const newHistory = history.filter(item => item.timestamp > thirtyDaysAgo);
  
  // Delete audio files for removed history items
  const removedItems = history.filter(item => item.timestamp <= thirtyDaysAgo);
  removedItems.forEach(item => {
    if (item.audioPath && fs.existsSync(item.audioPath)) {
      try {
        fs.unlinkSync(item.audioPath);
      } catch (error) {
        console.error('Error deleting old audio file:', error);
      }
    }
  });
  
  store.set('history', newHistory);
}

function addToHistory(rawText, processedText, audioPath) {
  const history = store.get('history', []);
  history.unshift({
    timestamp: Date.now(),
    rawText,
    processedText,
    audioPath
  });
  store.set('history', history);

  // Notify renderer of history update
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history-updated');
  }

  cleanupOldHistory();
}

// Update an existing history item with new transcript data
function updateHistoryItem(audioPath, rawText, processedText) {
  const history = store.get('history', []);
  
  // Find the item with the matching audio path
  const index = history.findIndex(item => item.audioPath === audioPath);
  
  if (index !== -1) {
    // Update the item with new transcripts but keep original timestamp
    history[index].rawText = rawText;
    history[index].processedText = processedText;
    
    store.set('history', history);
    
    // Notify renderer of history update
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('history-updated');
    }
    
    return true;
  }
  
  return false;
}

/**
 * Post-Processing with Groq
 */
async function postProcessTranscript(text) {
  const apiKey = store.get('apiKey');
  if (!apiKey) {
    throw new Error('API key not set');
  }

  const promptSettings = store.get('promptSettings', {
    enabled: true,
    prompt: DEFAULT_PROMPT
  });

  if (!promptSettings.enabled) {
    return text;
  }

  try {
    updateTranscriptionProgress('processing', 'Post-processing with Groq...');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: promptSettings.prompt
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.7,
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Groq API error: ${response.statusText}${errorData.error ? ' - ' + errorData.error.message : ''}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    updateTranscriptionProgress('error', 'Post-processing failed, using raw transcript');
    return text;
  }
}

/**
 * API and Transcription
 */
async function transcribeAudio(audioBuffer, skipFormatting = false) {
  const apiKey = store.get('apiKey');
  if (!apiKey) {
    throw new Error('API key not set. Please configure in settings.');
  }

  let tempFile = null;
  let savedAudioPath = null;
  try {
    updateTranscriptionProgress('start', 'Starting transcription...');
    
    console.log("Received audio buffer size:", audioBuffer.byteLength);

    // Format the audio data into a proper WAV file
    let wavBuffer;
    try {
      wavBuffer = formatWavFile(Buffer.from(audioBuffer));
      console.log("WAV buffer created, size:", wavBuffer.length);
    } catch (formatError) {
      console.error("Error formatting WAV file:", formatError);
      wavBuffer = Buffer.from(audioBuffer); // Use original data as fallback
    }

    // Save audio to temp file
    const timestamp = Date.now();
    tempFile = path.join(tempDir, `recording-${timestamp}.wav`);
    fs.writeFileSync(tempFile, wavBuffer);
    console.log("Temp file saved:", tempFile);

    // Save a permanent copy only if this is a new recording
    if (!skipFormatting) {
      savedAudioPath = path.join(recordingsDir, `recording-${timestamp}.wav`);
      fs.copyFileSync(tempFile, savedAudioPath);
      console.log("Permanent copy saved:", savedAudioPath);
    }

    updateTranscriptionProgress('api', 'Sending to Groq API...');

    // Send to Groq API for transcription
    const rawTranscript = await sendToGroqAPI(apiKey, tempFile);
    console.log("Raw transcript received:", rawTranscript ? rawTranscript.substring(0, 50) + "..." : "None");

    // If we get here and rawTranscript is empty, don't proceed
    if (!rawTranscript?.trim()) {
      updateTranscriptionProgress('error', 'No speech detected');
      setTimeout(() => closeOverlayWindow(), 2000);
      return;
    }

    // Post-process with Groq if enabled
    updateTranscriptionProgress('processing', 'Post-processing transcript...');
    const processedTranscript = await postProcessTranscript(rawTranscript);

    // Add to history only if we have valid transcripts and this is a new recording
    if (processedTranscript?.trim() && !skipFormatting && savedAudioPath) {
      addToHistory(rawTranscript, processedTranscript, savedAudioPath);
      // Copy processed version to clipboard
      updateTranscriptionProgress('complete', 'Processing complete');
      clipboard.writeText(processedTranscript);
    } else if (processedTranscript?.trim() && skipFormatting) {
      // For retranscriptions, just update the display and copy to clipboard
      updateTranscriptionProgress('complete', 'Processing complete');
      clipboard.writeText(processedTranscript);
    } else {
      updateTranscriptionProgress('error', 'Failed to process transcript');
    }

    // Close overlay after a delay
    setTimeout(() => closeOverlayWindow(), 1500);

    return processedTranscript;
  } catch (error) {
    console.error('Transcription error:', error);
    updateTranscriptionProgress('error', `Error: ${error.message}`);
    // Close overlay after a delay
    setTimeout(() => closeOverlayWindow(), 2000);
    throw error;
  } finally {
    // Clean up temp file
    try {
      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {
      console.error('Error cleaning up temp file:', e);
    }
  }
}

function updateTranscriptionProgress(step, message) {
  console.log(`Transcription progress: ${step}${message ? ' - ' + message : ''}`);
  
  // Handle error step specially with more logging
  if (step === 'error') {
    console.error(`Transcription error: ${message}`);
  }
  
  // Only send message if overlay window exists
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send('transcription-progress', { step, message });
    } catch (error) {
      console.error("Error sending progress update to overlay:", error);
    }
  } else {
    console.log("Cannot send progress update - overlay window not available");
  }
}

async function sendToGroqAPI(apiKey, audioFilePath) {
  console.log("Sending audio file to Groq API:", audioFilePath);
  
  // Create form data for API request
  const formData = new FormData();
  const fileStream = fs.createReadStream(audioFilePath);
  formData.append('file', fileStream);
  formData.append('model', 'whisper-large-v3');
  
  console.log("Form data created");

  // Send request to Groq API
  try {
    const response = await new Promise((resolve, reject) => {
      const formHeaders = formData.getHeaders();
      
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formHeaders
        }
      };
      
      console.log("API request options created, sending request...");
      
      const req = https.request(options, (res) => {
        let data = '';
        
        console.log(`API response status: ${res.statusCode}`);

        res.on('data', (chunk) => {
          data += chunk;
          updateTranscriptionProgress('receiving', 'Receiving transcription...');
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log("API request successful");
            resolve({ ok: true, data });
          } else {
            console.error('API Error Response:', {
              statusCode: res.statusCode,
              data: data
            });
            resolve({ ok: false, statusCode: res.statusCode, data });
          }
        });
      });

      req.on('error', (error) => {
        console.error('Request Error:', error);
        reject(error);
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
      
      req.setTimeout(30000); // 30 second timeout
      
      // Use a smaller timeout for pipe
      fileStream.on('error', (error) => {
        console.error('File stream error:', error);
        reject(error);
      });
      
      formData.pipe(req);
    });

    if (!response.ok) {
      console.error('API Error:', response.data);
      let errorMsg = 'API error';
      
      try {
        const errorData = JSON.parse(response.data);
        errorMsg = errorData.error?.message || errorData.error || 'API error';
      } catch (e) {
        errorMsg = `API error (${response.statusCode}): ${response.data.substring(0, 100)}`;
      }
      
      throw new Error(errorMsg);
    }

    try {
      const result = JSON.parse(response.data);
      console.log('API Response type:', typeof result);

      if (!result || typeof result !== 'object') {
        throw new Error('Invalid API response format');
      }

      const transcript = result.text?.trim();
      console.log('Transcript length:', transcript?.length || 0);

      // If no transcript or empty transcript, throw error
      if (!transcript) {
        throw new Error('No speech detected in audio');
      }

      return transcript;
    } catch (error) {
      console.error('Error processing API response:', error);
      throw new Error(`Failed to process API response: ${error.message}`);
    }
  } catch (error) {
    console.error('API request failed:', error);
    throw error;
  }
}

/**
 * Tray Management
 */
function createTray() {
  try {
    // Clean up existing tray if it exists
    if (tray) {
      tray.destroy();
      tray = null;
    }

    // Create native image from file
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, '../public/icons/32x32.png'));

    // Create tray with template image
    tray = new Tray(trayIcon);

    // Check if we're showing in the dock
    const showingInDock = !app.dock.isVisible();

    // Create context menu
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Start/Stop Recording',
        click: toggleRecording
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          } else {
            createMainWindow();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Show in Dock',
        type: 'checkbox',
        checked: showingInDock,
        click: () => toggleDockVisibility()
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('HotMic');
    tray.setContextMenu(contextMenu);
  } catch (error) {
    console.error('Error creating tray:', error);
  }
}

/**
 * Toggle dock visibility
 */
function toggleDockVisibility() {
  if (app.dock.isVisible()) {
    app.dock.hide();
  } else {
    app.dock.show();
  }

  // Update the tray menu after toggling
  if (tray) {
    const showingInDock = !app.dock.isVisible();
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Start/Stop Recording',
        click: toggleRecording
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          } else {
            createMainWindow();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Show in Dock',
        type: 'checkbox',
        checked: showingInDock,
        click: () => toggleDockVisibility()
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(contextMenu);
  }
}

/**
 * User Input Handling
 */
function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

/**
 * IPC Handlers
 */
function setupIPCHandlers() {
  // Receive audio data from renderer
  ipcMain.handle('audio-data', async (event, audioBuffer) => {
    try {
      const transcription = await transcribeAudio(audioBuffer);
      return { success: true, transcription };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // API key management
  ipcMain.handle('set-api-key', (event, key) => {
    store.set('apiKey', key);
    return true;
  });

  ipcMain.handle('get-api-key', () => {
    return store.get('apiKey') || '';
  });

  // Shortcut management
  ipcMain.handle('set-shortcut', (event, shortcut) => {
    try {
      // Unregister existing shortcut
      globalShortcut.unregisterAll();

      // Register new shortcut
      globalShortcut.register(shortcut, toggleRecording);

      // Save to store
      store.set('shortcut', shortcut);
      return true;
    } catch (error) {
      console.error('Error setting shortcut:', error);
      return false;
    }
  });

  ipcMain.handle('get-shortcut', () => {
    return store.get('shortcut') || 'Command+Shift+Space';
  });

  // Prompt settings
  ipcMain.handle('get-prompt-settings', () => {
    return store.get('promptSettings', {
      enabled: true,
      prompt: DEFAULT_PROMPT
    });
  });

  ipcMain.handle('set-prompt-settings', (event, settings) => {
    store.set('promptSettings', settings);
    return true;
  });

  // History management
  ipcMain.handle('get-history', () => {
    cleanupOldHistory();
    return store.get('history', []);
  });

  // Get audio file for playback or download
  ipcMain.handle('get-audio-file', (event, audioPath) => {
    if (!audioPath || !fs.existsSync(audioPath)) {
      return { success: false, error: 'Audio file not found' };
    }
    
    try {
      const buffer = fs.readFileSync(audioPath);
      return { success: true, buffer };
    } catch (error) {
      console.error('Error reading audio file:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Save audio file to user-selected location
  ipcMain.handle('save-audio-file', async (event, audioPath) => {
    try {
      if (!audioPath || !fs.existsSync(audioPath)) {
        return { success: false, error: 'Audio file not found' };
      }
      
      const { dialog } = await import('electron');
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Audio Recording',
        defaultPath: path.basename(audioPath),
        filters: [{ name: 'Audio Files', extensions: ['wav'] }]
      });
      
      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }
      
      fs.copyFileSync(audioPath, filePath);
      return { success: true, savedPath: filePath };
    } catch (error) {
      console.error('Error saving audio file:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Re-transcribe an existing audio file
  ipcMain.handle('retranscribe-audio', async (event, audioPath) => {
    try {
      if (!audioPath || !fs.existsSync(audioPath)) {
        return { success: false, error: 'Audio file not found' };
      }
      
      // Show overlay window
      createOverlayWindow();
      
      // Tell overlay we're processing
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('transcription-progress', { 
          step: 'start', 
          message: 'Starting transcription...' 
        });
      }
      
      // Use transcribeAudio directly, but tell it to skip the formatting
      // since this is already a properly formatted WAV file
      const audioBuffer = fs.readFileSync(audioPath);
      const transcription = await transcribeAudio(audioBuffer, true);
      
      // Update history item with new transcription
      if (transcription) {
        updateHistoryItem(audioPath, transcription, transcription);
      }
      
      return { success: true, transcription };
    } catch (error) {
      console.error('Error retranscribing audio:', error);
      return { success: false, error: error.message };
    }
  });

  // Settings window management
  ipcMain.handle('open-settings', () => {
    // Close overlay window if open and cancel any ongoing transcription
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('cancel-transcription');
      closeOverlayWindow();
    }

    // Stop recording if active
    if (isRecording) {
      isRecording = false;
      audioData = [];
    }

    // Show settings window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
    return true;
  });

  // Audio level updates from renderer
  ipcMain.handle('audio-level', (event, level) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('audio-level', level);
    }
    return true;
  });
}

/**
 * App Lifecycle Management
 */
async function initialize() {
  // Create temp directory if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Set up IPC handlers
  setupIPCHandlers();

  // When app is ready
  await app.whenReady();

  try {
    // Hide dock only if not configured to show
    if (!store.get('showInDock', false)) {
      app.dock.hide();
    }

    // Create main window first
    createMainWindow();

    // Create tray icon
    createTray();

    // Register global shortcut
    const shortcut = store.get('shortcut') || 'Command+Shift+Space';
    globalShortcut.register(shortcut, toggleRecording);

    // Handle app activation
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    });
  } catch (error) {
    console.error('Error initializing app:', error);
  }


  // Prevent default behavior of closing app when all windows are closed
  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });

  // Clean up when app is about to quit
  app.on('will-quit', () => {
    app.isQuitting = true;

    // Unregister shortcuts
    globalShortcut.unregisterAll();

    // Stop recording if active
    if (isRecording) {
      stopRecording();
    }

    // Close windows
    closeOverlayWindow();
  });
}

/**
 * Window Management
 */
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    skipTaskbar: false,
    title: 'HotMic',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#00000000'
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  // Show in App Switcher when window is shown
  mainWindow.on('show', () => {
    // Show in dock temporarily while window is open
    app.dock.show();
  });

  // Remove from App Switcher when window is hidden
  mainWindow.on('hide', () => {
    // Hide dock if it's not meant to be visible
    if (!store.get('showInDock', false)) {
      app.dock.hide();
    }
  });

  // Hide instead of close
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.once('ready-to-show', () => {
    // Only show on first launch or if API key isn't set
    if (!store.get('apiKey')) {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createOverlayWindow() {
  // Close existing overlay if any
  closeOverlayWindow();

  // Get screen dimensions to center the overlay
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 190,
    height: 190,
    x: Math.floor(width / 2 - 95),
    y: Math.floor(height / 2 - 95),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    opacity: 1.0,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    movable: true,
    vibrancy: null,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, '../public/overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
  });
}

function closeOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    overlayWindow = null;
  }
}

/**
 * Recording Management
 */
function startRecording() {
  if (isRecording) return;

  isRecording = true;
  audioData = [];

  // Show overlay window
  createOverlayWindow();

  // Start recording in overlay
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('start-recording');
  }
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;

  // Tell overlay to stop recording
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('stop-recording');
  }
}

// Start the app using a top-level await
(async () => {
  await initialize();
})();