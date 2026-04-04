import { useCallback, useEffect, useRef, useState } from "react";

type SpeechRecognitionErrorEventLike = Event & {
  error?: string;
  message?: string;
};

type SpeechRecognitionResultAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionResultAlternativeLike;
};

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface VoiceInputOptions {
  language?: string;
  continuous?: boolean;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const voiceWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };

  return (
    voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition ?? null
  );
}

export function useVoiceInput(
  onTranscript: (transcript: string) => void,
  options: VoiceInputOptions = {},
) {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const isSupported = getSpeechRecognitionCtor() !== null;

  const buildRecognition = useCallback(() => {
    const RecognitionCtor = getSpeechRecognitionCtor();

    if (!RecognitionCtor) {
      return null;
    }

    const recognition = new RecognitionCtor();
    recognition.continuous = options.continuous ?? true;
    recognition.interimResults = false;
    recognition.lang = options.language ?? "en-US";

    recognition.onstart = () => {
      setError(null);
      setIsListening(true);
    };

    recognition.onresult = (event) => {
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];

        if (!result || !result.isFinal || result.length === 0) {
          continue;
        }

        finalTranscript += result[0].transcript;
      }

      const trimmed = finalTranscript.trim();
      if (trimmed.length > 0) {
        onTranscript(trimmed);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed") {
        setError("Microphone permission was denied.");
        return;
      }

      if (event.error === "no-speech") {
        setError("No speech detected. Try again.");
        return;
      }

      setError(event.message ?? event.error ?? "Voice input failed.");
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    return recognition;
  }, [onTranscript, options.continuous, options.language]);

  const startListening = useCallback(() => {
    if (!isSupported) {
      setError("Voice input is not supported in this browser.");
      return;
    }

    const recognition = recognitionRef.current ?? buildRecognition();

    if (!recognition) {
      setError("Voice input could not be initialized.");
      return;
    }

    try {
      recognition.start();
    } catch {
      // Ignore duplicate start calls from rapid clicks.
    }
  }, [buildRecognition, isSupported]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return {
    isSupported,
    isListening,
    error,
    startListening,
    stopListening,
  };
}
