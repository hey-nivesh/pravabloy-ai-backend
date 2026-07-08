import { GoogleGenAI } from '@google/genai';
import { supabaseAdmin as supabase } from '../middleware/requireAuth';
import { geminiRateLimiter, callWithRetry } from '../utils/rateLimiter';

export interface TranscriptTurn {
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
}

type SessionContext = {
  category: string;
  scenarioPrompt: string;
  difficulty: string;
};

type AnalysisPayload = {
  wpm: number;
  filler_word_count: number;
  grammar_gaps: Array<{ original: string; corrected: string; explanation: string }>;
  lexicon_tier_rank: string;
  fluency_score: number;
  confidence_score: number;
  strengths: string[];
  improvement_areas: string[];
  pronunciation_feedback: string;
  vocabulary_feedback: string;
  overall_evaluation: string;
  vocabulary_tips: Array<{ term: string; meaning: string; standardAlternative: string }>;
};

type PersistedReport = {
  id?: string;
  voice_session_id: string;
  user_id: string;
  score?: number;
  filler_count?: number;
  grammar_corrections?: any[];
  vocab_feedback?: string;
  full_report?: any;
  [key: string]: any;
};

const ANALYSIS_MODEL = 'gemini-3.5-flash';

const CASE_STUDY_DEFAULTS: Record<string, SessionContext> = {
  'salary-negotiation': {
    category: 'executive',
    difficulty: 'Advanced',
    scenarioPrompt: 'Negotiate a salary revision professionally with measurable impact evidence.',
  },
  'system-design': {
    category: 'mock_interview',
    difficulty: 'Advanced',
    scenarioPrompt: 'Discuss a scalable architecture with clear tradeoff explanations.',
  },
  'hotel-checkin': {
    category: 'casual',
    difficulty: 'Intermediate',
    scenarioPrompt: 'Check into a hotel, confirm reservation details, and request assistance politely.',
  },
  'ordering-coffee': {
    category: 'casual',
    difficulty: 'Beginner',
    scenarioPrompt: 'Order coffee naturally and confidently with brief small talk.',
  },
};

function normalizeTranscript(raw: any): TranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      sender: (item?.sender === 'ai' ? 'ai' : 'user') as 'user' | 'ai',
      text: String(item?.text ?? '').trim(),
      timestamp: String(item?.timestamp ?? new Date().toISOString()),
    }))
    .filter((t) => t.text.length > 0);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countFillers(text: string): number {
  const fillers = ['um', 'uh', 'like', 'you know', 'sort of', 'kind of', 'basically', 'actually', 'literally', 'i mean'];
  const lower = text.toLowerCase();
  return fillers.reduce((sum, filler) => {
    const re = new RegExp(`\\b${filler.replace(/ /g, '\\s+')}\\b`, 'g');
    return sum + (lower.match(re)?.length ?? 0);
  }, 0);
}

function computeWpmFromTranscript(transcript: TranscriptTurn[], sessionRow: any): number {
  const userTurns = transcript.filter((t) => t.sender === 'user');
  const userWordCount = userTurns.reduce((sum, turn) => sum + countWords(turn.text), 0);
  if (userWordCount === 0) return 0;

  const userTimestamps = userTurns
    .map((turn) => new Date(turn.timestamp).getTime())
    .filter((ms) => Number.isFinite(ms));
  if (userTimestamps.length >= 2) {
    const durationMin = Math.max((Math.max(...userTimestamps) - Math.min(...userTimestamps)) / 60000, 1 / 6);
    return Math.round(userWordCount / durationMin);
  }

  const startedAt = new Date(sessionRow?.created_at ?? sessionRow?.started_at ?? 0).getTime();
  const endedAt = new Date(sessionRow?.completed_at ?? sessionRow?.updated_at ?? Date.now()).getTime();
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt > startedAt) {
    const durationMin = Math.max((endedAt - startedAt) / 60000, 1 / 6);
    return Math.round(userWordCount / durationMin);
  }

  return Math.round(userWordCount / 3);
}

function toDialogue(transcript: TranscriptTurn[]): string {
  return transcript
    .map((turn) => `${turn.sender === 'user' ? 'Student' : 'Coach'}: ${turn.text}`)
    .join('\n');
}

