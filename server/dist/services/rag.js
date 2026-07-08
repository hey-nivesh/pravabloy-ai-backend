"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSessionRagContext = getSessionRagContext;
const requireAuth_1 = require("../middleware/requireAuth");
/**
 * RAG Service to fetch user-specific weak vocabulary, key target phrases,
 * and contextual vocab definitions for the voice session.
 */
async function getSessionRagContext(userId, caseStudyId) {
    try {
        // 1. Fetch user's weakest vocab items or due reviews from vocab_vault
        const { data: userVocab, error: vocabError } = await requireAuth_1.supabase
            .from('vocab_vault')
            .select('word, definition')
            .eq('user_id', userId)
            .order('srs_interval_days', { ascending: true })
            .limit(3);
        // 2. Default standard suggestion words based on the case study ID
        let suggestedVocabulary = ['active listening', 'clarifying question', 'professional delivery'];
        if (caseStudyId === 'salary-negotiation') {
            suggestedVocabulary = ['market benchmark', 'increased scope of impact', 'achievements aligned with goals', 'competitive compensation'];
        }
        else if (caseStudyId === 'ordering-coffee') {
            suggestedVocabulary = ['double shot espresso', 'oat milk flat white', 'extra hot', 'keep the change'];
        }
        else if (caseStudyId === 'system-design') {
            suggestedVocabulary = ['horizontal scaling', 'cache eviction policy', 'single point of failure', 'read replica database'];
        }
        else if (caseStudyId === 'hotel-checkin') {
            suggestedVocabulary = ['room upgrade options', 'booking confirmation', 'complimentary breakfast', 'local attractions'];
        }
        const weakPhrasesList = userVocab && userVocab.length > 0
            ? userVocab.map(v => `"${v.word}" (defined as: ${v.definition})`).join(', ')
            : 'None (defaulting to case study vocabulary)';
        const ragContext = `
TARGET VOCABULARY SUGGESTIONS:
${suggestedVocabulary.join(', ')}

USER'S WEAK VOCABULARY PHRASES FROM THEIR VAULT TO REINFORCE:
${weakPhrasesList}
    `.trim();
        return {
            ragContext,
            suggestedVocabulary,
        };
    }
    catch (err) {
        console.warn('[RAG Service] Retrieval failed, returning default fallback context:', err);
        return {
            ragContext: 'Default conversational English coaching session.',
            suggestedVocabulary: ['professional delivery', 'conversation flows', 'clear speaking'],
        };
    }
}
