"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserProgressSummary = getUserProgressSummary;
exports.getLatestAnalyticsReport = getLatestAnalyticsReport;
const requireAuth_1 = require("../middleware/requireAuth");
const FALLBACK_SUMMARY = {
    points: [],
    latest: { fluency: 0, confidence: 0, wpm: 0, fillerCount: 0, lexiconTier: 'Smart Starter' },
    deltas: { fluency: 0, confidence: 0, wpm: 0, fillerCount: 0 },
    strengths: ['Start one full voice practice session to unlock personalized trends.'],
    improvementAreas: ['Complete 2+ sessions for data-driven coaching guidance.'],
    coachParagraph: 'Your progress dashboard will become fully personalized after your first completed practice session.',
};
function toNum(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function toLabel(dateValue) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime()))
        return 'N/A';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
async function getUserProgressSummary(userId) {
    const { data, error } = await requireAuth_1.supabase
        .from('analytics_reports')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(30);
    if (error || !data || data.length === 0) {
        return FALLBACK_SUMMARY;
    }
    const points = data.map((row) => ({
        label: toLabel(row.created_at),
        fluency: toNum(row.fluency_score ?? row.score),
        confidence: toNum(row.confidence_score ?? row.full_report?.confidence_score),
        wpm: toNum(row.wpm ?? row.full_report?.wpm),
        fillerCount: toNum(row.filler_word_count ?? row.filler_count ?? row.full_report?.filler_word_count),
    }));
    const latestPoint = points[points.length - 1];
    const priorPoint = points.length > 1 ? points[points.length - 2] : latestPoint;
    const latestRow = data[data.length - 1];
    const strengths = Array.isArray(latestRow?.strengths)
        ? latestRow.strengths
        : latestRow?.full_report?.strengths ?? [];
    const improvementAreas = Array.isArray(latestRow?.improvement_areas)
        ? latestRow.improvement_areas
        : latestRow?.full_report?.improvement_areas ?? [];
    const coachParagraph = latestRow?.full_report?.overall_evaluation ??
        `You are currently at ${latestPoint.fluency}% fluency with ${latestPoint.fillerCount} filler words on average. Keep daily sessions to sustain gains.`;
    return {
        points,
        latest: {
            fluency: latestPoint.fluency,
            confidence: latestPoint.confidence,
            wpm: latestPoint.wpm,
            fillerCount: latestPoint.fillerCount,
            lexiconTier: latestRow?.lexicon_tier_rank ??
                latestRow?.full_report?.lexicon_tier_rank ??
                'Smart Starter',
        },
        deltas: {
            fluency: latestPoint.fluency - priorPoint.fluency,
            confidence: latestPoint.confidence - priorPoint.confidence,
            wpm: latestPoint.wpm - priorPoint.wpm,
            fillerCount: latestPoint.fillerCount - priorPoint.fillerCount,
        },
        strengths,
        improvementAreas,
        coachParagraph,
    };
}
async function getLatestAnalyticsReport(userId) {
    const { data, error } = await requireAuth_1.supabase
        .from('analytics_reports')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
    if (error || !data)
        return null;
    return data;
}
