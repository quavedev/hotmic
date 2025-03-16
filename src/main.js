const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray } = require('electron');
const path = require('path');
const Store = require('electron-store');
// Import fetch and FormData for API requests
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');

// Initialize configuration store
const store = new Store();

// App state variables
let tray = null;
let mainWindow = null;
let overlayWindow = null;
let isRecording = false;
let apiKey = store.get('apiKey');
let globalShortcutKey = store.get('globalShortcut') || 'CommandOrControl+Shift+Space';

// Define temporary directory for audio files
const tempDir = path.join(os.tmpdir(), 'whisper-transcriber');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../public/icons/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  // Hide the window when closed instead of quitting the app
  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  // Development tools
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// Function to create floating overlay window for recording visualization
function createOverlayWindow() {
  // If window already exists, just show it
  if (overlayWindow) {
    overlayWindow.show();
    return;
  }
  
  // Get the primary display to center the window
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  // Create a transparent, frameless window
  overlayWindow = new BrowserWindow({
    width: 300,
    height: 300,
    x: Math.floor(width / 2 - 150),  // Center horizontally
    y: Math.floor(height / 2 - 150),  // Center vertically
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  
  // Load the overlay HTML
  overlayWindow.loadFile(path.join(__dirname, '../public/overlay.html'));
  
  // Hide instead of close when the close button is clicked
  overlayWindow.on('close', (event) => {
    event.preventDefault();
    overlayWindow.hide();
  });
  
  // Show dev tools in development mode
  if (process.argv.includes('--dev')) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' });
  }
  
  // When the window is ready, show it with a nice fade-in
  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
  });
}

function createTray() {
  // Try different approaches to create a tray icon
  let trayIconPath = path.join(__dirname, '../public/icons/tray-icon.png');
  
  // Check if the icon file exists
  if (!fs.existsSync(trayIconPath)) {
    console.log('Tray icon not found at expected path, creating default icon');
    
    // Create icons directory if it doesn't exist
    const iconsDir = path.dirname(trayIconPath);
    if (!fs.existsSync(iconsDir)) {
      fs.mkdirSync(iconsDir, { recursive: true });
    }
    
    // Create a minimalistic PNG as tray icon
    const blankIconData = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(trayIconPath, blankIconData);
  }
  
  try {
    tray = new Tray(trayIconPath);
  } catch (error) {
    console.error('Failed to create tray with icon, trying native image:', error);
    
    // Try creating with NativeImage
    const nativeImage = require('electron').nativeImage;
    const image = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    tray = new Tray(image);
  }
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: `Start/Stop Transcription (${globalShortcutKey})`, 
      click: toggleRecording 
    },
    { type: 'separator' },
    { 
      label: 'Show App', 
      click: () => mainWindow.show() 
    },
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => {
        app.quit();
      } 
    }
  ]);
  tray.setToolTip('Whisper Transcriber');
  tray.setContextMenu(contextMenu);
}

async function validateApiKey() {
  if (!apiKey) {
    console.error('Groq API key not set');
    return false;
  }
  
  // We'll consider the API key valid if it's not empty
  // The actual validation will happen when we make API calls
  return apiKey.trim().length > 0;
}

async function transcribeAudio(base64Audio) {
  if (!base64Audio) {
    console.error('No audio data provided for transcription');
    return 'Error: No audio data provided';
  }

  if (!apiKey) {
    return 'Error: Groq API key not configured. Please enter your API key in the settings.';
  }

  // Create temp directory if needed
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Save base64 audio to a temporary file
  const tempFile = path.join(tempDir, `recording-${Date.now()}.webm`);
  
  try {
    // Convert base64 to binary and save to file
    const binaryData = Buffer.from(base64Audio, 'base64');
    fs.writeFileSync(tempFile, binaryData);
    
    console.log(`Saved audio to ${tempFile}, sending to Groq Speech-to-Text API...`);
    
    try {
      // Create form data with the audio file
      const form = new FormData();
      form.append('file', fs.createReadStream(tempFile));
      form.append('model', 'whisper-large-v3');
      
      // Make the API request
      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...form.getHeaders()
        },
        body: form
      });
      
      // Clean up the temporary file
      try {
        fs.unlinkSync(tempFile);
      } catch (unlinkError) {
        console.error('Error removing temp file:', unlinkError);
      }
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('Error response from Groq API:', errorData);
        
        if (response.status === 401) {
          return 'Error: API key is invalid or expired. Please update your Groq API key in settings.';
        } else if (response.status === 404) {
          return 'Error: Speech-to-Text endpoint not found. Please check if the service is available.';
        }
        
        return `Error from Groq API: ${response.status} ${JSON.stringify(errorData)}`;
      }
      
      // Parse the response
      const data = await response.json();
      
      if (data && data.text) {
        return data.text;
      } else {
        console.error('Unexpected response format from Groq API:', data);
        return 'Error: Unexpected response format from Groq API';
      }
    } catch (groqError) {
      console.error('Error from Groq API:', groqError);
      return `Error from Groq API: ${groqError.message}`;
    }
  } catch (error) {
    console.error('Error transcribing audio:', error);
    
    // Clean up the temporary file if it exists
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (unlinkError) {
      console.error('Error removing temp file:', unlinkError);
    }
    
    return `Error: ${error.message}`;
  }
}

