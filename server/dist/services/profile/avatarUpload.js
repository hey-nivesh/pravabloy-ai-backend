"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadAvatarToCloudinary = uploadAvatarToCloudinary;
exports.persistUserAvatar = persistUserAvatar;
const requireAuth_1 = require("../../middleware/requireAuth");
function cloudNameFromEnv() {
    const fromPublic = process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME;
    if (fromPublic)
        return fromPublic;
    const raw = process.env.CLOUDINARY_URL ?? '';
    const match = raw.match(/@(.+)$/);
    return match?.[1] ?? '';
}
/**
 * Upload avatar bytes to Cloudinary using the unsigned upload preset.
 * Avoids signed-upload parameter ordering issues on the server.
 */
async function uploadAvatarToCloudinary(params) {
    const cloudName = cloudNameFromEnv();
    const uploadPreset = process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET ?? 'avatar';
    if (!cloudName || !uploadPreset) {
        throw new Error('Cloudinary is not configured. Set CLOUDINARY_URL or EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME and EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET.');
    }
    const folder = `pravabloyai/avatars/${params.userId}`;
    const dataUri = `data:${params.mimeType};base64,${params.imageBuffer.toString('base64')}`;
    const formData = new FormData();
    formData.append('file', dataUri);
    formData.append('upload_preset', uploadPreset);
    formData.append('folder', folder);
    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
    const response = await fetch(uploadUrl, { method: 'POST', body: formData });
    const rawText = await response.text();
    let json;
    try {
        json = JSON.parse(rawText);
    }
    catch {
        throw new Error(`Cloudinary upload failed: unexpected response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
        const detail = json?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`Cloudinary upload failed: ${detail}`);
    }
    const secureUrl = json.secure_url;
    const publicId = json.public_id;
    if (!secureUrl || !publicId) {
        throw new Error('Cloudinary returned an unexpected response.');
    }
    return { secureUrl, publicId };
}
async function persistUserAvatar(params) {
    const { error } = await requireAuth_1.supabaseAdmin
        .from('users')
        .update({
        avatar_url: params.secureUrl,
        avatar_public_id: params.publicId,
        updated_at: new Date().toISOString(),
    })
        .eq('id', params.userId);
    if (error) {
        throw new Error(`Failed to save avatar: ${error.message}`);
    }
}
