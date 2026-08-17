import type { Random } from '../persona';
import {
  between,
  digits,
  ean13CheckDigit,
  ibanCheckDigits,
  type Corpus,
  type Place,
} from './corpus';

/**
 * Switzerland, German-speaking.
 *
 * Municipalities are real, each with the PLZ it actually holds and the canton it
 * sits in — the trio a Swiss address form validates as a unit. People and
 * streets are invented; the street *forms* are real, because `-strasse`,
 * `-weg` and `-gasse` are how the country writes an address and a fictional
 * suffix would make every generated address obviously wrong.
 *
 * **On the two identifiers this locale emits.** An AHV number and a Swiss IBAN
 * are generated with correct check digits, because a number that fails the
 * page's own validation is useless for the thing the extension exists to do —
 * an AHV field that rejects every value tells the tester nothing about their
 * form. Both are synthetic: the AHV body is random within the 756 namespace and
 * the IBAN uses a test bank clearing number. Neither is looked up, derived from
 * a person, or retained (§4, NFR-010). They are test data that passes a format
 * check, which is the whole point, and nothing about them makes them belong to
 * anybody.
 */

const FIRST_NAMES = [
  'Adrian', 'Alexander', 'Alina', 'Andrea', 'Andreas', 'Anita', 'Anja', 'Anna', 'Annina', 'Barbara',
  'Beat', 'Benjamin', 'Bernhard', 'Bettina', 'Bruno', 'Carla', 'Caroline', 'Cédric', 'Chantal', 'Christian',
  'Christina', 'Christoph', 'Claudia', 'Corinne', 'Cornelia', 'Damian', 'Daniel', 'Daniela', 'David', 'Deborah',
  'Denis', 'Dominik', 'Doris', 'Edith', 'Elena', 'Elias', 'Elisabeth', 'Emil', 'Emma', 'Erika',
  'Ernst', 'Esther', 'Eva', 'Fabian', 'Fabienne', 'Felix', 'Fiona', 'Florian', 'Franziska', 'Fredy',
  'Gabriel', 'Gabriela', 'Georg', 'Gian', 'Gianna', 'Gilbert', 'Hanna', 'Hans', 'Heidi', 'Heinz',
  'Helena', 'Herbert', 'Hugo', 'Ingrid', 'Irene', 'Iris', 'Isabelle', 'Jakob', 'Jan', 'Janine',
  'Jasmin', 'Joel', 'Johanna', 'Johannes', 'Jonas', 'Judith', 'Julia', 'Julian', 'Jürg', 'Karin',
  'Karl', 'Katharina', 'Kevin', 'Klara', 'Kurt', 'Lara', 'Laura', 'Lea', 'Leandro', 'Lena',
  'Leon', 'Linda', 'Livia', 'Lorenz', 'Lucas', 'Ludwig', 'Luca', 'Lukas', 'Madeleine', 'Manuel',
  'Manuela', 'Marc', 'Marcel', 'Margrit', 'Maria', 'Marianne', 'Marina', 'Mario', 'Marion', 'Markus',
  'Martin', 'Martina', 'Matthias', 'Melanie', 'Michael', 'Michèle', 'Mirjam', 'Monika', 'Nadia', 'Nadine',
  'Nathalie', 'Nicolas', 'Nicole', 'Nina', 'Noah', 'Norbert', 'Olivia', 'Oliver', 'Pascal', 'Patricia',
  'Patrick', 'Paul', 'Petra', 'Philipp', 'Pia', 'Rafael', 'Ramona', 'Regina', 'Regula', 'Reto',
  'Rita', 'Robert', 'Roger', 'Roland', 'Rolf', 'Roman', 'Ruth', 'Sabine', 'Sabrina', 'Samuel',
  'Sandra', 'Sara', 'Sarah', 'Sebastian', 'Selina', 'Silvia', 'Simon', 'Simone', 'Sonja', 'Sophie',
  'Stefan', 'Stefanie', 'Stephan', 'Susanne', 'Sven', 'Sylvia', 'Tanja', 'Thomas', 'Tobias', 'Ursula',
  'Urs', 'Valentin', 'Vanessa', 'Verena', 'Veronika', 'Victor', 'Vinzenz', 'Walter', 'Werner', 'Yvonne',
];

