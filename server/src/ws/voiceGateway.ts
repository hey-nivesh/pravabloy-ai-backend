import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import url from 'url';

import { verifyToken, supabase } from '../middleware/requireAuth';
import { verifyUserEntitlement } from '../middleware/checkEntitlement';
import { createLiveSession, LiveSessionHandle } from '../services/gemini';
import { getSessionRagContext } from '../services/rag';

export function setupVoiceGateway(wss: WebSocket.Server) {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    console.log('[VoiceGateway] New WebSocket connection attempt...');

    const parsedUrl = url.parse(req.url || '', true);
    const token = parsedUrl.query.token as string | undefined;
    const caseStudyId = parsedUrl.query.caseStudyId as string | undefined;

    // 1. Authenticate WebSocket upgrade
    if (!token) {
      console.warn('[VoiceGateway] Connection rejected: token query parameter missing.');
      ws.send(JSON.stringify({ event: 'error', payload: { message: 'Authentication required. No token provided.', recoverable: false } }));
      ws.close(4001, 'Unauthorized');
      return;
    }

    let user: any;
    try {
      user = await verifyToken(token);
    } catch (err: any) {
      console.warn('[VoiceGateway] Connection rejected: invalid token.', err.message);
      ws.send(JSON.stringify({ event: 'error', payload: { message: 'Authentication failed: ' + err.message, recoverable: false } }));
      ws.close(4002, 'Unauthorized');
      return;
    }

    // 2. Verify Entitlement
    const hasMinutes = await verifyUserEntitlement(user.id);
    if (!hasMinutes) {
      console.warn(`[VoiceGateway] Connection rejected: user ${user.id} out of daily practice minutes.`);
      ws.send(JSON.stringify({
        event: 'error',
        payload: {
          message: 'Daily voice practice limit reached. Upgrade to Pro for unlimited access.',
          recoverable: false
        }
      }));
      ws.close(4003, 'Entitlement Limit Reached');
      return;
    }

    const activeCaseStudyId = caseStudyId || 'ordering-coffee';
    let voiceSessionId = '';
    let liveSession: LiveSessionHandle | null = null;
    const startTime = Date.now();

    // Determine target mode and fetch scenario prompt from database (case_studies table)
    let mode: 'casual' | 'formal' | 'executive' | 'mock_interview' = 'casual';
    let scenarioPrompt = '';

    try {
      const { data: caseStudyRow } = await supabase
        .from('case_studies')
        .select('category, scenario_prompt')
        .eq('id', activeCaseStudyId)
        .single();

      if (caseStudyRow) {
        const category = caseStudyRow.category || 'casual';
        scenarioPrompt = caseStudyRow.scenario_prompt || '';

        if (category === 'executive' || category === 'negotiation' || activeCaseStudyId === 'salary-negotiation') {
          mode = 'executive';
        } else if (category === 'interview' || category === 'mock_interview' || activeCaseStudyId === 'system-design') {
          mode = 'mock_interview';
        } else if (category === 'formal' || category === 'business') {
          mode = 'formal';
        } else {
          mode = 'casual';
        }
      }
    } catch (err: any) {
      console.warn('[VoiceGateway] Failed to fetch case study details, falling back:', err.message);
      if (activeCaseStudyId === 'salary-negotiation') mode = 'executive';
      if (activeCaseStudyId === 'system-design') mode = 'mock_interview';
    }

    // 3. Create Voice Session tracking row in Supabase
    try {
      const { data: sessionRow, error: sessError } = await supabase
        .from('voice_sessions')
        .insert({
          user_id: user.id,
          case_study_id: activeCaseStudyId,
          status: 'connected',
          started_at: new Date().toISOString(),
          transcript: []
        })
        .select('id')
        .single();

      if (sessError || !sessionRow) {
        throw new Error(sessError?.message || 'Failed to initialize session tracking.');
      }
      voiceSessionId = sessionRow.id;
    } catch (dbErr: any) {
      console.error('[VoiceGateway] Failed to insert voice_session row:', dbErr.message);
      ws.send(JSON.stringify({ event: 'error', payload: { message: 'Failed to initialize voice session.', recoverable: false } }));
      ws.close(5000, 'Database Error');
      return;
    }

    // Reconnection state tracker
    let reconnectAttempts = 0;

    const startGeminiSession = async () => {
      // 4. Fetch RAG Context
      const { ragContext } = await getSessionRagContext(user.id, activeCaseStudyId);

      // 5. Connect to Gemini Live bidirectional stream
      liveSession = createLiveSession({
        userId: user.id,
        caseStudyId: activeCaseStudyId,
        mode,
        ragContext,
        scenarioPrompt,
        sessionId: voiceSessionId
      });

      // 6. Connect session event callbacks
      liveSession.onAudioOutput((chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Client expects JSON { event: 'audio', payload: { base64 } } — NOT raw binary
          ws.send(JSON.stringify({
            event: 'audio',
            payload: { base64: chunk.toString('base64') },
          }));
        }
      });

      liveSession.onTranscriptDelta((text: string, role: 'user' | 'agent') => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'transcript',
            payload: { text, sender: role === 'agent' ? 'ai' : 'user', isFinal: false }
          }));
        }
      });

      liveSession.onLivePacing((pacing) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'live_pacing',
            payload: pacing
          }));
        }
      });

      liveSession.onInterrupted(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'interrupted' }));
        }
      });

      liveSession.onError(async (err: Error) => {
        console.error(`[VoiceGateway] Gemini Live session error on session ${voiceSessionId}:`, err.message);

        // Attempt exactly one automatic reconnection
        if (reconnectAttempts < 1) {
          reconnectAttempts++;
          console.log(`[VoiceGateway] Attempting to reconnect Gemini Live session for ID ${voiceSessionId}...`);
          try {
            if (liveSession) {
              await liveSession.close();
            }
            await startGeminiSession();
            return;
          } catch (reconnectErr) {
            console.error('[VoiceGateway] Reconnection attempt failed:', reconnectErr);
          }
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'error',
            payload: { message: 'Lost connection to audio cognitive services. Closing session.', recoverable: false }
          }));
        }
        ws.close(4004, 'Cognitive Services Exception');
      });
    };

    // Initialize the Gemini audio loop
    await startGeminiSession();

    // 7. Handle incoming binary or text data from Mobile Client WebSocket
    ws.on('message', (message: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        // Binary PCM frame (16kHz 16bit Mono) → stream directly to Gemini Live
        if (liveSession) {
          const buffer = Buffer.isBuffer(message)
            ? message
            : Array.isArray(message)
            ? Buffer.concat(message)
            : Buffer.from(message as ArrayBuffer);
          liveSession.sendAudioChunk(buffer);
        }
      } else {
        // Client JSON control commands
        try {
          const control = JSON.parse(message.toString());
          if (control.event === 'text' && control.payload?.text) {
            if (liveSession) {
              liveSession.sendTextEvent({ text: control.payload.text });
            }
          } else if (control.event === 'interrupted') {
            // Forward client-side recording barge-in if desired
          }
        } catch (jsonErr) {
          console.warn('[VoiceGateway] Malformed JSON control message:', jsonErr);
        }
      }
    });

    // 8. Graceful closure cleanup
    ws.on('close', async (code: number, reason: string) => {
      const durationSeconds = Math.ceil((Date.now() - startTime) / 1000);
      const durationMinutes = Math.ceil(durationSeconds / 60);

      console.log(`[VoiceGateway] User disconnected from session ${voiceSessionId}. Code: ${code}, Reason: ${reason}. Duration: ${durationSeconds}s`);

      // Close Gemini Live session & trigger analytics reporting job
      if (liveSession) {
        await liveSession.close();
      }

      // Update voice session record row in Supabase
      try {
        await supabase
          .from('voice_sessions')
          .update({
            ended_at: new Date().toISOString(),
            duration_seconds: durationSeconds,
            status: 'completed'
          })
          .eq('id', voiceSessionId);

        // Update daily voice minutes used for free tier calculations
        const { data: userProfile } = await supabase
          .from('users')
          .select('daily_voice_minutes_used')
          .eq('id', user.id)
          .single();

        const currentMinutes = userProfile?.daily_voice_minutes_used ?? 0;
        await supabase
          .from('users')
          .update({ daily_voice_minutes_used: currentMinutes + durationMinutes })
          .eq('id', user.id);

      } catch (err: any) {
        console.error('[VoiceGateway] Failed to finalize session cleanup in DB:', err.message);
      }
    });
  });
}
