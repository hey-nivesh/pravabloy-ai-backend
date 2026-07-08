import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Dynamically search parent folders for the .env configuration
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
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[requireAuth] Supabase configuration environment variables are missing.');
}

// Default client: service role when available (bypasses RLS for server jobs).
const dbKey = supabaseServiceKey || supabaseAnonKey;
export const supabase = createClient(supabaseUrl, dbKey);

/** Admin client — always uses service role key. Falls back to default client. */
export const supabaseAdmin = supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : supabase;

if (!supabaseServiceKey) {
  console.warn(
    '[requireAuth] SUPABASE_SERVICE_ROLE_KEY is not set. Server DB writes may fail under RLS. ' +
      'Voice gateway will use per-user JWT clients as a fallback.',
  );
}

/** Supabase client scoped to a user's JWT — satisfies RLS without service role. */
export function createUserSupabase(accessToken: string) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export interface AuthenticatedRequest extends Request {
  user?: any;
}

/**
 * requireAuth middleware for Express HTTP endpoints.
 * Extracts the JWT token from authorization header or query parameters
 * and authenticates against Supabase.
 */
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token = req.query.token as string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Authentication exception' });
  }
}

/**
 * Helper to verify Supabase tokens outside Express route middleware
 * (e.g. during WebSocket handshake upgrades).
 */
export async function verifyToken(token: string) {
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    throw new Error(error?.message || 'Invalid token');
  }
  return user;
}
