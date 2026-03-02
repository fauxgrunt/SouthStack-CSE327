/**
 * Performance utilities for optimizing the IDE on low-end devices
 */

/**
 * Debounce function - delays execution until after wait time has elapsed
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };
    
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle function - limits execution rate
 */
export function throttle<T extends unknown[]>(
  func: (...args: T) => void,
  limit: number
): (...args: T) => void {
  let inThrottle: boolean;
  
  return function executedFunction(...args: T) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Limit array size for memory management
 */
export function limitArraySize<T>(array: T[], maxSize: number): T[] {
  if (array.length <= maxSize) return array;
  return array.slice(-maxSize); // Keep only the last maxSize items
}

/**
 * Check if device is low-end based on hardware capabilities
 */
export async function detectDeviceCapability(): Promise<'low' | 'medium' | 'high'> {
  // Check hardware concurrency (CPU cores)
  const cores = navigator.hardwareConcurrency || 2;
  
  // Check memory (if available)
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory;
  const memory = deviceMemory || 4; // GB
  
  // Check GPU tier (if WebGPU available)
  let gpuTier: 'low' | 'medium' | 'high' = 'medium';
  const navigatorWithGPU = navigator as typeof navigator & { 
    gpu?: { 
      requestAdapter: () => Promise<{ limits: { maxBufferSize: number } } | null> 
    } 
  };
  
  if (navigatorWithGPU.gpu) {
    try {
      const adapter = await navigatorWithGPU.gpu.requestAdapter();
      if (adapter) {
        const limits = adapter.limits;
        // Basic heuristic based on max buffer size
        if (limits.maxBufferSize < 256 * 1024 * 1024) {
          gpuTier = 'low';
        } else if (limits.maxBufferSize > 1024 * 1024 * 1024) {
          gpuTier = 'high';
        }
      }
    } catch {
      gpuTier = 'low';
    }
  } else {
    gpuTier = 'low';
  }
  
  // Determine overall capability
  if (cores <= 2 || memory <= 2 || gpuTier === 'low') {
    return 'low';
  } else if (cores >= 8 && memory >= 8 && gpuTier === 'high') {
    return 'high';
  }
  return 'medium';
}

/**
 * Performance configuration based on device capability
 */
export interface PerformanceConfig {
  maxLogs: number;
  scrollBehavior: ScrollBehavior;
  syntaxHighlightingEnabled: boolean;
  autoScrollThrottle: number;
  useVirtualScrolling: boolean;
  reduceAnimations: boolean;
}

export function getPerformanceConfig(
  capability: 'low' | 'medium' | 'high'
): PerformanceConfig {
  switch (capability) {
    case 'low':
      return {
        maxLogs: 100,
        scrollBehavior: 'auto',
        syntaxHighlightingEnabled: false, // Disable expensive syntax highlighting
        autoScrollThrottle: 200,
        useVirtualScrolling: true,
        reduceAnimations: true,
      };
    case 'medium':
      return {
        maxLogs: 300,
        scrollBehavior: 'smooth',
        syntaxHighlightingEnabled: true,
        autoScrollThrottle: 100,
        useVirtualScrolling: false,
        reduceAnimations: false,
      };
    case 'high':
    default:
      return {
        maxLogs: 1000,
        scrollBehavior: 'smooth',
        syntaxHighlightingEnabled: true,
        autoScrollThrottle: 50,
        useVirtualScrolling: false,
        reduceAnimations: false,
      };
  }
}

/**
 * Simple LRU cache for memoization
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  constructor(maxSize: number = 50) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    
    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    // Delete if exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // Add to end
    this.cache.set(key, value);
    
    // Evict oldest if over size
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value as K;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
