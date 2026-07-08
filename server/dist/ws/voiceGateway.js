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
        const sessionId = clientSessionId ?? `${user.id}-${Date.now()}`;
        // ── 2. Determine mode & fetch scenario ─────────────────────────────
        let mode = 'casual';
        let scenarioPrompt = '';
        if (caseStudyId === 'salary-negotiation')
            mode = 'executive';
        else if (caseStudyId === 'system-design')
            mode = 'mock_interview';
        try {
            const { data: caseStudy } = await requireAuth_1.supabase
                .from('case_studies')
                .select('category, scenario_prompt')
                .eq('id', caseStudyId)
                .single();
            if (caseStudy?.scenario_prompt) {
                scenarioPrompt = String(caseStudy.scenario_prompt);
            }
            if (caseStudy?.category === 'executive')
                mode = 'executive';
            else if (caseStudy?.category === 'mock_interview' || caseStudy?.category === 'interview')
                mode = 'mock_interview';
            else if (caseStudy?.category === 'formal')
                mode = 'formal';
            else if (caseStudy?.category === 'casual')
                mode = 'casual';
        }
        catch (_) {
            // Keep deterministic fallback mapping when case_studies is unavailable.
        }
        try {
            await requireAuth_1.supabase
                .from('voice_sessions')
                .upsert({
                id: sessionId,
                user_id: user.id,
                case_study_id: caseStudyId,
                mode,
                status: 'in_progress',
                transcript: [],
                live_pacing: [],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });
        }
        catch (sessionErr) {
            console.warn('[VoiceGateway] Failed to initialize voice_sessions row:', sessionErr?.message ?? sessionErr);
        }
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
                // Session id is used for transcript + analytics linkage.
                sessionId,
            });
        }
        catch (err) {
            console.error('[VoiceGateway] Failed to create Gemini Live session:', err.message);
            ws.send(JSON.stringify({ event: 'error', payload: { message: 'Failed to start voice session.', recoverable: true } }));
            ws.close(4011, 'Session Init Failed');
            return;
        }
        // ── 4. Wire up Gemini → Client callbacks ──────────────────────────
        liveSession.onMessage((message) => {
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({ type: 'message', data: message }));
            }
        });
        liveSession.onLivePacing((pacing) => {
            if (ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({ event: 'live_pacing', payload: pacing }));
            }
        });
        liveSession.onInterrupted(() => {
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
            if (liveSession) {
                await liveSession.close();
                liveSession = null;
            }
            try {
                await requireAuth_1.supabase
                    .from('voice_sessions')
                    .update({
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                })
                    .eq('id', sessionId)
                    .eq('user_id', user.id)
                    .neq('status', 'completed');
            }
            catch (persistErr) {
                console.warn('[VoiceGateway] Failed to finalize voice session status:', persistErr?.message ?? persistErr);
            }
        });
        ws.on('error', (err) => {
            console.warn('[VoiceGateway] WebSocket error:', err.message);
        });
        console.log(`[VoiceGateway] Session live for user ${user.id} on case study "${caseStudyId}"`);
    });
}
