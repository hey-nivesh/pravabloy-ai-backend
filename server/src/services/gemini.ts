import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../middleware/requireAuth';
import { triggerSessionAnalytics, TranscriptTurn } from './analytics';
import {
  geminiRateLimiter,
  callWithRetry,
  callWithModelFallback,
  getDeterministicHash
} from '../utils/rateLimiter';
import { parsePcmMimeType, pcmToWav } from '../utils/pcmToWav';

/** Dedup concurrent TTS requests for the same text+speed hash */
const inflightTts = new Map<string, Promise<{ audioUrl: string }>>();

// ─── Voice Pool ────────────────────────────────────────────────────────────────
// Two voices per category: rotated randomly each session for variety.
// Voice names from the Gemini Live API prebuilt voice catalogue (v2.10.0).
// If a voice name returns an API error at runtime, fall back to 'Puck'.

const VOICE_POOL: Record<string, [string, string]> = {
  casual:         ['Puck', 'Kore'],
  formal:         ['Orus', 'Zephyr'],
  // "Executive" voices were sounding overly low pitch (Fenrir/Charon).
  // Switch to a more mid-range pairing for a natural conversational tone.
  executive:      ['Kore', 'Zephyr'],
  mock_interview: ['Aoede', 'Leda'],
};

const DEFAULT_VOICE_POOL: [string, string] = ['Puck', 'Kore'];

