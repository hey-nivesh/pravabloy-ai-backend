import type { EnrichedVocabularyWord } from './types';

export function formatEnrichedWord(params: {
  id: string;
  word: string;
  phonetic?: string | null;
  partOfSpeech?: string | null;
  definition: string;
  exampleSentence: string;
  usageTip?: string | null;
  source?: EnrichedVocabularyWord['source'];
  wordAudioUrl: string;
  slowWordAudioUrl: string;
  exampleAudioUrl: string;
  corpusWordId?: string;
  srsIntervalDays?: number;
  srsEaseFactor?: number;
}): EnrichedVocabularyWord {
  return {
    id: params.id,
    word: params.word,
    phonetic: params.phonetic ?? '',
    partOfSpeech: params.partOfSpeech ?? 'noun',
    definition: params.definition,
    exampleSentence: params.exampleSentence,
    usageTip: params.usageTip ?? '',
    source: params.source ?? 'corpus',
    audioUrl: params.wordAudioUrl,
    slowAudioUrl: params.slowWordAudioUrl,
    exampleAudioUrl: params.exampleAudioUrl,
    corpusWordId: params.corpusWordId,
    srsIntervalDays: params.srsIntervalDays,
    srsEaseFactor: params.srsEaseFactor,
  };
}
