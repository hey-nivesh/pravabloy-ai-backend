"use strict";
/**
 * Off-peak enrichment pre-warm for top-frequency corpus words.
 * Run: npm run prewarm:vocabulary
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const dotenv_1 = __importDefault(require("dotenv"));
const supabase_js_1 = require("@supabase/supabase-js");
const enrichWord_1 = require("../src/services/vocabulary/enrichWord");
const envPaths = [
    path_1.default.join(process.cwd(), '.env'),
    path_1.default.join(process.cwd(), '../.env'),
    path_1.default.join(process.cwd(), '../../pravabloyai/.env'),
];
for (const envPath of envPaths) {
    if (fs_1.default.existsSync(envPath)) {
        dotenv_1.default.config({ path: envPath });
        break;
    }
}
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey);
async function main() {
    const limit = Math.min(parseInt(process.env.PREWARM_LIMIT || '5000', 10), 10_000);
    const lang = process.env.PREWARM_LANG || 'en';
    const { data: candidates, error } = await supabase
        .from('vocabulary_words')
        .select('id, word, frequency_rank')
        .eq('is_enriched', false)
        .order('frequency_rank', { ascending: true, nullsFirst: false })
        .limit(limit);
    if (error)
        throw new Error(error.message);
    let enriched = 0;
    for (const row of candidates ?? []) {
        try {
            await (0, enrichWord_1.enrichWord)(row.id, lang);
            enriched += 1;
            if (enriched % 25 === 0) {
                console.log(`[prewarm] enriched ${enriched}/${candidates?.length ?? 0}`);
            }
        }
        catch (err) {
            console.warn(`[prewarm] skipped ${row.word}:`, err.message);
        }
    }
    console.log(`[prewarm] complete: ${enriched}/${candidates?.length ?? 0}`);
}
main().catch((err) => {
    console.error('[prewarm] failed:', err);
    process.exit(1);
});
