import { beforeEach, describe, expect, it } from 'vitest';
import { driveCombobox, stillAnswered } from '@/lib/page/combobox';
import { realScheduler } from '@/lib/page/settle';

/**
 * The combobox ladder (FR-081, UC-034 A9/A10, BR-034-9).
 *
 * `scripts/e2e-cascade.mjs` drives one real ARIA combobox in a real Chromium,
 * which is the proof that the ladder works. This file covers what a single
 * fixture cannot: the component shapes that differ from it, and every way of
 * *failing* — where the requirement is not that a value lands but that the page
 * is left exactly as it was found.
 */

const options = { at: 0.5, scheduler: realScheduler, budgetMs: 500 };

const combobox = (): HTMLElement => document.querySelector('#control')!;

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * The portal pattern: a trigger, and a listbox rendered at the far end of the
 * document. MUI, Ant, Radix and shadcn all do this, to escape an ancestor's
 * `overflow: hidden` — so a popup found by looking *under* the trigger is a
 * popup that is usually not there.
 */
function portaled({ commitOn = 'click' } = {}): void {
  document.body.innerHTML = `
    <div id="control" role="combobox" tabindex="0" aria-expanded="false"
         aria-haspopup="listbox" aria-controls="popup"><span id="shown">Select…</span></div>
    <div id="elsewhere"></div>`;

  const control = combobox();
  const shown = document.querySelector('#shown')!;
  const CHOICES = ['Pound sterling', 'Euro', 'US dollar'];
  let active = 0;

  const commit = (): void => {
    shown.textContent = CHOICES[active]!;
    close();
  };

  const close = (): void => {
    document.querySelector('#popup')?.remove();
    control.setAttribute('aria-expanded', 'false');
  };

  const open = (): void => {
    if (document.querySelector('#popup') !== null) return;
    control.setAttribute('aria-expanded', 'true');
    const popup = document.createElement('ul');
    popup.id = 'popup';
    popup.setAttribute('role', 'listbox');
    for (const [index, text] of CHOICES.entries()) {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.textContent = text;
      item.addEventListener(commitOn, (event) => {
        event.preventDefault();
        active = index;
        commit();
      });
      popup.append(item);
    }
    // Not inside the trigger. This is the whole point of the shape.
    document.querySelector('#elsewhere')!.append(popup);
  };

  control.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      if (document.querySelector('#popup') === null) { open(); active = 0; }
      else active = Math.min(active + 1, CHOICES.length - 1);
    } else if (event.key === 'Enter' && document.querySelector('#popup') !== null) {
      commit();
    } else if (event.key === 'Escape') {
      close();
    }
  });
  control.addEventListener('click', () => {
    if (document.querySelector('#popup') === null) open();
  });
}

describe('driving a custom combobox', () => {
  it('opens with the keyboard, chooses, and confirms', async () => {
    portaled();

    const result = await driveCombobox(combobox(), options);

    expect(result).toEqual({ driven: true, rung: 'keyboard' });
    expect(combobox().textContent.trim()).toBe('Euro');
  });

  it('finds a popup the page rendered somewhere else entirely', async () => {
    portaled();
    await driveCombobox(combobox(), options);

    // Followed through `aria-controls`, not by looking under the trigger. A
    // popup portaled to the far end of the document is the common case, not the
    // exotic one.
    expect(document.querySelector('#control [role="option"]')).toBeNull();
    expect(combobox().textContent.trim()).not.toBe('Select…');
  });

  it('falls back to the pointer when the keyboard does not commit', async () => {
    // A component that opens on ArrowDown but only commits on a real click —
    // common where Enter is reserved for submitting the surrounding form.
    portaled({ commitOn: 'mousedown' });
    document.querySelector('#control')!.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') event.stopImmediatePropagation();
    }, true);

    const result = await driveCombobox(combobox(), options);

    expect(result).toEqual({ driven: true, rung: 'pointer' });
    expect(combobox().textContent.trim()).toBe('Euro');
  });

  it('maps the background’s draw onto a list only the agent can see', async () => {
    // The background sends a position in [0, 1) because it cannot know how many
    // options there are (FR-081). Every position must be reachable, including
    // the last — the off-by-one the reference makes with `<select>` (D3).
    const chosen = new Set<string>();
    for (const at of [0, 0.34, 0.67, 0.99]) {
      portaled();
      await driveCombobox(combobox(), { ...options, at });
      chosen.add(combobox().textContent.trim());
    }
    expect(chosen).toEqual(new Set(['Pound sterling', 'Euro', 'US dollar']));
  });
});

