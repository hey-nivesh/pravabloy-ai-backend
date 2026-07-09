import { supabaseAdmin } from '../../middleware/requireAuth';
import { enrichWord } from './enrichWord';
import { formatEnrichedWord } from './formatWordResponse';
import type { EnrichedVocabularyWord } from './types';

export async function discoverCorpusWords(params: {
  userId: string;
  limit: number;
  lang: string;
}): Promise<EnrichedVocabularyWord[]> {
  const { userId, limit, lang } = params;

  const { data: userWords } = await supabaseAdmin
    .from('vocab_vault')
    .select('word, corpus_word_id')
    .eq('user_id', userId);

  const seenWords = new Set((userWords ?? []).map((row) => row.word.toLowerCase()));
  const seenCorpusIds = new Set(
    (userWords ?? []).map((row) => row.corpus_word_id).filter(Boolean) as string[],
  );

  const { data: candidates, error } = await supabaseAdmin
    .from('vocabulary_words')
    .select('id, word, part_of_speech, difficulty_level, frequency_rank, is_enriched')
    .order('frequency_rank', { ascending: true, nullsFirst: false })
    .limit(Math.max(limit * 40, 200));

  if (error) {
    throw new Error(error.message);
  }

  const picked = (candidates ?? []).filter(
    (row) => !seenWords.has(row.word.toLowerCase()) && !seenCorpusIds.has(row.id),
  );

  const selected = picked.slice(0, limit);
  const enriched: EnrichedVocabularyWord[] = [];

  for (const row of selected) {
    const { word, enrichment } = await enrichWord(row.id, lang);

    const vaultInsert = {
      user_id: userId,
      word: word.word,
      phonetic: enrichment.phonetic_spelling,
      part_of_speech: word.part_of_speech ?? 'noun',
      definition: enrichment.definition,
      example_sentence: enrichment.example_sentence,
      usage_tip: enrichment.usage_tip,
      source: 'corpus',
      corpus_word_id: word.id,
      srs_interval_days: 1,
      srs_ease_factor: 2.5,
      next_review_at: new Date().toISOString(),
    };

    const { data: inserted } = await supabaseAdmin
      .from('vocab_vault')
      .insert(vaultInsert)
      .select('*')
      .single();

    enriched.push(
      formatEnrichedWord({
        id: inserted?.id ?? word.id,
        word: word.word,
        phonetic: enrichment.phonetic_spelling,
        partOfSpeech: word.part_of_speech,
        definition: enrichment.definition,
        exampleSentence: enrichment.example_sentence,
        usageTip: enrichment.usage_tip,
        source: 'curated',
        wordAudioUrl: enrichment.word_audio_url ?? '',
        slowWordAudioUrl: enrichment.slow_word_audio_url ?? enrichment.word_audio_url ?? '',
        exampleAudioUrl: enrichment.example_audio_url ?? '',
        corpusWordId: word.id,
        srsIntervalDays: 1,
        srsEaseFactor: 2.5,
      }),
    );
  }

  return enriched;
}

