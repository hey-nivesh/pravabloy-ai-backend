"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJourneyMapProgress = getJourneyMapProgress;
exports.checkAndNotifyJourneyAchievements = checkAndNotifyJourneyAchievements;
const requireAuth_1 = require("../middleware/requireAuth");
const NODE_DEFINITIONS = [
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
async function loadProgressCounts(userId) {
    const { data: sessions } = await requireAuth_1.supabaseAdmin
        .from('voice_sessions')
        .select('case_study_id, mode, status, completed_at')
        .eq('user_id', userId)
        .eq('status', 'completed')
        .not('completed_at', 'is', null);
    const completed = sessions ?? [];
    const casualSessions = completed.filter((s) => s.mode === 'casual').length;
    const executiveSessions = completed.filter((s) => s.mode === 'executive').length;
    const interviewSessions = completed.filter((s) => s.mode === 'mock_interview' || s.case_study_id === 'system-design').length;
    const negotiationSessions = completed.filter((s) => s.case_study_id === 'salary-negotiation').length;
    const { count: vocabMastered } = await requireAuth_1.supabaseAdmin
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
function isNodeComplete(id, counts) {
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
function isNodeUnlocked(id, counts, completedBefore) {
    const index = NODE_DEFINITIONS.findIndex((n) => n.id === id);
    if (index <= 0)
        return true;
    return completedBefore[index - 1] ?? false;
}
function progressForNode(id, counts) {
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
async function getJourneyMapProgress(userId) {
    const counts = await loadProgressCounts(userId);
    const { data: userRow } = await requireAuth_1.supabaseAdmin
        .from('users')
        .select('avatar_url')
        .eq('id', userId)
        .maybeSingle();
    const completionFlags = NODE_DEFINITIONS.map((def) => isNodeComplete(def.id, counts));
    const nodes = NODE_DEFINITIONS.map((def, index) => {
        const complete = completionFlags[index];
        const unlocked = isNodeUnlocked(def.id, counts, completionFlags);
        let status = 'locked';
        if (complete) {
            status = 'completed';
        }
        else if (unlocked) {
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
    let currentNodeId = 'grammar_foundations';
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
        }
        else if (!unlocked) {
            nodes[i].status = 'locked';
        }
        else if (!foundCurrent) {
            nodes[i].status = 'current';
            currentNodeId = def.id;
            foundCurrent = true;
        }
        else {
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
async function checkAndNotifyJourneyAchievements(userId) {
    const { nodes } = await getJourneyMapProgress(userId);
    const { notifyJourneyUnlock } = await Promise.resolve().then(() => __importStar(require('./notifications')));
    for (const node of nodes) {
        if (node.status !== 'completed')
            continue;
        await notifyJourneyUnlock(userId, node.id, node.label);
    }
}
