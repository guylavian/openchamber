/**
 * Sherpa-onnx offline TTS (Kokoro and Piper/VITS). Runs inside the dictation worker process
 * only — never load the native addon in the main server process.
 */

import { existsSync } from 'fs';
import path from 'path';

import { loadSherpaOnnxNode } from './sherpa-loader.js';

interface SherpaTtsModelConfig {
  vits?: { model: string; tokens: string; dataDir?: string; lengthScale: number };
  kokoro?: { model: string; voices: string; tokens: string; dataDir: string; lengthScale: number; lexicon?: string };
}

interface SherpaTtsAudio {
  samples?: Float32Array | number[];
  sampleRate?: number;
}

interface SherpaOfflineTts {
  sampleRate?: number;
  generate: (request: { text: string; sid: number | undefined; speed: number; enableExternalBuffer: boolean }) => SherpaTtsAudio | null;
  free?: () => void;
}

interface SherpaOnnxNode {
  OfflineTts?: new (config: { model: SherpaTtsModelConfig; numThreads: number; provider: string; maxNumSentences: number }) => SherpaOfflineTts;
}

interface SherpaTtsModelFiles {
  modelDir: string;
  type?: string | undefined;
  files: Record<string, string>;
  lexicon?: string[] | undefined;
}

interface SherpaTtsEngineConfig extends SherpaTtsModelFiles {
  numThreads?: number | undefined;
}

interface SynthesizeOptions {
  speakerId?: number | undefined;
  speed?: number | undefined;
}

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function float32ToPcm16le(samples: Float32Array): Buffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.round(clamped * 32767);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * sherpa-onnx model config for one catalog entry. Kokoro carries a voices
 * bank (speaker ids) and optional lexicons; a Piper/VITS model is a single
 * voice with espeak-ng phonemization.
 * @param {{ modelDir: string, type?: string, files: Record<string, string>, lexicon?: string[] }} config
 */
function buildModelConfig(config: SherpaTtsModelFiles): SherpaTtsModelConfig {
  const file = (key: string, label: string): string => {
    const filePath = path.join(config.modelDir, config.files[key]!);
    assertFileExists(filePath, label);
    return filePath;
  };
  const modelPath = file('model', 'TTS model');
  const tokensPath = file('tokens', 'TTS tokens');

  if (config.type === 'vits') {
    // Piper models phonemize through espeak-ng (`espeakData`); character
    // models (Coqui) read the text directly and carry no espeak data.
    const dataDir = config.files.espeakData ? file('espeakData', 'TTS espeak-ng dataDir') : '';
    return { vits: { model: modelPath, tokens: tokensPath, ...(dataDir ? { dataDir } : {}), lengthScale: 1.0 } };
  }

  const dataDir = file('espeakData', 'TTS espeak-ng dataDir');
  const voicesPath = file('voices', 'TTS voices');
  const lexicon = (config.lexicon ?? []).map((key) => file(key, 'TTS lexicon')).join(',');
  return {
    kokoro: {
      model: modelPath,
      voices: voicesPath,
      tokens: tokensPath,
      dataDir,
      lengthScale: 1.0,
      ...(lexicon ? { lexicon } : {}),
    },
  };
}

export class SherpaTtsEngine {
  declare tts: SherpaOfflineTts;

  /**
   * @param {{ modelDir: string, type?: string, files: Record<string, string>, lexicon?: string[], numThreads?: number }} config
   */
  constructor(config: SherpaTtsEngineConfig) {
    const model = buildModelConfig(config);

    const sherpa = loadSherpaOnnxNode() as SherpaOnnxNode;
    if (typeof sherpa.OfflineTts !== 'function') {
      throw new Error('sherpa-onnx-node OfflineTts is unavailable');
    }

    this.tts = new sherpa.OfflineTts({
      model,
      numThreads: config.numThreads ?? 2,
      provider: 'cpu',
      maxNumSentences: 1,
    });
  }

  /**
   * Synthesize text to PCM16LE.
   * @param {string} text
   * @param {{ speakerId?: number, speed?: number }} [options]
   * @returns {{ pcm16: Buffer, sampleRate: number }}
   */
  synthesize(text: string, options: SynthesizeOptions = {}): { pcm16: Buffer; sampleRate: number } {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      throw new Error('Cannot synthesize empty text');
    }

    const audio = this.tts.generate({
      text: trimmed,
      sid: Number.isInteger(options.speakerId) ? options.speakerId : 0,
      speed: typeof options.speed === 'number' && options.speed > 0 ? options.speed : 1.0,
      // Request a copied buffer from sherpa itself: native external-backed
      // typed arrays are rejected by Electron.
      enableExternalBuffer: false,
    });

    let samples: Float32Array | null = null;
    if (audio && audio.samples instanceof Float32Array) {
      samples = Float32Array.from(audio.samples);
    } else if (audio && Array.isArray(audio.samples)) {
      samples = Float32Array.from(audio.samples);
    }
    if (!samples) {
      throw new Error('Unexpected sherpa TTS output: missing Float32 samples');
    }

    const sampleRate =
      audio && typeof audio.sampleRate === 'number' && audio.sampleRate > 0
        ? audio.sampleRate
        : typeof this.tts.sampleRate === 'number' && this.tts.sampleRate > 0
          ? this.tts.sampleRate
          : 24000;

    return { pcm16: float32ToPcm16le(samples), sampleRate };
  }

  free(): void {
    try {
      this.tts?.free?.();
    } catch {
      // ignore
    }
  }
}
