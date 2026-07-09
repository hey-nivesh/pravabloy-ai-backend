import express from 'express';
import http from 'http';
import url from 'url';
import path from 'path';
import fs from 'fs';
import WebSocket from 'ws';
import dotenv from 'dotenv';

import { requireAuth, AuthenticatedRequest, supabase, supabaseAdmin } from './middleware/requireAuth';
import { setupVoiceGateway } from './ws/voiceGateway';
import { analyzeSessionById } from './services/analytics';
import { getLatestAnalyticsReport, getUserProgressSummary } from './services/progress';
import {
  discoverCorpusWords,
  enrichDueVaultWords,
  searchVocabulary,
} from './services/vocabulary/discoverWords';
import { resolvePronunciationUrl, resolvePronunciationByText } from './services/vocabulary/pronunciation';
import { recordStreakActivity } from './services/streak';
import { uploadAvatarToCloudinary, persistUserAvatar } from './services/profile/avatarUpload';
import { getOrCreateTodayChallenge, updateChallengeOnVocabReview } from './services/dailyChallenge';
import { awardVocabMasteredXp } from './services/xp';
import { getJourneyMapProgress } from './services/journeyMap';
import {
  countUnreadNotifications,
  listNotifications,
  markNotificationsRead,
} from './services/notifications';

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
const port = Number(process.env.PORT) || 5000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  app.set('trust proxy', 1);
}

const allowedOrigins = (process.env.CORS_ORIGINS ?? '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Avatar uploads send base64 JSON — default 100kb limit is too small
app.use(express.json({ limit: '15mb' }));

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Image is too large (max 10 MB).' });
  }
  next(err);
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

async function assembleVocabSession(params: {
  userId: string;
  lang: string;
  limit: number;
}): Promise<any[]> {
  const { userId, lang, limit } = params;
  const now = new Date().toISOString();

  const { data: dueWords } = await supabaseAdmin
    .from('vocab_vault')
    .select('*')
    .eq('user_id', userId)
    .or(`next_review_at.is.null,next_review_at.lte.${now}`)
    .order('next_review_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (dueWords && dueWords.length > 0) {
    return enrichDueVaultWords({ rows: dueWords, lang });
  }

  const discovered = await discoverCorpusWords({ userId, limit, lang });
  if (discovered.length > 0) {
    return discovered;
  }

  console.warn('[VocabSession] Corpus empty or unavailable — falling back to on-demand AI vocab generation');
  const { generateAiVocab } = await import('./services/gemini');
  const generated = await generateAiVocab(lang, limit);
  return generated.map((w: any, idx: number) => ({
    id: w.id ?? `ai-${Date.now()}-${idx}`,
    word: w.word,
    phonetic: w.phonetic ?? '',
    partOfSpeech: w.part_of_speech ?? 'noun',
    definition: w.definition,
    exampleSentence: w.example_sentence ?? w.exampleSentence,
    usageTip: w.usage_tip ?? w.usageTip ?? '',
    source: 'curated',
    audioUrl: '',
    slowAudioUrl: '',
    exampleAudioUrl: '',
    srsIntervalDays: 1,
    srsEaseFactor: 2.5,
  }));
}

app.get('/api/v1/vocab-vault/session', async (req, res) => {
  const userId = (req.query.userId as string) || '';
  const lang = (req.query.lang as string) || 'en';
  const limit = parseInt(req.query.limit as string) || 5;

  try {
    if (!userId) {
      return res.status(400).json({ error: 'userId is required.' });
    }

    const words = await assembleVocabSession({ userId, lang, limit });
    res.json({ words });
  } catch (err: any) {
    console.error('[REST Vocab] Failed to assemble session:', err.message);
    res.status(500).json({ error: 'Failed to retrieve vocab session.' });
  }
});

app.get('/api/v1/vocab-vault/due', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id;
  const lang = (req.query.lang as string) || 'en';
  const limit = parseInt(req.query.limit as string) || 5;

  try {
    const words = await assembleVocabSession({ userId, lang, limit });
    res.json({ words });
  } catch (err: any) {
    console.error('[REST Vocab] Failed to assemble daily list:', err.message);
    res.status(500).json({ error: 'Failed to retrieve vocab session.' });
  }
});

app.get('/api/v1/vocab-vault/search', async (req, res) => {
  const q = (req.query.q as string) || '';
  const lang = (req.query.lang as string) || 'en';
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  try {
    const words = await searchVocabulary({ query: q, limit, lang });
    res.json({ words });
  } catch (err: any) {
    console.error('[REST Vocab] Search failed:', err.message);
    res.status(500).json({ error: 'Vocabulary search failed.' });
  }
});

app.get('/api/v1/vocab-vault/pronunciation', async (req, res) => {
  const wordId = (req.query.wordId as string) || '';
  const text = (req.query.text as string) || '';
  const type = (req.query.type as string) || 'word';
  const speed = (req.query.speed as string) || 'normal';
  const lang = (req.query.lang as string) || 'en';
  const format = (req.query.format as string) || 'json';

  if (!wordId && !text) {
    return res.status(400).json({ error: 'wordId or text is required.' });
  }

  try {
    const audioUrl = text && !wordId
      ? await resolvePronunciationByText({ text, type, speed, lang })
      : await resolvePronunciationUrl({ wordId, type, speed, lang });

    if (!audioUrl) {
      return res.status(404).json({ error: 'Audio not available for this word.' });
    }

    if (format === 'json') {
      return res.json({ audioUrl });
    }

    return res.redirect(302, audioUrl);
  } catch (err: any) {
    console.error('[REST Vocab] Pronunciation failed:', err.message);
    return res.status(500).json({ error: 'Failed to resolve pronunciation audio.' });
  }
});

