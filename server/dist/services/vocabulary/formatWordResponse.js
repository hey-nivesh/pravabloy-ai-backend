"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatEnrichedWord = formatEnrichedWord;
function formatEnrichedWord(params) {
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
