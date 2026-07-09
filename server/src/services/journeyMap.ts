import { supabaseAdmin } from '../middleware/requireAuth';

export type JourneyNodeId =
  | 'grammar_foundations'
  | 'vocabulary_grove'
  | 'casual_cove'
  | 'executive_boardroom'
  | 'negotiation_arena'
  | 'mock_interview_summit';

export type JourneyNodeStatus = 'locked' | 'current' | 'completed';

export type JourneyNode = {
  id: JourneyNodeId;
  number: number;
  label: string;
  shortLabel: string;
  categoryRoute: string | null;
  status: JourneyNodeStatus;
  unlockHint: string;
  /** Sessions completed in this node's category (for progress display) */
  progressCount: number;
  progressTarget: number;
};

const NODE_DEFINITIONS: Array<{
  id: JourneyNodeId;
  number: number;
  label: string;
  shortLabel: string;
  categoryRoute: string | null;
  progressTarget: number;
  unlockHint: string;
}> = [
  {
    id: 'grammar_foundations',
    number: 1,
    label: 'Grammar Foundations',
    shortLabel: 'Grammar',
    categoryRoute: '/progress',
    progressTarget: 1,
    unlockHint: 'Always available — complete your first practice session.',
  },
  {
    id: 'vocabulary_grove',
    number: 2,
    label: 'Vocabulary Grove',
    shortLabel: 'Vocab',
    categoryRoute: '/vocab',
    progressTarget: 10,
    unlockHint: 'Complete Grammar Foundations to unlock.',
  },
  {
    id: 'casual_cove',
    number: 3,
    label: 'Casual Conversation Cove',
    shortLabel: 'Casual',
    categoryRoute: '/practice?category=casual',
    progressTarget: 2,
    unlockHint: 'Master 10 words in Vocabulary Grove to unlock.',
  },
  {
    id: 'executive_boardroom',
    number: 4,
    label: 'Executive Boardroom',
    shortLabel: 'Executive',
    categoryRoute: '/practice?category=executive',
    progressTarget: 2,
    unlockHint: 'Complete Casual Conversation Cove to unlock.',
  },
  {
    id: 'negotiation_arena',
    number: 5,
    label: 'Negotiation Arena',
    shortLabel: 'Negotiate',
    categoryRoute: '/practice?category=executive',
    progressTarget: 1,
    unlockHint: 'Complete Executive Boardroom to unlock.',
  },
  {
    id: 'mock_interview_summit',
    number: 6,
    label: 'Mock Interview Summit',
    shortLabel: 'Interview',
    categoryRoute: '/practice?category=interview',
    progressTarget: 2,
    unlockHint: 'Complete Negotiation Arena to unlock.',
  },
];

type ProgressCounts = {
  totalSessions: number;
  casualSessions: number;
  executiveSessions: number;
  interviewSessions: number;
  negotiationSessions: number;
  vocabMastered: number;
};

async function loadProgressCounts(userId: string): Promise<ProgressCounts> {
  const { data: sessions } = await supabaseAdmin
    .from('voice_sessions')
    .select('case_study_id, mode, status, completed_at')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .not('completed_at', 'is', null);

  const completed = sessions ?? [];
  const casualSessions = completed.filter((s) => s.mode === 'casual').length;
  const executiveSessions = completed.filter((s) => s.mode === 'executive').length;
  const interviewSessions = completed.filter(
    (s) => s.mode === 'mock_interview' || s.case_study_id === 'system-design',
  ).length;
  const negotiationSessions = completed.filter(
    (s) => s.case_study_id === 'salary-negotiation',
  ).length;

  const { count: vocabMastered } = await supabaseAdmin
    .from('vocab_vault')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('srs_interval_days', 7);

  return {
    totalSessions: completed.length,
    casualSessions,
    executiveSessions,
    interviewSessions,
    negotiationSessions,
    vocabMastered: vocabMastered ?? 0,
  };
}

