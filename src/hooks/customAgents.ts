import { useRef } from 'react';
import * as webllm from '@mlc-ai/web-llm';

/**
 * Example: Custom Agent for Test Generation
 * 
 * This demonstrates how to extend the agentic loop architecture
 * with specialized agents for different tasks.
 */

interface TestGenerationResult {
  testCode: string;
  coverage: string[];
  success: boolean;
}

export const useTestAgent = () => {
  const engineRef = useRef<webllm.MLCEngine | null>(null);

  /**
   * Initialize the test generation agent with the same engine
   */
  const initialize = async (engine: webllm.MLCEngine) => {
    engineRef.current = engine;
  };

  /**
   * Generate tests for given source code
   */
  const generateTests = async (
    sourceCode: string,
    testingFramework: 'jest' | 'vitest' | 'mocha' = 'jest'
  ): Promise<TestGenerationResult> => {
    if (!engineRef.current) {
      throw new Error('Test agent not initialized');
    }

    const systemPrompt = `You are a test generation expert.
Generate comprehensive unit tests for the provided code.

Guidelines:
- Use ${testingFramework} testing framework
- Cover edge cases and error scenarios
- Include descriptive test names
- Aim for >90% code coverage
- Test both success and failure paths`;

    const userPrompt = `Generate ${testingFramework} tests for this code:

\`\`\`javascript
${sourceCode}
\`\`\`

Return ONLY the test code, no explanations.`;

    try {
      const completion = await engineRef.current.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.5, // Lower temperature for more consistent test generation
        max_tokens: 1024,
      });

      const testCode = extractCode(completion.choices[0].message.content || '');
      
      // Extract covered scenarios from test descriptions
      const coverage = extractCoverageScenarios(testCode);

      return {
        testCode,
        coverage,
        success: true,
      };
    } catch (error: any) {
      return {
        testCode: '',
        coverage: [],
        success: false,
      };
    }
  };

  return { initialize, generateTests };
};

/**
 * Example: Debug Agent for Error Analysis
 */
export const useDebugAgent = () => {
  const engineRef = useRef<webllm.MLCEngine | null>(null);

  const initialize = async (engine: webllm.MLCEngine) => {
    engineRef.current = engine;
  };

  /**
   * Analyze error and suggest fixes
   */
  const analyzeError = async (
    code: string,
    error: string,
    stackTrace?: string
  ) => {
    if (!engineRef.current) {
      throw new Error('Debug agent not initialized');
    }

    const systemPrompt = `You are an expert debugger.
Analyze errors and provide detailed explanations with fixes.

Your response should include:
1. Root cause analysis
2. Step-by-step fix explanation
3. Corrected code
4. Prevention tips`;

    const userPrompt = `Debug this error:

CODE:
\`\`\`javascript
${code}
\`\`\`

ERROR: ${error}

${stackTrace ? `STACK TRACE:\n${stackTrace}` : ''}

Provide analysis and fixed code.`;

    const completion = await engineRef.current.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 1500,
    });

    return parseDebugResponse(completion.choices[0].message.content || '');
  };

  return { initialize, analyzeError };
};

/**
 * Example: Refactor Agent for Code Improvement
 */
export const useRefactorAgent = () => {
  const engineRef = useRef<webllm.MLCEngine | null>(null);

  const initialize = async (engine: webllm.MLCEngine) => {
    engineRef.current = engine;
  };

  /**
   * Suggest refactorings for given code
   */
  const suggestRefactoring = async (
    code: string,
    goals: string[] = ['readability', 'performance', 'maintainability']
  ) => {
    if (!engineRef.current) {
      throw new Error('Refactor agent not initialized');
    }

    const systemPrompt = `You are a code refactoring expert.
Suggest improvements focusing on: ${goals.join(', ')}.

Principles:
- DRY (Don't Repeat Yourself)
- SOLID principles
- Modern best practices
- Performance optimization
- Type safety`;

    const userPrompt = `Refactor this code:

\`\`\`javascript
${code}
\`\`\`

Provide refactored version with explanation of changes.`;

    const completion = await engineRef.current.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.6,
      max_tokens: 1500,
    });

    return parseRefactorResponse(completion.choices[0].message.content || '');
  };

  return { initialize, suggestRefactoring };
};

