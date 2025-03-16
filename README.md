# Whisper Transcriber

A macOS desktop application for transcribing audio using the Groq API and Whisper model. This app allows you to transcribe speech from your microphone and automatically paste it into any text field on your Mac.

## Features

- Record audio from your microphone with a simple click or global keyboard shortcut
- Transcribe speech using Groq's API and Whisper model
- Automatically paste transcribed text into any text field
- System tray integration for easy access
- Persistent API key storage

## Requirements

- macOS 
- Node.js (v14 or higher)
- Groq API key (get one from [Groq Console](https://console.groq.com/keys))
- Microphone access on your computer

## Installation

1. Clone this repository:
```
git clone https://github.com/your-username/whisper-transcriber.git
cd whisper-transcriber
```

2. Install Node.js dependencies:
```
npm install
```

3. Start the application:
```
npm start
```

## Usage

1. Launch the application
2. Enter your Groq API key in the settings section
3. Click "Start Recording" or use the global shortcut `Cmd+Shift+Space` to start recording
4. Speak clearly into your microphone
5. The app will automatically stop recording after 30 seconds or when you click "Stop Recording"
6. The transcribed text will be copied to your clipboard and can be pasted into any text field

## Building for Distribution

To create a distributable version of the app:

```
npm run build
```

This will create a distributable package in the `dist` directory.

## Permissions

This app requires the following permissions:

- Microphone access (for recording audio)
- Accessibility access (for pasting text)

## Technologies Used

- Electron.js - Cross-platform desktop app framework
- Groq API - For accessing the Whisper large language model
- Node.js - JavaScript runtime
- node-record-lpcm16 - For recording audio

## License

ISC