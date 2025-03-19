document.addEventListener('DOMContentLoaded', async () => {
  // DOM elements
  const apiKeyInput = document.getElementById('api-key');
  const saveApiKeyBtn = document.getElementById('save-api-key');
  const shortcutInput = document.getElementById('shortcut-input');
  const recordShortcutBtn = document.getElementById('record-shortcut-btn');
  const saveShortcutBtn = document.getElementById('save-shortcut-btn');
  const recordBtn = document.getElementById('record-btn');
  const statusElement = document.getElementById('status');
  const transcriptionResult = document.getElementById('transcription-result');
  const notification = document.getElementById('notification');

  // Tab elements
  const tabTranscribe = document.getElementById('tab-transcribe');
  const tabHistory = document.getElementById('tab-history');
  const tabSettings = document.getElementById('tab-settings');
  const transcribeSection = document.getElementById('transcribe-section');
  const historySection = document.getElementById('history-section');
  const settingsSection = document.getElementById('settings-section');

  // Initialize tab navigation
  setupTabs();

  // Audio recording variables
  let isRecording = false;
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingTimer = null;
  let audioStream = null;

  // Audio analyzer variables
  let audioContext;
  let analyzer;
  let analyzerInterval;
  let isSendingAudioLevels = false;

  // Transcription history (stored in memory for this session)
  let transcriptionHistory = [];

  // Get saved API key
  const savedApiKey = await window.electronAPI.getApiKey();
  if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
    // Mask the API key
    setTimeout(() => {
      apiKeyInput.type = 'password';
    }, 500);
  }

  // Get and display the current global shortcut
  const currentShortcut = await window.electronAPI.getGlobalShortcut();
  shortcutInput.value = currentShortcut;

  // Set up listeners for events from main process
  const removeRecordingStatusListener = window.electronAPI.onRecordingStatus((recording) => {
    updateRecordingUI(recording);
  });

  const removeTranscriptionListener = window.electronAPI.onTranscriptionComplete((text) => {
    // Update transcription result
    transcriptionResult.textContent = text;

    // Add to history
    const timestamp = new Date().toLocaleString();
    transcriptionHistory.unshift({ text, timestamp });
    updateTranscriptionHistory();

    // Show notification
    showNotification('Transcription complete and copied to clipboard', 'success');
  });

  const removeErrorListener = window.electronAPI.onError((message) => {
    showNotification(message, 'error');
  });

  const removeToggleRecordingListener = window.electronAPI.onToggleRecording(() => {
    toggleRecording();
  });

  const removeStartRecordingFromMainListener = window.electronAPI.onStartRecordingFromMain(() => {
    setupAudioRecording();
  });

  const removeShortcutUpdatedListener = window.electronAPI.onShortcutUpdated((shortcut) => {
    shortcutInput.value = shortcut;
    showNotification(`Global shortcut updated to: ${shortcut}`, 'success');
  });

  // Shortcut recording variables
  let isRecordingShortcut = false;
  let recordedKeys = new Set();
  let keyOrder = [];

  // Event listeners for API key
  saveApiKeyBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      showNotification('Please enter an API key', 'error');
      return;
    }

    const success = await window.electronAPI.saveApiKey(apiKey);

    if (success) {
      showNotification('API key saved successfully', 'success');
    } else {
      showNotification('Failed to validate API key', 'error');
    }
  });

  // Event listeners for shortcut recording
  recordShortcutBtn.addEventListener('click', () => {
    toggleShortcutRecording();
  });

  saveShortcutBtn.addEventListener('click', async () => {
    const shortcut = shortcutInput.value.trim();
    if (!shortcut) {
      showNotification('Please record a shortcut first', 'error');
      return;
    }

    const success = await window.electronAPI.setGlobalShortcut(shortcut);

    if (success) {
      showNotification(`Global shortcut set to: ${shortcut}`, 'success');
    } else {
      showNotification('Failed to register shortcut. Try a different combination.', 'error');
    }
  });

  function toggleShortcutRecording() {
    isRecordingShortcut = !isRecordingShortcut;

    if (isRecordingShortcut) {
      // Start recording
      recordShortcutBtn.textContent = 'Stop';
      recordShortcutBtn.classList.add('recording');
      shortcutInput.value = 'Press keys...';
      recordedKeys.clear();
      keyOrder = [];

      // Add key listeners
      window.addEventListener('keydown', recordKeyDown);
      window.addEventListener('keyup', recordKeyUp);
    } else {
      // Stop recording
      recordShortcutBtn.textContent = 'Record';
      recordShortcutBtn.classList.remove('recording');
      window.removeEventListener('keydown', recordKeyDown);
      window.removeEventListener('keyup', recordKeyUp);

      // Format the shortcut
      formatShortcut();
    }
  }

  function recordKeyDown(event) {
    if (!isRecordingShortcut) return;

    event.preventDefault();

    const key = normalizeKey(event.key);
    if (!recordedKeys.has(key)) {
      recordedKeys.add(key);
      keyOrder.push(key);
      updateShortcutDisplay();
    }
  }

  function recordKeyUp(event) {
    // Nothing needed here for now
  }

  function normalizeKey(key) {
    // Normalize key names
    switch (key) {
      case ' ':
        return 'Space';
      case 'Control':
        return 'CommandOrControl';
      case 'Meta':
        return 'CommandOrControl';
      case 'ArrowUp':
        return 'Up';
      case 'ArrowDown':
        return 'Down';
      case 'ArrowLeft':
        return 'Left';
      case 'ArrowRight':
        return 'Right';
      default:
        // Capitalize first letter for single character keys
        if (key.length === 1) {
          return key.toUpperCase();
        }
        return key;
    }
  }

  function updateShortcutDisplay() {
    if (keyOrder.length === 0) {
      shortcutInput.value = 'Press keys...';
    } else {
      shortcutInput.value = keyOrder.join('+');
    }
  }

  function formatShortcut() {
    if (keyOrder.length === 0) {
      shortcutInput.value = '';
      return;
    }

    // Move modifier keys to the front
    const modifiers = ['CommandOrControl', 'Alt', 'Shift', 'Option'];
    const sortedKeys = [];

    // First add modifiers in correct order
    modifiers.forEach(mod => {
      if (recordedKeys.has(mod)) {
        sortedKeys.push(mod);
        recordedKeys.delete(mod);
      }
    });

    // Then add remaining keys in the order they were pressed
    keyOrder.forEach(key => {
      if (recordedKeys.has(key)) {
        sortedKeys.push(key);
      }
    });

    shortcutInput.value = sortedKeys.join('+');
  }

  // Audio recording
  recordBtn.addEventListener('click', toggleRecording);

  // Functions to handle recording
  async function toggleRecording() {
    if (isRecording) {
      stopRecording();
    } else {
      await startRecording();
    }
  }

  // Listen for Escape key to cancel recording
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isRecording) {
      // Just stop recording without processing
      isRecording = false;
      updateRecordingUI(false);
      window.electronAPI.updateRecordingState(false);
    }
  });

  async function startRecording() {
    const apiKey = await window.electronAPI.getApiKey();
    if (!apiKey) {
      showNotification('Please configure your Groq API key first', 'error');
      return;
    }

    try {
      isRecording = true;
      updateRecordingUI(true);
      await window.electronAPI.updateRecordingState(true);

      // Set up audio recording
      await setupAudioRecording();

      recordingTimer = setTimeout(() => {
        if (isRecording) {
          stopRecording();
        }
      }, 30000);
    } catch (error) {
      console.error('Error starting recording:', error);
      showNotification(`Error starting recording: ${error.message}`, 'error');
    }
  }

  async function setupAudioRecording() {
    try {
      // Get microphone input
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Set up audio analyzer
      setupAudioAnalyzer(audioStream);

      // Set up media recorder
      mediaRecorder = new MediaRecorder(audioStream);
      audioChunks = [];

      mediaRecorder.addEventListener('dataavailable', event => {
        audioChunks.push(event.data);
      });

      mediaRecorder.addEventListener('stop', async () => {
        // Process the audio data for transcription
        if (audioChunks.length > 0) {
          await processRecording();
        }
      });

      mediaRecorder.start(1000);
    } catch (error) {
      console.error('Error setting up audio recording:', error);
      showNotification(`Error setting up audio: ${error.message}`, 'error');
    }
  }

  function stopRecording() {
    if (!isRecording) return;

    if (recordingTimer) {
      clearTimeout(recordingTimer);
      recordingTimer = null;
    }

    isRecording = false;
    updateRecordingUI(false);
    window.electronAPI.updateRecordingState(false);

    // Stop media recorder
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    // Stop audio tracks
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop());
      audioStream = null;
    }

    // Clean up audio analyzer
    cleanupAudioAnalyzer();
  }

  async function processRecording() {
    try {
      showNotification('Processing audio...', '');

      // Create an audio blob from the recorded chunks
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });

      // Convert blob to base64
      const base64Audio = await blobToBase64(audioBlob);

      // Remove the data URI prefix (e.g., "data:audio/webm;base64,")
      const base64Data = base64Audio.split(',')[1];

      // Send to main process for transcription
      await window.electronAPI.transcribeAudio(base64Data);

    } catch (error) {
      console.error('Error processing recording:', error);
      showNotification(`Error processing recording: ${error.message}`, 'error');
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function updateRecordingUI(recording) {
    if (recording) {
      recordBtn.textContent = 'Stop Recording';
      recordBtn.style.backgroundColor = '#ff3b30';
      statusElement.textContent = 'Recording...';
      statusElement.classList.add('recording');
    } else {
      recordBtn.textContent = 'Start Recording';
      recordBtn.style.backgroundColor = '';
      statusElement.textContent = 'Not recording';
      statusElement.classList.remove('recording');
    }
  }

  /**
   * SIMPLIFIED AUDIO ANALYZER
   * Just get the basic audio levels and send them
   */
  function setupAudioAnalyzer(stream) {
    console.log('Setting up BASIC audio analyzer');

    // Clean up any existing analyzer
    cleanupAudioAnalyzer();

    try {
      // Create audio context and analyzer
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      analyzer = audioContext.createAnalyser();

      // Use small FFT size for better performance
      analyzer.fftSize = 256;
      analyzer.smoothingTimeConstant = 0.5; // Less jittery
      source.connect(analyzer);

      // Set up data array for frequency analysis
      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      // Flag to track if we're sending levels
      isSendingAudioLevels = true;

      // Function to analyze audio
      const analyzeAudio = () => {
        // Return early if not recording
        if (!isRecording || !isSendingAudioLevels) {
          return;
        }

        try {
          // Get frequency data
          analyzer.getByteFrequencyData(dataArray);

          // Calculate average volume (0-1)
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
          }
          const average = sum / bufferLength / 255;

          // Calculate a more stable audio level with proper noise gate
          let level = Math.min(1.0, average * 2.5); // Amplify a bit

          // Apply noise gate - zero out any levels below threshold
          const noiseGate = 0.07;
          if (level < noiseGate) {
            level = 0;
          }

          // SUPER CLEAR AUDIO LEVEL LOGGING
          console.log(`‼️ DETECTED AUDIO LEVEL: ${level.toFixed(4)}`);

          // Show right in the document for absolute clarity
          document.title = `Audio: ${level.toFixed(2)}`;

          // Update debug display with VERY visible indication
          const debugEl = document.getElementById('audio-debug');
          if (debugEl) {
            debugEl.textContent = `AUDIO LEVEL: ${level.toFixed(4)}`;
            debugEl.style.backgroundColor = level > 0.1 ? 'green' : 'red';
          }

          // Send to main process with a clear message
          console.log(`📢 SENDING LEVEL ${level.toFixed(4)} TO MAIN PROCESS`);
          window.electronAPI.sendAudioLevel(level)
            .then(() => {
              // Schedule next frame if still recording
              if (isRecording && isSendingAudioLevels) {
                requestAnimationFrame(analyzeAudio);
              }
            })
            .catch(err => {
              console.error(`❌ ERROR SENDING AUDIO: ${err.message}`);
            });
        } catch (error) {
          console.error(`❌ ERROR ANALYZING AUDIO: ${error.message}`);
        }
      };

      // Start the analysis loop
      requestAnimationFrame(analyzeAudio);
    } catch (error) {
      console.error(`❌ SETUP ERROR: ${error.message}`);
    }
  }

  // Helper function to clean up audio analyzer resources
  function cleanupAudioAnalyzer() {
    // Set flag to stop any ongoing analysis
    isSendingAudioLevels = false;

    // Clear any interval (not used in test version)
    if (analyzerInterval) {
      clearInterval(analyzerInterval);
      analyzerInterval = null;
    }

    // Close audio context if it exists
    if (audioContext && audioContext.state !== 'closed') {
      try {
        audioContext.close().catch(err => {
          console.log('Error closing audio context:', err);
        });
      } catch (e) {
        console.log('Error closing audio context:', e);
      }
    }

    // Clear references
    audioContext = null;
    analyzer = null;
  }

  // Helper functions
  function showNotification(message, type = '') {
    notification.textContent = message;
    notification.className = ''; // Reset classes

    if (type) {
      notification.classList.add(type);
    }

    notification.classList.remove('hidden');

    // Auto-hide after 3 seconds
    setTimeout(() => {
      notification.classList.add('hidden');
    }, 3000);
  }

  // Clean up event listeners when window is closed
  window.addEventListener('beforeunload', () => {
    // Remove IPC event listeners
    removeRecordingStatusListener();
    removeTranscriptionListener();
    removeErrorListener();
    removeToggleRecordingListener();
    removeStartRecordingFromMainListener();
    removeShortcutUpdatedListener();

    // Remove DOM event listeners
    if (recordShortcutBtn) {
      recordShortcutBtn.removeEventListener('click', toggleShortcutRecording);
    }

    if (saveShortcutBtn) {
      saveShortcutBtn.removeEventListener('click', saveShortcut);
    }

    if (recordBtn) {
      recordBtn.removeEventListener('click', toggleRecording);
    }

    // Stop recording if active
    if (isRecording) {
      stopRecording();
    }
  });

  // Tab navigation functions
  function setupTabs() {
    // Add click listeners to tabs
    tabTranscribe.addEventListener('click', () => switchTab('transcribe'));
    tabHistory.addEventListener('click', () => switchTab('history'));
    tabSettings.addEventListener('click', () => switchTab('settings'));
  }

  function switchTab(tabName) {
    // Remove active class from all tabs
    tabTranscribe.classList.remove('active');
    tabHistory.classList.remove('active');
    tabSettings.classList.remove('active');

    // Hide all sections
    transcribeSection.style.display = 'none';
    historySection.style.display = 'none';
    settingsSection.style.display = 'none';

    // Show selected tab and content
    switch (tabName) {
      case 'transcribe':
        tabTranscribe.classList.add('active');
        transcribeSection.style.display = 'block';
        break;
      case 'history':
        tabHistory.classList.add('active');
        historySection.style.display = 'block';
        updateTranscriptionHistory(); // Refresh the history when switching to this tab
        break;
      case 'settings':
        tabSettings.classList.add('active');
        settingsSection.style.display = 'block';
        break;
    }
  }

  // Update the transcription history display
  function updateTranscriptionHistory() {
    const historyList = document.getElementById('history-list');

    if (transcriptionHistory.length === 0) {
      historyList.innerHTML = '<div class="empty-history">No transcription history yet</div>';
      return;
    }

    let historyHTML = '';
    transcriptionHistory.forEach((item, index) => {
      historyHTML += `
        <div class="history-item">
          <div class="history-timestamp">${item.timestamp}</div>
          <div class="history-text">${item.text}</div>
        </div>
        ${index < transcriptionHistory.length - 1 ? '<hr class="history-divider">' : ''}
      `;
    });

    historyList.innerHTML = historyHTML;
  }
});