/**
 * Example: Multi-Agent Coordinator
 * 
 * Orchestrates multiple specialized agents to complete complex tasks
 */
export const useMultiAgentCoordinator = () => {
  const testAgent = useTestAgent();
  const debugAgent = useDebugAgent();
  const refactorAgent = useRefactorAgent();

  const initialize = async (engine: webllm.MLCEngine) => {
    await testAgent.initialize(engine);
    await debugAgent.initialize(engine);
    await refactorAgent.initialize(engine);
  };

  /**
   * Complete workflow: Generate → Test → Debug → Refactor
   */
  const completeWorkflow = async (
    initialCode: string,
    requirements: string
  ) => {
    const workflow = {
      steps: [] as any[],
      finalCode: initialCode,
      success: false,
    };

    try {
      // Step 1: Generate tests
      workflow.steps.push({ phase: 'test-generation', status: 'started' });
      const tests = await testAgent.generateTests(initialCode);
      workflow.steps.push({ phase: 'test-generation', status: 'completed', data: tests });

      // Step 2: If tests reveal issues, debug
      // (In real implementation, would execute tests and check results)
      
      // Step 3: Refactor for quality
      workflow.steps.push({ phase: 'refactoring', status: 'started' });
      const refactored = await refactorAgent.suggestRefactoring(initialCode, [
        'readability',
        'performance'
      ]);
      workflow.steps.push({ phase: 'refactoring', status: 'completed', data: refactored });

      workflow.finalCode = refactored.code;
      workflow.success = true;
    } catch (error: any) {
      workflow.steps.push({ phase: 'error', status: 'failed', error: error.message });
    }

    return workflow;
  };

  return { initialize, completeWorkflow };
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function extractCode(response: string): string {
  const codeBlockMatch = response.match(/```(?:javascript|js|typescript|ts)?\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return response.trim();
}

function extractCoverageScenarios(testCode: string): string[] {
  const scenarios: string[] = [];
  
  // Extract test descriptions (e.g., "it('should handle empty input')")
  const testMatches = testCode.matchAll(/(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g);
  
  for (const match of testMatches) {
    scenarios.push(match[1]);
  }
  
  return scenarios;
}

function parseDebugResponse(response: string) {
  // Simple parser - in production, use structured output
  const sections = {
    analysis: '',
    fix: '',
    code: '',
    tips: '',
  };

  const analysisMatch = response.match(/(?:root cause|analysis)[:\s]+([\s\S]*?)(?=\n\n|fix|code)/i);
  if (analysisMatch) sections.analysis = analysisMatch[1].trim();

  const fixMatch = response.match(/(?:fix|solution)[:\s]+([\s\S]*?)(?=\n\n|code|prevention)/i);
  if (fixMatch) sections.fix = fixMatch[1].trim();

  sections.code = extractCode(response);

  const tipsMatch = response.match(/(?:prevention|tips)[:\s]+([\s\S]*?)$/i);
  if (tipsMatch) sections.tips = tipsMatch[1].trim();

  return sections;
}

function parseRefactorResponse(response: string) {
  return {
    code: extractCode(response),
    explanation: response.replace(/```[\s\S]*?```/g, '').trim(),
    improvements: extractImprovements(response),
  };
}

function extractImprovements(response: string): string[] {
  const improvements: string[] = [];
  
  // Look for bullet points or numbered lists
  const listMatches = response.matchAll(/^[\s]*[-*•]\s*(.+)$/gm);
  
  for (const match of listMatches) {
    improvements.push(match[1].trim());
  }
  
  return improvements;
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

/*
import { useMultiAgentCoordinator } from './customAgents';

function MyComponent() {
  const coordinator = useMultiAgentCoordinator();
  const { state, initializeEngine } = useAgenticLoop();

  useEffect(() => {
    if (engineRef.current) {
      coordinator.initialize(engineRef.current);
    }
  }, [state.isInitialized]);

  const handleComplexTask = async () => {
    const workflow = await coordinator.completeWorkflow(
      userCode,
      'Create a REST API with validation'
    );
    console.log('Workflow steps:', workflow.steps);
    console.log('Final code:', workflow.finalCode);
  };

  return <button onClick={handleComplexTask}>Run Multi-Agent Workflow</button>;
}
*/