const LAST_NAMES = [
  'Aebi', 'Ackermann', 'Aeschlimann', 'Albrecht', 'Ammann', 'Amrein', 'Anderegg', 'Arnold', 'Bachmann', 'Bader',
  'Bär', 'Bättig', 'Bauer', 'Baumann', 'Baumgartner', 'Beck', 'Berger', 'Bernasconi', 'Bieri', 'Bischof',
  'Blaser', 'Bögli', 'Bolliger', 'Bosshard', 'Brand', 'Brändli', 'Brunner', 'Bucher', 'Bühler', 'Bühlmann',
  'Burger', 'Burri', 'Christen', 'Dähler', 'Dubach', 'Duss', 'Eberhard', 'Egger', 'Egli', 'Ehrler',
  'Eichenberger', 'Elmer', 'Erni', 'Etter', 'Fankhauser', 'Farner', 'Fasel', 'Felber', 'Fischer', 'Flückiger',
  'Forster', 'Frei', 'Frey', 'Fricker', 'Frischknecht', 'Fuchs', 'Furrer', 'Gasser', 'Geiger', 'Gerber',
  'Giger', 'Glaus', 'Gnägi', 'Graf', 'Grossenbacher', 'Gubler', 'Gut', 'Haas', 'Häfliger', 'Hafner',
  'Halter', 'Hänggi', 'Hartmann', 'Hasler', 'Hauser', 'Hebeisen', 'Hediger', 'Hegglin', 'Heiniger', 'Held',
  'Hermann', 'Hess', 'Hirt', 'Hodel', 'Hofer', 'Hoffmann', 'Hofmann', 'Hohl', 'Hostettler', 'Huber',
  'Hugentobler', 'Hunziker', 'Hürlimann', 'Imhof', 'Isler', 'Iten', 'Jäggi', 'Jenni', 'Jost', 'Käser',
  'Kaufmann', 'Keller', 'Kern', 'Kessler', 'Kiener', 'Kobel', 'Koch', 'Kohler', 'Kramer', 'Krebs',
  'Küng', 'Kunz', 'Kurmann', 'Lang', 'Lanz', 'Lehmann', 'Leuenberger', 'Leutwyler', 'Lienhard', 'Locher',
  'Lüthi', 'Lustenberger', 'Lutz', 'Marti', 'Martinelli', 'Mathys', 'Maurer', 'Meier', 'Merz', 'Mettler',
  'Meyer', 'Michel', 'Möckli',
  'Mohler', 'Moser', 'Müller', 'Näf', 'Neuenschwander', 'Niederberger', 'Nussbaumer',
  'Oberli', 'Odermatt', 'Oppliger', 'Ott', 'Pfister', 'Portmann', 'Probst', 'Räber', 'Ramseier', 'Rast',
  'Rieder', 'Riesen', 'Ritter', 'Roth', 'Rüegg', 'Rüfenacht', 'Ruf', 'Rufer', 'Rutishauser', 'Salzmann',
  'Schaad', 'Schaffner', 'Schär', 'Schaub', 'Scheidegger', 'Schenk', 'Scherrer', 'Schiess', 'Schlegel', 'Schmid',
  'Schmidt', 'Schneeberger', 'Schneider', 'Schnyder', 'Schoch', 'Schöni', 'Schuler', 'Schürch', 'Schwab', 'Schwarz',
  'Seiler', 'Senn', 'Sigrist', 'Sommer', 'Spahr', 'Spichiger', 'Stadelmann', 'Stalder', 'Staub', 'Stauffer',
  'Steiger', 'Stettler', 'Steiner', 'Stocker', 'Stöckli', 'Strub', 'Studer', 'Stucki', 'Stutz', 'Suter',
  'Sutter', 'Tanner', 'Thommen', 'Trachsel', 'Tschanz', 'Tschudi', 'Ulrich', 'Vogel', 'Vogt', 'Von Arx',
  'Wagner', 'Walder', 'Walther', 'Weber', 'Wehrli', 'Weibel', 'Wenger', 'Werner', 'Wettstein', 'Widmer',
  'Wiederkehr', 'Wild', 'Winkler', 'Wirth', 'Wirz', 'Wittwer', 'Wolf', 'Wüthrich', 'Wyss', 'Zaugg',
  'Zbinden', 'Zehnder', 'Zeller', 'Ziegler', 'Zimmermann', 'Zingg', 'Zryd', 'Zubler', 'Zürcher', 'Zwahlen',
];

/**
 * Combined with the suffixes below, and joined without a space.
 *
 * `Ahornweg`, not `Ahorn Weg` — a Swiss street name is one word, and a space
 * would make every address here read as a translation.
 */
