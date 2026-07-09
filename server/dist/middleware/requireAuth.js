"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabaseAdmin = exports.supabase = void 0;
exports.createUserSupabase = createUserSupabase;
exports.requireAuth = requireAuth;
exports.verifyToken = verifyToken;
const supabase_js_1 = require("@supabase/supabase-js");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const dotenv_1 = __importDefault(require("dotenv"));
// Dynamically search parent folders for the .env configuration
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
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('[requireAuth] Supabase configuration environment variables are missing.');
}
// Default client: service role when available (bypasses RLS for server jobs).
const dbKey = supabaseServiceKey || supabaseAnonKey;
exports.supabase = (0, supabase_js_1.createClient)(supabaseUrl, dbKey);
/** Admin client — always uses service role key. Falls back to default client. */
exports.supabaseAdmin = supabaseServiceKey
    ? (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey)
    : exports.supabase;
if (!supabaseServiceKey) {
    console.warn('[requireAuth] SUPABASE_SERVICE_ROLE_KEY is not set. Server DB writes may fail under RLS. ' +
        'Voice gateway will use per-user JWT clients as a fallback.');
}
/** Supabase client scoped to a user's JWT — satisfies RLS without service role. */
function createUserSupabase(accessToken) {
    return (0, supabase_js_1.createClient)(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
}
/**
 * requireAuth middleware for Express HTTP endpoints.
 * Extracts the JWT token from authorization header or query parameters
 * and authenticates against Supabase.
 */
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    let token = req.query.token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    }
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    try {
        const { data: { user }, error } = await exports.supabase.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
        req.user = user;
        next();
    }
    catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Authentication exception' });
    }
}
/**
 * Helper to verify Supabase tokens outside Express route middleware
 * (e.g. during WebSocket handshake upgrades).
 */
async function verifyToken(token) {
    const { data: { user }, error } = await exports.supabase.auth.getUser(token);
    if (error || !user) {
        throw new Error(error?.message || 'Invalid token');
    }
    return user;
}
