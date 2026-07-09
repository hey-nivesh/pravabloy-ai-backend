export type DifficultyLevel = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export type VocabularyWordRow = {
  id: string;
  word: string;
  base_lemma: string | null;
  part_of_speech: string | null;
  difficulty_level: DifficultyLevel | null;
  frequency_rank: number | null;
  is_enriched: boolean;
  created_at: string;
};

export type VocabularyEnrichmentRow = {
  word_id: string;
  definition: string;
  phonetic_spelling: string | null;
  example_sentence: string;
  usage_tip: string | null;
  word_audio_url: string | null;
  example_audio_url: string | null;
  slow_word_audio_url: string | null;
  generated_language: string;
  generated_at: string;
};

export type EnrichedVocabularyWord = {
  id: string;
  word: string;
  phonetic: string;
  partOfSpeech: string;
  definition: string;
  exampleSentence: string;
  usageTip: string;
  source: 'curated' | 'vault' | 'corpus';
  audioUrl: string;
  slowAudioUrl: string;
  exampleAudioUrl: string;
  corpusWordId?: string;
  srsIntervalDays?: number;
  srsEaseFactor?: number;
};
