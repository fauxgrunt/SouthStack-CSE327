import { useCallback, useEffect, useState } from "react";
import {
  clearGenerationHistory,
  listGenerationHistory,
  saveGenerationHistoryItem,
  type GenerationHistoryItem,
} from "../services/storage";

export function useGenerationHistory() {
  const [history, setHistory] = useState<GenerationHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const items = await listGenerationHistory();
        if (!cancelled) {
          setHistory(items);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const addHistoryItem = useCallback(
    async (item: Omit<GenerationHistoryItem, "id" | "timestamp">) => {
      const nextItem = await saveGenerationHistoryItem(item);
      setHistory((prev) => [nextItem, ...prev].slice(0, 25));
      return nextItem;
    },
    [],
  );

  const clearHistory = useCallback(async () => {
    await clearGenerationHistory();
    setHistory([]);
  }, []);

  return {
    history,
    isLoading,
    addHistoryItem,
    clearHistory,
  };
}
