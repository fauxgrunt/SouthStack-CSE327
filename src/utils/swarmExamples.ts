import type { useSwarmManager } from "../hooks/useSwarmManager";

/**
 * Swarm Usage Examples
 *
 * Example functions demonstrating how to use the swarm system.
 */

/**
 * Example 1: Distribute a complex task across the swarm
 */
export async function exampleDistributeTask(
  swarmManager: ReturnType<typeof useSwarmManager>,
) {
  try {
    const assignments = await swarmManager.distributeTask(
      "Create a full-stack todo application with React frontend, Express backend, and SQLite database",
    );

    console.log(`Distributed ${assignments.length} tasks`);

    // Monitor progress
    const checkProgress = setInterval(() => {
      const progress = swarmManager.getProgress();
      console.log(`Progress: ${progress.completed}/${progress.total}`);

      if (progress.completed === progress.total) {
        clearInterval(checkProgress);
        console.log("All tasks completed!");
      }
    }, 1000);
  } catch (error) {
    console.error("Distribution failed:", error);
  }
}

/**
 * Example 2: Execute a task locally (standalone mode)
 */
export async function exampleLocalExecution(
  swarmManager: ReturnType<typeof useSwarmManager>,
) {
  try {
    const code = await swarmManager.executeLocalTask(
      "components/Button.tsx",
      "Create a reusable Button component with TypeScript, supporting variants (primary, secondary) and sizes (sm, md, lg)",
    );

    console.log("Generated code:", code);
  } catch (error) {
    console.error("Local execution failed:", error);
  }
}

/**
 * Example 3: Connect to a specific worker node
 */
export async function exampleConnectToWorker(
  swarmManager: ReturnType<typeof useSwarmManager>,
  workerId: string,
) {
  try {
    await swarmManager.connectToNode(workerId);
    console.log(`Connected to worker: ${workerId}`);
  } catch (error) {
    console.error("Connection failed:", error);
  }
}
