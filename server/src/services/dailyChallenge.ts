import { supabaseAdmin } from '../middleware/requireAuth';
import { awardDailyChallengeBonus } from './xp';
import { notifyDailyChallengeComplete } from './notifications';

export type DailyChallengeTaskType = 'voice_session' | 'vocab_review' | 'grammar_check';

export type DailyChallengeTask = {
  id: string;
  type: DailyChallengeTaskType;
  label: string;
  target: number;
  progress: number;
  completed: boolean;
  /** When true, progress tracks voice minutes instead of session count */
  trackMinutes?: boolean;
  /** When true, only "got_it" vocab reviews count toward progress */
  masteryOnly?: boolean;
};

export type DailyChallengeRow = {
  id: string;
  user_id: string;
  challenge_date: string;
  tasks: DailyChallengeTask[];
  xp_reward: number;
  streak_protection: boolean;
  completed: boolean;
};

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultTasks(): DailyChallengeTask[] {
  return [
    {
      id: 'voice-session',
      type: 'voice_session',
      label: 'Complete a voice practice session',
      target: 1,
      progress: 0,
      completed: false,
    },
    {
      id: 'voice-minutes',
      type: 'voice_session',
      label: 'Practice speaking for 5 minutes',
      target: 5,
      progress: 0,
      completed: false,
      trackMinutes: true,
    },
    {
      id: 'vocab-review',
      type: 'vocab_review',
      label: 'Review 3 vocabulary words',
      target: 3,
      progress: 0,
      completed: false,
    },
    {
      id: 'vocab-master',
      type: 'vocab_review',
      label: 'Master 2 words with "Got it"',
      target: 2,
      progress: 0,
      completed: false,
      masteryOnly: true,
    },
    {
      id: 'grammar-check',
      type: 'grammar_check',
      label: 'Complete a fluency check',
      target: 1,
      progress: 0,
      completed: false,
    },
  ];
}

function bumpTask(task: DailyChallengeTask, increment: number): DailyChallengeTask {
  if (task.completed) return task;
  const progress = Math.min(task.target, task.progress + increment);
  return {
    ...task,
    progress,
    completed: progress >= task.target,
  };
}

function allTasksComplete(tasks: DailyChallengeTask[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.completed);
}

export async function getOrCreateTodayChallenge(userId: string): Promise<DailyChallengeRow> {
  const challengeDate = todayUtcDate();

  const { data: existing } = await supabaseAdmin
    .from('daily_challenges')
    .select('*')
    .eq('user_id', userId)
    .eq('challenge_date', challengeDate)
    .maybeSingle();

  if (existing) {
    return {
      ...existing,
      tasks: (existing.tasks as DailyChallengeTask[]) ?? defaultTasks(),
    } as DailyChallengeRow;
  }

  const tasks = defaultTasks();
  const { data: created, error } = await supabaseAdmin
    .from('daily_challenges')
    .insert({
      user_id: userId,
      challenge_date: challengeDate,
      tasks,
      xp_reward: 50,
      streak_protection: false,
      completed: false,
    })
    .select('*')
    .single();

  if (error || !created) {
    throw new Error(error?.message ?? 'Failed to create daily challenge.');
  }

  return { ...created, tasks } as DailyChallengeRow;
}

async function persistChallenge(
  challenge: DailyChallengeRow,
  tasks: DailyChallengeTask[],
  completed: boolean,
  streakProtection: boolean,
): Promise<DailyChallengeRow> {
  const { data, error } = await supabaseAdmin
    .from('daily_challenges')
    .update({
      tasks,
      completed,
      streak_protection: streakProtection,
      updated_at: new Date().toISOString(),
    })
    .eq('id', challenge.id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to update daily challenge.');
  }

  return { ...data, tasks } as DailyChallengeRow;
}

export type ChallengeUpdateResult = {
  challenge: DailyChallengeRow;
  justCompleted: boolean;
  xpAwarded: number;
};

export async function updateChallengeOnVoiceSession(
  userId: string,
  durationMinutes: number,
  hasAnalysis: boolean,
): Promise<ChallengeUpdateResult | null> {
  const challenge = await getOrCreateTodayChallenge(userId);
  if (challenge.completed) {
    return { challenge, justCompleted: false, xpAwarded: 0 };
  }

  let tasks = [...challenge.tasks];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task.type !== 'voice_session' || task.completed) continue;

    if (task.trackMinutes) {
      tasks[i] = bumpTask(task, Math.max(1, Math.ceil(durationMinutes)));
    } else {
      tasks[i] = bumpTask(task, 1);
    }
  }

  if (hasAnalysis) {
    tasks = tasks.map((task) =>
      task.type === 'grammar_check' && !task.completed ? bumpTask(task, 1) : task,
    );
  }

  const completed = allTasksComplete(tasks);
  let xpAwarded = 0;
  let streakProtection = challenge.streak_protection;

  if (completed && !challenge.completed) {
    const xpResult = await awardDailyChallengeBonus(userId);
    xpAwarded = xpResult?.xpAwarded ?? 0;
    streakProtection = true;
    void notifyDailyChallengeComplete(userId).catch(() => {});
  }

  const updated = await persistChallenge(challenge, tasks, completed, streakProtection);
  return {
    challenge: updated,
    justCompleted: completed && !challenge.completed,
    xpAwarded,
  };
}

export async function updateChallengeOnVocabReview(
  userId: string,
  mastered: boolean,
): Promise<ChallengeUpdateResult | null> {
  const challenge = await getOrCreateTodayChallenge(userId);
  if (challenge.completed) {
    return { challenge, justCompleted: false, xpAwarded: 0 };
  }

  let tasks = challenge.tasks.map((task) => {
    if (task.type !== 'vocab_review' || task.completed) return task;
    if (task.masteryOnly && !mastered) return task;
    return bumpTask(task, 1);
  });

  const completed = allTasksComplete(tasks);
  let xpAwarded = 0;
  let streakProtection = challenge.streak_protection;

  if (completed && !challenge.completed) {
    const xpResult = await awardDailyChallengeBonus(userId);
    xpAwarded = xpResult?.xpAwarded ?? 0;
    streakProtection = true;
    void notifyDailyChallengeComplete(userId).catch(() => {});
  }

  const updated = await persistChallenge(challenge, tasks, completed, streakProtection);
  return {
    challenge: updated,
    justCompleted: completed && !challenge.completed,
    xpAwarded,
  };
}