export async function enrichDueVaultWords(params: {
  rows: any[];
  lang: string;
}): Promise<EnrichedVocabularyWord[]> {
  const results: EnrichedVocabularyWord[] = [];

  for (const row of params.rows) {
    let enrichment = null;
    let corpusWordId = row.corpus_word_id as string | null;

    if (!corpusWordId) {
      const { data: corpusMatch } = await supabaseAdmin
        .from('vocabulary_words')
        .select('id')
        .ilike('word', row.word)
        .limit(1)
        .maybeSingle();
      corpusWordId = corpusMatch?.id ?? null;
    }

    if (corpusWordId) {
      const enriched = await enrichWord(corpusWordId, params.lang);
      enrichment = enriched.enrichment;
    } else {
      const { synthesizeSpeech } = await import('../gemini');
      const youdaoWord = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(row.word)}&type=2`;
      const youdaoExample = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(row.example_sentence)}&type=2`;

      let wordAudioUrl = youdaoWord;
      let slowAudioUrl = youdaoWord;
      let exampleAudioUrl = youdaoExample;

      try {
        wordAudioUrl = (await synthesizeSpeech({ text: row.word, language: params.lang, speed: 'normal', debugContext: 'word' })).audioUrl;
      } catch { /* fallback */ }
      try {
        slowAudioUrl = (await synthesizeSpeech({ text: row.word, language: params.lang, speed: 'slow', debugContext: 'word-slow' })).audioUrl;
      } catch { /* fallback */ }
      try {
        exampleAudioUrl = (
          await synthesizeSpeech({
            text: row.example_sentence,
            language: params.lang,
            speed: 'normal',
            debugContext: 'example',
          })
        ).audioUrl;
      } catch { /* fallback */ }

      results.push(
        formatEnrichedWord({
          id: row.id,
          word: row.word,
          phonetic: row.phonetic,
          partOfSpeech: row.part_of_speech,
          definition: row.definition,
          exampleSentence: row.example_sentence,
          usageTip: row.usage_tip,
          source: row.source === 'corpus' ? 'curated' : 'vault',
          wordAudioUrl,
          slowWordAudioUrl: slowAudioUrl,
          exampleAudioUrl,
          srsIntervalDays: row.srs_interval_days,
          srsEaseFactor: Number(row.srs_ease_factor),
        }),
      );
      continue;
    }

    results.push(
      formatEnrichedWord({
        id: row.id,
        word: row.word,
        phonetic: enrichment?.phonetic_spelling ?? row.phonetic,
        partOfSpeech: row.part_of_speech,
        definition: enrichment?.definition ?? row.definition,
        exampleSentence: enrichment?.example_sentence ?? row.example_sentence,
        usageTip: enrichment?.usage_tip ?? row.usage_tip,
        source: 'vault',
        wordAudioUrl: enrichment?.word_audio_url ?? '',
        slowWordAudioUrl: enrichment?.slow_word_audio_url ?? enrichment?.word_audio_url ?? '',
        exampleAudioUrl: enrichment?.example_audio_url ?? '',
        corpusWordId: corpusWordId ?? undefined,
        srsIntervalDays: row.srs_interval_days,
        srsEaseFactor: Number(row.srs_ease_factor),
      }),
    );
  }

  return results;
}

export async function searchVocabulary(params: {
  query: string;
  limit: number;
  lang: string;
}): Promise<EnrichedVocabularyWord[]> {
  const q = params.query.trim();
  if (!q) return [];

  const { data, error } = await supabaseAdmin.rpc('search_vocabulary_words', {
    search_query: q,
    result_limit: params.limit,
  });

  if (error) {
    const { data: fallback } = await supabaseAdmin
      .from('vocabulary_words')
      .select('id, word, part_of_speech, difficulty_level, frequency_rank')
      .ilike('word', `${q}%`)
      .order('frequency_rank', { ascending: true, nullsFirst: false })
      .limit(params.limit);

    const rows = fallback ?? [];
    const enriched: EnrichedVocabularyWord[] = [];
    for (const row of rows) {
      const { word, enrichment } = await enrichWord(row.id, params.lang);
      enriched.push(
        formatEnrichedWord({
          id: word.id,
          word: word.word,
          phonetic: enrichment.phonetic_spelling,
          partOfSpeech: word.part_of_speech,
          definition: enrichment.definition,
          exampleSentence: enrichment.example_sentence,
          usageTip: enrichment.usage_tip,
          source: 'corpus',
          wordAudioUrl: enrichment.word_audio_url ?? '',
          slowWordAudioUrl: enrichment.slow_word_audio_url ?? enrichment.word_audio_url ?? '',
          exampleAudioUrl: enrichment.example_audio_url ?? '',
          corpusWordId: word.id,
        }),
      );
    }
    return enriched;
  }

  const enriched: EnrichedVocabularyWord[] = [];
  for (const row of data ?? []) {
    const { word, enrichment } = await enrichWord(row.id, params.lang);
    enriched.push(
      formatEnrichedWord({
        id: word.id,
        word: word.word,
        phonetic: enrichment.phonetic_spelling,
        partOfSpeech: word.part_of_speech,
        definition: enrichment.definition,
        exampleSentence: enrichment.example_sentence,
        usageTip: enrichment.usage_tip,
        source: 'corpus',
        wordAudioUrl: enrichment.word_audio_url ?? '',
        slowWordAudioUrl: enrichment.slow_word_audio_url ?? enrichment.word_audio_url ?? '',
        exampleAudioUrl: enrichment.example_audio_url ?? '',
        corpusWordId: word.id,
      }),
    );
  }

  return enriched;
}