const STREET_STEMS = [
  'Ahorn', 'Akazien', 'Alpen', 'Alte Post', 'Amsel', 'Apfelbaum', 'Bach', 'Bahnhof', 'Baum', 'Berg',
  'Birken', 'Blumen', 'Brunnen', 'Buchen', 'Burg', 'Dorf', 'Eichen', 'Erlen', 'Esche', 'Falken',
  'Feld', 'Felsen', 'Fichten', 'Finken', 'Föhren', 'Forst', 'Garten', 'Gerbe', 'Gips', 'Haldern',
  'Hasel', 'Heide', 'Hirschen', 'Hof', 'Holunder', 'Hügel', 'Kapellen', 'Kastanien', 'Kirch', 'Kirsch',
  'Klee', 'Kloster', 'Krähen', 'Kreuz', 'Lärchen', 'Laub', 'Lerchen', 'Linden', 'Löwen', 'Malven',
  'Matten', 'Meisen', 'Mühle', 'Nelken', 'Nuss', 'Ober', 'Obstgarten', 'Pappel', 'Pfarr', 'Platanen',
  'Quellen', 'Raben', 'Rain', 'Reben', 'Ried', 'Ringgi', 'Rosen', 'Rossberg', 'Rüti', 'Salmen',
  'Schaf', 'Schmiede', 'Schul', 'Schwalben', 'Segel', 'Sonnen', 'Spital', 'Stadel', 'Stein', 'Sternen',
  'Storchen', 'Tannen', 'Taubenschlag', 'Ulmen', 'Unter', 'Veilchen', 'Vogelsang', 'Wald', 'Wasser', 'Weiden',
  'Wein', 'Wiesen', 'Winkel', 'Zeder', 'Ziegelei', 'Zwetschgen',
];

const STREET_SUFFIXES = ['strasse', 'weg', 'gasse', 'platz', 'rain', 'halde', 'matt', 'hof'];

const ORGANISATION_STEMS = [
  'Alpsteig', 'Bergquell', 'Brunnenhof', 'Dreilinden', 'Eichhalde', 'Felsentor', 'Föhrenpark', 'Gletscher',
  'Grüntal', 'Hochmatt', 'Kiesgrube', 'Lindenhof', 'Möwenberg', 'Nordhang', 'Oberried', 'Pilatusblick',
  'Quellenhof', 'Rebhalde', 'Rheinbogen', 'Rosengarten', 'Säntisblick', 'Schattenberg', 'Seefeld', 'Sonnenrain',
  'Steinbruch', 'Tannwald', 'Thalmatt', 'Uferpark', 'Vierwald', 'Waldegg', 'Wasserturm', 'Weinberg',
  'Wildbach', 'Zeitglocken', 'Zollhaus', 'Zwölfhorn',
];

const ORGANISATION_SUFFIXES = [
  'AG', 'GmbH', 'Holding AG', 'Systems AG', 'Technik AG', 'Logistik GmbH', 'Beratung GmbH', 'Werke AG',
  'Industrie AG', 'Treuhand AG', 'Bau AG', 'Handels GmbH', 'Labor AG', 'Immobilien AG',
];

const JOB_TITLES = [
  'Anlagenführer', 'Applikationsentwicklerin', 'Aussendienstmitarbeiter', 'Bauführerin', 'Berufsbildner',
  'Betriebsleiterin', 'Buchhalter', 'Chemielaborantin', 'Controllerin', 'Dispomanager',
  'Einkäuferin', 'Elektroinstallateur', 'Fachfrau Gesundheit', 'Facility Manager', 'Finanzberaterin',
  'Geschäftsführer', 'Grafikerin', 'Hauswart', 'Immobilienbewirtschafterin', 'Informatikerin',
  'Ingenieurin', 'Kaufmännische Angestellte', 'Konstrukteur', 'Kundenberaterin', 'Laborant',
  'Lagerlogistiker', 'Lehrerin', 'Logopädin', 'Maschinenbauingenieur', 'Mediamatikerin',
  'Netzwerkadministrator', 'Personalfachfrau', 'Pflegefachmann', 'Polymechaniker', 'Produktmanagerin',
  'Projektleiter', 'Qualitätsprüferin', 'Rechtsanwältin', 'Redaktorin', 'Sachbearbeiterin',
  'Schreiner', 'Sicherheitsbeauftragter', 'Softwareentwicklerin', 'Sozialarbeiter', 'Steuerberaterin',
  'Systemtechniker', 'Testingenieurin', 'Tierärztin', 'Treuhänderin', 'Verkaufsleiter',
  'Versicherungsberaterin', 'Zahnärztin',
];

