import { ExtractedContext } from "../core/contextManager";

export const DETERMINISTIC_SYSTEM_PROMPT = `You are a strictly deterministic TypeScript compiler assistant for vibe-coding.
CRITICAL RULES:
1. Respond ONLY with a valid JSON object matching this exact schema:
   {
     "intentSummary": "string",
     "patches": [
       {
         "targetFile": "string",
         "searchBlock": "exact substring to find in source code",
         "replaceBlock": "valid TypeScript replacement code",
         "explanation": "string"
       }
     ]
   }
2. NEVER wrap the response in Markdown code blocks.
3. NEVER use 'any', 'eval()', 'new Function()', or 'debugger'.
4. Ensure 'searchBlock' matches the provided source code character-for-character.`;

export interface PromptBuildInput {
  intent: string;
  context: ExtractedContext;
  sourceCode: string;
  errorFeedback?: string;
}

export function buildUserPrompt(input: PromptBuildInput): string {
  const sections: string[] = [
    `=== VIBE INTENT ===\n${input.intent.trim()}`,
    `=== AST METADATA ===\nFile: ${input.context.fileName}\nContextHash: ${input.context.contextHash}\nImports: ${input.context.imports.join(", ") || "none"}\nExports: ${input.context.exportedSymbols.join(", ") || "none"}\nSymbols: ${input.context.functionsAndClasses.join(", ") || "none"}`,
    `=== SOURCE CODE ===\n${input.sourceCode}`,
  ];

  if (input.errorFeedback) {
    sections.push(
      `=== PREVIOUS PIPELINE ERROR (MUST FIX) ===\n${input.errorFeedback}`
    );
  }

  return sections.join("\n\n");
}
