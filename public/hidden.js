// Variables for audio recording
let isRecording = false;
let mediaRecorder = null;
let audioStream = null;
let audioChunks = [];
let recordingTimer = null;
let recordingStartTime = null;

// Audio analyzer variables
let audioContext;
let analyzer;
let analyzerInterval;
let isSendingAudioLevels = false;
let audioLevelHistory = []; // Store recent audio levels for better visualization

// DOM elements
const statusElement = document.getElementById('status');
const audioDebugElement = document.getElementById('audio-debug');

// Initialize the hidden recorder
document.addEventListener('DOMContentLoaded', () => {
  console.log('Hidden recorder initialized');
  updateStatus('Ready');
});

// Listen for commands from the main process
window.electronAPI.onStartRecordingFromMain(async () => {
  console.log('Hidden window received start recording command');
  await setupAudioRecording();
});

window.electronAPI.onStopRecordingFromMain(() => {
  console.log('Hidden window received stop recording command');
  stopRecording();
});

/**
 * Set up audio recording
 */
async function setupAudioRecording() {
  try {
    updateStatus('Setting up recording...');

    // Stop any existing recording
    if (isRecording) {
      stopRecording();
    }

    // Reset audio level history
    audioLevelHistory = [];

    // Get microphone input with higher quality settings
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false, // Disable to get more natural levels
        sampleRate: 44100,
        channelCount: 1
      }
    };

    audioStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Set up media recorder with better quality
    const options = { mimeType: 'audio/webm;codecs=opus' };
    try {
      mediaRecorder = new MediaRecorder(audioStream, options);
    } catch (e) {
      console.warn('Opus codec not supported, falling back to default codec');
      mediaRecorder = new MediaRecorder(audioStream);
    }

    audioChunks = [];
    recordingStartTime = Date.now();

    // Set up event listeners
    mediaRecorder.addEventListener('dataavailable', event => {
      audioChunks.push(event.data);
    });

    mediaRecorder.addEventListener('stop', async () => {
      console.log('MediaRecorder stopped');

      // Only process if we didn't manually stop
      if (isRecording) {
        // Create blob from chunks
        const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/wav' });

        // Log recording information
        const recordingDuration = Date.now() - recordingStartTime;
        console.log(`Recording completed: ${(audioBlob.size / 1024).toFixed(2)} KB, ${(recordingDuration / 1000).toFixed(1)} seconds`);
        updateStatus(`Processing ${(audioBlob.size / 1024).toFixed(0)} KB audio...`);

        // Convert to base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          const base64data = reader.result.split(',')[1];
          // Send to main process for transcription
          window.electronAPI.sendAudioForTranscriptionMain(base64data)
            .catch(err => {
              console.error('Error sending audio for transcription:', err);
              updateStatus('Error: ' + err.message);
            });
        };

        // Reset recording state
        isRecording = false;
        updateStatus('Processing transcription...');
      }

      // Clean up
      cleanupAudioRecording();
    });

    // Start recording
    mediaRecorder.start(1000); // Collect data every second
    isRecording = true;
    updateStatus('Recording');

    // Set up audio analyzer for level monitoring
    setupAudioAnalyzer(audioStream);

  } catch (error) {
    console.error('Error setting up audio recording:', error);
    updateStatus('Error: ' + error.message);
    cleanupAudioRecording();
  }
}

/**
 * Stop recording
 */
function stopRecording() {
  if (!isRecording) return;

  console.log('Stopping recording in hidden window');

  // Stop the media recorder if it's active
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (error) {
      console.error('Error stopping media recorder:', error);
    }
  }

  // Clean up analyzer
  cleanupAudioAnalyzer();

  // Clean up audio recording
  cleanupAudioRecording();

  // Update state
  isRecording = false;
  updateStatus('Stopped');
}

/**
 * Clean up audio recording resources
 */
function cleanupAudioRecording() {
  // Stop all tracks in the audio stream
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  // Clear recording timer
  if (recordingTimer) {
    clearTimeout(recordingTimer);
    recordingTimer = null;
  }

  // Reset media recorder
  mediaRecorder = null;

  // Reset chunks
  audioChunks = [];
}

/**
 * Set up audio analyzer to monitor audio levels
 */
function setupAudioAnalyzer(stream) {
  console.log('Setting up audio analyzer in hidden window');

  // Clean up any existing analyzer
  cleanupAudioAnalyzer();

  try {
    // Create audio context and analyzer
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyzer = audioContext.createAnalyser();

    // Configure analyzer for better frequency response
    analyzer.fftSize = 1024; // More detailed frequency data
    analyzer.smoothingTimeConstant = 0.3; // More responsive
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
        let level = Math.min(1.0, average * 3.0); // Amplify a bit more for better visualization

        // Apply noise gate - zero out any levels below threshold
        const noiseGate = 0.05; // Slightly lower noise gate
        if (level < noiseGate) {
          level = 0;
        }

        // Keep a short history of audio levels for smoothing
        audioLevelHistory.push(level);
        if (audioLevelHistory.length > 3) {
          audioLevelHistory.shift();
        }

        // Calculate smoothed level (average of recent levels)
        const smoothedLevel = audioLevelHistory.reduce((sum, val) => sum + val, 0) / audioLevelHistory.length;

        // Update debug display
        updateAudioLevel(smoothedLevel);

        // Send to main process
        window.electronAPI.sendAudioLevel(smoothedLevel)
          .then(() => {
            // Schedule next frame if still recording
            if (isRecording && isSendingAudioLevels) {
              requestAnimationFrame(analyzeAudio);
            }
          })
          .catch(err => {
            console.error('Error sending audio level:', err);
          });
      } catch (error) {
        console.error('Error analyzing audio:', error);
      }
    };

    // Start the analysis loop
    requestAnimationFrame(analyzeAudio);
  } catch (error) {
    console.error('Error setting up audio analyzer:', error);
  }
}

/**
 * Clean up audio analyzer resources
 */
function cleanupAudioAnalyzer() {
  // Set flag to stop any ongoing analysis
  isSendingAudioLevels = false;

  // Clear any interval
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

/**
 * Update the status display
 */
function updateStatus(status) {
  if (statusElement) {
    statusElement.textContent = status;
  }
}

/**
 * Update the audio level display
 */
function updateAudioLevel(level) {
  if (audioDebugElement) {
    audioDebugElement.textContent = `Audio level: ${level.toFixed(4)}`;

    // Use a gradient color from red (high) to green (low)
    const red = Math.floor(level * 255);
    const green = Math.floor(255 - (level * 128));
    const blue = 100;

    audioDebugElement.style.backgroundColor = level > 0.1
      ? `rgb(${red}, ${green}, ${blue})`
      : '#f7d4d4';
  }
}
