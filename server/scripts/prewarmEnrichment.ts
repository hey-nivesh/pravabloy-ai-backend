/**
 * Off-peak enrichment pre-warm for top-frequency corpus words.
 * Run: npm run prewarm:vocabulary
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { enrichWord } from '../src/services/vocabulary/enrichWord';

const envPaths = [
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '../.env'),
  path.join(process.cwd(), '../../pravabloyai/.env'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const limit = Math.min(parseInt(process.env.PREWARM_LIMIT || '5000', 10), 10_000);
  const lang = process.env.PREWARM_LANG || 'en';

  const { data: candidates, error } = await supabase
    .from('vocabulary_words')
    .select('id, word, frequency_rank')
    .eq('is_enriched', false)
    .order('frequency_rank', { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  let enriched = 0;
  for (const row of candidates ?? []) {
    try {
      await enrichWord(row.id, lang);
      enriched += 1;
      if (enriched % 25 === 0) {
        console.log(`[prewarm] enriched ${enriched}/${candidates?.length ?? 0}`);
      }
    } catch (err: any) {
      console.warn(`[prewarm] skipped ${row.word}:`, err.message);
    }
  }

  console.log(`[prewarm] complete: ${enriched}/${candidates?.length ?? 0}`);
}

main().catch((err) => {
  console.error('[prewarm] failed:', err);
  process.exit(1);
});
