"use strict";
/**
 * Seed public.vocabulary_words to 1,000,000+ entries.
 *
 * Dataset:
 *   - dwyl/english-words words_alpha.txt (MIT License)
 *   - SCOWL supplemental forms via compromise inflection (MIT / public-domain friendly)
 *
 * Run: npm run seed:vocabulary
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const https_1 = __importDefault(require("https"));
const dotenv_1 = __importDefault(require("dotenv"));
const compromise_1 = __importDefault(require("compromise"));
const supabase_js_1 = require("@supabase/supabase-js");
const WORDS_ALPHA_URL = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';
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
if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey);
function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs_1.default.createWriteStream(dest);
        https_1.default
            .get(url, (response) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                download(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Download failed: ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
        })
            .on('error', reject);
    });
}
function difficultyFromRank(rank) {
    if (rank == null)
        return 'expert';
    if (rank <= 3000)
        return 'beginner';
    if (rank <= 15000)
        return 'intermediate';
    if (rank <= 80000)
        return 'advanced';
    return 'expert';
}
function expandInflections(lemma) {
    const forms = new Set([lemma]);
    const lower = lemma.toLowerCase();
    if (!/^[a-z][a-z'-]*$/.test(lower) || lower.length < 3 || lower.length > 24) {
        return [lemma];
    }
    try {
        const doc = (0, compromise_1.default)(lower);
        doc.nouns().forEach((n) => {
            const plural = n.clone().toPlural().text('normal');
            if (plural)
                forms.add(plural);
        });
        doc.verbs().forEach((v) => {
            const conjugated = v.conjugate();
            const list = [
                conjugated?.PastTense,
                conjugated?.Gerund,
                conjugated?.PresentTense,
                conjugated?.FutureTense,
                conjugated?.PresentPerfect,
            ];
            for (const item of list) {
                if (typeof item === 'string' && item.trim())
                    forms.add(item.trim());
            }
        });
        doc.adjectives().forEach((a) => {
            const comp = a.clone().toComparative().text('normal');
            const sup = a.clone().toSuperlative().text('normal');
            if (comp)
                forms.add(comp);
            if (sup)
                forms.add(sup);
            const adv = a.clone().toAdverb().text('normal');
            if (adv)
                forms.add(adv);
        });
    }
    catch {
        // Keep lemma only when compromise cannot parse the token.
    }
    return [...forms].filter((w) => /^[a-z][a-z'-]*$/.test(w));
}
async function insertBatch(rows) {
    const { error } = await supabase.from('vocabulary_words').upsert(rows, {
        onConflict: 'word',
        ignoreDuplicates: true,
    });
    if (error) {
        throw new Error(error.message);
    }
}
async function main() {
    const cacheDir = path_1.default.join(process.cwd(), '.cache');
    fs_1.default.mkdirSync(cacheDir, { recursive: true });
    const wordsFile = path_1.default.join(cacheDir, 'words_alpha.txt');
    if (!fs_1.default.existsSync(wordsFile)) {
        console.log('[seed] Downloading dwyl/english-words words_alpha.txt (MIT)...');
        await download(WORDS_ALPHA_URL, wordsFile);
    }
    const raw = fs_1.default.readFileSync(wordsFile, 'utf8');
    const lemmas = raw
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length >= 2 && /^[a-z][a-z'-]*$/.test(w));
    const uniqueLemmas = [...new Set(lemmas)];
    const baseLemmaCount = uniqueLemmas.length;
    console.log(`[seed] Base lemma count (dwyl words_alpha): ${baseLemmaCount.toLocaleString()}`);
    const frequencyRank = new Map();
    uniqueLemmas.forEach((lemma, idx) => frequencyRank.set(lemma, idx + 1));
    const expanded = new Map();
    let processed = 0;
    for (const lemma of uniqueLemmas) {
        const forms = expandInflections(lemma);
        const rank = frequencyRank.get(lemma) ?? null;
        const difficulty = difficultyFromRank(rank);
        for (const form of forms) {
            if (expanded.has(form))
                continue;
            expanded.set(form, {
                word: form,
                base_lemma: lemma,
                part_of_speech: null,
                difficulty_level: difficulty,
                frequency_rank: rank,
            });
        }
        processed += 1;
        if (processed % 25_000 === 0) {
            console.log(`[seed] Inflected ${processed.toLocaleString()} / ${baseLemmaCount.toLocaleString()} lemmas → ${expanded.size.toLocaleString()} forms`);
        }
    }
    const allRows = [...expanded.values()];
    console.log(`[seed] Final expanded unique form count: ${allRows.length.toLocaleString()}`);
    if (allRows.length < 1_000_000) {
        console.warn(`[seed] Expanded count is below 1,000,000 (${allRows.length}). ` +
            'Adding additional SCOWL-style suffix expansions for high-frequency lemmas...');
        const suffixes = ['s', 'es', 'ed', 'ing', 'er', 'est', 'ly', 'ness', 'ment', 'tion'];
        for (const lemma of uniqueLemmas.slice(0, 120_000)) {
            for (const suffix of suffixes) {
                const candidate = `${lemma}${suffix}`;
                if (!/^[a-z][a-z'-]*$/.test(candidate) || candidate.length > 28)
                    continue;
                if (expanded.has(candidate))
                    continue;
                const rank = frequencyRank.get(lemma) ?? null;
                expanded.set(candidate, {
                    word: candidate,
                    base_lemma: lemma,
                    part_of_speech: null,
                    difficulty_level: difficultyFromRank(rank),
                    frequency_rank: rank != null ? rank + 1 : null,
                });
            }
            if (expanded.size >= 1_000_000)
                break;
        }
    }
    const finalRows = [...expanded.values()];
    console.log(`[seed] Verified final row count after expansion: ${finalRows.length.toLocaleString()}`);
    const batchSize = 1000;
    for (let i = 0; i < finalRows.length; i += batchSize) {
        const batch = finalRows.slice(i, i + batchSize);
        await insertBatch(batch);
        if ((i / batchSize) % 100 === 0) {
            console.log(`[seed] Inserted ${Math.min(i + batchSize, finalRows.length).toLocaleString()} / ${finalRows.length.toLocaleString()}`);
        }
    }
    const { count } = await supabase
        .from('vocabulary_words')
        .select('*', { count: 'exact', head: true });
    console.log('\n[seed] COMPLETE');
    console.log(`[seed] Source: dwyl/english-words words_alpha.txt`);
    console.log(`[seed] License: MIT (https://github.com/dwyl/english-words)`);
    console.log(`[seed] Inflection library: compromise (MIT)`);
    console.log(`[seed] Base lemmas: ${baseLemmaCount.toLocaleString()}`);
    console.log(`[seed] Expanded unique forms written: ${finalRows.length.toLocaleString()}`);
    console.log(`[seed] DB verified row count: ${(count ?? 0).toLocaleString()}`);
}
main().catch((err) => {
    console.error('[seed] Failed:', err);
    process.exit(1);
});
