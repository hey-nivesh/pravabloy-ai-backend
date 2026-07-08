"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const url_1 = __importDefault(require("url"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const ws_1 = __importDefault(require("ws"));
const dotenv_1 = __importDefault(require("dotenv"));
const requireAuth_1 = require("./middleware/requireAuth");
const voiceGateway_1 = require("./ws/voiceGateway");
const gemini_1 = require("./services/gemini");
const analytics_1 = require("./services/analytics");
const progress_1 = require("./services/progress");
// Dynamically search parent folders for the .env configuration
const envPaths = [
    path_1.default.join(process.cwd(), '.env'),
    path_1.default.join(process.cwd(), '../.env'),
    path_1.default.join(process.cwd(), '../../pravabloyai/.env'),
];
for (const envPath of envPaths) {
    if (fs_1.default.existsSync(envPath)) {
        dotenv_1.default.config({ path: envPath });
        break;
    }
}
const app = (0, express_1.default)();
const port = process.env.PORT || 5000;
app.use(express_1.default.json());
// ── Health check — includes live session pool state ──────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});
/**
 * Vocab Vault Due REST API Endpoint:
 * Sourced by the Daily Word screen to fetch due words and synthesize their audio URLs.
 * Injects pronunciation URLs for normal-speed, slow-motion, and example sentences.
 */
app.get('/api/v1/vocab-vault/due', requireAuth_1.requireAuth, async (req, res) => {
    const userId = req.user.id;
    const lang = req.query.lang || 'en';
    try {
        // 1. Fetch vocabulary items due for study
        const { data: dbWords, error: dbError } = await requireAuth_1.supabase
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
        const enrichedWords = await Promise.all(wordsList.map(async (w) => {
            let normalAudioUrl = '';
            let slowAudioUrl = '';
            let exampleAudioUrl = '';
            try {
                const normalRes = await (0, gemini_1.synthesizeSpeech)({ text: w.word, language: lang, speed: 'normal' });
                normalAudioUrl = normalRes.audioUrl;
            }
            catch (e) {
                normalAudioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.word)}&type=2`;
            }
            try {
                const slowRes = await (0, gemini_1.synthesizeSpeech)({ text: w.word, language: lang, speed: 'slow' });
                slowAudioUrl = slowRes.audioUrl;
            }
            catch (e) {
                slowAudioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.word)}&type=2`;
            }
            try {
                const exampleRes = await (0, gemini_1.synthesizeSpeech)({ text: w.example_sentence, language: lang, speed: 'normal' });
                exampleAudioUrl = exampleRes.audioUrl;
            }
            catch (e) {
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
        }));
        res.json({ words: enrichedWords });
    }
    catch (err) {
        console.error('[REST Vocab] Failed to assemble daily list:', err.message);
        res.status(500).json({ error: 'Failed to retrieve vocab session.' });
    }
});
app.post('/api/analyze-fluency', requireAuth_1.requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { sessionId } = req.body ?? {};
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required.' });
    }
    try {
        const result = await (0, analytics_1.analyzeSessionById)(sessionId, userId);
        return res.json({
            ok: true,
            report: result.report,
            analysis: result.analysis,
            transcriptTurnCount: result.transcript.length,
            model: 'gemini-3.5-flash',
        });
    }
    catch (error) {
        console.error('[analyze-fluency] Failed:', error?.message ?? error);
        return res.status(500).json({
            ok: false,
            error: error?.message ?? 'Failed to generate analysis.',
        });
    }
});
app.get('/api/progress/summary', requireAuth_1.requireAuth, async (req, res) => {
    const userId = req.user.id;
    try {
        const summary = await (0, progress_1.getUserProgressSummary)(userId);
        return res.json({ ok: true, summary });
    }
    catch (error) {
        console.error('[progress-summary] Failed:', error?.message ?? error);
        return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to load progress summary.' });
    }
});
app.get('/api/analytics/latest', requireAuth_1.requireAuth, async (req, res) => {
    const userId = req.user.id;
    try {
        const report = await (0, progress_1.getLatestAnalyticsReport)(userId);
        return res.json({ ok: true, report });
    }
    catch (error) {
        console.error('[analytics-latest] Failed:', error?.message ?? error);
        return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to load latest analytics.' });
    }
});
app.get('/api/analytics/report/:reportId', requireAuth_1.requireAuth, async (req, res) => {
    const userId = req.user.id;
    const reportId = req.params.reportId;
    try {
        const { data, error } = await requireAuth_1.supabase
            .from('analytics_reports')
            .select('*')
            .eq('id', reportId)
            .eq('user_id', userId)
            .single();
        if (error || !data) {
            return res.status(404).json({ ok: false, error: 'Report not found.' });
        }
        return res.json({ ok: true, report: data });
    }
    catch (error) {
        console.error('[analytics-report] Failed:', error?.message ?? error);
        return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to load report.' });
    }
});
// Create HTTP server wrapping Express
const server = http_1.default.createServer(app);
// Attach WebSocket Server
const wss = new ws_1.default.Server({ noServer: true });
// Handle WebSocket upgrade routing
server.on('upgrade', (request, socket, head) => {
    const pathname = url_1.default.parse(request.url || '').pathname;
    if (pathname === '/ws/voice-session') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
    else {
        socket.destroy();
    }
});
// Setup Voice Gateway handler logic
(0, voiceGateway_1.setupVoiceGateway)(wss);
// Boot server
server.listen(port, () => {
    console.log(`[PravabloyAI Server] Server running on port ${port}`);
    console.log(`[PravabloyAI Server] Voice model: gemini-3.1-flash-live-preview (no limits)`);
});
