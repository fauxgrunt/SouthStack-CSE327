import { WebContainer } from '@webcontainer/api';

/**
 * WebContainer Service - Singleton Pattern
 * 
 * Manages the WebContainer instance for in-browser Node.js execution.
 * WebContainer provides a full Node.js runtime in the browser with:
 * - Virtual file system
 * - Process spawning (npm, node, etc.)
 * - Network isolation
 */

class WebContainerService {
  private static instance: WebContainerService | null = null;
  private container: WebContainer | null = null;
  private bootPromise: Promise<WebContainer> | null = null;
  private isBooting = false;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): WebContainerService {
    if (!WebContainerService.instance) {
      WebContainerService.instance = new WebContainerService();
    }
    return WebContainerService.instance;
  }

  /**
   * Boot the WebContainer instance
   * This is an expensive operation and should only be done once
   */
  public async boot(): Promise<WebContainer> {
    // If already booted, return the existing instance
    if (this.container) {
      return this.container;
    }

    // If currently booting, wait for that promise
    if (this.bootPromise) {
      return this.bootPromise;
    }

    // Start booting
    this.isBooting = true;
    this.bootPromise = this._bootContainer();

    try {
      this.container = await this.bootPromise;
      return this.container;
    } catch (error) {
      // Reset state on failure
      this.bootPromise = null;
      this.isBooting = false;
      throw error;
    } finally {
      this.isBooting = false;
    }
  }

  /**
   * Internal boot logic with better error handling
   */
  private async _bootContainer(): Promise<WebContainer> {
    try {
      // Check if SharedArrayBuffer is available (required for WebContainer)
      if (typeof SharedArrayBuffer === 'undefined') {
        throw new Error(
          'SharedArrayBuffer is not available. Make sure your server sends the correct COOP and COEP headers:\n' +
          'Cross-Origin-Opener-Policy: same-origin\n' +
          'Cross-Origin-Embedder-Policy: require-corp'
        );
      }

      console.log('[WebContainer] Booting...');
      const container = await WebContainer.boot();
      console.log('[WebContainer] Successfully booted!');
      
      return container;
    } catch (error: any) {
      console.error('[WebContainer] Boot failed:', error);
      throw new Error(`Failed to boot WebContainer: ${error.message}`);
    }
  }

  /**
   * Get the booted container instance
   * Throws if not yet booted
   */
  public getContainer(): WebContainer {
    if (!this.container) {
      throw new Error('WebContainer not booted. Call boot() first.');
    }
    return this.container;
  }

  /**
   * Check if container is ready
   */
  public isReady(): boolean {
    return this.container !== null;
  }

  /**
   * Write a file to the virtual file system
   */
  public async writeFile(path: string, content: string): Promise<void> {
    const container = this.getContainer();
    
    try {
      await container.fs.writeFile(path, content);
      console.log(`[WebContainer] Wrote file: ${path} (${content.length} bytes)`);
    } catch (error: any) {
      console.error(`[WebContainer] Failed to write file ${path}:`, error);
      throw new Error(`Failed to write file ${path}: ${error.message}`);
    }
  }

  /**
   * Read a file from the virtual file system
   */
  public async readFile(path: string): Promise<string> {
    const container = this.getContainer();
    
    try {
      const content = await container.fs.readFile(path, 'utf-8');
      return content;
    } catch (error: any) {
      console.error(`[WebContainer] Failed to read file ${path}:`, error);
      throw new Error(`Failed to read file ${path}: ${error.message}`);
    }
  }

  /**
   * Create a directory
   */
  public async mkdir(path: string): Promise<void> {
    const container = this.getContainer();
    
    try {
      await container.fs.mkdir(path, { recursive: true });
      console.log(`[WebContainer] Created directory: ${path}`);
    } catch (error: any) {
      // Ignore if directory already exists
      if (!error.message?.includes('exists')) {
        console.error(`[WebContainer] Failed to create directory ${path}:`, error);
        throw new Error(`Failed to create directory ${path}: ${error.message}`);
      }
    }
  }

  /**
   * Spawn a process and return it
   * The caller is responsible for handling the output streams
   */
  public async spawn(
    command: string,
    args: string[] = [],
    options?: { cwd?: string; env?: Record<string, string> }
  ) {
    const container = this.getContainer();
    
    try {
      console.log(`[WebContainer] Spawning: ${command} ${args.join(' ')}`);
      const process = await container.spawn(command, args, {
        ...options,
        terminal: {
          cols: 80,
          rows: 30,
        },
      });
      
      return process;
    } catch (error: any) {
      console.error(`[WebContainer] Failed to spawn ${command}:`, error);
      throw new Error(`Failed to spawn ${command}: ${error.message}`);
    }
  }

  /**
   * Execute a command and wait for it to complete
   * Returns the exit code and captured output
   */
  public async exec(
    command: string,
    args: string[] = [],
    options?: { cwd?: string }
  ): Promise<{ exitCode: number; output: string }> {
    const process = await this.spawn(command, args, options);
    
    let output = '';
    
    // Capture stdout
    process.output.pipeTo(
      new WritableStream({
        write(chunk) {
          output += chunk;
        },
      })
    );

    // Wait for process to complete
    const exitCode = await process.exit;
    
    console.log(`[WebContainer] Process exited with code: ${exitCode}`);
    
    return { exitCode, output };
  }

  /**
   * Mount files to the file system
   * Useful for initializing a project structure
   */
  public async mount(
    files: Record<string, { file: { contents: string } } | { directory: Record<string, any> }>
  ): Promise<void> {
    const container = this.getContainer();
    
    try {
      await container.mount(files);
      console.log('[WebContainer] Mounted file structure');
    } catch (error: any) {
      console.error('[WebContainer] Failed to mount files:', error);
      throw new Error(`Failed to mount files: ${error.message}`);
    }
  }

  /**
   * Get the URL for the dev server running in WebContainer
   * WebContainer automatically maps ports to unique URLs
   */
  public async getServerUrl(port: number = 3000): Promise<string> {
    const container = this.getContainer();
    
    // Wait for server to be ready (simple polling)
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // WebContainer provides a unique URL for each port
    return `http://localhost:${port}`;
  }
}

// Export singleton instance
export const webContainerService = WebContainerService.getInstance();

// Export type for external use
export type { WebContainer };