/** Real municipalities, each with a PLZ it actually holds and its canton. */
const PLACES: readonly Place[] = [
  { locality: 'Aarau', region: 'Aargau', regionCode: 'AG', postalPrefix: '5000' },
  { locality: 'Altdorf', region: 'Uri', regionCode: 'UR', postalPrefix: '6460' },
  { locality: 'Appenzell', region: 'Appenzell Innerrhoden', regionCode: 'AI', postalPrefix: '9050' },
  { locality: 'Baar', region: 'Zug', regionCode: 'ZG', postalPrefix: '6340' },
  { locality: 'Baden', region: 'Aargau', regionCode: 'AG', postalPrefix: '5400' },
  { locality: 'Basel', region: 'Basel-Stadt', regionCode: 'BS', postalPrefix: '4051' },
  { locality: 'Bellinzona', region: 'Ticino', regionCode: 'TI', postalPrefix: '6500' },
  { locality: 'Bern', region: 'Bern', regionCode: 'BE', postalPrefix: '3011' },
  { locality: 'Biel/Bienne', region: 'Bern', regionCode: 'BE', postalPrefix: '2502' },
  { locality: 'Brugg', region: 'Aargau', regionCode: 'AG', postalPrefix: '5200' },
  { locality: 'Burgdorf', region: 'Bern', regionCode: 'BE', postalPrefix: '3400' },
  { locality: 'Chur', region: 'Graubünden', regionCode: 'GR', postalPrefix: '7000' },
  { locality: 'Delémont', region: 'Jura', regionCode: 'JU', postalPrefix: '2800' },
  { locality: 'Dietikon', region: 'Zürich', regionCode: 'ZH', postalPrefix: '8953' },
  { locality: 'Dübendorf', region: 'Zürich', regionCode: 'ZH', postalPrefix: '8600' },
  { locality: 'Emmen', region: 'Luzern', regionCode: 'LU', postalPrefix: '6020' },
  { locality: 'Frauenfeld', region: 'Thurgau', regionCode: 'TG', postalPrefix: '8500' },
  { locality: 'Fribourg', region: 'Fribourg', regionCode: 'FR', postalPrefix: '1700' },
  { locality: 'Genève', region: 'Genève', regionCode: 'GE', postalPrefix: '1201' },
  { locality: 'Glarus', region: 'Glarus', regionCode: 'GL', postalPrefix: '8750' },
  { locality: 'Grenchen', region: 'Solothurn', regionCode: 'SO', postalPrefix: '2540' },
  { locality: 'Herisau', region: 'Appenzell Ausserrhoden', regionCode: 'AR', postalPrefix: '9100' },
  { locality: 'Horgen', region: 'Zürich', regionCode: 'ZH', postalPrefix: '8810' },
  { locality: 'Kloten', region: 'Zürich', regionCode: 'ZH', postalPrefix: '8302' },
  { locality: 'Kreuzlingen', region: 'Thurgau', regionCode: 'TG', postalPrefix: '8280' },
  { locality: 'Kriens', region: 'Luzern', regionCode: 'LU', postalPrefix: '6010' },
  { locality: 'Lausanne', region: 'Vaud', regionCode: 'VD', postalPrefix: '1003' },
  { locality: 'Liestal', region: 'Basel-Landschaft', regionCode: 'BL', postalPrefix: '4410' },
  { locality: 'Locarno', region: 'Ticino', regionCode: 'TI', postalPrefix: '6600' },
  { locality: 'Lugano', region: 'Ticino', regionCode: 'TI', postalPrefix: '6900' },
  { locality: 'Luzern', region: 'Luzern', regionCode: 'LU', postalPrefix: '6003' },
  { locality: 'Martigny', region: 'Valais', regionCode: 'VS', postalPrefix: '1920' },
  { locality: 'Montreux', region: 'Vaud', regionCode: 'VD', postalPrefix: '1820' },
  { locality: 'Neuchâtel', region: 'Neuchâtel', regionCode: 'NE', postalPrefix: '2000' },
  { locality: 'Nyon', region: 'Vaud', regionCode: 'VD', postalPrefix: '1260' },
  { locality: 'Olten', region: 'Solothurn', regionCode: 'SO', postalPrefix: '4600' },
  { locality: 'Rapperswil', region: 'St. Gallen', regionCode: 'SG', postalPrefix: '8640' },
  { locality: 'Sarnen', region: 'Obwalden', regionCode: 'OW', postalPrefix: '6060' },
  { locality: 'Schaffhausen', region: 'Schaffhausen', regionCode: 'SH', postalPrefix: '8200' },
  { locality: 'Schwyz', region: 'Schwyz', regionCode: 'SZ', postalPrefix: '6430' },
  { locality: 'Sion', region: 'Valais', regionCode: 'VS', postalPrefix: '1950' },
  { locality: 'Solothurn', region: 'Solothurn', regionCode: 'SO', postalPrefix: '4500' },
  { locality: 'St. Gallen', region: 'St. Gallen', regionCode: 'SG', postalPrefix: '9000' },
  { locality: 'Stans', region: 'Nidwalden', regionCode: 'NW', postalPrefix: '6370' },
  { locality: 'Thun', region: 'Bern', regionCode: 'BE', postalPrefix: '3600' },
  { locality: 'Uster', region: 'Zürich', regionCode: 'ZH', postalPrefix: '8610' },
  { locality: 'Vevey', region: 'Vaud', regionCode: 'VD', postalPrefix: '1800' },
  { locality: 'Wettingen', region: 'Aargau', regionCode: 'AG', postalPrefix: '5430' },
  { locality: 'Wil', region: 'St. Gallen', regionCode: 'SG', postalPrefix: '9500' },
  { locality: 'Winterthur', region: 'Zürich', regionCode: 'ZH', postalPrefix: '8400' },
  { locality: 'Wohlen', region: 'Aargau', regionCode: 'AG', postalPrefix: '5610' },
  { locality: 'Yverdon-les-Bains', region: 'Vaud', regionCode: 'VD', postalPrefix: '1400' },
  { locality: 'Zofingen', region: 'Aargau', regionCode: 'AG', postalPrefix: '4800' },
  { locality: 'Zug', region: 'Zug', regionCode: 'ZG', postalPrefix: '6300' },
  { locality: 'Zürich', region: 'Zürich', regionCode: 'ZH', postalPrefix: '8001' },
];

