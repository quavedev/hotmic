/**
 * Whisper Transcriber Main Process
 *
 * This file handles the main Electron process:
 * - Window management
 * - Recording and transcription
 * - Communication with renderer processes
 * - Global shortcuts
 * - Tray icon
 */

const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, clipboard } = require('electron');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store').default;

/**
 * Application Configuration
 */
// Initialize persistent store for app settings
const store = new Store();

// Define temp directory for audio files
const tempDir = path.join(os.tmpdir(), 'whisper-transcriber');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
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
 * Window Management
 */
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

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
}

function createOverlayWindow() {
  // Close existing overlay if any
  closeOverlayWindow();

  // Get screen dimensions to center the overlay
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 220,
    height: 220,
    x: Math.floor(width / 2 - 110),
    y: Math.floor(height / 2 - 110),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
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
  console.log('Starting recording...');

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
  console.log('Stopping recording...');

  if (!isRecording) return;

  isRecording = false;

  // Tell overlay to stop recording
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('stop-recording');
  }
}

/**
 * API and Transcription
 */
async function transcribeAudio(audioBuffer) {
  const apiKey = store.get('apiKey');
  if (!apiKey) {
    throw new Error('API key not set. Please configure in settings.');
  }

  let tempFile = null;
  try {
    console.log('Transcribing audio...');
    updateTranscriptionProgress('start', 'Starting transcription...');

    // Save audio to temp file
    tempFile = path.join(tempDir, `recording-${Date.now()}.wav`);
    fs.writeFileSync(tempFile, Buffer.from(audioBuffer));

    updateTranscriptionProgress('api', 'Sending to Groq API...');

    // Send to Groq API
    const result = await sendToGroqAPI(apiKey, tempFile);

    // Copy to clipboard and notify
    updateTranscriptionProgress('complete', 'Transcription complete');
    clipboard.writeText(result);
    console.log('Transcription copied to clipboard');

    // Close overlay after a delay
    setTimeout(() => closeOverlayWindow(), 1500);

    return result;
  } catch (error) {
    console.error('Transcription error:', error);
    updateTranscriptionProgress('error', `Error: ${error.message}`);

    // Close overlay after a delay
    setTimeout(() => closeOverlayWindow(), 2000);
    throw error;
  } finally {
    // Clean up temp file
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

function updateTranscriptionProgress(step, message) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('transcription-progress', { step, message });
  }
}

async function sendToGroqAPI(apiKey, audioFilePath) {
  // Create form data for API request
  const formData = new FormData();
  formData.append('file', fs.createReadStream(audioFilePath));
  formData.append('model', 'whisper-large-v3');

  // Send request to Groq API
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

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
        updateTranscriptionProgress('receiving', 'Receiving transcription...');
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, data });
        } else {
          resolve({ ok: false, statusCode: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    formData.pipe(req);
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.data}`);
  }

  const result = JSON.parse(response.data);
  return result.text;
}

/**
 * Tray Management
 */
function createTray() {
  try {
    // Create a simple tray icon using a base64 encoded image
    const { nativeImage } = require('electron');

    // This is a simple 16x16 monochrome icon encoded as base64
    const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOxAAADsQBlSsOGwAAAGdJREFUOE/tk8EJwCAQBL+gvdjGfSkgtZhKbEQQY8CAJuRezgeXA24YRVdBEFyEmdFPUl+IJ1SZQNoQWSBkAQMJizxXkHPmn4LNmzLw0mgbIgz8JQN23tLHiHAF+A/IAnILDgXXeRYXchHSBDH5SjwAAAAASUVORK5CYII=';

    // Create native image from base64
    const trayIcon = nativeImage.createFromDataURL(`data:image/png;base64,${iconBase64}`);

    // Create tray
    tray = new Tray(trayIcon);

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
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('Whisper Transcriber');
    tray.setContextMenu(contextMenu);

    console.log('Tray created successfully');
  } catch (error) {
    console.error('Error creating tray:', error);
    // Continue without tray if it fails
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
    return store.get('shortcut') || 'CommandOrControl+Shift+Space';
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
function initialize() {
  // Create temp directory if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Set up IPC handlers
  setupIPCHandlers();

  // When app is ready
  app.whenReady().then(() => {
    try {
      // Create main window first
      createMainWindow();

      // Create tray icon
      createTray();

      // Register global shortcut
      const shortcut = store.get('shortcut') || 'CommandOrControl+Shift+Space';
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
  });

  // Prevent default behavior of closing app when all windows are closed
  app.on('window-all-closed', (e) => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
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

// Start the app
initialize();