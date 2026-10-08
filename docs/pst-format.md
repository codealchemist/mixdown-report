# Logic Pro Channel EQ preset format (.pst)

Apple doesn't document this format. This is what Mixdown Report relies on, how it was worked out, and what is still unverified. The encoder and decoder are in [`src/core/eq/pst.js`](../src/core/eq/pst.js).

## Sources

- Robert Heaton, [Reverse engineering Logic Pro synth files](https://robertheaton.com/2017/07/17/reverse-engineering-logic-pro-synth-files/) (2017): `.pst` files are a 28-byte header containing `GAMETSPP`, followed by the plug-in's parameters as little-endian 32-bit floats in the plug-in's own parameter order, with no checksum.
- Logic's factory Channel EQ presets in `/Library/Application Support/Logic/Plug-In Settings/Channel EQ/` (149 files) and `#default.pst` in the Logic app bundle. Presets with descriptive names (`Low Cut`, `Hi Cut 20kHz`, `Hi-Fi EQ`, `Clean Up Kick`, `Final Mix - Pop`) identified each field.
- 16 user-saved Channel EQ presets from Logic Pro 11.

## Layout

All integers and floats are little-endian.

| Offset | Size | Value |
| --- | --- | --- |
| 0 | u32 | Total file size in bytes |
| 4 | u32 | `1` |
| 8 | u32 | Number of float parameters + 1 |
| 12 | 8 bytes | ASCII `GAMETSPP` |
| 20 | u32 | Plug-in id: `236` for Channel EQ |
| 24 | u32 | `0` |
| 28 | f32 × n | Parameters (below) |
| 28 + 4n | 8 bytes | Trailer: ASCII `xP8L`, then u32 `8` |

File size = 28 + 4n + 8. Three sizes exist in the wild: 220 bytes (n = 46, older Logic), 236 bytes (n = 50) and 240 bytes (n = 51, Logic 11, and what Mixdown Report writes).

### Parameters

Eight bands of four floats each, in Logic's left-to-right band order:

| Params | Band | Fields |
| --- | --- | --- |
| p0–p3 | 1 Low Cut | on (0/1), frequency Hz, slope ÷ 6, Q |
| p4–p7 | 2 Low Shelf | on, frequency Hz, gain dB, Q |
| p8–p11 | 3 Parametric | on, frequency Hz, gain dB, Q |
| p12–p15 | 4 Parametric | on, frequency Hz, gain dB, Q |
| p16–p19 | 5 Parametric | on, frequency Hz, gain dB, Q |
| p20–p23 | 6 Parametric | on, frequency Hz, gain dB, Q |
| p24–p27 | 7 High Shelf | on, frequency Hz, gain dB, Q |
| p28–p31 | 8 High Cut | on, frequency Hz, slope ÷ 6, Q |
| p32 | Output | gain dB |
| p33–p50 | Analyzer and display settings | written with Logic 11's default values |

Evidence for the less obvious fields:

- **On/off comes first in each band.** `#default.pst` has p0 = 0 and p28 = 0 (Logic's default has Low Cut and High Cut off); `Low Cut.pst` has p0 = 1; `Hi Cut 20kHz.pst` and `Clean Up Kick.pst` have p28 = 1.
- **Output gain is p32.** `Final Mix - Pop.pst` has p32 = −2.5; user presets carry small values such as +1, +2 and −0.1 there.
- **Slope.** Stored values are 1, 2, 3, 4 and 6. Read as dB/Oct ÷ 6 they give 6, 12, 18, 24 and 36 dB/Oct, matching Logic's slope menu (6/12/18/24/36/48). `Low Cut.pst` (value 6 = 36 dB/Oct) and the default High Cut (4 = 24 dB/Oct) fit.

Re-encoding Logic's `#default.pst` from the decoded model gives the same 240 bytes, apart from the last bit of three Q values (0.6 stored as 0.59999996), caused by the decoder rounding for display.

## Confirmed in Logic 11

Loading the calibration preset shows every value as written (37 Hz 18 dB/Oct, 61 Hz +2.5 dB, 123 Hz −3.5 dB Q 1.70, 456 Hz +4.5 dB Q 2.30, 1790 Hz −5.5 dB, 3460 Hz +6.0 dB Q 1.20, 9900 Hz −1.0 dB Q 0.60, 15400 Hz 36 dB/Oct, Gain −1.5 dB), which confirms the band layout, the output gain and the slope encoding (value × 6 = dB/Oct).

Two display details: Logic shows frequencies to three significant digits (9876 Hz appears as "9900 Hz"), and it truncates rather than rounds, so a Q of 0.9 stored as the float 0.89999998 appears as "0.89". The encoder therefore stores each value as the nearest float that is not smaller in magnitude.

Measured with the app's calibration on Logic 11: bells are about 1.3× narrower than the RBJ model at the same Q, shelf gains about 1.2× stronger, gains and shelf Q otherwise as modelled, and the 18 dB/Oct Low Cut is steeper near its corner than a Butterworth 18 dB/Oct. The calibration corrects exports for these.

## Still unverified

- **Mid/Side Processing.** One of p33–p50 is probably Channel EQ's Processing menu (Stereo, Left, Right, Mid, Side). It isn't identified yet, so exported presets always use stereo processing, and the app explains the Side low cut in text instead.

### Measuring it in the app (recommended)

"Measure Logic's Channel EQ" in the EQ presets section measures what Logic actually does: it plays a deterministic 30-second pink noise through Channel EQ with the calibration preset (or any preset you choose), and divides the bounce's power spectrum by the noise's. That gives Channel EQ's response independently of timing or latency. The app then fits how Logic interprets the stored values against its own filter model (Q and gain scaling for bells and shelves, which slope encoding the cuts use), checks that every band shows up, and can apply the correction to all exports. See `src/core/eq/calibration.js`.

### Checking by eye

1. In the app, open **Installing presets in Logic Pro** and download the **calibration preset**, or run `npm run calibration`, which writes it into `Channel EQ/Mixdown Report/`.
2. In Logic, open Channel EQ and choose **Mixdown Report › Mixdown Calibration**.
3. The bands should read: Low Cut 37 Hz 18 dB/Oct · Low Shelf 61 Hz +2.5 dB Q 0.9 · 123 Hz −3.5 dB Q 1.7 · 456 Hz +4.5 dB Q 2.3 · 1789 Hz −5.5 dB Q 0.8 · 3456 Hz +6 dB Q 1.2 · High Shelf 9876 Hz −1 dB Q 0.6 · High Cut 15432 Hz 36 dB/Oct · Gain −1.5 dB.

To identify the Processing parameter: in Logic, save the same Channel EQ twice, once with Processing set to Stereo and once set to Side, then compare the two files (`npm run pst -- file1.pst file2.pst` prints the parameters side by side).
