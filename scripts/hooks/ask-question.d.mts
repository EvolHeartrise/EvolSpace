// Types for ask-question.mjs (so TypeScript tests can import its pure functions).
export interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}
export declare function validAnswers(questions: AskQuestion[], answers: unknown): Record<string, string> | null;