describe('leaving the page as it was found (BR-034-10)', () => {
  it('closes the popup and restores focus when nothing can be driven', async () => {
    document.body.innerHTML = `
      <input id="elsewhere">
      <div id="control" role="combobox" tabindex="0" aria-expanded="false"></div>`;
    const focused = document.querySelector<HTMLInputElement>('#elsewhere')!;
    focused.focus();

    const result = await driveCombobox(combobox(), options);

    expect(result.driven).toBe(false);
    if (!result.driven) expect(result.reason).toBe('combobox-offered-nothing');
    // A page left in a trapped state because we walked away mid-interaction is
    // a worse outcome than an unfilled field (UC-034 A10).
    expect(document.activeElement).toBe(focused);
  });

  it('closes a popup it opened but could not choose from', async () => {
    portaled();
    // Opens, and then refuses every commit — keyboard and pointer alike.
    const control = combobox();
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.stopImmediatePropagation();
    }, true);
    for (const type of ['mousedown', 'click']) {
      document.body.addEventListener(type, (event) => {
        if ((event.target as Element).getAttribute('role') === 'option') {
          event.stopImmediatePropagation();
        }
      }, true);
    }

    const result = await driveCombobox(control, options);

    expect(result.driven).toBe(false);
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('#popup')).toBeNull();
  });

  it('restores the page even when a handler throws', async () => {
    document.body.innerHTML = `
      <input id="elsewhere">
      <div id="control" role="combobox" tabindex="0" aria-controls="popup"></div>
      <ul id="popup" role="listbox"><li role="option">Only</li></ul>`;
    const focused = document.querySelector<HTMLInputElement>('#elsewhere')!;
    focused.focus();
    combobox().addEventListener('keydown', () => {
      throw new Error('the page threw');
    });

    const result = await driveCombobox(combobox(), options);

    // One hostile control is one control's failure (BR-004-11), and the restore
    // is in a `finally` precisely so a throw cannot skip it.
    expect(result.driven).toBe(false);
    expect(document.activeElement).toBe(focused);
  });

  it('never writes the hidden field behind the component (BR-034-9)', async () => {
    portaled();
    const carrier = document.createElement('input');
    carrier.type = 'hidden';
    carrier.name = 'currency';
    document.body.append(carrier);

    await driveCombobox(combobox(), options);

    // The shortcut that always "works" and always lies: it updates what the form
    // submits without updating what the component believes, so the page reads
    // "Select…" while the submission carries a value. Nothing here goes looking
    // for it — and the component's own commit is what set it, if anything did.
    expect(carrier.value).toBe('');
  });
});

describe('deciding whether a combobox is answered', () => {
  it('rejects a control still holding an open popup', () => {
    document.body.innerHTML = `<div id="control" role="combobox" aria-expanded="true">Euro</div>`;
    expect(stillAnswered(combobox()).landed).toBe(false);
  });

  it('rejects a control the page emptied', () => {
    document.body.innerHTML = `<div id="control" role="combobox"></div>`;
    expect(stillAnswered(combobox()).landed).toBe(false);
  });

  it('accepts a closed control showing something', () => {
    document.body.innerHTML = `<div id="control" role="combobox" aria-expanded="false">Euro</div>`;
    expect(stillAnswered(combobox()).landed).toBe(true);
  });

  it('cannot tell a placeholder from an answer, which is the documented gap', () => {
    // Recorded as a test rather than only as a comment, so the limitation is
    // asserted rather than remembered. Closing it means retaining the chosen
    // option's label to the end of the fill, which BR-034-11 forbids.
    document.body.innerHTML = `<div id="control" role="combobox" aria-expanded="false">Select…</div>`;
    expect(stillAnswered(combobox()).landed).toBe(true);
  });
});
