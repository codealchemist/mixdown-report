/**
 * Tonal-balance advice per band and direction. `mix` steps act on tracks in Logic Pro;
 * `eq(amount)` describes the gentle Stereo Out Channel EQ move for mastering.
 */
import { MINUS } from './format.js';

export const BAND_ADVICE = Object.freeze({
  sub: {
    high: {
      title: 'Too much sub-bass',
      why: 'Excess energy under 60 Hz eats headroom, makes the limiter pump and is inaudible on most phones and laptops.',
      mix: [
        'On kick and bass (or 808), open Channel EQ and set Low Cut to 25–30 Hz, 12 dB/Oct.',
        'Only kick and bass should carry content under 60 Hz: put Channel EQ Low Cut at 80–150 Hz on pads, keys, guitars and vocals.',
        'If the bass still dominates, lower its fader 1–2 dB before EQ-ing the master.',
      ],
      eq: (a) => `Low Shelf 50 Hz, ${MINUS}${a} dB, Q 0.71`,
    },
    low: {
      title: 'Sub-bass is light',
      why: 'The track can sound small on club systems, car stereos and good headphones.',
      mix: [
        'On the bass track, Channel EQ Low Shelf +2 dB at 60 Hz.',
        'For synth or 808 bass, layer a sine one octave down and blend it in under the main bass.',
        'If you mix on small speakers, check the low end on headphones before adding more.',
      ],
      eq: (a) => `Low Shelf 50 Hz, +${a} dB, Q 0.71`,
    },
  },
  low: {
    high: {
      title: 'Bass range is boomy',
      why: 'Too much 60–250 Hz makes the mix sound heavy and blurs kick and bass together.',
      mix: [
        "Solo kick and bass together. On the bass, Channel EQ bell −2 to −3 dB at the kick's punch frequency (usually 60–100 Hz), Q 1.5.",
        "Put Channel EQ Low Cut at 100–150 Hz on everything that isn't kick or bass.",
        'If kick and bass still mask each other, add Compressor on the bass with Side Chain set to the kick (Studio VCA, 4:1, fast attack, 2–4 dB reduction).',
      ],
      eq: (a) => `Bell 120 Hz, ${MINUS}${a} dB, Q 0.8`,
    },
    low: {
      title: 'Bass range is thin',
      why: 'The mix lacks weight and warmth next to commercial releases.',
      mix: [
        'Raise the bass fader 1–2 dB before reaching for EQ.',
        'Channel EQ on the bass: bell +2 dB at 80–100 Hz, Q 1.0.',
        "Check that Low Cut filters on kick and bass aren't set too high.",
      ],
      eq: (a) => `Bell 100 Hz, +${a} dB, Q 0.8`,
    },
  },
  lowmid: {
    high: {
      title: 'Muddy low mids',
      why: 'Build-up at 250–500 Hz is the most common home-mix problem. It makes everything sound cloudy and boxy.',
      mix: [
        'On guitars, keys, pads and vocals, sweep a narrow Channel EQ boost (+8 dB, Q 4) between 200 and 500 Hz to find the boxy spot, then cut 2–4 dB there.',
        "Put Channel EQ Low Cut at 100–200 Hz on every track that doesn't need low end.",
        'Low-cut your reverb returns (ChromaVerb, Space Designer) at 200–300 Hz.',
      ],
      eq: (a) => `Bell 300 Hz, ${MINUS}${a} dB, Q 1.0`,
    },
    low: {
      title: 'Low mids are scooped',
      why: 'Instruments may sound thin and lack body.',
      mix: [
        'Check for aggressive Low Cut filters on guitars, keys and vocals and lower them to 80–100 Hz.',
        'Channel EQ on the main harmonic instruments: bell +1.5 dB at 250–350 Hz, Q 1.0.',
      ],
      eq: (a) => `Bell 300 Hz, +${a} dB, Q 1.0`,
    },
  },
  mid: {
    high: {
      title: 'Mids are boxy or honky',
      why: 'Excess 500 Hz–2 kHz sounds nasal and crowded.',
      mix: [
        'Sweep 600 Hz–1.5 kHz on vocals, guitars and snare to find the honk, then cut 2–3 dB with Q 2.',
        'Check whether several parts sit in the same register; mute or pan one to compare.',
      ],
      eq: (a) => `Bell 1 kHz, ${MINUS}${a} dB, Q 0.9`,
    },
    low: {
      title: 'Mids are scooped',
      why: 'Vocals and lead instruments live here. A scoop pushes them back and makes the mix sound hollow on phones and laptops.',
      mix: [
        'Bring up the lead vocal and lead instruments 1 dB before boosting.',
        'Channel EQ on the lead vocal: bell +1.5 dB at 1–1.5 kHz, Q 1.0.',
      ],
      eq: (a) => `Bell 1 kHz, +${a} dB, Q 0.7`,
    },
  },
  upmid: {
    high: {
      title: 'Harsh upper mids',
      why: 'The ear is most sensitive at 2–4 kHz. Too much causes fatigue at volume.',
      mix: [
        'Check distorted guitars, synth leads and vocals: Channel EQ bell −2 to −3 dB at 2.5–3.5 kHz, Q 2.',
        'If harshness appears only on loud notes, put Multipressor on that track with one band at 2–5 kHz, ratio 3:1, 2–3 dB of reduction.',
      ],
      eq: (a) => `Bell 3 kHz, ${MINUS}${a} dB, Q 1.2`,
    },
    low: {
      title: 'Upper mids lack definition',
      why: 'Vocals and guitars can sound distant and words harder to follow.',
      mix: [
        'Channel EQ on the lead vocal: bell +2 dB at 3 kHz, Q 1.2.',
        'On snare and guitars, try +1.5 dB around 2.5 kHz for attack.',
      ],
      eq: (a) => `Bell 3 kHz, +${a} dB, Q 0.9`,
    },
  },
  pres: {
    high: {
      title: 'Presence range is sharp',
      why: 'Usually sibilant vocals or splashy cymbals at 4–8 kHz.',
      mix: [
        "Put DeEsser 2 on the lead vocal: Mode Relative, Frequency 6–7 kHz, lower Threshold until 's' sounds drop 3–5 dB.",
        'On overheads and hi-hats: Channel EQ bell −2 dB at 5–7 kHz, Q 1.5.',
      ],
      eq: (a) => `Bell 6 kHz, ${MINUS}${a} dB, Q 1.0`,
    },
    low: {
      title: 'Presence is low',
      why: 'The mix may sound veiled and lose clarity.',
      mix: ['Channel EQ on the lead vocal: High Shelf +2 dB at 5 kHz.', 'Check hi-hat and percussion levels.'],
      eq: (a) => `High Shelf 5 kHz, +${a} dB, Q 0.71`,
    },
  },
  air: {
    high: {
      title: 'Top end is too bright',
      why: 'Too much 8–16 kHz sounds brittle or hissy, and gets worse after limiting and lossy encoding.',
      mix: [
        'Check cymbals, hats and vocal breaths: High Shelf −2 dB at 10 kHz on overheads.',
        'Set High Cut at 8–10 kHz on reverb returns, and check for noisy tracks.',
      ],
      eq: (a) => `High Shelf 10 kHz, ${MINUS}${a} dB, Q 0.71`,
    },
    low: {
      title: 'Top end is dark',
      why: 'The mix may sound dull next to commercial releases.',
      mix: [
        'Channel EQ on vocals and overheads: High Shelf +2 dB at 10–12 kHz.',
        "Check that reverbs and synths aren't low-passed too hard.",
      ],
      eq: (a) => `High Shelf 12 kHz, +${a} dB, Q 0.71`,
    },
  },
});
