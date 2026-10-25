import type { VoiceConfig } from './config';

/** Transcript post-processing (prompt §9 steps 1–5). Pure; never acts on partials. */
const PUNCT = '[,.!?;:—–-]';
const EDGE = /^[\s.,!?;:"'“”‘’—–-]+|[\s.,!?;:"'“”‘’—–-]+$/g;
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function words(phrase: string): string[] { return phrase.trim().toLowerCase().split(/\s+/).filter(Boolean); }

export function normalize(text: string): string { return text.replace(/\s+/g, ' ').trim().replace(EDGE, ''); }

/** §9.1–2: normalize, keep text after the last full wake phrase, strip a leading remnant. Also used for display. */
export function stripWake(text: string, config: VoiceConfig): string {
  let s = normalize(text);
  const parts = words(config.wake.phrase);
  if (!parts.length) return s;
  const full = new RegExp(`(?:^|\\b)${parts.map(escape).join(`${PUNCT}?\\s+`)}${PUNCT}?\\s*`, 'gi');
  let last: RegExpExecArray | null = null;
  for (let match = full.exec(s); match; match = full.exec(s)) { last = match; if (match[0].length === 0) full.lastIndex++; }
  if (last) {
    const after = normalize(s.slice(last.index + last[0].length));
    s = after || normalize(s.slice(0, last.index));
  }
  const lastWord = parts[parts.length - 1]!;
  const tails: string[] = [];
  for (let i = 0; i <= lastWord.length - 3; i++) tails.push(lastWord.slice(i));
  const alternatives = [...tails, ...config.wake.remnantAliases.map(alias => alias.toLowerCase())].map(escape).join('|');
  const leading = parts.slice(0, -1).map(escape).join(`${PUNCT}?\\s+`);
  const remnant = new RegExp(`^(${leading ? `${leading}${PUNCT}?\\s+` : ''})?(${alternatives})${PUNCT}?(\\s+|$)`, 'i');
  return normalize(s.replace(remnant, ''));
}

export type Classification =
  | { kind: 'interrupt'; always: boolean; text: string }
  | { kind: 'stop-command'; text: string }
  | { kind: 'empty' }
  | { kind: 'drop'; reason: string }
  | { kind: 'command'; text: string; commandKind: 'command' | 'dictation' };

/** §9 steps 3–5 on already-stripped text. `stop` is an interrupt only when a command is in flight (§5.3). */
export function classify(stripped: string, config: VoiceConfig, speechMs: number | null): Classification {
  const s = normalize(stripped);
  if (!s) return { kind: 'empty' };
  const bare = s.toLowerCase().replace(/[.!?]+$/, '');
  if (new RegExp(config.interrupts.always, 'i').test(bare)) return { kind: 'interrupt', always: true, text: s };
  if (new RegExp(config.interrupts.inFlightOnly, 'i').test(bare)) return { kind: 'stop-command', text: s };
  if (config.hallucinationBlocklist.some(entry => entry.toLowerCase() === bare)) return { kind: 'drop', reason: 'blocklist' };
  if (/^\[.*\]$/.test(s) || /^\(.*\)$/.test(s)) return { kind: 'drop', reason: 'non-speech tag' };
  if (s.split(/\s+/).length < 2 && speechMs !== null && speechMs < 150) return { kind: 'drop', reason: 'too short' };
  const dictation = /^(type|write|dictate)\s+(.+)$/i.exec(s);
  if (dictation) return { kind: 'command', text: dictation[2]!, commandKind: 'dictation' };
  return { kind: 'command', text: s, commandKind: 'command' };
}

export const wordCount = (text: string): number => normalize(text).split(/\s+/).filter(Boolean).length;
export const joinText = (...parts: (string | null | undefined)[]): string => parts.map(part => part?.trim() ?? '').filter(Boolean).join(' ');