function pickVoice(mode: string): string {
  const pool = VOICE_POOL[mode] ?? DEFAULT_VOICE_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Per-mode opening prompt for model-initiated turn ─────────────────────────
// We send a user-role "begin" message to make the model speak first.
// The scenario_prompt from the DB (if provided) is preferred; these are fallbacks.

const OPENER_FALLBACKS: Record<string, string> = {
  mock_interview:
    'You are now on a live video interview. Please greet me, introduce yourself briefly as the interviewer, and ask me your first question.',
  executive:
    'The meeting has begun. Please greet me as your colleague and open the negotiation with your first position statement.',
  formal:
    'The session is starting. Please greet me professionally and frame the first topic you want to discuss.',
  casual:
    'We\'re live! Please greet me warmly and ask me a casual opener to get the conversation going.',
};

// ─── Filler word list for pacing analysis ─────────────────────────────────────
const FILLER_WORDS = new Set([
  'um', 'uh', 'like', 'you know', 'sort of', 'kind of', 'basically',
  'actually', 'literally', 'right', 'okay', 'so', 'well', 'I mean',
]);

function countFillers(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const filler of FILLER_WORDS) {
    // Simple regex word-boundary match for each filler phrase
    const pattern = new RegExp(`\\b${filler.replace(/ /g, '\\s+')}\\b`, 'gi');
    const matches = lower.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

// ─── LivePacing frame shape ────────────────────────────────────────────────────
export interface LivePacingFrame {
  /** Estimated words per minute from the last user utterance. 0 if no data. */
  wpm: number;
  /** Running filler word count for this session */
  fillerCount: number;
  /** True if a pause > 3s was detected since the last pacing frame */
  pauseFlag: boolean;
}

// ─── LiveSessionHandle ────────────────────────────────────────────────────────
export interface LiveSessionHandle {
  sendAudioChunk(chunk: Buffer): void;
  sendTextEvent(event: object): void;
  onMessage(callback: (message: LiveServerMessage) => void): void;
  onInterrupted(callback: () => void): void;
  onTurnComplete(callback: (fullTranscript: TranscriptTurn[]) => void): void;
  onLivePacing(callback: (frame: LivePacingFrame) => void): void;
  onError(callback: (err: Error) => void): void;
  close(): Promise<{ reportId: string | null }>;
}

// Hard maximum session duration (15 minutes)
const MAX_SESSION_DURATION_MS = 15 * 60 * 1000;

/**
 * Creates and wraps a stateful Gemini Live session using the official @google/genai SDK.
 *
 * What's new vs. previous version:
 *  - Voice pool: per-mode pair of voices, randomly selected each session
 *  - VAD: automatic activity detection with tuned silence thresholds
 *  - First-speaker: model sends an in-character opener immediately after onopen
 *  - Live pacing: WPM / filler count / pause flag computed from user transcript deltas
 */
export function createLiveSession(params: {
  userId: string;
  caseStudyId: string;
  mode: 'casual' | 'formal' | 'executive' | 'mock_interview';
  ragContext: string;
  scenarioPrompt?: string;
  voicePreference?: string;
  sessionId: string;
  userDb?: SupabaseClient;
}): LiveSessionHandle {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not defined.');
  }

  // 'aistudio-build' User-Agent is required by the Gemini Live preview API
  // to grant access under the free tier API key. This matches the configuration
  // used in the reference fluency-coach server.ts implementation.
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  // ── Voice selection ───────────────────────────────────────────────
  const selectedVoice = params.voicePreference || pickVoice(params.mode);
  console.log(`[GeminiLiveSession] Session ${params.sessionId}: mode=${params.mode}, voice=${selectedVoice}`);

  // ── System instruction ────────────────────────────────────────────
  const basePersona = `You are a warm, encouraging, expert English fluency coach having a live spoken conversation with a learner. Speak naturally, keep responses conversational and not overly long, and gently model correct grammar/vocabulary through your own responses rather than constantly interrupting to correct the user mid-flow.`;

  let modeInstruction = '';
  switch (params.mode) {
    case 'mock_interview':
      modeInstruction = 'Act as a professional hiring manager interviewing the user for a technical role. Ask realistic follow-up questions one at a time and maintain a formal yet helpful demeanor.';
      break;
    case 'executive':
      modeInstruction = 'Act as a senior business VP counterpart in a high-stakes corporate salary review. Negotiate firmly but professionally and look for collaborative solutions.';
      break;
    case 'formal':
      modeInstruction = 'Maintain a polite, corporate framing. Guide the conversation with structured scenarios.';
      break;
    default:
      modeInstruction = 'Maintain a casual, friendly conversation. Encourage the student to speak freely about day-to-day topics.';
  }

  const systemInstruction = `
${basePersona}

SCENARIO FRAMING:
${modeInstruction}

RAG CONTEXT & TARGET PHRASES:
${params.ragContext}

Where natural, steer the conversation to give the learner an opportunity to use the vocabulary list above. Keep a mental note of notable grammar mistakes or filler-word usage, but do NOT correct them live. Correction is handled separately at the end of the session. Keep your spoken responses short (1-2 sentences) to encourage the user to speak more.
  `.trim();

  // ── Callback registry ─────────────────────────────────────────────
  let messageCb: ((message: LiveServerMessage) => void) | null = null;
  let interruptedCb: (() => void) | null = null;
  let turnCompleteCb: ((fullTranscript: TranscriptTurn[]) => void) | null = null;
  let livePacingCb: ((frame: LivePacingFrame) => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;

  // ── Session state ─────────────────────────────────────────────────
  let isConnected = false;
  let isClosed = false;
  let sessionObject: any = null;
  const pendingAudioChunks: Buffer[] = [];

  const accumulatedTranscript: TranscriptTurn[] = [];
  const livePacingFrames: LivePacingFrame[] = [];
  let currentUserText = '';
  let currentAiText = '';

  // ── Live pacing state ─────────────────────────────────────────────
  let sessionFillerCount = 0;
  let lastUserSpeechEndMs = 0;          // When the last user turn ended
  let lastUserTurnStartMs = 0;          // When the current user turn started
  let currentUserWordCount = 0;          // Words in current user turn

  const emitPacing = (pauseFlag: boolean) => {
    if (!livePacingCb) return;
    const nowMs = Date.now();
    let wpm = 0;
    if (lastUserTurnStartMs > 0 && currentUserWordCount > 0) {
      const durationMin = (nowMs - lastUserTurnStartMs) / 60000;
      wpm = durationMin > 0 ? Math.round(currentUserWordCount / durationMin) : 0;
    }
    livePacingCb({ wpm, fillerCount: sessionFillerCount, pauseFlag });
    livePacingFrames.push({
      wpm,
      fillerCount: sessionFillerCount,
      pauseFlag,
    });
  };

  const sessionDb = params.userDb ?? supabaseAdmin;

  const saveTranscriptToDb = async () => {
    const { error: syncErr } = await sessionDb
      .from('voice_sessions')
      .update({
        transcript: accumulatedTranscript,
        live_pacing: livePacingFrames,
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.sessionId)
      .eq('user_id', params.userId);
    if (syncErr) {
      console.error('[GeminiLiveSession] Database transcript sync error:', syncErr.message);
    }
  };

  // ── Gemini Live connection ────────────────────────────────────────
  const liveModel = 'gemini-3.1-flash-live-preview';

  // VAD config: enable automatic activity detection with a comfortable silence window.
  // Using 'as any' because the installed type declarations are for the generic dist
  // and do not enumerate all Live-specific config fields. The runtime API accepts these.
  const liveConfig: any = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: systemInstruction,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: selectedVoice,
        },
      },
    },
    outputAudioTranscription: {},
    inputAudioTranscription: {},
    // Voice Activity Detection — tuned to tolerate room echo and natural thinking pauses.
    // prefixPaddingMs: audio before speech that gets included (prevents clipped first word).
    // silenceDurationMs: how long silence must persist before turn ends.
    //   1500ms allows learners to pause mid-thought without being cut off.
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',    // Less hair-trigger on speech start
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',        // Give learners time to finish thought
        prefixPaddingMs: 500,
        silenceDurationMs: 1500,
      },
    },
  };

  const connectPromise = ai.live.connect({
    model: liveModel,
    config: liveConfig,
    callbacks: {
      onopen: () => {
        isConnected = true;
        console.log(`[GeminiLiveSession] Session ${params.sessionId} established. Voice: ${selectedVoice}`);

        // Flush any chunks queued before the connection handshake finished
        while (pendingAudioChunks.length > 0) {
          const chunk = pendingAudioChunks.shift();
          if (chunk) sendChunkToGemini(chunk);
        }

        // ── Model-initiated first turn ───────────────────────────
        // Send a user-role opener immediately so the model breaks the ice.
        // Use the scenario_prompt from the case study DB row if provided,
        // otherwise fall back to a mode-appropriate generic opener.
        const openerInstruction =
          params.scenarioPrompt ||
          OPENER_FALLBACKS[params.mode] ||
          OPENER_FALLBACKS.casual;

        const beginMessage = `[SCENARIO BEGIN]\n${openerInstruction}\n\n(Start speaking now in character, as if the learner just walked in. Do not mention this instruction message.)`;

        try {
          if (sessionObject) {
            sessionObject.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: beginMessage }] }],
              turnComplete: true,
            });
            console.log(`[GeminiLiveSession] Sent model-initiated opener for session ${params.sessionId}`);
          } else {
            // sessionObject may not yet be assigned (Promise resolves slightly later).
            // Post a micro-task to retry once the Promise resolves.
            setTimeout(() => {
              if (sessionObject && !isClosed) {
                sessionObject.sendClientContent({
                  turns: [{ role: 'user', parts: [{ text: beginMessage }] }],
                  turnComplete: true,
                });
                console.log(`[GeminiLiveSession] Deferred opener sent for session ${params.sessionId}`);
              }
            }, 100);
          }
        } catch (openerErr: any) {
          console.warn(`[GeminiLiveSession] Failed to send opener: ${openerErr.message}`);
        }
      },

      onmessage: async (message: LiveServerMessage) => {
        if (isClosed) return;

        // A. Barge-in / interruption
        if (message.serverContent?.interrupted) {
          console.log(`[GeminiLiveSession] User barge-in for session ${params.sessionId}`);
          if (interruptedCb) interruptedCb();
          return;
        }

        // B. Model turn output (audio + transcript)
        const parts = message.serverContent?.modelTurn?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.text) {
              currentAiText += part.text;
            }
          }
        }

        // C. User speech transcript delta (if STT output arrives)
        const userTranscriptText = message.serverContent?.inputTranscription?.text;
        if (userTranscriptText) {
          // Track for pacing
          if (lastUserTurnStartMs === 0) lastUserTurnStartMs = Date.now();
          const words = userTranscriptText.trim().split(/\s+/).filter(Boolean);
          currentUserWordCount += words.length;
          sessionFillerCount += countFillers(userTranscriptText);

          currentUserText += userTranscriptText;

          // Emit a pacing frame on each user speech delta
          const pauseFlag =
            lastUserSpeechEndMs > 0 &&
            lastUserTurnStartMs - lastUserSpeechEndMs > 3000;
          emitPacing(pauseFlag);
        }

        // D. Turn complete
        if (message.serverContent?.turnComplete) {
          if (currentUserText.trim()) {
            accumulatedTranscript.push({
              sender: 'user',
              text: currentUserText.trim(),
              timestamp: new Date().toISOString(),
            });
            // Reset pacing counters for the next turn
            lastUserSpeechEndMs = Date.now();
            lastUserTurnStartMs = 0;
            currentUserWordCount = 0;
            currentUserText = '';
          }
          if (currentAiText.trim()) {
            accumulatedTranscript.push({
              sender: 'ai',
              text: currentAiText.trim(),
              timestamp: new Date().toISOString(),
            });
            currentAiText = '';
          }

          await saveTranscriptToDb();
          if (turnCompleteCb) turnCompleteCb(accumulatedTranscript);
        }

        if (messageCb) messageCb(message);
      },

      onerror: (err: any) => {
        console.error(`[GeminiLiveSession] Gemini SDK WebSocket error:`, err);
        if (errorCb) errorCb(err instanceof Error ? err : new Error(String(err)));
      },

      onclose: () => {
        console.log(`[GeminiLiveSession] Gemini connection closed for session ${params.sessionId}`);
        isConnected = false;
      },
    },
  });

  connectPromise
    .then((sess: any) => {
      sessionObject = sess;
    })
    .catch((err: any) => {
      console.error(`[GeminiLiveSession] Failed to connect live session:`, err);
      if (errorCb) errorCb(err);
    });

  // ── Send raw PCM bytes to Gemini Live ─────────────────────────────
  const sendChunkToGemini = (chunk: Buffer) => {
    if (sessionObject && isConnected) {
      try {
        sessionObject.sendRealtimeInput({
          audio: { mimeType: 'audio/pcm;rate=16000', data: chunk.toString('base64') },
        });
      } catch (err: any) {
        console.warn('[GeminiLiveSession] sendRealtimeInput error:', err.message);
      }
    }
  };

  // ── Session duration guard ────────────────────────────────────────
  const sessionTimeout = setTimeout(() => {
    console.warn(
      `[GeminiLiveSession] Session ${params.sessionId} exceeded ${MAX_SESSION_DURATION_MS / 60000} minutes. Force closing.`
    );
    handleClose();
  }, MAX_SESSION_DURATION_MS);

  const handleClose = async (): Promise<{ reportId: string | null }> => {
    if (isClosed) return { reportId: null };
    isClosed = true;
    clearTimeout(sessionTimeout);
    console.log(`[GeminiLiveSession] Closing session ${params.sessionId}`);

    if (currentUserText.trim()) {
      accumulatedTranscript.push({
        sender: 'user',
        text: currentUserText.trim(),
        timestamp: new Date().toISOString(),
      });
    }
    if (currentAiText.trim()) {
      accumulatedTranscript.push({
        sender: 'ai',
        text: currentAiText.trim(),
        timestamp: new Date().toISOString(),
      });
    }
    await saveTranscriptToDb();

    const { reportId } = await triggerSessionAnalytics(params.sessionId, params.userId, accumulatedTranscript);

    if (sessionObject) {
      try { sessionObject.close(); } catch (_) { /* intentionally ignored */ }
    }

    return { reportId };
  };

  // ── Public handle ─────────────────────────────────────────────────
  return {
    sendAudioChunk(chunk: Buffer) {
      if (isClosed) return;
      if (!isConnected) {
        pendingAudioChunks.push(chunk);
      } else {
        sendChunkToGemini(chunk);
      }
    },
    sendTextEvent(event: any) {
      if (isClosed || !isConnected || !sessionObject) return;
      if (event.text) {
        currentUserText += event.text;
        sessionObject.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: event.text }] }],
          turnComplete: true,
        });
      }
    },
    onMessage(callback) { messageCb = callback; },
    onInterrupted(callback) { interruptedCb = callback; },
    onTurnComplete(callback) { turnCompleteCb = callback; },
    onLivePacing(callback) { livePacingCb = callback; },
    onError(callback) { errorCb = callback; },
    close: handleClose,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Synchronous TTS using Gemini's native audio output modality.
