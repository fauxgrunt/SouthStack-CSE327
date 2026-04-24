type OcrResultLike = {
  data?: {
    text?: string;
  };
};

type AsrOutputLike = {
  text?: string;
};

type AsrPipeline = (
  audio: Float32Array,
  options?: {
    chunk_length_s?: number;
    stride_length_s?: number;
    return_timestamps?: boolean;
  },
) => Promise<string | AsrOutputLike>;

let asrPipelinePromise: Promise<AsrPipeline> | null = null;

function sanitizeExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function downsampleTo16k(
  input: Float32Array,
  sourceRate: number,
): Float32Array {
  const targetRate = 16000;

  if (sourceRate === targetRate) {
    return input;
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const index0 = Math.floor(sourceIndex);
    const index1 = Math.min(index0 + 1, input.length - 1);
    const weight = sourceIndex - index0;

    output[i] = input[index0] * (1 - weight) + input[index1] * weight;
  }

  return output;
}

async function decodeAudioFileToMono(file: File): Promise<{
  samples: Float32Array;
  sampleRate: number;
}> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();

  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const mono = new Float32Array(decoded.length);

    for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
      const channelData = decoded.getChannelData(ch);
      for (let i = 0; i < decoded.length; i += 1) {
        mono[i] += channelData[i] / decoded.numberOfChannels;
      }
    }

    return { samples: mono, sampleRate: decoded.sampleRate };
  } finally {
    await audioContext.close();
  }
}

async function getAsrPipeline(): Promise<AsrPipeline> {
  if (!asrPipelinePromise) {
    asrPipelinePromise = (async () => {
      const { env, pipeline } = await import("@xenova/transformers");

      env.allowLocalModels = false;
      env.useBrowserCache = true;

      const transcriber = (await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny.en",
        { quantized: true },
      )) as AsrPipeline;

      return transcriber;
    })();
  }

  return asrPipelinePromise;
}

export async function extractTextFromImage(file: File): Promise<string> {
  const { recognize } = await import("tesseract.js");
  const result = (await recognize(file, "eng")) as OcrResultLike;
  return sanitizeExtractedText(result.data?.text ?? "");
}

export async function transcribeAudioFile(file: File): Promise<string> {
  const { samples, sampleRate } = await decodeAudioFileToMono(file);
  const normalized = downsampleTo16k(samples, sampleRate);
  const transcriber = await getAsrPipeline();
  const output = await transcriber(normalized, {
    chunk_length_s: 20,
    stride_length_s: 5,
    return_timestamps: false,
  });

  const text =
    typeof output === "string"
      ? output
      : output && typeof output === "object"
        ? (output.text ?? "")
        : "";

  return sanitizeExtractedText(text);
}
