"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupVoiceGateway = setupVoiceGateway;
const ws_1 = __importDefault(require("ws"));
const url_1 = __importDefault(require("url"));
const requireAuth_1 = require("../middleware/requireAuth");
const gemini_1 = require("../services/gemini");
const rag_1 = require("../services/rag");
function setupVoiceGateway(wss) {
    wss.on('connection', async (ws, req) => {
        console.log('[VoiceGateway] New WebSocket connection attempt...');
        const parsedUrl = url_1.default.parse(req.url || '', true);
        const token = parsedUrl.query.token;
        const caseStudyId = parsedUrl.query.caseStudyId || 'ordering-coffee';
        const clientSessionId = parsedUrl.query.sessionId;
        // Buffer Gemini PCM outputs and send fewer, larger websocket messages.
        // This reduces the number of client-side audio file transitions (stutters)
        // caused by handling every tiny PCM part as its own playback segment.
        const PCM_SAMPLE_RATE = 16000;
        const BYTES_PER_SAMPLE = 2; // int16 PCM
        const BYTES_PER_SEC = PCM_SAMPLE_RATE * BYTES_PER_SAMPLE; // mono
        const MIN_MERGE_BYTES = BYTES_PER_SEC * 1; // ~1s of audio before forced flush
        const MAX_MERGE_MS = 600; // cap latency even if chunk sizes are small
        let pendingAudioChunks = [];
        let pendingAudioBytes = 0;
        let flushTimer = null;
        const flushAudio = () => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            if (pendingAudioBytes === 0)
                return;
            if (ws.readyState !== ws_1.default.OPEN) {
                pendingAudioChunks = [];
                pendingAudioBytes = 0;
                return;
            }
            const merged = Buffer.concat(pendingAudioChunks);
            pendingAudioChunks = [];
            pendingAudioBytes = 0;
            ws.send(JSON.stringify({
                event: 'audio',
                payload: { base64: merged.toString('base64') },
            }));
        };
        // ── 1. Authenticate ────────────────────────────────────────────────
        if (!token) {
            ws.send(JSON.stringify({ event: 'error', payload: { message: 'Authentication required.', recoverable: false } }));
            ws.close(4001, 'Unauthorized');
            return;
        }
        let user;
        try {
            user = await (0, requireAuth_1.verifyToken)(token);
        }
        catch (err) {
            console.warn('[VoiceGateway] Invalid token:', err.message);
            ws.send(JSON.stringify({ event: 'error', payload: { message: 'Authentication failed: ' + err.message, recoverable: false } }));
            ws.close(4002, 'Unauthorized');
            return;
        }
        console.log(`[VoiceGateway] User ${user.id} authenticated. Case study: ${caseStudyId}`);
        // ── 2. Determine mode & fetch scenario ─────────────────────────────
        let mode = 'casual';
        let scenarioPrompt = '';
        if (caseStudyId === 'salary-negotiation')
            mode = 'executive';
        else if (caseStudyId === 'system-design')
            mode = 'mock_interview';
        // ── 3. Connect directly to Gemini Live (no DB, no limits) ──────────
        let liveSession = null;
        try {
            const { ragContext } = await (0, rag_1.getSessionRagContext)(user.id, caseStudyId);
            liveSession = (0, gemini_1.createLiveSession)({
                userId: user.id,
                caseStudyId,
                mode,
                ragContext,
                scenarioPrompt,
                // Session id is used for analytics_reports linking.
                // If the client provided one, keep it stable; otherwise fall back.
                sessionId: clientSessionId ?? `${user.id}-${Date.now()}`, // ephemeral session ID
            });
        }
        catch (err) {
            console.error('[VoiceGateway] Failed to create Gemini Live session:', err.message);
            ws.send(JSON.stringify({ event: 'error', payload: { message: 'Failed to start voice session.', recoverable: true } }));
            ws.close(4011, 'Session Init Failed');
            return;
        }
        // ── 4. Wire up Gemini → Client callbacks ──────────────────────────
        liveSession.onAudioOutput((chunk) => {
            if (ws.readyState !== ws_1.default.OPEN)
                return;
            pendingAudioChunks.push(chunk);
            pendingAudioBytes += chunk.length;
            // Flush immediately once we've buffered enough audio.
            if (pendingAudioBytes >= MIN_MERGE_BYTES) {
                flushAudio();
                return;
            }
            // Otherwise flush shortly to avoid excessive latency.
            if (!flushTimer) {
                flushTimer = setTimeout(() => flushAudio(), MAX_MERGE_MS);
            }
        });
        liveSession.onTranscriptDelta((text, role) => {
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({
                    event: 'transcript',
                    payload: { text, sender: role === 'agent' ? 'ai' : 'user', isFinal: false },
                }));
            }
        });
        liveSession.onLivePacing((pacing) => {
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({ event: 'live_pacing', payload: pacing }));
            }
        });
        liveSession.onInterrupted(() => {
            // Discard any queued audio when the model is interrupted (barge-in).
            pendingAudioChunks = [];
            pendingAudioBytes = 0;
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({ event: 'interrupted' }));
            }
        });
        liveSession.onError(async (err) => {
            console.error('[VoiceGateway] Gemini Live error:', err.message);
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({ event: 'error', payload: { message: 'Lost connection to voice model.', recoverable: true } }));
            }
        });
        // ── 5. Handle incoming Client → Gemini data ────────────────────────
        ws.on('message', (message, isBinary) => {
            if (!liveSession)
                return;
            if (isBinary) {
                // Raw PCM bytes (16kHz 16-bit mono) from the mobile mic
                const buffer = Buffer.isBuffer(message)
                    ? message
                    : Array.isArray(message)
                        ? Buffer.concat(message)
                        : Buffer.from(message);
                liveSession.sendAudioChunk(buffer);
            }
            else {
                try {
                    const control = JSON.parse(message.toString());
                    if (control.event === 'text' && control.payload?.text) {
                        liveSession.sendTextEvent({ text: control.payload.text });
                    }
                }
                catch (_) { }
            }
        });
        // ── 6. Cleanup on disconnect ───────────────────────────────────────
        ws.on('close', async (code, reason) => {
            console.log(`[VoiceGateway] Connection closed. Code=${code}, User=${user.id}`);
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            pendingAudioChunks = [];
            pendingAudioBytes = 0;
            if (liveSession) {
                await liveSession.close();
                liveSession = null;
            }
        });
        ws.on('error', (err) => {
            console.warn('[VoiceGateway] WebSocket error:', err.message);
        });
        console.log(`[VoiceGateway] Session live for user ${user.id} on case study "${caseStudyId}"`);
    });
}
