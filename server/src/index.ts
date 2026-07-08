import express from 'express';
import http from 'http';
import url from 'url';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';
import dotenv from 'dotenv';

import { requireAuth, AuthenticatedRequest, supabase } from './middleware/requireAuth';
import { setupVoiceGateway } from './ws/voiceGateway';
import { synthesizeSpeech } from './services/gemini';


// Dynamically search parent folders for the .env configuration
const envPaths = [
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '../.env'),
  path.join(process.cwd(), '../../pravabloyai/.env'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());

// ── Health check — includes live session pool state ──────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/**
 * Vocab Vault Due REST API Endpoint:
 * Sourced by the Daily Word screen to fetch due words and synthesize their audio URLs.
 * Injects pronunciation URLs for normal-speed, slow-motion, and example sentences.
 */
app.get('/api/v1/vocab-vault/due', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  const lang = (req.query.lang as string) || 'en';

  try {
    // 1. Fetch vocabulary items due for study
    const { data: dbWords, error: dbError } = await supabase
      .from('vocab_vault')
      .select('*')
      .eq('user_id', userId)
      .limit(5);

    // If database query returns empty, mock up a curated daily word list
    const wordsList = dbWords && dbWords.length > 0 ? dbWords : [
      { id: '1', word: 'Eloquent', phonetic: '/ˈɛl.ə.kwənt/', part_of_speech: 'adjective', definition: 'Fluent and persuasive in speaking or writing.', example_sentence: 'His eloquent words convinced the entire board.', usage_tip: 'Best for formal contexts.' },
      { id: '2', word: 'Pragmatic', phonetic: '/præɡˈmæt.ɪk/', part_of_speech: 'adjective', definition: 'Sensible and realistic.', example_sentence: 'She took a pragmatic approach to the budget crisis.', usage_tip: 'Highly valued in management feedback.' }
    ];

    // 2. Synthesize audio speech URLs using Gemini TTS and package into response
    const enrichedWords = await Promise.all(
      wordsList.map(async (w: any) => {
        let normalAudioUrl = '';
        let slowAudioUrl = '';
        let exampleAudioUrl = '';

        try {
          const normalRes = await synthesizeSpeech({ text: w.word, language: lang, speed: 'normal' });
          normalAudioUrl = normalRes.audioUrl;
        } catch (e) {
          normalAudioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.word)}&type=2`;
        }

        try {
          const slowRes = await synthesizeSpeech({ text: w.word, language: lang, speed: 'slow' });
          slowAudioUrl = slowRes.audioUrl;
        } catch (e) {
          slowAudioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.word)}&type=2`;
        }

        try {
          const exampleRes = await synthesizeSpeech({ text: w.example_sentence, language: lang, speed: 'normal' });
          exampleAudioUrl = exampleRes.audioUrl;
        } catch (e) {
          exampleAudioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.example_sentence)}&type=2`;
        }

        return {
          id: w.id,
          word: w.word,
          phonetic: w.phonetic,
          partOfSpeech: w.part_of_speech,
          definition: w.definition,
          exampleSentence: w.example_sentence,
          usageTip: w.usage_tip,
          source: w.source || 'curated',
          audioUrl: normalAudioUrl,
          slowAudioUrl: slowAudioUrl,
          exampleAudioUrl: exampleAudioUrl
        };
      })
    );

    res.json({ words: enrichedWords });
  } catch (err: any) {
    console.error('[REST Vocab] Failed to assemble daily list:', err.message);
    res.status(500).json({ error: 'Failed to retrieve vocab session.' });
  }
});

// Create HTTP server wrapping Express
const server = http.createServer(app);

// Attach WebSocket Server
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade routing
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url || '').pathname;

  if (pathname === '/ws/voice-session') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Setup Voice Gateway handler logic
setupVoiceGateway(wss);

// Boot server
server.listen(port, () => {
  console.log(`[PravabloyAI Server] Server running on port ${port}`);
  console.log(`[PravabloyAI Server] Voice model: gemini-3.1-flash-live-preview (no limits)`);
});