// ─────────────────────────────────────────────────────────────────────────────
export async function synthesizeSpeech(params: {
  text: string;
  language?: string;
  speed?: 'normal' | 'slow';
  /** Temporary debug label for tracing word vs example TTS paths */
  debugContext?: 'word' | 'word-slow' | 'example' | string;
}): Promise<{ audioUrl: string }> {
  const hash = getDeterministicHash(params.text, params.speed);
  const inflightKey = `${hash}:wav`;

  const existing = inflightTts.get(inflightKey);
  if (existing) {
    console.log(`[TTS] Awaiting in-flight synthesis for hash ${hash.slice(0, 8)}…`);
    return existing;
  }

  const work = synthesizeSpeechInner(params);
  inflightTts.set(inflightKey, work);
  try {
    return await work;
  } finally {
    inflightTts.delete(inflightKey);
  }
}

async function synthesizeSpeechInner(params: {
  text: string;
  language?: string;
  speed?: 'normal' | 'slow';
  debugContext?: 'word' | 'word-slow' | 'example' | string;
}): Promise<{ audioUrl: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not defined.');

  const debugContext = params.debugContext ?? (params.text.trim().includes(' ') ? 'example' : 'word');
  console.log(
    `[TTS Debug] context=${debugContext} speed=${params.speed ?? 'normal'} ` +
      `chars=${params.text.length} preview="${params.text.slice(0, 80)}${params.text.length > 80 ? '…' : ''}"`,
  );

  const bucketName = 'vocab-audio';
  const hash = getDeterministicHash(params.text, params.speed);
  const fileName = `tts_${hash}.wav`;

  // 1. Cache lookup: download probe (list search is unreliable)
  try {
    const { error: downloadError } = await supabaseAdmin.storage
      .from(bucketName)
      .download(fileName);

    if (!downloadError) {
      console.log(`[TTS Cache] Found cached TTS file for "${params.text}" (${params.speed})`);
      const { data: signedData, error: signError } = await supabaseAdmin.storage
        .from(bucketName)
        .createSignedUrl(fileName, 365 * 24 * 60 * 60);

      if (!signError && signedData) {
        return { audioUrl: signedData.signedUrl };
      }
    }
  } catch (cacheErr: any) {
    console.warn('[TTS Cache] Cache check failed, proceeding to synthesize:', cacheErr.message);
  }

  // 2. Synthesize using rate limiter queue, retries, and fallback to gemini-1.5-flash
  const ai = new GoogleGenAI({ apiKey });
  let audioBase64: string | undefined;
  let pcmMimeType: string | undefined;

  try {
    audioBase64 = await geminiRateLimiter.enqueue(() =>
      callWithModelFallback('gemini-2.5-flash', 'gemini-1.5-flash', async (modelName) => {
        return callWithRetry(async () => {
          console.log(`[TTS Gemini] Generating TTS for "${params.text}" using model ${modelName}...`);
          const response = await ai.models.generateContent({
            model: modelName,
            contents: `Please read the following text aloud clearly and naturally in its original language, without adding any introductory or concluding remarks: "${params.text}"`,
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: params.speed === 'slow' ? 'Charon' : 'Puck',
                  },
                },
              },
            },
          });

          const parts = response.candidates?.[0]?.content?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.inlineData?.data) {
                pcmMimeType = part.inlineData.mimeType ?? pcmMimeType;
                return part.inlineData.data;
              }
            }
          }
          throw new Error('[TTS] Gemini failed to output native audio content modality.');
        });
      })
    );
  } catch (err: any) {
    throw new Error(`[TTS] Synthesis failed: ${err.message}`);
  }

  if (!audioBase64) {
    throw new Error('[TTS] Gemini failed to output native audio content modality.');
  }

  const pcmBuffer = Buffer.from(audioBase64, 'base64');
  const pcmMeta = parsePcmMimeType(pcmMimeType);
  const wavBuffer = pcmToWav(pcmBuffer, pcmMeta);

  const { error: uploadError } = await supabaseAdmin.storage
    .from(bucketName)
    .upload(fileName, wavBuffer, {
      contentType: 'audio/wav',
      cacheControl: '3600',
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`[TTS] Supabase upload failed: ${uploadError.message}`);
  }

  console.log(`[TTS] Saved ${wavBuffer.length} byte WAV for "${params.text.slice(0, 40)}…" (${params.speed})`);

  const { data: signedData, error: signError } = await supabaseAdmin.storage
    .from(bucketName)
    .createSignedUrl(fileName, 365 * 24 * 60 * 60);

  if (signError || !signedData) {
    throw new Error(`[TTS] Supabase URL signing failed: ${signError?.message || 'unknown error'}`);
  }

  return { audioUrl: signedData.signedUrl };
}

