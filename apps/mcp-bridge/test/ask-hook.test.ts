// Tests for scripts/hooks/ask-question.mjs (AskUserQuestion → answer in EvolSpace).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validAnswers } from '../../../scripts/hooks/ask-question.mjs';
import { deadUrl } from './fake-evol.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'hooks', 'ask-question.mjs');

const qs = [
  { question: 'Which color?', options: [{ label: 'Cyan' }, { label: 'Purple' }] },
  { question: 'Which parts?', multiSelect: true, options: [{ label: 'HUD' }, { label: 'Walls' }] },
];

describe('validAnswers', () => {
  it('accepts known labels for every question (multi joined with commas)', () => {
    expect(validAnswers(qs, { 'Which color?': 'Purple', 'Which parts?': 'HUD, Walls' })).toEqual({ 'Which color?': 'Purple', 'Which parts?': 'HUD, Walls' });
  });
  it('rejects missing questions and unknown labels', () => {
    expect(validAnswers(qs, { 'Which color?': 'Purple' })).toBeNull();
    expect(validAnswers(qs, { 'Which color?': 'Red', 'Which parts?': 'HUD' })).toBeNull();
    expect(validAnswers(qs, null)).toBeNull();
  });
});

describe('hook process', () => {
  it('without an EvolSpace server: no output, exit 0, fast (the terminal dialog shows as usual)', async () => {
    const url = await deadUrl();
    const res = await new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
      const t0 = Date.now();
      const p = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env: { ...process.env, EVOL_URL: url }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
      p.stdin.end(JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: qs } }));
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.ms).toBeLessThan(5000);
  });
});
