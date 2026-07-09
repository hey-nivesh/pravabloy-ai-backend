"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverCorpusWords = discoverCorpusWords;
exports.enrichDueVaultWords = enrichDueVaultWords;
exports.searchVocabulary = searchVocabulary;
const requireAuth_1 = require("../../middleware/requireAuth");
const enrichWord_1 = require("./enrichWord");
const formatWordResponse_1 = require("./formatWordResponse");
async function discoverCorpusWords(params) {
    const { userId, limit, lang } = params;
    const { data: userWords } = await requireAuth_1.supabaseAdmin
        .from('vocab_vault')
        .select('word, corpus_word_id')
        .eq('user_id', userId);
    const seenWords = new Set((userWords ?? []).map((row) => row.word.toLowerCase()));
    const seenCorpusIds = new Set((userWords ?? []).map((row) => row.corpus_word_id).filter(Boolean));
    const { data: candidates, error } = await requireAuth_1.supabaseAdmin
        .from('vocabulary_words')
        .select('id, word, part_of_speech, difficulty_level, frequency_rank, is_enriched')
        .order('frequency_rank', { ascending: true, nullsFirst: false })
        .limit(Math.max(limit * 40, 200));
    if (error) {
        throw new Error(error.message);
    }
    const picked = (candidates ?? []).filter((row) => !seenWords.has(row.word.toLowerCase()) && !seenCorpusIds.has(row.id));
    const selected = picked.slice(0, limit);
    const enriched = [];
    for (const row of selected) {
        const { word, enrichment } = await (0, enrichWord_1.enrichWord)(row.id, lang);
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
        const { data: inserted } = await requireAuth_1.supabaseAdmin
            .from('vocab_vault')
            .insert(vaultInsert)
            .select('*')
            .single();
        enriched.push((0, formatWordResponse_1.formatEnrichedWord)({
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
        }));
    }
    return enriched;
}
async function enrichDueVaultWords(params) {
    const results = [];
    for (const row of params.rows) {
        let enrichment = null;
        let corpusWordId = row.corpus_word_id;
        if (!corpusWordId) {
            const { data: corpusMatch } = await requireAuth_1.supabaseAdmin
                .from('vocabulary_words')
                .select('id')
                .ilike('word', row.word)
                .limit(1)
                .maybeSingle();
            corpusWordId = corpusMatch?.id ?? null;
        }
        if (corpusWordId) {
            const enriched = await (0, enrichWord_1.enrichWord)(corpusWordId, params.lang);
            enrichment = enriched.enrichment;
        }
        else {
            const { synthesizeSpeech } = await Promise.resolve().then(() => __importStar(require('../gemini')));
            const youdaoWord = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(row.word)}&type=2`;
            const youdaoExample = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(row.example_sentence)}&type=2`;
            let wordAudioUrl = youdaoWord;
            let slowAudioUrl = youdaoWord;
            let exampleAudioUrl = youdaoExample;
            try {
                wordAudioUrl = (await synthesizeSpeech({ text: row.word, language: params.lang, speed: 'normal', debugContext: 'word' })).audioUrl;
            }
            catch { /* fallback */ }
            try {
                slowAudioUrl = (await synthesizeSpeech({ text: row.word, language: params.lang, speed: 'slow', debugContext: 'word-slow' })).audioUrl;
            }
            catch { /* fallback */ }
            try {
                exampleAudioUrl = (await synthesizeSpeech({
                    text: row.example_sentence,
                    language: params.lang,
                    speed: 'normal',
                    debugContext: 'example',
                })).audioUrl;
            }
            catch { /* fallback */ }
            results.push((0, formatWordResponse_1.formatEnrichedWord)({
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
            }));
            continue;
        }
        results.push((0, formatWordResponse_1.formatEnrichedWord)({
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
        }));
    }
    return results;
}
async function searchVocabulary(params) {
    const q = params.query.trim();
    if (!q)
        return [];
    const { data, error } = await requireAuth_1.supabaseAdmin.rpc('search_vocabulary_words', {
        search_query: q,
        result_limit: params.limit,
    });
    if (error) {
        const { data: fallback } = await requireAuth_1.supabaseAdmin
            .from('vocabulary_words')
            .select('id, word, part_of_speech, difficulty_level, frequency_rank')
            .ilike('word', `${q}%`)
            .order('frequency_rank', { ascending: true, nullsFirst: false })
            .limit(params.limit);
        const rows = fallback ?? [];
        const enriched = [];
        for (const row of rows) {
            const { word, enrichment } = await (0, enrichWord_1.enrichWord)(row.id, params.lang);
            enriched.push((0, formatWordResponse_1.formatEnrichedWord)({
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
            }));
        }
        return enriched;
    }
    const enriched = [];
    for (const row of data ?? []) {
        const { word, enrichment } = await (0, enrichWord_1.enrichWord)(row.id, params.lang);
        enriched.push((0, formatWordResponse_1.formatEnrichedWord)({
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
        }));
    }
    return enriched;
}