export async function generateAiVocab(language: string = 'en', limit: number = 5): Promise<any[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not defined.');

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Generate a JSON array of exactly ${limit} sophisticated, intermediate to advanced English vocabulary words that are highly useful for active spoken conversation (e.g., business discussions, casual storytelling, clear explanations).
For each word, provide:
- "word": string (capitalized)
- "phonetic": string (in IPA slash format, e.g. /ɪˈlɒk.wənt/)
- "part_of_speech": string (exactly one of: noun, verb, adjective, adverb, phrase)
- "definition": string (rendered in English)
- "example_sentence": string (illustrating natural spoken usage)
- "usage_tip": string (nuance, conversational tip, or collocation)

Provide ONLY raw JSON text. Do NOT wrap the JSON inside markdown code blocks.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    const text = response.text?.trim() || '[]';
    const cleanedText = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleanedText);

    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => ({
        id: `ai-${Date.now()}-${idx}`,
        word: String(item.word),
        phonetic: String(item.phonetic || ''),
        part_of_speech: String(item.part_of_speech || 'noun').toLowerCase(),
        definition: String(item.definition),
        example_sentence: String(item.example_sentence),
        usage_tip: String(item.usage_tip || ''),
      }));
    }
  } catch (err: any) {
    console.error('[GeminiVocab] Failed to generate AI vocabulary:', err.message);
    throw new Error('AI vocabulary generation failed. Please try again.');
  }

  throw new Error('AI vocabulary generation returned invalid data.');
}
