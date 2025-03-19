const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, clipboard } = require('electron');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store').default;

// Initialize store for app settings
const store = new Store();

// Define temporary directory for audio files
const tempDir = path.join(os.tmpdir(), 'whisper-transcriber');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// App state
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isRecording = false;
let recorder = null;
let audioData = [];

// =====================
// Window Management
// =====================

function createMainWindow() {
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
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    overlayWindow = null;
  }

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

// =====================
// Recording Management
// =====================

function startRecording() {
  console.log('Starting recording...');

  if (isRecording) return;

  isRecording = true;
  audioData = [];

  // Show overlay window
  createOverlayWindow();

  // Setup recording session in main window or overlay
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('start-recording');
  }
}

function stopRecording() {
  console.log('Stopping recording...');

  if (!isRecording) return;

  isRecording = false;

  // Tell window to stop recording and get audio data
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('stop-recording');
  }
}

// =====================
// API and Transcription
// =====================

async function transcribeAudio(audioBuffer) {
  try {
    console.log('Transcribing audio...');

    // Update overlay with status
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-progress', {
        step: 'start',
        message: 'Starting transcription...'
      });
    }

    // Get API key
    const apiKey = store.get('apiKey');
    if (!apiKey) {
      throw new Error('API key not set. Please configure in settings.');
    }

    // Save audio to temp file
    const tempFile = path.join(tempDir, `recording-${Date.now()}.wav`);
    fs.writeFileSync(tempFile, Buffer.from(audioBuffer));

    // Update progress
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-progress', {
        step: 'api',
        message: 'Sending to Groq API...'
      });
    }

    // Create form data for API request
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempFile));
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

          // Update progress
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('transcription-progress', {
              step: 'receiving',
              message: 'Receiving transcription...'
            });
          }
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

    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }

    if (!response.ok) {
      throw new Error(`API error: ${response.data}`);
    }

    // Parse response
    const result = JSON.parse(response.data);
    const transcription = result.text;

    // Update progress
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-progress', {
        step: 'complete',
        message: 'Transcription complete'
      });
    }

    // Copy to clipboard
    clipboard.writeText(transcription);

    console.log('Transcription copied to clipboard');

    // Close overlay after a delay
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.close();
        overlayWindow = null;
      }
    }, 1500);

    return transcription;

  } catch (error) {
    console.error('Transcription error:', error);

    // Show error in overlay
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('transcription-progress', {
        step: 'error',
        message: `Error: ${error.message}`
      });

      // Close overlay after a delay
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.close();
          overlayWindow = null;
        }
      }, 2000);
    }

    throw error;
  }
}

// =====================
// IPC Handlers
// =====================

// Handle recording start/stop from global shortcut
function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

// Receive audio data from renderer
ipcMain.handle('audio-data', async (event, audioBuffer) => {
  try {
    const transcription = await transcribeAudio(audioBuffer);
    return { success: true, transcription };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handle API key setting
ipcMain.handle('set-api-key', (event, key) => {
  store.set('apiKey', key);
  return true;
});

// Get API key
ipcMain.handle('get-api-key', () => {
  return store.get('apiKey') || '';
});

// Set global shortcut
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

// Get global shortcut
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

// =====================
// App Lifecycle
// =====================

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

app.whenReady().then(() => {
  // Create main window first
  createMainWindow();

  try {
    // Attempt to create tray
    createTray();
  } catch (error) {
    console.error('Failed to create tray:', error);
    // App will continue without tray
  }

  try {
    // Register global shortcut
    const shortcut = store.get('shortcut') || 'CommandOrControl+Shift+Space';
    globalShortcut.register(shortcut, toggleRecording);
  } catch (error) {
    console.error('Failed to register global shortcut:', error);
    // Show error in main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shortcut-error', error.message);
    }
  }

  // Handle app activation
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
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
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    overlayWindow = null;
  }
});