/**
 * Instrument library for per-track Channel EQ suggestions.
 *
 * Each instrument has a conservative corrective starting point (`base`) used by mix engineers,
 * and a list of mix problems it typically contributes to (`fixes`). Track EQs combine the two:
 * the base moves, plus extra moves for the problems the mix analysis actually found.
 */

export const GROUPS = Object.freeze(['Drums', 'Bass', 'Guitars', 'Keys', 'Synths', 'Orchestral', 'Vocals', 'Other']);

const cut = (freq, slope = 18, reason = 'Removes low end this part does not need, so kick and bass stay clear') => ({ type: 'lowCut', freq, slope, q: 0.71, reason });
const hiCut = (freq, slope = 12, reason) => ({ type: 'highCut', freq, slope, q: 0.71, reason });
const bell = (freq, gain, q, reason) => ({ type: 'peak', freq, gain, q, reason });
const lowShelf = (freq, gain, reason) => ({ type: 'lowShelf', freq, gain, q: 0.71, reason });
const highShelf = (freq, gain, reason) => ({ type: 'highShelf', freq, gain, q: 0.71, reason });

const MUD = 'Clears boxy low-mid build-up';
const AIR = 'Adds air and openness';

/**
 * @typedef {object} Instrument
 * @property {string} id
 * @property {string} name
 * @property {string} group one of GROUPS
 * @property {string[]} aliases words people use in track names, lower case
 * @property {boolean} [lowEnd] carries the low end (kick, bass): low problems are fixed with EQ, not a higher low cut
 * @property {import('./channel-eq.js').Move[]} base
 * @property {string[]} fixes mix problems this part usually contributes to, as `${bandId}:${'high'|'low'}`
 * @property {Record<string, string>} [notes] extra advice per problem
 */

