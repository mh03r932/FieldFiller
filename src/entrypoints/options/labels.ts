import type { MessageKey } from '@/lib/platform/i18n';
import type { MatchSource } from '@/lib/settings';

/**
 * How each match source is named on screen, wherever it is named.
 *
 * One table, because the rule editor and the sources section each had their own
 * copy and only a comment holding them together — a catalog key changed in one
 * stranded the other, and a source called "CSS class" in one section and
 * `className` in another reads as two different settings.
 *
 * Declared as a total record rather than a lookup with a fallback, so adding an
 * eighth source is a compile error here instead of a raw identifier on screen.
 */
export const SOURCE_LABELS: Record<MatchSource, MessageKey> = {
  name: 'sourceName',
  id: 'sourceId',
  testId: 'sourceTestId',
  className: 'sourceClassName',
  label: 'sourceLabel',
  placeholder: 'sourcePlaceholder',
  ariaLabel: 'sourceAriaLabel',
};
