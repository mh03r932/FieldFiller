import { message } from '@/lib/platform/i18n';
import { getSettings } from '@/lib/platform/settings-store';
import {
  SETTINGS_FILE_TYPE,
  serialiseSettings,
  settingsFileName,
} from '@/lib/settings-file';
import type { OptionsHost } from './host';

/**
 * UC-025 — the configuration, out to a file.
 *
 * Its own module rather than a seventh function in `sections.ts`, because it is
 * not the shape those are. Every section there reads a slice of settings, draws
 * controls over it and writes the whole state back; this one edits nothing, has
 * no control to keep in sync, and its whole behaviour is in what happens after a
 * click. Putting it there would have meant explaining why the file's two
 * functions do not save.
 *
 * **An export is a read.** Nothing here writes settings, and the two failure
 * paths below leave storage exactly as they found it — which is the whole of the
 * failure postcondition, and is true by there being no write to fail rather than
 * by anything being rolled back.
 */
export function renderExport(host: OptionsHost, into: HTMLElement): void {
  const actions = document.createElement('div');
  actions.className = 'export-actions';

  const toFile = document.createElement('button');
  toFile.type = 'button';
  toFile.className = 'primary export-file';
  toFile.textContent = message('exportButton');
  toFile.addEventListener('click', () => {
    void exportToFile(host);
  });

  // Offered from the start rather than revealed after a failure, and A2 is the
  // reason it can be no other way. A download refused by the browser — a
  // policy, a full disk, a user cancelling the save — does not report back to
  // the page that started it: the anchor's click returns normally and nothing
  // else ever arrives. So a clipboard route that only appeared "on failure"
  // would be unreachable in precisely the case A2 describes, because the page
  // cannot know the case has happened. Standing offer instead, and the failure
  // message points at it for the failures we *can* see.
  const toClipboard = document.createElement('button');
  toClipboard.type = 'button';
  toClipboard.className = 'export-clipboard';
  toClipboard.textContent = message('exportClipboardButton');
  toClipboard.addEventListener('click', () => {
    void exportToClipboard(host);
  });

  actions.append(toFile, toClipboard);

  // A1, on the surface rather than only in the spec. The file holds what storage
  // holds, and this page saves every valid change as it is made — so the two
  // agree except for an edit that has not validated yet, which is exactly what
  // this sentence tells the user to expect. Saying it here is cheaper than
  // discovering it on the machine the file was imported onto.
  const stored = document.createElement('p');
  stored.className = 'hint';
  stored.textContent = message('exportStoredNote');

  // BR-025-5, in the interface because that is where the question is asked. "Is
  // it safe to commit this to a shared repository?" is the first thing this
  // feature raises, and the answer is yes for a structural reason the user
  // cannot see from here: passwords are generated per fill and never stored, so
  // the file carries policy and never a secret.
  const privacy = document.createElement('p');
  privacy.className = 'hint export-privacy';
  privacy.textContent = message('exportPrivacyNote');

  into.replaceChildren(actions, stored, privacy);
}

/**
 * The stored state, whole (UC-025 step 2, BR-025-1).
 *
 * From storage rather than from `host.settings()`, and the difference is small
 * but it is the one the use case names. This page holds the state in memory and
 * is optimistic about writes: a save that storage rejected leaves memory ahead
 * of storage, announced but not undone (UC-024 A2). Exporting memory would then
 * write a file describing a configuration no fill has ever run — the failure A1
 * exists to prevent, reached through the one door A1 does not describe.
 *
 * `getSettings` is a cached read that `onChanged` invalidates, so this is a
 * memory hit in the ordinary case and a storage read exactly when storage has
 * moved.
 */
async function currentFile(): Promise<{ readonly name: string; readonly text: string }> {
  const settings = await getSettings();
  return { name: settingsFileName(settings), text: serialiseSettings(settings) };
}

/**
 * BR-025-2: out through an anchor and an object URL, never `downloads`.
 *
 * The permission is forbidden by NFR-008 and `scripts/check-permissions.mjs`
 * fails the build on it, so this is not a workaround for a permission we have
 * not asked for — it is the route the project chose when it decided not to have
 * the permission at all. Written down here because it is the kind of constraint
 * that gets rediscovered during a refactor and "fixed" by adding the permission.
 */
async function exportToFile(host: OptionsHost): Promise<void> {
  let url: string | undefined;
  try {
    const file = await currentFile();
    const blob = new Blob([file.text], { type: SETTINGS_FILE_TYPE });
    url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();

    // Announced as *offered*, not as saved. The click above hands the file to
    // the browser and the browser decides what happens next — it may prompt,
    // save silently, or refuse — and none of those come back to this page. A
    // message claiming the file was written would be a guess dressed as a fact
    // the one time it matters, which is A2.
    host.announce(message('exportOffered', [file.name]));
  } catch (error) {
    // What this *can* catch: storage unreadable, a blob that could not be
    // constructed. Reported with the browser's own words and no diagnosis of
    // our own, per A2 — the page cannot see why the browser declined and must
    // not pretend to.
    host.announce(message('exportFailed', [describe(error)]));
  } finally {
    // Not synchronously after `click()`. The download reads the blob through
    // this URL and revoking it in the same task can cancel the read before it
    // starts; a task later, the browser has taken its reference and the URL is
    // ours to release. Skipping the revoke entirely would leak the whole
    // configuration into the page's blob store for as long as the options page
    // stays open, which BR-025-2 has no patience for either.
    const created = url;
    if (created !== undefined) setTimeout(() => URL.revokeObjectURL(created), 0);
  }
}

/** A2's second route: the same bytes, to the clipboard, when a file will not do. */
async function exportToClipboard(host: OptionsHost): Promise<void> {
  try {
    const file = await currentFile();
    await navigator.clipboard.writeText(file.text);
    host.announce(message('exportCopied'));
  } catch (error) {
    // Unlike the download, this one does report its own failure — a clipboard
    // write rejects when the permission is refused or the page is not focused —
    // so the user is told which of the two routes is unavailable rather than
    // being left to guess that both are.
    host.announce(message('exportCopyFailed', [describe(error)]));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
