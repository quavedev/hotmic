# HotMic

A lightweight desktop application that transcribes audio using the Groq API and Whisper-large-v3 model.

## Features

- Press a global shortcut to start/stop recording
- Audio is sent to Groq API for transcription
- Results are automatically copied to clipboard
- Visual feedback during recording and processing
- Configurable keyboard shortcut

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Run the application:
   ```
   npm start
   ```

## Configuration

1. Sign up for a Groq API account at [https://console.groq.com](https://console.groq.com)
2. Get an API key
3. Enter your API key in the app settings

## Usage

1. Press the configured global shortcut (default: Ctrl+Shift+Space) to start recording
2. Speak into your microphone
3. Press the shortcut again to stop recording and begin transcription
4. Once transcription is complete, the text will be copied to your clipboard

## Development

- Run with developer tools: `npm run dev`
- Build distribution: `npm run build`

## Dependencies

- Electron
- Electron Store
- Form Data

## License

MIT