import type { Content, Part } from '@google/genai';

function isUserTurnStart(c: Content): boolean {
  return c.role === 'user' && (c.parts ?? []).some((p) => typeof p.text === 'string');
}

/** Merges adjacent text-only parts (streamed fragments) while keeping signed parts intact. */
export function mergeTextParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    const plainText = (p: Part | undefined) =>
      p !== undefined && typeof p.text === 'string' && !p.thought && !p.thoughtSignature && !p.functionCall && Object.keys(p).length === 1;
    if (plainText(part) && plainText(prev)) {
      out[out.length - 1] = { text: prev!.text! + part.text! };
    } else {
      out.push(part);
    }
  }
  return out.filter((p) => !(typeof p.text === 'string' && p.text === '' && !p.thoughtSignature));
}

function mergeSameRole(contents: Content[]): Content[] {
  const out: Content[] = [];
  for (const c of contents) {
    const prev = out[out.length - 1];
    if (prev && prev.role === c.role) {
      out[out.length - 1] = { role: c.role, parts: mergeTextParts([...(prev.parts ?? []), ...(c.parts ?? [])]) };
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * Keeps the token bill flat as conversations grow:
 *  - only the last `maxTurns` user turns are kept;
 *  - turns older than `fullTurns` lose their tool call/response parts (the
 *    model's final text answer, which contains the numbers, is kept).
 */
export function compactHistory(contents: Content[], maxTurns: number, fullTurns: number): Content[] {
  const turnStarts: number[] = [];
  contents.forEach((c, i) => {
    if (isUserTurnStart(c)) turnStarts.push(i);
  });
  if (turnStarts.length === 0) return contents;

  const firstKept = turnStarts[Math.max(0, turnStarts.length - maxTurns)];
  const fullFrom = turnStarts[Math.max(0, turnStarts.length - fullTurns)];

  const kept: Content[] = [];
  for (let i = firstKept; i < contents.length; i++) {
    const c = contents[i];
    if (i >= fullFrom) {
      kept.push(c);
      continue;
    }
    const parts = (c.parts ?? []).filter(
      (p) => !p.functionCall && !p.functionResponse && typeof p.text === 'string' && p.text.trim() !== '',
    );
    if (parts.length) kept.push({ role: c.role, parts: parts.map((p) => ({ text: p.text })) });
  }
  return mergeSameRole(kept);
}