/**
 * An AHV number: `756.XXXX.XXXX.CC`.
 *
 * 756 is Switzerland's country code in the underlying EAN-13 numbering, and the
 * final digit is that standard's check digit over the preceding twelve. Computed
 * rather than randomised, because a Swiss form validates it and a number that
 * fails is worthless as test data — which is the only reason this is emitted at
 * all. The eight middle digits are random: nothing looks anybody up.
 */
function ahvNumber(random: Random): string {
  const body = `756${digits(9, random)}`;
  const check = ean13CheckDigit(body);
  return `${body.slice(0, 3)}.${body.slice(3, 7)}.${body.slice(7, 11)}.${body.slice(11)}${String(check)}`;
}

/**
 * A Swiss IBAN: `CH` + two check digits + a five-digit clearing number + a
 * twelve-character account number.
 *
 * The clearing number is drawn from the 09000 range, which is reserved and
 * belongs to no operating bank — so the result validates as an IBAN and points
 * at nothing. The check digits are computed by ISO 13616's mod-97 rule for the
 * same reason the AHV check digit is: a payment form rejects anything else.
 */
function swissIban(random: Random): string {
  const clearing = `09${String(between(0, 999, random)).padStart(3, '0')}`;
  const account = digits(12, random);
  const bban = `${clearing}${account}`;
  const grouped = `CH${ibanCheckDigits('CH', bban)}${bban}`;
  return (grouped.match(/.{1,4}/g) ?? [grouped]).join(' ');
}

export const DE_CH: Corpus = {
  locale: 'de-CH',
  country: 'Schweiz',
  countryCode: 'CH',

  firstNames: FIRST_NAMES,
  lastNames: LAST_NAMES,
  streetStems: STREET_STEMS,
  streetSuffixes: STREET_SUFFIXES,
  organisationStems: ORGANISATION_STEMS,
  organisationSuffixes: ORGANISATION_SUFFIXES,
  jobTitles: JOB_TITLES,
  places: PLACES,

  // Number after the street, and no comma — `Bahnhofstrasse 12`.
  streetLine: (street, number) => `${street} ${String(number)}`,
  // A PLZ is the whole code, not a prefix: four digits identify the place
  // outright, so unlike a ZIP there is nothing left to generate.
  postalCode: (place) => place.postalPrefix,

  // 07X is the Swiss mobile range. Written in the international form a form is
  // most likely to accept, since the national form varies by field.
  phone: (random) =>
    `+41 7${String(between(5, 9, random))} ${digits(3, random)} ${digits(2, random)} ${digits(2, random)}`,

  nationalId: ahvNumber,
  iban: swissIban,
};