app.post('/api/v1/vocab-vault/:id/review', async (req, res) => {
  const wordId = req.params.id;
  const {
    userId,
    srs_interval_days: srsIntervalDays,
    srs_ease_factor: srsEaseFactor,
    next_review_at: nextReviewAt,
  } = req.body ?? {};

  if (!wordId || !userId) {
    return res.status(400).json({ error: 'wordId and userId are required.' });
  }

  if (wordId.startsWith('mock-')) {
    return res.json({
      next_review_at: nextReviewAt,
      srs_interval_days: srsIntervalDays,
    });
  }

  try {
    const { error } = await supabaseAdmin
      .from('vocab_vault')
      .update({
        srs_interval_days: srsIntervalDays ?? 1,
        srs_ease_factor: srsEaseFactor ?? 2.5,
        next_review_at: nextReviewAt ?? new Date(Date.now() + 86_400_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', wordId)
      .eq('user_id', userId);

    if (error) {
      throw new Error(error.message);
    }

    const mastered = req.body?.response === 'got_it';
    if (mastered) {
      void awardVocabMasteredXp(userId).catch((xpErr) => {
        console.warn('[REST Vocab] XP award failed:', xpErr?.message ?? xpErr);
      });
    }
    void updateChallengeOnVocabReview(userId, mastered).catch((challengeErr) => {
      console.warn('[REST Vocab] Daily challenge update failed:', challengeErr?.message ?? challengeErr);
    });

    return res.json({
      next_review_at: nextReviewAt,
      srs_interval_days: srsIntervalDays,
    });
  } catch (err: any) {
    console.error('[REST Vocab] Review update failed:', err.message);
    return res.status(500).json({ error: 'Failed to update review schedule.' });
  }
});

app.get('/api/v1/daily-challenge/today', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const challenge = await getOrCreateTodayChallenge(req.user.id);
    return res.json({ ok: true, challenge });
  } catch (err: any) {
    console.error('[daily-challenge] fetch failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message ?? 'Failed to load daily challenge.' });
  }
});

app.get('/api/v1/journey-map', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const progress = await getJourneyMapProgress(req.user.id);
    return res.json({ ok: true, ...progress });
  } catch (err: any) {
    console.error('[journey-map] fetch failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message ?? 'Failed to load journey map.' });
  }
});

app.get('/api/v1/notifications', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const notifications = await listNotifications(req.user.id, limit);
    const unreadCount = await countUnreadNotifications(req.user.id);
    return res.json({ ok: true, notifications, unreadCount });
  } catch (err: any) {
    console.error('[notifications] list failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message ?? 'Failed to load notifications.' });
  }
});

app.post('/api/v1/notifications/read', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const notificationId = req.body?.notificationId as string | undefined;
    await markNotificationsRead(req.user.id, notificationId);
    const unreadCount = await countUnreadNotifications(req.user.id);
    return res.json({ ok: true, unreadCount });
  } catch (err: any) {
    console.error('[notifications] mark read failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message ?? 'Failed to mark notifications read.' });
  }
});

app.post('/api/v1/streak/record', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const result = await recordStreakActivity(req.user.id);
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[streak] record failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message ?? 'Failed to record streak.' });
  }
});

app.post('/api/profile/avatar', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { imageBase64, mimeType } = req.body ?? {};

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 is required.' });
  }

  const safeMime =
    typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';

  try {
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    if (imageBuffer.length === 0) {
      return res.status(400).json({ error: 'imageBase64 is empty.' });
    }
    if (imageBuffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image is too large (max 10 MB).' });
    }

    const { secureUrl, publicId } = await uploadAvatarToCloudinary({
      imageBuffer,
      mimeType: safeMime,
      userId: req.user.id,
    });

    await persistUserAvatar({
      userId: req.user.id,
      secureUrl,
      publicId,
    });

    return res.json({ ok: true, secureUrl, publicId });
  } catch (err: any) {
    console.error('[profile/avatar] upload failed:', err.message);
    return res.status(500).json({ error: err.message ?? 'Avatar upload failed.' });
  }
});

app.post('/api/v1/vocab-vault/prewarm', async (req, res) => {
  const limit = Math.min(parseInt(req.body?.limit as string) || 5000, 10_000);
  const lang = (req.body?.lang as string) || 'en';

  try {
    const { data: candidates } = await supabaseAdmin
      .from('vocabulary_words')
      .select('id')
      .eq('is_enriched', false)
      .order('frequency_rank', { ascending: true, nullsFirst: false })
      .limit(limit);

    const { enrichWord } = await import('./services/vocabulary/enrichWord');
    let enriched = 0;
    for (const row of candidates ?? []) {
      try {
        await enrichWord(row.id, lang);
        enriched += 1;
      } catch (err: any) {
        console.warn(`[prewarm] skipped ${row.id}:`, err.message);
      }
    }

    return res.json({ ok: true, attempted: candidates?.length ?? 0, enriched });
  } catch (err: any) {
    console.error('[prewarm] failed:', err.message);
    return res.status(500).json({ error: 'Prewarm job failed.' });
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

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

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

setupVoiceGateway(wss);

server.listen(port, () => {
  console.log(`[PravabloyAI Server] Server running on port ${port}`);
  console.log(`[PravabloyAI Server] Voice model: gemini-3.1-flash-live-preview (no limits)`);
});
