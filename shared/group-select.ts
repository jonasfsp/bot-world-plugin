import { el } from './dom.ts';
import { tStrings } from './i18n.ts';
import type { UiLocale } from '../src/types.ts';

/**
 * Bot group picker: '' shows every bot; a group name shows only that group's bots.
 * The worker scopes the snapshot, so this control only reports the choice.
 * Redact Mode shows `Group #N` instead of the real group names.
 */
export type GroupSelect = {
  element: HTMLSelectElement;
  update(input: {
    groups: readonly string[];
    selected: string;
    redactMode: boolean;
    locale: UiLocale;
  }): void;
};

export function groupOptionLabels(
  groups: readonly string[],
  selected: string,
  redactMode: boolean,
  locale: UiLocale
): Array<{ value: string; label: string }> {
  const s = tStrings(locale);
  const all = [...groups];
  // Keep a saved choice visible even before its bots have been seen this session.
  if (selected !== '' && !all.includes(selected)) all.push(selected);
  return [
    { value: '', label: s.groupAll },
    ...all.map((g, i) => ({ value: g, label: redactMode ? s.groupAlias(i + 1) : g })),
  ];
}

export function createGroupSelect(onChange: (group: string) => void): GroupSelect {
  const select = el('select', {
    className: 'bw-group-select bw-hidden',
    onChange: () => onChange(select.value),
  }) as HTMLSelectElement;
  let lastSig = '';
  return {
    element: select,
    update({ groups, selected, redactMode, locale }) {
      const options = groupOptionLabels(groups, selected, redactMode, locale);
      const sig = JSON.stringify([options, selected]);
      if (sig !== lastSig) {
        lastSig = sig;
        while (select.firstChild) select.removeChild(select.firstChild);
        for (const opt of options) {
          const node = el('option', { value: opt.value }, opt.label) as HTMLOptionElement;
          node.selected = opt.value === selected;
          select.appendChild(node);
        }
        select.value = selected;
        const label = tStrings(locale).groupSelectLabel;
        select.title = label;
        select.setAttribute('aria-label', label);
      }
      // Only worth showing once there is a group to pick (or one is already picked).
      select.classList.toggle('bw-hidden', options.length <= 1);
    },
  };
}
