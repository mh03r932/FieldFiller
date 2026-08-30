import type { ControlOption, FieldDescriptor, FieldValue } from '../protocol';
import { createPersona, type Persona, type Random } from '../persona/persona';
import type { Generator, Rule } from '../settings';
import type { Selection } from './match';
import { generateFromTemplate, parseTemplate } from './template';
import { generateFromRegex, parseRegex } from './regex-subset';
import { formatDate, randomDate } from './dates';

/**
 * Turning a matched rule into a value for one control.
 *
 * Returns `undefined` whenever the rule cannot produce something this control
 * could legally hold — an unusable pattern, or a value no option matches. The
 * caller then falls through to the persona-driven generator, which is DD-005's
 * rule: a rule that cannot apply degrades to the built-in behaviour rather than
 * leaving a field empty.
 */

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'dolore', 'magna', 'aliqua',
  'enim', 'minim', 'veniam', 'quis', 'nostrud', 'ullamco', 'laboris', 'aliquip',
];

type RuleValue = {
  /** The text the rule produced, before any control-shaped interpretation. */
  readonly text: string;
  readonly provenance: string;
};

/**
 * The string a rule generates for this field, or `undefined` if it cannot.
 *
 * Split from `applyToControl` so the options page can preview a rule's output
 * without a control to write it to (UC-013).
 */
export function generateRuleText(
  rule: Rule,
  persona: Persona,
  random: Random,
): RuleValue | undefined {
  const generator = rule.generator;
  const fromPersona = personaValue(generator, persona, rule.fromPersona, random);
  if (fromPersona !== undefined) {
    return {
      text: fromPersona.text,
      provenance: `rule "${rule.label}" → ${fromPersona.origin}`,
    };
  }

  const text = synthesise(generator, random);
  if (text === undefined) return undefined;

  return { text, provenance: `rule "${rule.label}" → ${generator.type}` };
}

/**
 * Persona-backed types, honouring the rule's coherence flag (DD-005).
 *
 * With the flag on — the default — the value is the *fill's* persona, so a rule
 * writing an email cannot desynchronise the page's own confirmation field or
 * summary. With it off, a throwaway persona is built from this control's own
 * random stream: still internally plausible, still deterministic for the control
 * (FR-080), just unrelated to the rest of the form.
 */
function personaValue(
  generator: Generator,
  persona: Persona,
  fromPersona: boolean,
  random: Random,
): { text: string; origin: string } | undefined {
  const source = fromPersona ? persona : createPersona(random);
  const origin = fromPersona ? 'persona' : 'fresh';

  switch (generator.type) {
    case 'name': {
      const text =
        generator.part === 'first'
          ? source.firstName
          : generator.part === 'last'
            ? source.lastName
            : source.fullName;
      return { text, origin: `${origin} ${generator.part} name` };
    }
    case 'email':
      return { text: source.email, origin: `${origin} email` };
    case 'username':
      return { text: source.username, origin: `${origin} username` };
    case 'organisation':
      return { text: source.organisation, origin: `${origin} organisation` };
    case 'telephone':
      return { text: source.phone, origin: `${origin} telephone` };
    case 'url':
      return { text: source.url, origin: `${origin} URL` };
    default:
      return undefined;
  }
}

/** The types with no persona counterpart. `undefined` means "unusable rule". */
function synthesise(generator: Generator, random: Random): string | undefined {
  switch (generator.type) {
    case 'constant':
      return generator.value;

    case 'list': {
      // Independent per field, seeded by the control's token (FR-080), so two
      // fields may legitimately draw the same item and a control refilled in a
      // later pass draws the same one again (DD-005).
      const index = Math.floor(random() * generator.items.length);
      return generator.items[index];
    }

    case 'number': {
      const span = generator.max - generator.min;
      const value = generator.min + random() * span;
      return value.toFixed(generator.decimals);
    }

    case 'date':
      return formatDate(randomDate(generator.from, generator.to, random), generator.format);

    case 'text': {
      const span = generator.maxWords - generator.minWords;
      const count = generator.minWords + Math.floor(random() * (span + 1));
      const words = Array.from(
        { length: count },
        () => LOREM_WORDS[Math.floor(random() * LOREM_WORDS.length)] ?? 'lorem',
      );
      const sentence = words.join(' ');
      return sentence.charAt(0).toUpperCase() + sentence.slice(1);
    }

    case 'alphanumeric': {
      // Re-parsed here rather than carried from validation, because a rule can
      // reach a fill without ever passing through the options page — imported,
      // or synced from a device running a newer version (FR-070 is authoring
      // time; this is the runtime guard behind it).
      const parsed = parseTemplate(generator.template);
      return parsed.ok ? generateFromTemplate(parsed.parts, random) : undefined;
    }

    case 'regex': {
      const parsed = parseRegex(generator.pattern);
      return parsed.ok ? generateFromRegex(parsed.node, random) : undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Shapes a rule's text into a value this control can actually take.
 *
 * For controls that publish options, the text is matched against them rather
 * than written: typing "Germany" into a `<select>` is not a legal write, and a
 * rule saying `country → Germany` should select the option, not fail. No match
 * returns `undefined` so the built-in picker runs — the rule was about *which*
 * option, and if it names one that is not offered there is nothing to honour.
 */
export function applyToControl(
  selection: Selection,
  value: RuleValue,
  descriptor: FieldDescriptor,
  constrain: (text: string, descriptor: FieldDescriptor) => string,
): FieldValue | undefined {
  const provenance = `${value.provenance} (matched ${selection.source})`;

  switch (descriptor.kind) {
    case 'select-one':
    case 'select-multiple':
    case 'radio': {
      const option = matchOption(descriptor.options ?? [], value.text);
      if (option === undefined) return undefined;
      return {
        ref: descriptor.ref,
        as: 'choice',
        values: [option.value],
        provenance: `${provenance} → option "${option.label || option.value}"`,
      };
    }

    // A checkbox has no options to match against and a custom combobox does not
    // publish its own, so neither can honour a text rule. Both fall through to
    // the built-in behaviour rather than being written with something arbitrary.
    case 'checkbox':
    case 'combobox':
      return undefined;

    default:
      return {
        ref: descriptor.ref,
        as: 'text',
        // The page's own constraints still bound the result (BR-004-7, FR-072).
        // A rule supplies policy; it does not get to produce a value the form
        // will reject, which is ND-11 restated.
        value: constrain(value.text, descriptor),
        provenance,
      };
  }
}

/**
 * The option a rule's text names.
 *
 * Value and label are both tried, case-insensitively and trimmed, because a user
 * writing `Germany` means the option that reads Germany and has no reason to
 * know the page's value for it is `DE`.
 */
function matchOption(options: readonly ControlOption[], text: string): ControlOption | undefined {
  const wanted = text.trim().toLowerCase();
  if (wanted === '') return undefined;

  return options.find(
    (option) =>
      !option.disabled &&
      (option.value.trim().toLowerCase() === wanted || option.label.trim().toLowerCase() === wanted),
  );
}