// This function now toggles recording and manages the overlay
function toggleRecording() {
  // If this was triggered by the global shortcut, create/show the overlay window
  if (!mainWindow.isFocused()) {
    createOverlayWindow();
  }
  
  // Notify the main window to toggle recording
  if (mainWindow) {
    mainWindow.webContents.send('toggle-recording');
  }
  
  // Notify the overlay window (if it exists) about the recording toggle
  if (overlayWindow && overlayWindow.isVisible()) {
    overlayWindow.webContents.send('toggle-recording');
  }
}

// IPC handlers
ipcMain.handle('save-api-key', async (event, key) => {
  store.set('apiKey', key);
  apiKey = key;
  return await validateApiKey();
});

ipcMain.handle('get-api-key', () => {
  return store.get('apiKey') || '';
});

// New handler to transcribe audio data sent from the renderer
ipcMain.handle('transcribe-audio', async (event, base64Audio) => {
  if (mainWindow) {
    mainWindow.webContents.send('recording-status', false);
  }
  
  if (tray) {
    tray.setToolTip('Whisper Transcriber (Transcribing...)');
  }
  
  const transcription = await transcribeAudio(base64Audio);
  
  // Copy to clipboard and send to app
  if (transcription && !transcription.startsWith('Error:')) {
    require('electron').clipboard.writeText(transcription);
    
    if (mainWindow) {
      mainWindow.webContents.send('transcription-complete', transcription);
    }
    
    console.log('Text copied to clipboard - you can paste with Command+V');
  } else if (mainWindow) {
    mainWindow.webContents.send('error', transcription || 'Transcription failed');
  }
  
  if (tray) {
    tray.setToolTip('Whisper Transcriber');
  }
  
  return transcription;
});

// New handler to update recording state
ipcMain.handle('update-recording-state', (event, isCurrentlyRecording) => {
  isRecording = isCurrentlyRecording;
  
  if (tray) {
    if (isRecording) {
      tray.setToolTip('Whisper Transcriber (Recording...)');
    } else {
      tray.setToolTip('Whisper Transcriber');
    }
  }
  
  return true;
});

// Handler for saving and registering a new global shortcut
ipcMain.handle('set-global-shortcut', async (event, shortcutKey) => {
  try {
    globalShortcutKey = shortcutKey;
    store.set('globalShortcut', shortcutKey);
    
    // Register the new shortcut
    const success = registerGlobalShortcut();
    
    // Update tray menu text if needed
    if (success && tray) {
      const contextMenu = Menu.buildFromTemplate([
        { 
          label: `Start/Stop Transcription (${globalShortcutKey})`, 
          click: toggleRecording 
        },
        { type: 'separator' },
        { 
          label: 'Show App', 
          click: () => mainWindow.show() 
        },
        { type: 'separator' },
        { 
          label: 'Quit', 
          click: () => {
            app.quit();
          } 
        }
      ]);
      tray.setContextMenu(contextMenu);
    }
    
    return success;
  } catch (error) {
    console.error('Error setting global shortcut:', error);
    return false;
  }
});

// Handler for getting the current global shortcut
ipcMain.handle('get-global-shortcut', () => {
  return globalShortcutKey;
});

// Handler for receiving audio levels and forwarding to overlay window
ipcMain.handle('audio-level', (event, level) => {
  if (overlayWindow && overlayWindow.isVisible()) {
    overlayWindow.webContents.send('audio-level', level);
  }
  return true;
});

// Function to register the global shortcut
function registerGlobalShortcut() {
  try {
    // Unregister any existing shortcuts first
    globalShortcut.unregisterAll();
    
    // Register the new shortcut
    const registered = globalShortcut.register(globalShortcutKey, toggleRecording);
    if (registered) {
      console.log(`Global shortcut ${globalShortcutKey} registered successfully`);
      if (mainWindow) {
        mainWindow.webContents.send('shortcut-updated', globalShortcutKey);
      }
      return true;
    } else {
      console.error(`Failed to register global shortcut ${globalShortcutKey}`);
      return false;
    }
  } catch (error) {
    console.error('Error registering global shortcut:', error);
    return false;
  }
}

// App lifecycle
app.whenReady().then(async () => {
  try {
    console.log('Starting Whisper Transcriber application...');
    
    // Create the main application window
    createWindow();
    console.log('Main window created');
    
    // Create system tray icon
    try {
      createTray();
      console.log('System tray icon created');
    } catch (trayError) {
      console.error('Failed to create tray, continuing without tray icon:', trayError);
      // Continue without tray
    }
    
    // Register the saved global shortcut
    registerGlobalShortcut();
    
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow) {
        mainWindow.show();
      }
    });
    
    // Check if API key is valid
    const isApiKeyValid = await validateApiKey();
    if (isApiKeyValid) {
      console.log('Groq API key is present');
    } else {
      console.log('Waiting for Groq API key to be set');
    }
    
    console.log('App initialization complete');
    
  } catch (error) {
    console.error('Error during app initialization:', error);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Unregister shortcut
  globalShortcut.unregisterAll();
});