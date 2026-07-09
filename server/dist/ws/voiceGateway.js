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
const dailyChallenge_1 = require("../services/dailyChallenge");
const xp_1 = require("../services/xp");
const notifications_1 = require("../services/notifications");
const journeyMap_1 = require("../services/journeyMap");
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
        const userDb = (0, requireAuth_1.createUserSupabase)(token);
        // ── 2. Determine mode & fetch scenario ─────────────────────────────
        let mode = 'casual';
        let scenarioPrompt = '';
        if (caseStudyId === 'salary-negotiation')
            mode = 'executive';
        else if (caseStudyId === 'system-design')
            mode = 'mock_interview';
        try {
            const { data: caseStudy } = await requireAuth_1.supabaseAdmin
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
        const { error: upsertErr } = await userDb
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
        if (upsertErr) {
            console.error('[VoiceGateway] Failed to initialize voice_sessions row:', upsertErr.message);
        }
        // ── 3. Connect directly to Gemini Live ─────────────────────────────
        let liveSession = null;
        let isFinalizing = false;
        try {
            const { ragContext } = await (0, rag_1.getSessionRagContext)(user.id, caseStudyId);
            liveSession = (0, gemini_1.createLiveSession)({
                userId: user.id,
                caseStudyId,
                mode,
                ragContext,
                scenarioPrompt,
                sessionId,
                userDb,
            });
        }
        catch (err) {
            console.error('[VoiceGateway] Failed to create Gemini Live session:', err.message);
            ws.send(JSON.stringify({ event: 'error', payload: { message: 'Failed to start voice session.', recoverable: true } }));
            ws.close(4011, 'Session Init Failed');
            return;
        }
        const finalizeSession = async (notifyClient) => {
            if (isFinalizing)
                return null;
            isFinalizing = true;
            let reportId = null;
            if (liveSession) {
                const result = await liveSession.close();
                reportId = result.reportId;
                liveSession = null;
            }
            const completedAt = new Date().toISOString();
            const { data: sessionRow } = await userDb
                .from('voice_sessions')
                .select('created_at, status')
                .eq('id', sessionId)
                .eq('user_id', user.id)
                .maybeSingle();
            const { error: updateErr } = await userDb
                .from('voice_sessions')
                .update({
                status: 'completed',
                completed_at: completedAt,
                updated_at: completedAt,
            })
                .eq('id', sessionId)
                .eq('user_id', user.id)
                .neq('status', 'completed');
            if (updateErr) {
                console.error('[VoiceGateway] Failed to finalize voice session status:', updateErr.message);
            }
            if (sessionRow?.status !== 'completed') {
                const startedAt = sessionRow?.created_at
                    ? new Date(sessionRow.created_at).getTime()
                    : Date.now();
                const durationMinutes = Math.max(1, (new Date(completedAt).getTime() - startedAt) / 60_000);
                void (0, xp_1.awardVoiceSessionXp)(user.id, durationMinutes).then((xpResult) => {
                    if (xpResult) {
                        void (0, notifications_1.notifySessionComplete)(user.id, durationMinutes, xpResult.xpAwarded).catch(() => { });
                    }
                }).catch((err) => {
                    console.warn('[VoiceGateway] XP award failed:', err?.message ?? err);
                });
                void (0, dailyChallenge_1.updateChallengeOnVoiceSession)(user.id, durationMinutes, Boolean(reportId)).catch((err) => {
                    console.warn('[VoiceGateway] Daily challenge update failed:', err?.message ?? err);
                });
                void (0, journeyMap_1.checkAndNotifyJourneyAchievements)(user.id).catch(() => { });
            }
            if (notifyClient && ws.readyState === ws_1.default.OPEN) {
                ws.send(JSON.stringify({
                    event: 'session_analyzed',
                    payload: { sessionId, reportId },
                }));
            }
            return reportId;
        };
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
                    else if (control.event === 'end_session') {
                        void finalizeSession(true).then(() => {
                            if (ws.readyState === ws_1.default.OPEN) {
                                ws.close(1000, 'Session ended');
                            }
                        });
                    }
                }
                catch (_) { }
            }
        });
        // ── 6. Cleanup on disconnect ───────────────────────────────────────
        ws.on('close', async (code, reason) => {
            console.log(`[VoiceGateway] Connection closed. Code=${code}, User=${user.id}`);
            await finalizeSession(false);
        });
        ws.on('error', (err) => {
            console.warn('[VoiceGateway] WebSocket error:', err.message);
        });
        console.log(`[VoiceGateway] Session live for user ${user.id} on case study "${caseStudyId}"`);
    });
}