async function getSessionContext(sessionRow: any): Promise<SessionContext> {
  const fallback = CASE_STUDY_DEFAULTS[sessionRow?.case_study_id ?? 'ordering-coffee'] ?? {
    category: 'casual',
    scenarioPrompt: 'General English speaking practice.',
    difficulty: 'Intermediate',
  };

  try {
    const { data, error } = await supabase
      .from('case_studies')
      .select('category, scenario_prompt, difficulty')
      .eq('id', sessionRow?.case_study_id)
      .single();
    if (!error && data) {
      return {
        category: String(data.category ?? fallback.category),
        scenarioPrompt: String(data.scenario_prompt ?? fallback.scenarioPrompt),
        difficulty: String(data.difficulty ?? fallback.difficulty),
      };
    }
  } catch (_) {
    // Fall back silently if case_studies table is unavailable in this environment.
  }
  return fallback;
}

async function generateLlmAnalysis(input: {
  transcript: TranscriptTurn[];
  context: SessionContext;
  computedWpm: number;
  computedFillerCount: number;
  livePacing: any;
}): Promise<AnalysisPayload> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) throw new Error('Missing GEMINI_API_KEY');
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const responseSchema = {
    type: 'object',
    properties: {
      wpm: { type: 'integer' },
      filler_word_count: { type: 'integer' },
      grammar_gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            original: { type: 'string' },
            corrected: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['original', 'corrected', 'explanation'],
        },
      },
      lexicon_tier_rank: { type: 'string' },
      fluency_score: { type: 'integer' },
      confidence_score: { type: 'integer' },
      strengths: { type: 'array', items: { type: 'string' } },
      improvement_areas: { type: 'array', items: { type: 'string' } },
      pronunciation_feedback: { type: 'string' },
      vocabulary_feedback: { type: 'string' },
      overall_evaluation: { type: 'string' },
      vocabulary_tips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            term: { type: 'string' },
            meaning: { type: 'string' },
            standardAlternative: { type: 'string' },
          },
          required: ['term', 'meaning', 'standardAlternative'],
        },
      },
    },
    required: [
      'wpm',
      'filler_word_count',
      'grammar_gaps',
      'lexicon_tier_rank',
      'fluency_score',
      'confidence_score',
      'strengths',
      'improvement_areas',
      'pronunciation_feedback',
      'vocabulary_feedback',
      'overall_evaluation',
      'vocabulary_tips',
    ],
  };

  const prompt = `
You are an expert spoken-English evaluator.
Evaluate the student using the real conversation transcript only.

Scenario category: ${input.context.category}
Scenario prompt: ${input.context.scenarioPrompt}
Difficulty: ${input.context.difficulty}

Computed baseline metrics (trust these unless transcript clearly contradicts):
- computed_wpm: ${input.computedWpm}
- computed_filler_word_count: ${input.computedFillerCount}
- live_pacing_summary: ${JSON.stringify(input.livePacing ?? null)}

Transcript (alternating Student/Coach):
${toDialogue(input.transcript)}

Scoring guidance:
- Fluency and confidence must reflect transcript evidence, not generic praise.
- grammar_gaps should include concrete corrections from student utterances only.
- strengths and improvement_areas should each be concise, specific bullet-style phrases.
- lexicon_tier_rank should be one of: Smart Starter, Confident Speaker, Diplomatic Communicator.

Return strict JSON matching the provided schema.
`.trim();

  const responseText = await geminiRateLimiter.enqueue(() =>
    callWithRetry(async () => {
      const response = await ai.models.generateContent({
        model: ANALYSIS_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: responseSchema as any,
        } as any,
      });
      return response.text;
    }),
  );

  if (!responseText) {
    throw new Error('Gemini returned an empty analysis response.');
  }
  const parsed = JSON.parse(responseText) as AnalysisPayload;
  return parsed;
}

function buildShortTranscriptFallback(transcript: TranscriptTurn[], wpm: number, fillerCount: number): AnalysisPayload {
  return {
    wpm,
    filler_word_count: fillerCount,
    grammar_gaps: [],
    lexicon_tier_rank: 'Smart Starter',
    fluency_score: transcript.length === 0 ? 0 : 40,
    confidence_score: transcript.length === 0 ? 0 : 45,
    strengths: transcript.length === 0 ? ['Session started successfully'] : ['Attempted spoken interaction'],
    improvement_areas: ['Speak for at least 1-2 full minutes to unlock deeper analysis'],
    pronunciation_feedback: 'Not enough speech data to evaluate pronunciation reliably.',
    vocabulary_feedback: 'Not enough transcript data for vocabulary assessment.',
    overall_evaluation:
      transcript.length === 0
        ? 'The session ended before usable transcript data was captured.'
        : 'The session was too short for a full-quality fluency analysis.',
    vocabulary_tips: [],
  };
}

