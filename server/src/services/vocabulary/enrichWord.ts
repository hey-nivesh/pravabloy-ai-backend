import { GoogleGenAI } from '@google/genai';
import { supabaseAdmin } from '../../middleware/requireAuth';
import { synthesizeSpeech } from '../gemini';
import type { VocabularyEnrichmentRow, VocabularyWordRow } from './types';

const ENRICH_TIMEOUT_MS = 45_000;

const FALLBACK_DEFINITION = 'Definition is being prepared. Please try again shortly.';
const FALLBACK_EXAMPLE = 'We will add a natural example sentence for this word soon.';

export type EnrichWordResult = {
  word: VocabularyWordRow;
  enrichment: VocabularyEnrichmentRow;
  fromCache: boolean;
};

function difficultyPrompt(level: string | null): string {
  switch (level) {
    case 'beginner':
      return 'Use simple, everyday language suitable for beginners.';
    case 'intermediate':
      return 'Use clear professional language suitable for intermediate learners.';
    case 'advanced':
      return 'Use nuanced, professional language suitable for advanced learners.';
    case 'expert':
      return 'Use sophisticated language suitable for expert-level learners.';
    default:
      return 'Use clear, natural language suitable for intermediate learners.';
  }
}

async function generateEnrichmentContent(params: {
  word: string;
  partOfSpeech: string | null;
  difficultyLevel: string | null;
  targetLanguage: string;
}): Promise<{
  definition: string;
  phonetic_spelling: string;
  example_sentence: string;
  usage_tip: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not defined.');

  const ai = new GoogleGenAI({ apiKey });
  const lang = params.targetLanguage === 'en' ? 'English' : params.targetLanguage;
  const pos = params.partOfSpeech ?? 'unknown';

  const prompt = `You are a vocabulary coach for spoken English learners.

Word: "${params.word}"
Part of speech: ${pos}
Difficulty: ${params.difficultyLevel ?? 'intermediate'}
Target language for explanation: ${lang}

${difficultyPrompt(params.difficultyLevel)}

Return ONLY valid JSON with these exact keys:
{
  "definition": "clear definition in ${lang}",
  "phonetic_spelling": "IPA in slash notation, e.g. /ɪˈlɒk.wənt/",
  "example_sentence": "ONE natural, realistic sentence someone would actually say or write in real life — not a textbook or dictionary-style sentence. The sentence must use the word naturally.",
  "usage_tip": "short conversational tip, collocation, or nuance"
}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const text = response.text?.trim() || '{}';
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  return {
    definition: String(parsed.definition ?? FALLBACK_DEFINITION),
    phonetic_spelling: String(parsed.phonetic_spelling ?? ''),
    example_sentence: String(parsed.example_sentence ?? FALLBACK_EXAMPLE),
    usage_tip: String(parsed.usage_tip ?? ''),
  };
}

async function synthesizeAllAudio(params: {
  word: string;
  exampleSentence: string;
  language: string;
}): Promise<{
  word_audio_url: string;
  slow_word_audio_url: string;
  example_audio_url: string;
}> {
  const youdaoWord = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(params.word)}&type=2`;
  const youdaoExample = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(params.exampleSentence)}&type=2`;

  let word_audio_url = youdaoWord;
  let slow_word_audio_url = youdaoWord;
  let example_audio_url = youdaoExample;

  try {
    const normalRes = await synthesizeSpeech({
      text: params.word,
      language: params.language,
      speed: 'normal',
      debugContext: 'word',
    });
    word_audio_url = normalRes.audioUrl;
  } catch (err: any) {
    console.warn(`[enrichWord] word TTS failed for "${params.word}":`, err.message);
  }

  try {
    const slowRes = await synthesizeSpeech({
      text: params.word,
      language: params.language,
      speed: 'slow',
      debugContext: 'word-slow',
    });
    slow_word_audio_url = slowRes.audioUrl;
  } catch (err: any) {
    console.warn(`[enrichWord] slow word TTS failed for "${params.word}":`, err.message);
  }

  try {
    const exampleRes = await synthesizeSpeech({
      text: params.exampleSentence,
      language: params.language,
      speed: 'normal',
      debugContext: 'example',
    });
    example_audio_url = exampleRes.audioUrl;
  } catch (err: any) {
    console.warn(
      `[enrichWord] example TTS failed for "${params.word}" (${params.exampleSentence.length} chars):`,
      err.message,
    );
  }

  return { word_audio_url, slow_word_audio_url, example_audio_url };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function enrichWord(
  wordId: string,
  targetLanguage = 'en',
): Promise<EnrichWordResult> {
  const { data: wordRow, error: wordErr } = await supabaseAdmin
    .from('vocabulary_words')
    .select('*')
    .eq('id', wordId)
    .single();

  if (wordErr || !wordRow) {
    throw new Error(`Corpus word not found: ${wordId}`);
  }

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('vocabulary_enrichment')
    .select('*')
    .eq('word_id', wordId)
    .eq('generated_language', targetLanguage)
    .maybeSingle();

  if (!existingErr && existing) {
    return { word: wordRow as VocabularyWordRow, enrichment: existing as VocabularyEnrichmentRow, fromCache: true };
  }

  const work = async (): Promise<EnrichWordResult> => {
    const content = await generateEnrichmentContent({
      word: wordRow.word,
      partOfSpeech: wordRow.part_of_speech,
      difficultyLevel: wordRow.difficulty_level,
      targetLanguage,
    });

    const audio = await synthesizeAllAudio({
      word: wordRow.word,
      exampleSentence: content.example_sentence,
      language: targetLanguage,
    });

    const enrichmentRow = {
      word_id: wordId,
      definition: content.definition,
      phonetic_spelling: content.phonetic_spelling,
      example_sentence: content.example_sentence,
      usage_tip: content.usage_tip,
      word_audio_url: audio.word_audio_url,
      example_audio_url: audio.example_audio_url,
      slow_word_audio_url: audio.slow_word_audio_url,
      generated_language: targetLanguage,
    };

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('vocabulary_enrichment')
      .upsert(enrichmentRow, { onConflict: 'word_id,generated_language' })
      .select('*')
      .single();

    if (insertErr || !inserted) {
      throw new Error(insertErr?.message ?? 'Failed to persist vocabulary enrichment');
    }

    await supabaseAdmin
      .from('vocabulary_words')
      .update({ is_enriched: true })
      .eq('id', wordId);

    return {
      word: wordRow as VocabularyWordRow,
      enrichment: inserted as VocabularyEnrichmentRow,
      fromCache: false,
    };
  };

  try {
    return await withTimeout(work(), ENRICH_TIMEOUT_MS, 'enrichWord');
  } catch (err: any) {
    console.error(`[enrichWord] Failed for ${wordRow.word}:`, err.message);

    const fallback = {
      word_id: wordId,
      definition: `${wordRow.word}: ${FALLBACK_DEFINITION}`,
      phonetic_spelling: '',
      example_sentence: FALLBACK_EXAMPLE.replace('this word', wordRow.word),
      usage_tip: '',
      word_audio_url: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(wordRow.word)}&type=2`,
      example_audio_url: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(FALLBACK_EXAMPLE)}&type=2`,
      slow_word_audio_url: `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(wordRow.word)}&type=2`,
      generated_language: targetLanguage,
    };

    const { data: inserted } = await supabaseAdmin
      .from('vocabulary_enrichment')
      .upsert(fallback, { onConflict: 'word_id,generated_language' })
      .select('*')
      .single();

    return {
      word: wordRow as VocabularyWordRow,
      enrichment: (inserted ?? fallback) as VocabularyEnrichmentRow,
      fromCache: false,
    };
  }
}

export async function enrichWordByText(
  wordText: string,
  targetLanguage = 'en',
): Promise<EnrichWordResult | null> {
  const { data } = await supabaseAdmin
    .from('vocabulary_words')
    .select('id')
    .ilike('word', wordText)
    .limit(1)
    .maybeSingle();

  if (!data?.id) return null;
  return enrichWord(data.id, targetLanguage);
}

export async function getEnrichmentForWord(
  wordId: string,
  targetLanguage = 'en',
): Promise<VocabularyEnrichmentRow | null> {
  const { data } = await supabaseAdmin
    .from('vocabulary_enrichment')
    .select('*')
    .eq('word_id', wordId)
    .eq('generated_language', targetLanguage)
    .maybeSingle();

  return (data as VocabularyEnrichmentRow) ?? null;
}
