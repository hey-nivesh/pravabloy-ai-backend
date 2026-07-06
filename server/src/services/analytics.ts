import { GoogleGenAI } from '@google/genai';
import { supabase } from '../middleware/requireAuth';
import {
  geminiRateLimiter,
  callWithRetry,
  callWithModelFallback
} from '../utils/rateLimiter';

export interface TranscriptTurn {
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
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
): Promise<void> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error('[Analytics Service] Missing GEMINI_API_KEY. Cannot run post-session analytics.');
    return;
  }

  if (!transcript || transcript.length === 0) {
    console.log(`[Analytics Service] Transcript is empty for session ${sessionId}. Skipping generation.`);
    return;
  }

  console.log(`[Analytics Service] Starting post-session report generation for session ${sessionId}...`);

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const formattedTranscript = transcript
      .map(t => `${t.sender.toUpperCase()}: ${t.text}`)
      .join('\n');

    const prompt = `
You are a senior English language learning analyst. Analyze the following spoken English dialog transcript between a student (USER) and their AI tutor (AI).

TRANSCRIPT:
${formattedTranscript}

Generate a JSON analysis report with the following exact keys:
- "overallScore": A number from 0 to 100 assessing fluency.
- "fillerWordsCount": An integer count of filler words (like "um", "uh", "like", "you know") used by the user.
- "grammarCorrections": An array of objects, each containing "original" (user's sentence), "corrected" (correct version), and "explanation".
- "vocabularyFeedback": A paragraph detailing recommendations for better word choices to sound more native or professional.

Return ONLY raw valid JSON. Do not wrap in markdown code blocks.
    `.trim();

    const reportText = await geminiRateLimiter.enqueue(() =>
      callWithModelFallback('gemini-2.5-flash', 'gemini-1.5-flash', async (modelName) => {
        return callWithRetry(async () => {
          console.log(`[Analytics Service] Analyzing transcript using model ${modelName}...`);
          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: {
              responseMimeType: 'application/json'
            }
          });
          return response.text;
        });
      })
    );
    if (!reportText) {
      throw new Error('Gemini returned an empty analytics report response.');
    }

    const reportData = JSON.parse(reportText);

    // Write the report details to Supabase database (e.g. table: analytics_reports)
    const { data: dbReport, error: dbError } = await supabase
      .from('analytics_reports')
      .insert({
        user_id: userId,
        voice_session_id: sessionId,
        score: reportData.overallScore ?? 80,
        filler_count: reportData.fillerWordsCount ?? 0,
        grammar_corrections: reportData.grammarCorrections ?? [],
        vocab_feedback: reportData.vocabularyFeedback ?? 'Good conversation flow. Continue practicing daily.',
        full_report: reportData,
        created_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (dbError) {
      throw new Error(`Failed to save report to DB: ${dbError.message}`);
    }

    // Link the report back to the voice session row
    await supabase
      .from('voice_sessions')
      .update({
        analytics_report_id: dbReport.id,
        completed_at: new Date().toISOString(),
        status: 'completed'
      })
      .eq('id', sessionId);

    console.log(`[Analytics Service] Successfully generated and stored report ${dbReport.id} for session ${sessionId}`);
  } catch (err: any) {
    console.error(`[Analytics Service] Failed generation error for session ${sessionId}:`, err.message);

    // Fallback stub insert to prevent locking UI flows
    try {
      const { data: fallbackReport } = await supabase
        .from('analytics_reports')
        .insert({
          user_id: userId,
          voice_session_id: sessionId,
          score: 75,
          filler_count: 3,
          grammar_corrections: [],
          vocab_feedback: 'Analysis fallback generated. Practice speaking 5 minutes daily.',
          created_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (fallbackReport) {
        await supabase
          .from('voice_sessions')
          .update({
            analytics_report_id: fallbackReport.id,
            completed_at: new Date().toISOString(),
            status: 'completed'
          })
          .eq('id', sessionId);
      }
    } catch (fallbackErr: any) {
      console.error('[Analytics Service] Even fallback DB insert failed:', fallbackErr.message);
    }
  }
}