/** @type {readonly Instrument[]} */
export const INSTRUMENTS = Object.freeze([
  // Drums
  { id: 'kick', name: 'Kick drum', group: 'Drums', aliases: ['kick', 'kik', 'bd', 'bass drum'], lowEnd: true,
    base: [cut(30, 24, 'Removes sub-rumble below the kick fundamental'), bell(60, 2, 1.2, 'Weight at the kick fundamental'), bell(350, -4, 2, 'Removes the cardboard "box" tone'), bell(3500, 2, 1.5, 'Beater click so the kick cuts through on small speakers')],
    fixes: ['sub:high', 'sub:low', 'low:high', 'low:low', 'upmid:low'] },
  { id: 'snare', name: 'Snare', group: 'Drums', aliases: ['snare', 'sn', 'snr'],
    base: [cut(80, 18), bell(200, 1.5, 1.2, 'Body'), bell(900, -2, 2.5, 'Tames boxiness and ring'), bell(5000, 2, 1, 'Crack and snap')],
    fixes: ['mid:high', 'upmid:low', 'pres:low'] },
  { id: 'toms', name: 'Toms', group: 'Drums', aliases: ['tom', 'toms', 'floor tom', 'rack tom'],
    base: [cut(60, 18), bell(100, 2, 1, 'Fullness'), bell(400, -3, 1.5, MUD), bell(4000, 1.5, 1.2, 'Stick attack')],
    fixes: ['lowmid:high', 'mid:high'] },
  { id: 'hihat', name: 'Hi-hat', group: 'Drums', aliases: ['hihat', 'hi-hat', 'hi hat', 'hh', 'hats'],
    base: [cut(300, 24, 'Keeps kick and snare spill out of the hat mic'), bell(3500, -1.5, 2, 'Softens clang'), highShelf(10000, 1.5, 'Shimmer')],
    fixes: ['upmid:high', 'pres:high', 'air:high', 'air:low'] },
  { id: 'overheads', name: 'Overheads / cymbals', group: 'Drums', aliases: ['overhead', 'overheads', 'oh', 'cymbal', 'cymbals', 'ride', 'crash'],
    base: [cut(150, 12, 'Leaves the low end to the close mics'), bell(400, -2, 1.4, MUD), highShelf(12000, 2, AIR)],
    fixes: ['lowmid:high', 'upmid:high', 'pres:high', 'pres:low', 'air:high', 'air:low'] },
  { id: 'room', name: 'Room mics', group: 'Drums', aliases: ['room', 'rooms', 'amb', 'ambience'],
    base: [cut(80, 18), bell(500, -2, 1.2, MUD), highShelf(8000, -1, 'Keeps room mics behind the close mics')],
    fixes: ['lowmid:high', 'mid:high'] },
  { id: 'drumbus', name: 'Drum kit (full, Drummer)', group: 'Drums', aliases: ['drums', 'drum', 'kit', 'drummer', 'drum kit', 'drum bus', 'dkd'], lowEnd: true,
    base: [cut(30, 24, 'Removes sub-rumble'), bell(400, -2, 1.2, MUD), bell(5000, 1.5, 0.9, 'Snap and definition')],
    fixes: ['sub:high', 'sub:low', 'low:high', 'low:low', 'lowmid:high', 'upmid:high', 'pres:high', 'pres:low', 'air:high', 'air:low'] },
  { id: 'percussion', name: 'Percussion', group: 'Drums', aliases: ['perc', 'percussion', 'shaker', 'tambourine', 'tamb', 'conga', 'bongo', 'clap', 'claps'],
    base: [cut(200, 18, 'Percussion rarely needs low end'), highShelf(10000, 1.5, AIR)],
    fixes: ['pres:high', 'air:high', 'air:low'] },
  // Bass
  { id: 'bassguitar', name: 'Bass guitar', group: 'Bass', aliases: ['bass', 'bs', 'bass guitar', 'bass gtr', 'electric bass', 'p bass', 'jazz bass'], lowEnd: true,
    base: [cut(35, 24, 'Removes inaudible sub that eats headroom'), bell(80, 1.5, 1.2, 'Weight'), bell(250, -2.5, 1.5, MUD), bell(800, 1.5, 1.5, 'Growl so the bass reads on small speakers'), hiCut(9000, 12, 'Removes string and fret noise')],
    fixes: ['sub:high', 'sub:low', 'low:high', 'low:low', 'lowmid:high', 'mid:low'] },
  { id: 'synthbass', name: 'Synth bass / 808', group: 'Bass', aliases: ['808', 'sub', 'sub bass', 'synth bass', 'synthbass', 'bass synth'], lowEnd: true,
    base: [cut(28, 24, 'Removes rumble under the fundamental'), bell(55, 1.5, 1, 'Sub weight'), bell(300, -2, 1.5, MUD)],
    fixes: ['sub:high', 'sub:low', 'low:high', 'low:low', 'lowmid:high'] },
  // Guitars
  { id: 'eguitarclean', name: 'Electric guitar (clean)', group: 'Guitars', aliases: ['guitar', 'gtr', 'electric', 'clean', 'clean guitar', 'strat', 'tele', 'egtr'],
    base: [cut(100, 18), bell(250, -2, 1.5, MUD), bell(3000, 1.5, 1.2, 'Pick attack and presence')],
    fixes: ['low:high', 'sub:high', 'lowmid:high', 'mid:high', 'mid:low', 'upmid:low', 'pres:low'] },
  { id: 'eguitardist', name: 'Electric guitar (distorted)', group: 'Guitars', aliases: ['guitar', 'gtr', 'distorted', 'dist', 'crunch', 'heavy', 'rhythm', 'lead guitar', 'solo', 'metal', 'drive', 'amp'],
    base: [cut(90, 18), bell(250, -2.5, 1.5, MUD), bell(3200, -2, 2, 'Takes the harsh edge off distortion'), hiCut(11000, 12, 'Removes amp fizz')],
    fixes: ['low:high', 'sub:high', 'lowmid:high', 'mid:high', 'upmid:high', 'pres:high', 'air:high'] },
  { id: 'aguitar', name: 'Acoustic guitar', group: 'Guitars', aliases: ['acoustic', 'ac', 'ac gtr', 'acoustic guitar', 'nylon', 'steel string', 'agtr'],
    base: [cut(100, 18), bell(200, -2.5, 1.2, 'Tames body boom from the soundhole'), highShelf(10000, 2, 'Sparkle and string detail')],
    fixes: ['low:high', 'lowmid:high', 'upmid:high', 'pres:low', 'air:low'] },
  // Keys
  { id: 'piano', name: 'Piano', group: 'Keys', aliases: ['piano', 'pno', 'grand', 'upright', 'keys'],
    base: [cut(50, 12), bell(300, -1.5, 1, MUD), bell(3000, 1, 1, 'Clarity'), highShelf(10000, 1, AIR)],
    fixes: ['lowmid:high', 'mid:high', 'upmid:low', 'air:low'] },
  { id: 'epiano', name: 'Electric piano / keys', group: 'Keys', aliases: ['rhodes', 'wurli', 'wurlitzer', 'ep', 'e piano', 'electric piano', 'keys', 'clav'],
    base: [cut(80, 18), bell(300, -1.5, 1, MUD), bell(2000, 1.5, 1, 'Bark and definition')],
    fixes: ['lowmid:high', 'mid:low', 'upmid:high'] },
  { id: 'organ', name: 'Organ', group: 'Keys', aliases: ['organ', 'b3', 'hammond', 'org'],
    base: [cut(70, 18), bell(250, -2, 1.2, MUD), bell(3000, 1, 1, 'Edge')],
    fixes: ['lowmid:high', 'mid:high'] },
  // Synths
  { id: 'pad', name: 'Synth pad', group: 'Synths', aliases: ['pad', 'pads', 'synth pad', 'ambient', 'atmos', 'texture'],
    base: [cut(150, 18, 'Pads sit above the bass and kick'), bell(350, -2, 1, MUD), hiCut(12000, 12, 'Keeps pads behind vocals and cymbals')],
    fixes: ['low:high', 'sub:high', 'lowmid:high', 'upmid:high', 'air:high'] },
  { id: 'synthlead', name: 'Synth lead', group: 'Synths', aliases: ['lead', 'synth', 'synth lead', 'lead synth', 'arp', 'pluck'],
    base: [cut(150, 18), bell(300, -1.5, 1, MUD), bell(2500, 1, 1, 'Focus')],
    fixes: ['lowmid:high', 'mid:low', 'upmid:high', 'pres:high'] },
  // Orchestral
  { id: 'strings', name: 'Strings (violins, violas)', group: 'Orchestral', aliases: ['strings', 'str', 'violin', 'violins', 'viola', 'violas', 'ensemble', 'orchestra'],
    base: [cut(120, 18), bell(300, -1.5, 1, MUD), bell(3000, -1, 2, 'Softens bow screech'), highShelf(10000, 1, AIR)],
    fixes: ['low:high', 'lowmid:high', 'upmid:high', 'air:low'] },
  { id: 'cello', name: 'Cello / double bass', group: 'Orchestral', aliases: ['cello', 'cellos', 'vc', 'double bass', 'contrabass', 'upright bass'],
    base: [cut(50, 12), bell(250, -1.5, 1.2, MUD), bell(2500, 1, 1.2, 'Bow definition')],
    fixes: ['lowmid:high', 'mid:high'] },
  { id: 'brass', name: 'Brass', group: 'Orchestral', aliases: ['brass', 'horns', 'horn', 'trumpet', 'tpt', 'trombone', 'tbn', 'sax'],
    base: [cut(100, 18), bell(400, -1.5, 1.2, MUD), bell(3000, -1.5, 2, 'Takes the bite off loud passages')],
    fixes: ['lowmid:high', 'mid:high', 'upmid:high'] },
  { id: 'woodwinds', name: 'Woodwinds', group: 'Orchestral', aliases: ['woodwind', 'woodwinds', 'flute', 'clarinet', 'oboe', 'bassoon'],
    base: [cut(120, 18), bell(300, -1.5, 1, MUD), highShelf(10000, 1, 'Breath and air')],
    fixes: ['lowmid:high', 'pres:high', 'air:low'] },
  // Vocals
  { id: 'leadvocal', name: 'Lead vocal', group: 'Vocals', aliases: ['vocal', 'vocals', 'vox', 'voice', 'lead vocal', 'lead vox', 'singer', 'lv'],
    base: [cut(90, 18, 'Removes handling noise, plosives and room rumble'), bell(250, -2, 1.5, MUD), bell(3000, 2, 1, 'Presence and intelligibility'), highShelf(12000, 2, AIR)],
    fixes: ['lowmid:high', 'mid:low', 'upmid:low', 'pres:high', 'pres:low', 'air:low'],
    notes: { 'pres:high': 'For sibilance, use DeEsser 2 (Frequency 6–7 kHz) before cutting more with EQ.' } },
  { id: 'backingvocals', name: 'Backing vocals', group: 'Vocals', aliases: ['backing', 'bv', 'bvs', 'bgv', 'bkg', 'harmony', 'harmonies', 'choir', 'background vocals', 'backing vocals'],
    base: [cut(150, 18, 'Thins backing vocals so the lead stays in front'), bell(300, -2, 1.2, MUD), bell(3000, -1, 1.5, 'Leaves presence for the lead vocal'), highShelf(12000, 1.5, AIR)],
    fixes: ['lowmid:high', 'upmid:high', 'pres:high', 'air:low'],
    notes: { 'pres:high': 'Stacked backing vocals multiply sibilance; DeEsser 2 on the bus helps.' } },
  { id: 'rapvocal', name: 'Rap / spoken vocal', group: 'Vocals', aliases: ['rap', 'mc', 'spoken', 'spoken word', 'narration', 'adlib', 'adlibs'],
    base: [cut(100, 18), bell(300, -2, 1.5, MUD), bell(4000, 2, 1.2, 'Consonant clarity'), highShelf(10000, 1, AIR)],
    fixes: ['lowmid:high', 'upmid:low', 'pres:high', 'pres:low'],
    notes: { 'pres:high': 'For sibilance, use DeEsser 2 before cutting more with EQ.' } },
  // Other
  { id: 'fx', name: 'FX / other', group: 'Other', aliases: ['fx', 'sfx', 'effects', 'riser', 'sweep', 'impact', 'noise', 'other'],
    base: [cut(80, 18)],
    fixes: ['low:high', 'sub:high'] },
]);

