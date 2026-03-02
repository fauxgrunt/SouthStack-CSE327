import { memo, useRef, useEffect, useState } from 'react';
import { throttle } from '../utils/performance';

/**
 * VirtualizedLogViewer - Efficiently renders large log arrays by only rendering visible items
 * This dramatically improves performance on low-end devices
 */

interface LogEntry {
  timestamp: Date;
  phase: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

interface VirtualizedLogViewerProps {
  logs: LogEntry[];
  maxHeight?: number;
}

const LOG_ITEM_HEIGHT = 32; // Approximate height of each log item in pixels
const BUFFER_SIZE = 5; // Number of extra items to render above/below viewport

export const VirtualizedLogViewer = memo<VirtualizedLogViewerProps>(({ 
  logs, 
  maxHeight = 400 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });

  // Calculate which logs should be visible
  const updateVisibleRange = throttle((scrollTop: number) => {
    const startIndex = Math.max(0, Math.floor(scrollTop / LOG_ITEM_HEIGHT) - BUFFER_SIZE);
    const visibleCount = Math.ceil(maxHeight / LOG_ITEM_HEIGHT) + (BUFFER_SIZE * 2);
    const endIndex = Math.min(logs.length, startIndex + visibleCount);
    
    setVisibleRange({ start: startIndex, end: endIndex });
  }, 100);

  // Handle scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const newScrollTop = container.scrollTop;
      updateVisibleRange(newScrollTop);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [updateVisibleRange]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    // Only auto-scroll if user is near the bottom
    const isNearBottom = 
      container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    
    if (isNearBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }, [logs.length]);

  const visibleLogs = logs.slice(visibleRange.start, visibleRange.end);
  const totalHeight = logs.length * LOG_ITEM_HEIGHT;
  const offsetY = visibleRange.start * LOG_ITEM_HEIGHT;

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'error': return 'text-red-400';
      case 'warning': return 'text-yellow-400';
      case 'success': return 'text-green-400';
      default: return 'text-gray-300';
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  return (
    <div
      ref={containerRef}
      className="bg-gray-950 rounded-lg p-4 overflow-y-auto font-mono text-xs"
      style={{ maxHeight: `${maxHeight}px`, position: 'relative' }}
    >
      <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleLogs.map((log, index) => {
            const actualIndex = visibleRange.start + index;
            return (
              <div
                key={actualIndex}
                className={`py-1 ${getLogColor(log.type)}`}
                style={{ height: `${LOG_ITEM_HEIGHT}px` }}
              >
                <span className="text-gray-500">[{formatTime(log.timestamp)}]</span>
                <span className="text-blue-400 ml-2">{log.phase}</span>
                <span className="ml-2">{log.message}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

VirtualizedLogViewer.displayName = 'VirtualizedLogViewer';
