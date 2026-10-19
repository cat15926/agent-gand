import type { LlmDisplayKind } from '@agent-gand/shared';

/**
 * A control-capable turn may replace free text with an accepted tool submission.
 * Keep its temporary prose out of conversation bubbles; the committed Message is
 * the display authority. Ordinary turns retain live text and review JSON keeps
 * its existing hidden presentation. This does not classify model reasoning.
 */
export function turnDisplayKind(input: {
  displayKind?: LlmDisplayKind;
  controlTools?: readonly unknown[];
}): LlmDisplayKind {
  if (input.displayKind === 'review_protocol') return 'review_protocol';
  if (input.controlTools?.length) return 'control_draft';
  return input.displayKind ?? 'message';
}
