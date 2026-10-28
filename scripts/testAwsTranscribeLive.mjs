// Opt-in live transport check. Input is a mono PCM16 WAV; no fixture text is used as an oracle.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FsBlobStore } from '@splice/runtime';
import { AwsTranscribeProvider } from '../packages/backend/src/example/awsTranscribe.ts';
import { parseMonoPcm16Wav } from '../packages/backend/src/example/wav.ts';

const file = process.argv[2];
if (!file) throw new Error('Usage: npm run test:recombination:transcription:live -- <mono-pcm16.wav>');
const { pcm, sampleRateHz } = parseMonoPcm16Wav(await readFile(file));
const workspace = await mkdtemp(path.join(os.tmpdir(), 'splice-live-transcribe-'));
try {
  const blobs = new FsBlobStore(workspace);
  const audio = await blobs.put(pcm, { contentType: 'audio/L16' });
  const provider = new AwsTranscribeProvider({ blobs, region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION });
  const final = [];
  for await (const segment of provider.transcribe({ audio, language: process.env.SPLICE_TRANSCRIPTION_LANGUAGE ?? 'en-US', format: 'pcm_s16le', sampleRateHz, channels: 1 }, {})) {
    if (segment.final) final.push(segment);
  }
  if (!final.length) throw new Error('Live provider returned no final speech segments');
  console.log(JSON.stringify({ provider: provider.id, sampleRateHz, segments: final }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