export const INSTRUMENT_BY_ID = Object.freeze(Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i])));

const words = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]+|[0-9]+/g) ?? []; // "solo2" → "solo 2"

/**
 * Instruments matching a typed filter, best first. Empty query returns all, in library order.
 * Matches the start of the name, the start of any word or alias, then anywhere.
 */
export function filterInstruments(query) {
  const q = String(query).trim().toLowerCase();
  if (!q) return [...INSTRUMENTS];
  const scored = [];
  for (const inst of INSTRUMENTS) {
    const name = inst.name.toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 4;
    else if (inst.aliases.some((a) => a === q)) score = 3.5;
    else if (inst.aliases.some((a) => a.startsWith(q)) || words(inst.name).some((w) => w.startsWith(q))) score = 3;
    else if (inst.group.toLowerCase().startsWith(q)) score = 2;
    else if (name.includes(q) || inst.aliases.some((a) => a.includes(q))) score = 1;
    if (score >= 0) scored.push({ inst, score: score + (inst.group.toLowerCase().startsWith(q) ? 0.2 : 0) }); // "guitar": Guitars before Bass guitar
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.inst);
}

/** Words that pick between similar instruments (for example clean vs distorted guitar). */
const HINTS = [
  [/\b(dist|distorted|crunch|heavy|metal|drive|solo|lead)\b/, 'eguitardist', /guitar|gtr/],
  [/\b(ac|acoustic|nylon)\b/, 'aguitar', /guitar|gtr|ac/],
  [/\b(808|sub)\b/, 'synthbass', /./],
  [/\b(bv|bvs|bgv|backing|harmony|harmonies|choir)\b/, 'backingvocals', /./],
];

/**
 * Best-guess instrument for a track name such as "gtr-dist-L" or "Lead Vox 2". Returns null when nothing matches.
 * Exact alias words win over partial matches; hint words decide between similar instruments.
 */
export function guessInstrument(trackName) {
  const text = words(trackName).join(' ');
  if (!text) return null;
  for (const [hint, id, requires] of HINTS) if (hint.test(text) && requires.test(text)) return id;
  let best = null;
  for (const inst of INSTRUMENTS) {
    for (const alias of inst.aliases) {
      const re = new RegExp(`\\b${alias.replace(/[^a-z0-9 ]/g, '')}\\b`);
      if (re.test(text) && (!best || alias.length > best.length)) best = { id: inst.id, length: alias.length };
    }
  }
  return best?.id ?? null;
}
