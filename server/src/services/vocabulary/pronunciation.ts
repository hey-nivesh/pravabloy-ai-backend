import { supabaseAdmin } from '../../middleware/requireAuth';
import { enrichWord, enrichWordByText, getEnrichmentForWord } from './enrichWord';
import { synthesizeSpeech } from '../gemini';

export async function resolvePronunciationUrl(params: {
  wordId: string;
  type?: string;
  speed?: string;
  lang?: string;
}): Promise<string> {
  const type = params.type === 'example' ? 'example' : 'word';
  const speed = params.speed === 'slow' ? 'slow' : 'normal';
  const lang = params.lang ?? 'en';

  let wordText: string | null = null;
  let exampleSentence: string | null = null;
  let corpusWordId: string | null = null;

  const { data: vaultRow } = await supabaseAdmin
    .from('vocab_vault')
    .select('word, example_sentence, corpus_word_id')
    .eq('id', params.wordId)
    .maybeSingle();

  if (vaultRow) {
    wordText = vaultRow.word;
    exampleSentence = vaultRow.example_sentence;
    corpusWordId = vaultRow.corpus_word_id;
  } else {
    const { data: corpusRow } = await supabaseAdmin
      .from('vocabulary_words')
      .select('id, word')
      .eq('id', params.wordId)
      .maybeSingle();

    if (corpusRow) {
      wordText = corpusRow.word;
      corpusWordId = corpusRow.id;
    }
  }

  if (!wordText) {
    throw new Error('Word not found for pronunciation');
  }

  if (corpusWordId) {
    let enrichment = await getEnrichmentForWord(corpusWordId, lang);
    if (!enrichment) {
      const enriched = await enrichWord(corpusWordId, lang);
      enrichment = enriched.enrichment;
    }

    if (type === 'example') {
      if (enrichment.example_audio_url) return enrichment.example_audio_url;
      exampleSentence = enrichment.example_sentence;
    } else if (speed === 'slow') {
      if (enrichment.slow_word_audio_url) return enrichment.slow_word_audio_url;
    } else if (enrichment.word_audio_url) {
      return enrichment.word_audio_url;
    }
  }

  if (type === 'example') {
    const text = exampleSentence ?? wordText;
    try {
      const res = await synthesizeSpeech({ text, language: lang, speed: 'normal', debugContext: 'example' });
      return res.audioUrl;
    } catch {
      return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`;
    }
  }

  try {
    const res = await synthesizeSpeech({
      text: wordText,
      language: lang,
      speed,
      debugContext: speed === 'slow' ? 'word-slow' : 'word',
    });
    return res.audioUrl;
  } catch {
    return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(wordText)}&type=2`;
  }
}

export async function resolvePronunciationByText(params: {
  text: string;
  type?: string;
  speed?: string;
  lang?: string;
}): Promise<string> {
  const type = params.type === 'example' ? 'example' : 'word';
  const speed = params.speed === 'slow' ? 'slow' : 'normal';
  const lang = params.lang ?? 'en';
  const text = params.text.trim();

  if (!text) {
    throw new Error('text is required for pronunciation');
  }

  try {
    const res = await synthesizeSpeech({
      text,
      language: lang,
      speed: type === 'example' ? 'normal' : speed,
      debugContext: type === 'example' ? 'example' : speed === 'slow' ? 'word-slow' : 'word',
    });
    return res.audioUrl;
  } catch {
    return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`;
  }
}

export async function resolvePronunciationByWordText(params: {
  word: string;
  type?: string;
  speed?: string;
  lang?: string;
}): Promise<string> {
  const enriched = await enrichWordByText(params.word, params.lang ?? 'en');
  if (!enriched) {
    throw new Error('Word not found in corpus');
  }

  const { enrichment } = enriched;
  if (params.type === 'example') {
    return enrichment.example_audio_url ?? '';
  }
  if (params.speed === 'slow') {
    return enrichment.slow_word_audio_url ?? enrichment.word_audio_url ?? '';
  }
  return enrichment.word_audio_url ?? '';
}
