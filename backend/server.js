import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, ActivityHandling } from '@google/genai';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/genai-audio' });

app.use(cors());
app.use(express.json());

// Health check endpoint (this is fine to keep)
app.get('/', (req, res) => {
  res.send('GenAI Audio Streaming Backend is running.');
});

// --- The rest of your file remains exactly the same ---

// Model and config as in the sample
const model = "gemini-2.5-flash-preview-native-audio-dialog";
const config = {
  responseModalities: [Modality.AUDIO],
  systemInstruction: `You are Rev, the helpful voice assistant for Revolt Motors...`, // Your system instruction
  realtimeInputConfig: {
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_MEDIUM,
      endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_MEDIUM,
      prefixPaddingMs: 20,
      silenceDurationMs: 100,
    },
    activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
  },
};

wss.on('connection', async (ws) => {
    console.log('WebSocket client connected');
    let session = null;
    let closed = false;
    const responseQueue = []
    let isGenerating = false;
    let currentTurnId = null;

    // Helper to wait for a message from the queue
    async function waitMessage() {
      let done = false;
      let message = undefined;
      while (!done) {
        message = responseQueue.shift();
        if (message) {
          done = true;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return message;
    }

    // Helper to collect all turns for a request
    async function handleTurn() {
      const turns = [];
      let done = false;
      while (!done) {
        const message = await waitMessage();
        turns.push(message);
        // Forward each message to the client as soon as it arrives
        if (message.data && !message.serverContent?.interrupted) {
          ws.send(JSON.stringify({ type: 'audio',  data: message.data }));
        }

        // CHANGE: Check for generation complete and turn complete separately
        if (message.serverContent?.generationComplete) {
          isGenerating = false;
        }
        if (message.serverContent && message.serverContent.turnComplete) {
          done = true;
          isGenerating = false;
          currentTurnId = null;
        }
      }
      return turns;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      session = await ai.live.connect({
        model: model,
        callbacks: {
          onopen: function () {
            ws.send(JSON.stringify({ type: 'status', message: 'Session opened' }));
          },
          onmessage: function (message) {
            console.log("Received message from Gemini:", message);
            if (message.serverContent?.interrupted) {
              console.log("Interruption detected - stopping current generation");
              isGenerating = false;
              ws.send(JSON.stringify({
                type: 'interrupt',
                turnId: currentTurnId,
                timestamp: Date.now()
              }));
            }

            // CHANGE: Track generation state for better interruption handling
            if (message.serverContent?.modelTurn) {
              if (!isGenerating) {
                isGenerating = true;
                currentTurnId = Date.now().toString();
                ws.send(JSON.stringify({
                  type: 'generation_start',
                  turnId: currentTurnId
                }));
              }
            }
            responseQueue.push(message);
          },
          onerror: function (e) {
            ws.send(JSON.stringify({ type: 'error', message: e.message }));
          },
          onclose: function (e) {
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

    ws.on('message', async (data) => {
      try {
        const base64Audio = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
        console.log('--- Debug Session Start ---');
        console.log('Received PCM buffer length:', data.length);
        console.log('Base64 audio preview:', base64Audio.slice(0, 30));
        console.log('Sending audio to Gemini...');
        session.sendRealtimeInput({
          audio: {
            data: base64Audio,
            mimeType: "audio/pcm;rate=16000"
          }
        });
        const turns = await handleTurn();
        console.log('Received response from Gemini:', turns.length, 'turn(s)');
        console.log('--- Debug Session End ---');
      } catch (e) {
        console.error('Error in audio debug session:', e);
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    });

    ws.on('close', () => {
      closed = true;
      if (session) session.close();
      console.log('WebSocket client disconnected');
    });
  });

  const PORT = process.env.PORT || 5050;
  server.listen(PORT, () => {
    console.log(`GenAI Audio Streaming Backend listening on port ${PORT}`);
  });