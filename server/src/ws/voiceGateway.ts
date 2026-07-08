import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import url from 'url';
import { SupabaseClient } from '@supabase/supabase-js';

import { createUserSupabase, supabaseAdmin, verifyToken } from '../middleware/requireAuth';
import { createLiveSession, LiveSessionHandle } from '../services/gemini';
import { getSessionRagContext } from '../services/rag';

export function setupVoiceGateway(wss: WebSocket.Server) {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    console.log('[VoiceGateway] New WebSocket connection attempt...');

    const parsedUrl = url.parse(req.url || '', true);
    const token = parsedUrl.query.token as string | undefined;
    const caseStudyId = (parsedUrl.query.caseStudyId as string) || 'ordering-coffee';
    const clientSessionId = parsedUrl.query.sessionId as string | undefined;

    // ── 1. Authenticate ────────────────────────────────────────────────
    if (!token) {
      ws.send(JSON.stringify({ event: 'error', payload: { message: 'Authentication required.', recoverable: false } }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    let user: any;
    try {
      user = await verifyToken(token);
    } catch (err: any) {
      console.warn('[VoiceGateway] Invalid token:', err.message);
      ws.send(JSON.stringify({ event: 'error', payload: { message: 'Authentication failed: ' + err.message, recoverable: false } }));
      ws.close(4002, 'Unauthorized');
      return;
    }

    console.log(`[VoiceGateway] User ${user.id} authenticated. Case study: ${caseStudyId}`);

    const sessionId = clientSessionId ?? `${user.id}-${Date.now()}`;
    const userDb: SupabaseClient = createUserSupabase(token);

    // ── 2. Determine mode & fetch scenario ─────────────────────────────
    let mode: 'casual' | 'formal' | 'executive' | 'mock_interview' = 'casual';
    let scenarioPrompt = '';

    if (caseStudyId === 'salary-negotiation') mode = 'executive';
    else if (caseStudyId === 'system-design') mode = 'mock_interview';

    try {
      const { data: caseStudy } = await supabaseAdmin
        .from('case_studies')
        .select('category, scenario_prompt')
        .eq('id', caseStudyId)
        .single();
      if (caseStudy?.scenario_prompt) {
        scenarioPrompt = String(caseStudy.scenario_prompt);
      }
      if (caseStudy?.category === 'executive') mode = 'executive';
      else if (caseStudy?.category === 'mock_interview' || caseStudy?.category === 'interview') mode = 'mock_interview';
      else if (caseStudy?.category === 'formal') mode = 'formal';
      else if (caseStudy?.category === 'casual') mode = 'casual';
    } catch (_) {
      // Keep deterministic fallback mapping when case_studies is unavailable.
    }

    const { error: upsertErr } = await userDb
      .from('voice_sessions')
      .upsert({
        id: sessionId,
        user_id: user.id,
        case_study_id: caseStudyId,
        mode,
        status: 'in_progress',
        transcript: [],
        live_pacing: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    if (upsertErr) {
      console.error('[VoiceGateway] Failed to initialize voice_sessions row:', upsertErr.message);
    }

    // ── 3. Connect directly to Gemini Live ─────────────────────────────
    let liveSession: LiveSessionHandle | null = null;
    let isFinalizing = false;

    try {
      const { ragContext } = await getSessionRagContext(user.id, caseStudyId);

      liveSession = createLiveSession({
        userId: user.id,
        caseStudyId,
        mode,
        ragContext,
        scenarioPrompt,
        sessionId,
        userDb,
      });
    } catch (err: any) {
      console.error('[VoiceGateway] Failed to create Gemini Live session:', err.message);
      ws.send(JSON.stringify({ event: 'error', payload: { message: 'Failed to start voice session.', recoverable: true } }));
      ws.close(4011, 'Session Init Failed');
      return;
    }

    const finalizeSession = async (notifyClient: boolean): Promise<string | null> => {
      if (isFinalizing) return null;
      isFinalizing = true;

      let reportId: string | null = null;
      if (liveSession) {
        const result = await liveSession.close();
        reportId = result.reportId;
        liveSession = null;
      }

      const { error: updateErr } = await userDb
        .from('voice_sessions')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', sessionId)
        .eq('user_id', user.id)
        .neq('status', 'completed');
      if (updateErr) {
        console.error('[VoiceGateway] Failed to finalize voice session status:', updateErr.message);
      }

      if (notifyClient && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          event: 'session_analyzed',
          payload: { sessionId, reportId },
        }));
      }

      return reportId;
    };

    // ── 4. Wire up Gemini → Client callbacks ──────────────────────────
    liveSession.onMessage((message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'message', data: message }));
      }
    });

    liveSession.onLivePacing((pacing) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'live_pacing', payload: pacing }));
      }
    });

    liveSession.onInterrupted(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'interrupted' }));
      }
    });

    liveSession.onError(async (err: Error) => {
      console.error('[VoiceGateway] Gemini Live error:', err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'error', payload: { message: 'Lost connection to voice model.', recoverable: true } }));
      }
    });

    // ── 5. Handle incoming Client → Gemini data ────────────────────────
    ws.on('message', (message: WebSocket.RawData, isBinary: boolean) => {
      if (!liveSession) return;

      if (isBinary) {
        const buffer = Buffer.isBuffer(message)
          ? message
          : Array.isArray(message)
          ? Buffer.concat(message)
          : Buffer.from(message as ArrayBuffer);
        liveSession.sendAudioChunk(buffer);
      } else {
        try {
          const control = JSON.parse(message.toString());
          if (control.event === 'text' && control.payload?.text) {
            liveSession.sendTextEvent({ text: control.payload.text });
          } else if (control.event === 'end_session') {
            void finalizeSession(true).then(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.close(1000, 'Session ended');
              }
            });
          }
        } catch (_) {}
      }
    });

    // ── 6. Cleanup on disconnect ───────────────────────────────────────
    ws.on('close', async (code: number, reason: Buffer) => {
      console.log(`[VoiceGateway] Connection closed. Code=${code}, User=${user.id}`);
      await finalizeSession(false);
    });

    ws.on('error', (err) => {
      console.warn('[VoiceGateway] WebSocket error:', err.message);
    });

    console.log(`[VoiceGateway] Session live for user ${user.id} on case study "${caseStudyId}"`);
  });
}