function isNodeComplete(id: JourneyNodeId, counts: ProgressCounts): boolean {
  switch (id) {
    case 'grammar_foundations':
      return counts.totalSessions >= 1;
    case 'vocabulary_grove':
      return counts.vocabMastered >= 10;
    case 'casual_cove':
      return counts.casualSessions >= 2;
    case 'executive_boardroom':
      return counts.executiveSessions >= 2;
    case 'negotiation_arena':
      return counts.negotiationSessions >= 1;
    case 'mock_interview_summit':
      return counts.interviewSessions >= 2;
    default:
      return false;
  }
}

function isNodeUnlocked(id: JourneyNodeId, counts: ProgressCounts, completedBefore: boolean[]): boolean {
  const index = NODE_DEFINITIONS.findIndex((n) => n.id === id);
  if (index <= 0) return true;
  return completedBefore[index - 1] ?? false;
}

function progressForNode(id: JourneyNodeId, counts: ProgressCounts): number {
  switch (id) {
    case 'grammar_foundations':
      return Math.min(counts.totalSessions, 1);
    case 'vocabulary_grove':
      return Math.min(counts.vocabMastered, 10);
    case 'casual_cove':
      return Math.min(counts.casualSessions, 2);
    case 'executive_boardroom':
      return Math.min(counts.executiveSessions, 2);
    case 'negotiation_arena':
      return Math.min(counts.negotiationSessions, 1);
    case 'mock_interview_summit':
      return Math.min(counts.interviewSessions, 2);
    default:
      return 0;
  }
}

export async function getJourneyMapProgress(userId: string): Promise<{
  nodes: JourneyNode[];
  currentNodeId: JourneyNodeId;
  avatarUrl: string | null;
}> {
  const counts = await loadProgressCounts(userId);

  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('avatar_url')
    .eq('id', userId)
    .maybeSingle();

  const completionFlags = NODE_DEFINITIONS.map((def) => isNodeComplete(def.id, counts));

  const nodes: JourneyNode[] = NODE_DEFINITIONS.map((def, index) => {
    const complete = completionFlags[index];
    const unlocked = isNodeUnlocked(def.id, counts, completionFlags);

    let status: JourneyNodeStatus = 'locked';
    if (complete) {
      status = 'completed';
    } else if (unlocked) {
      status = 'current';
    }

    return {
      id: def.id,
      number: def.number,
      label: def.label,
      shortLabel: def.shortLabel,
      categoryRoute: def.categoryRoute,
      status,
      unlockHint: def.unlockHint,
      progressCount: progressForNode(def.id, counts),
      progressTarget: def.progressTarget,
    };
  });

  // Only the furthest unlocked-but-incomplete node is "current"; earlier incomplete stay completed or locked
  let currentNodeId: JourneyNodeId = 'grammar_foundations';
  for (const node of nodes) {
    if (node.status === 'current') {
      currentNodeId = node.id;
      break;
    }
    if (node.status === 'completed') {
      currentNodeId = node.id;
    }
  }

  // Refine: mark only the first non-completed unlocked node as current, others as locked if not complete
  let foundCurrent = false;
  for (let i = 0; i < nodes.length; i++) {
    const def = NODE_DEFINITIONS[i];
    const complete = completionFlags[i];
    const unlocked = isNodeUnlocked(def.id, counts, completionFlags);

    if (complete) {
      nodes[i].status = 'completed';
    } else if (!unlocked) {
      nodes[i].status = 'locked';
    } else if (!foundCurrent) {
      nodes[i].status = 'current';
      currentNodeId = def.id;
      foundCurrent = true;
    } else {
      nodes[i].status = 'locked';
    }
  }

  return {
    nodes,
    currentNodeId,
    avatarUrl: userRow?.avatar_url ?? null,
  };
}

/** Notify user when journey nodes are newly completed (deduped via metadata). */
export async function checkAndNotifyJourneyAchievements(userId: string): Promise<void> {
  const { nodes } = await getJourneyMapProgress(userId);
  const { notifyJourneyUnlock } = await import('./notifications');

  for (const node of nodes) {
    if (node.status !== 'completed') continue;
    await notifyJourneyUnlock(userId, node.id, node.label);
  }
}