async function insertReportWithFallback(reportInsert: Record<string, any>): Promise<PersistedReport> {
  const { data, error } = await supabase
    .from('analytics_reports')
    .insert(reportInsert)
    .select('*')
    .single();
  if (!error && data) return data as PersistedReport;

  const legacyInsert = {
    user_id: reportInsert.user_id,
    voice_session_id: reportInsert.voice_session_id,
    score: reportInsert.score,
    filler_count: reportInsert.filler_count,
    grammar_corrections: reportInsert.grammar_corrections,
    vocab_feedback: reportInsert.vocab_feedback,
    full_report: reportInsert.full_report,
    created_at: reportInsert.created_at,
  };
  const { data: legacyData, error: legacyError } = await supabase
    .from('analytics_reports')
    .insert(legacyInsert)
    .select('*')
    .single();
  if (legacyError) throw new Error(`Failed to persist analytics report: ${legacyError.message}`);
  return legacyData as PersistedReport;
}

export async function analyzeSessionById(sessionId: string, userId: string, transcriptOverride?: TranscriptTurn[]) {
  const { data: sessionRow, error: sessionErr } = await supabase
    .from('voice_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single();

  if (sessionErr || !sessionRow) {
    throw new Error(`Voice session not found: ${sessionErr?.message ?? 'unknown error'}`);
  }

  const transcript = transcriptOverride?.length ? transcriptOverride : normalizeTranscript(sessionRow.transcript);
  const computedWpm = computeWpmFromTranscript(transcript, sessionRow);
  const computedFillerCount = transcript
    .filter((t) => t.sender === 'user')
    .reduce((sum, t) => sum + countFillers(t.text), 0);

  const context = await getSessionContext(sessionRow);
  const livePacing = sessionRow.live_pacing ?? sessionRow.livePacing ?? null;

  const analysis =
    transcript.length < 2
      ? buildShortTranscriptFallback(transcript, computedWpm, computedFillerCount)
      : await generateLlmAnalysis({
          transcript,
          context,
          computedWpm,
          computedFillerCount,
          livePacing,
        });

  const normalizedAnalysis: AnalysisPayload = {
    ...analysis,
    wpm: Number.isFinite(analysis.wpm) ? analysis.wpm : computedWpm,
    filler_word_count: Number.isFinite(analysis.filler_word_count)
      ? analysis.filler_word_count
      : computedFillerCount,
  };

  const mergedFullReport = {
    ...normalizedAnalysis,
    transcript_turn_count: transcript.length,
    context,
    computed_metrics: {
      wpm: computedWpm,
      filler_word_count: computedFillerCount,
    },
    live_pacing_summary: livePacing,
  };

  const reportInsert = {
    user_id: userId,
    voice_session_id: sessionId,
    wpm: normalizedAnalysis.wpm,
    filler_word_count: normalizedAnalysis.filler_word_count,
    grammar_gaps: normalizedAnalysis.grammar_gaps,
    lexicon_tier_rank: normalizedAnalysis.lexicon_tier_rank,
    fluency_score: normalizedAnalysis.fluency_score,
    confidence_score: normalizedAnalysis.confidence_score,
    strengths: normalizedAnalysis.strengths,
    improvement_areas: normalizedAnalysis.improvement_areas,
    // Backward-compatible fields consumed by the current mobile UI:
    score: normalizedAnalysis.fluency_score,
    filler_count: normalizedAnalysis.filler_word_count,
    grammar_corrections: normalizedAnalysis.grammar_gaps,
    vocab_feedback: normalizedAnalysis.vocabulary_feedback,
    full_report: mergedFullReport,
    created_at: new Date().toISOString(),
  };

  const persisted = await insertReportWithFallback(reportInsert);

  await supabase
    .from('voice_sessions')
    .update({
      analytics_report_id: persisted.id,
      completed_at: new Date().toISOString(),
      status: 'completed',
    })
    .eq('id', sessionId)
    .eq('user_id', userId);

  return { report: persisted, analysis: mergedFullReport, transcript };
}

/**
 * Analytics Service: Evaluates voice sessions post-completion.
 * Parses the dialog history to calculate speaking duration, identify grammatical errors,
 * highlight filler word frequency, and generate constructive feedback.
 */
export async function triggerSessionAnalytics(
  sessionId: string,
  userId: string,
  transcript: TranscriptTurn[]
): Promise<{ reportId: string | null }> {
  try {
    const result = await analyzeSessionById(sessionId, userId, transcript);
    const reportId = result.report?.id ? String(result.report.id) : null;
    console.log(`[Analytics Service] Successfully generated and stored report for session ${sessionId}`);
    return { reportId };
  } catch (err: any) {
    console.error(`[Analytics Service] Failed generation error for session ${sessionId}:`, err.message);
    return { reportId: null };
  }
}
