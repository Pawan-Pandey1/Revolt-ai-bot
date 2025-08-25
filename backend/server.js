// --- Importing required modules --- //
import http from 'http'; // Node's HTTP module to create a server
import cors from 'cors'; // Enables Cross-Origin Resource Sharing
import { WebSocketServer } from 'ws'; // WebSocket server for real-time communication
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, ActivityHandling } from '@google/genai'; 
// Google GenAI SDK for real-time AI audio interaction
import express from 'express'; // Express framework for APIs and middleware
import dotenv from 'dotenv'; // For loading environment variables from .env
dotenv.config(); // Load .env variables into process.env

// --- Setup Express and HTTP server --- //
const app = express();
const server = http.createServer(app);

// Attach WebSocket server to the same HTTP server, on custom path
const wss = new WebSocketServer({ server, path: '/api/genai-audio' });

// Middlewares
app.use(cors()); // Allow frontend apps from other domains to connect
app.use(express.json()); // Parse incoming JSON requests

// Health check endpoint (simple API test route)
app.get('/', (req, res) => {
  res.send('GenAI Audio Streaming Backend is running.');
});

// --- Google GenAI Model Configuration --- //
const model = "gemini-2.5-flash-preview-native-audio-dialog"; // Realtime speech model
const config = {
  responseModalities: [Modality.AUDIO], // Expecting audio responses back
  systemInstruction: `You are Rev, the helpful voice assistant for Revolt Motors...`, 
  // Custom system prompt for AI behavior
  realtimeInputConfig: {
    automaticActivityDetection: { // Controls speech detection
      disabled: false,
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_MEDIUM, // Detect when user starts talking
      endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_MEDIUM, // Detect when user stops talking
      prefixPaddingMs: 20, // Add small padding before speech
      silenceDurationMs: 100, // Silence before considering end of speech
    },
    activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS, 
    // Allows interrupting AI speech when user starts speaking again
  },
};

// --- WebSocket Handling (real-time audio exchange) --- //
wss.on('connection', async (ws) => {
  console.log('WebSocket client connected');

  let session = null;          // Google GenAI live session
  let closed = false;          // Tracks if connection is closed
  const responseQueue = [];    // Queue of AI responses to send to client
  let isGenerating = false;    // Flag for AI speech generation state
  let currentTurnId = null;    // ID for the current AI speaking turn

  // --- Helper function: wait for AI messages in queue --- //
  async function waitMessage() {
    let message;
    while (!message) {
      message = responseQueue.shift(); // Pop message from queue
      if (!message) {
        await new Promise((resolve) => setTimeout(resolve, 100)); // Polling every 100ms
      }
    }
    return message;
  }

  // --- Helper function: process one conversation turn --- //
  async function handleTurn() {
    const turns = [];
    let done = false;
    while (!done) {
      const message = await waitMessage();
      turns.push(message);

      // If AI returns audio, forward immediately to client
      if (message.data && !message.serverContent?.interrupted) {
        ws.send(JSON.stringify({ type: 'audio', data: message.data }));
      }

      // Track AI generation state
      if (message.serverContent?.generationComplete) {
        isGenerating = false;
      }

      // End the turn when AI signals it's finished
      if (message.serverContent?.turnComplete) {
        done = true;
        isGenerating = false;
        currentTurnId = null;
      }
    }
    return turns;
  }

  // --- Create a Google GenAI live session --- //
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    session = await ai.live.connect({
      model: model,
      callbacks: {
        onopen: () => {
          ws.send(JSON.stringify({ type: 'status', message: 'Session opened' }));
        },
        onmessage: (message) => {
          console.log("Received message from Gemini:", message);

          // If user interrupted AI
          if (message.serverContent?.interrupted) {
            console.log("Interruption detected - stopping current generation");
            isGenerating = false;
            ws.send(JSON.stringify({
              type: 'interrupt',
              turnId: currentTurnId,
              timestamp: Date.now()
            }));
          }

          // Track when AI starts generating speech
          if (message.serverContent?.modelTurn) {
            if (!isGenerating) {
              isGenerating = true;
              currentTurnId = Date.now().toString(); // Unique ID for turn
              ws.send(JSON.stringify({
                type: 'generation_start',
                turnId: currentTurnId
              }));
            }
          }

          // Push message into queue for handleTurn()
          responseQueue.push(message);
        },
        onerror: (e) => {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        },
        onclose: (e) => {
          ws.send(JSON.stringify({ type: 'status', message: 'Session closed: ' + e.reason }));
        },
      },
      config: config,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close();
    return;
  }

  // --- When WebSocket receives audio from client --- //
  ws.on('message', async (data) => {
    try {
      // Convert raw PCM audio to base64 for Gemini API
      const base64Audio = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');

      console.log('--- Debug Session Start ---');
      console.log('Received PCM buffer length:', data.length);
      console.log('Base64 audio preview:', base64Audio.slice(0, 30));
      console.log('Sending audio to Gemini...');

      // Send audio input to AI
      session.sendRealtimeInput({
        audio: {
          data: base64Audio,
          mimeType: "audio/pcm;rate=16000" // Format required by Gemini
        }
      });

      // Handle the AI's response (turns of conversation)
      const turns = await handleTurn();
      console.log('Received response from Gemini:', turns.length, 'turn(s)');
      console.log('--- Debug Session End ---');
    } catch (e) {
      console.error('Error in audio debug session:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  // --- Handle client disconnect --- //
  ws.on('close', () => {
    closed = true;
    if (session) session.close();
    console.log('WebSocket client disconnected');
  });
});

// --- Start the server --- //
const PORT = process.env.PORT || 5050;
server.listen(PORT, () => {
  console.log(`GenAI Audio Streaming Backend listening on port ${PORT}`);
});
