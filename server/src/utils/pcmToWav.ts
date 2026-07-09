/**
 * Wrap raw Linear PCM (L16) from Gemini TTS in a standard WAV container.
 * Gemini returns audio/l16 at 24 kHz mono by default.
 */
export function parsePcmMimeType(mimeType?: string | null): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
} {
  const normalized = (mimeType ?? 'audio/l16;rate=24000;channels=1').toLowerCase();
  const rateMatch = normalized.match(/rate=(\d+)/);
  const channelsMatch = normalized.match(/channels=(\d+)/);

  return {
    sampleRate: rateMatch ? parseInt(rateMatch[1], 10) : 24_000,
    channels: channelsMatch ? parseInt(channelsMatch[1], 10) : 1,
    bitsPerSample: 16,
  };
}

export function pcmToWav(
  pcmBuffer: Buffer,
  options: { sampleRate: number; channels: number; bitsPerSample: number },
): Buffer {
  const { sampleRate, channels, bitsPerSample } = options;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}
