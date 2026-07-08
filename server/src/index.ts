import express from 'express';
import http from 'http';
import url from 'url';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';
import dotenv from 'dotenv';

import { requireAuth, AuthenticatedRequest, supabase, supabaseAdmin } from './middleware/requireAuth';
import { setupVoiceGateway } from './ws/voiceGateway';
import { synthesizeSpeech, generateAiVocab } from './services/gemini';
import { analyzeSessionById } from './services/analytics';
import { getLatestAnalyticsReport, getUserProgressSummary } from './services/progress';


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
 * Vocab Vault Session Endpoint:
 * Matches what useDailyWord calls. If the user is new or has no vocabulary items in database,
 * uses Gemini to dynamically generate 5 rich vocab words in real-time.
 */
app.get('/api/v1/vocab-vault/session', async (req, res) => {
  const userId = (req.query.userId as string) || '';
  const lang = (req.query.lang as string) || 'en';
  const limit = parseInt(req.query.limit as string) || 5;

  try {
    let wordsList: any[] = [];

    if (userId) {
      const now = new Date().toISOString();
      const { data: dueWords } = await supabaseAdmin
        .from('vocab_vault')
        .select('*')
        .eq('user_id', userId)
        .or(`next_review_at.is.null,next_review_at.lte.${now}`)
        .order('next_review_at', { ascending: true, nullsFirst: true })
        .limit(limit);

      if (dueWords && dueWords.length > 0) {
        wordsList = dueWords;
      }
    }

    if (wordsList.length === 0) {
      console.log(`[VocabSession] Generating ${limit} AI vocabulary words for user ${userId || 'anonymous'}`);
      const generated = await generateAiVocab(lang, limit);

      if (userId) {
        const rows = generated.map((w) => ({
          user_id: userId,
          word: w.word,
          phonetic: w.phonetic,
          part_of_speech: w.part_of_speech,
          definition: w.definition,
          example_sentence: w.example_sentence,
          usage_tip: w.usage_tip,
          source: 'curated',
          srs_interval_days: 1,
          srs_ease_factor: 2.5,
          next_review_at: new Date().toISOString(),
        }));

        const { data: inserted, error: insertErr } = await supabaseAdmin
          .from('vocab_vault')
          .insert(rows)
          .select('*');

        if (!insertErr && inserted && inserted.length > 0) {
          wordsList = inserted;
        } else {
          wordsList = generated;
        }
      } else {
        wordsList = generated;
      }
    }

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
          const exampleRes = await synthesizeSpeech({ text: w.example_sentence || w.exampleSentence, language: lang, speed: 'normal' });
          exampleAudioUrl = exampleRes.audioUrl;
        } catch (e) {
          exampleAudioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.example_sentence || w.exampleSentence)}&type=2`;
        }

        return {
          id: w.id,
          word: w.word,
          phonetic: w.phonetic,
          partOfSpeech: w.part_of_speech || w.partOfSpeech,
          definition: w.definition,
          exampleSentence: w.example_sentence || w.exampleSentence,
          usageTip: w.usage_tip || w.usageTip,
          source: w.source || 'curated',
          audioUrl: normalAudioUrl,
          slowAudioUrl: slowAudioUrl,
          exampleAudioUrl: exampleAudioUrl
        };
      })
    );

    res.json({ words: enrichedWords });
  } catch (err: any) {
    console.error('[REST Vocab] Failed to assemble AI vocab list:', err.message);
    res.status(500).json({ error: 'Failed to retrieve vocab session.' });
  }
});
app.get('/api/v1/vocab-vault/due', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  const lang = (req.query.lang as string) || 'en';
  const limit = parseInt(req.query.limit as string) || 5;

  try {
    const now = new Date().toISOString();
    const { data: dbWords } = await supabaseAdmin
      .from('vocab_vault')
      .select('*')
      .eq('user_id', userId)
      .or(`next_review_at.is.null,next_review_at.lte.${now}`)
      .order('next_review_at', { ascending: true, nullsFirst: true })
      .limit(limit);

    let wordsList = dbWords && dbWords.length > 0 ? dbWords : [];

    if (wordsList.length === 0) {
      const generated = await generateAiVocab(lang, limit);
      const rows = generated.map((w) => ({
        user_id: userId,
        word: w.word,
        phonetic: w.phonetic,
        part_of_speech: w.part_of_speech,
        definition: w.definition,
        example_sentence: w.example_sentence,
        usage_tip: w.usage_tip,
        source: 'curated',
        srs_interval_days: 1,
        srs_ease_factor: 2.5,
        next_review_at: new Date().toISOString(),
      }));

      const { data: inserted } = await supabaseAdmin.from('vocab_vault').insert(rows).select('*');
      wordsList = inserted && inserted.length > 0 ? inserted : generated;
    }
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

app.post('/api/analyze-fluency', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }

  try {
    const result = await analyzeSessionById(sessionId, userId);
    return res.json({
      ok: true,
      report: result.report,
      analysis: result.analysis,
      transcriptTurnCount: result.transcript.length,
      model: 'gemini-3.5-flash',
    });
  } catch (error: any) {
    console.error('[analyze-fluency] Failed:', error?.message ?? error);
    return res.status(500).json({
      ok: false,
      error: error?.message ?? 'Failed to generate analysis.',
    });
  }
});

app.get('/api/progress/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  try {
    const summary = await getUserProgressSummary(userId);
    return res.json({ ok: true, summary });
  } catch (error: any) {
    console.error('[progress-summary] Failed:', error?.message ?? error);
    return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to load progress summary.' });
  }
});

app.get('/api/analytics/by-session/:sessionId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  const sessionId = req.params.sessionId;
  try {
    const { data: sessionRow } = await supabaseAdmin
      .from('voice_sessions')
      .select('analytics_report_id, status, completed_at')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!sessionRow) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    if (!sessionRow.analytics_report_id) {
      return res.json({ ok: true, ready: false, reportId: null });
    }

    return res.json({
      ok: true,
      ready: true,
      reportId: sessionRow.analytics_report_id,
      completedAt: sessionRow.completed_at,
    });
  } catch (error: any) {
    console.error('[analytics-by-session] Failed:', error?.message ?? error);
    return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to check session analytics.' });
  }
});

app.get('/api/voice-sessions/history', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const { data, error } = await supabaseAdmin
      .from('voice_sessions')
      .select('id, case_study_id, mode, status, completed_at, created_at, updated_at, analytics_report_id, transcript')
      .eq('user_id', userId)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);

    const sessions = (data ?? []).map((row) => {
      const durationSec = Math.max(
        0,
        Math.round(
          (new Date(row.completed_at ?? row.updated_at).getTime() -
            new Date(row.created_at).getTime()) /
            1000,
        ),
      );
      const transcript = Array.isArray(row.transcript) ? row.transcript : [];
      return {
        id: row.id,
        caseStudyId: row.case_study_id,
        mode: row.mode,
        status: row.status,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        durationSeconds: durationSec,
        analyticsReportId: row.analytics_report_id,
        turnCount: transcript.length,
      };
    });

    return res.json({ ok: true, sessions });
  } catch (error: any) {
    console.error('[voice-sessions-history] Failed:', error?.message ?? error);
    return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to load session history.' });
  }
});

app.get('/api/analytics/latest', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  try {
    const report = await getLatestAnalyticsReport(userId);
    return res.json({ ok: true, report });
  } catch (error: any) {
    console.error('[analytics-latest] Failed:', error?.message ?? error);
    return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to load latest analytics.' });
  }
});

app.get('/api/analytics/report/:reportId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  const reportId = req.params.reportId;
  try {
    const { data, error } = await supabase
      .from('analytics_reports')
      .select('*')
      .eq('id', reportId)
      .eq('user_id', userId)
      .single();
    if (error || !data) {
      return res.status(404).json({ ok: false, error: 'Report not found.' });
    }
    return res.json({ ok: true, report: data });
  } catch (error: any) {
    console.error('[analytics-report] Failed:', error?.message ?? error);
    return res.status(500).json({ ok: false, error: error?.message ?? 'Failed to load report.' });
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
