# PD200W protocol map

This map was verified on USB VID:PID `352f:0411`, firmware 1.0.4, using Maono
Link 3.6.9 for macOS. The HID interface has usage page `0x0c`, usage `0x01`, and
64-byte input/output reports.

## Random register packets

A write is 64 bytes, zero-padded after the checksum:

```text
00 c4 0b 00 00 03 AA AA VV VV CC CC 00 ...
```

`AA` is the little-endian address, `VV` the little-endian unsigned value, and
`CC` is `(-sum(all preceding bytes)) & 0xffff`, also little-endian.

A read uses:

```text
00 c4 09 00 00 04 AA AA CC CC 00 ...
```

## Verified settings

| Setting | Address | Values |
| --- | ---: | --- |
| Microphone gain | `0x207e` | `0..20` |
| Headphone volume | `0x207f` | `0..20` |
| Noise cancellation | `0x2084` | off `0`, on `1` |
| Noise level | `0x2085` | slight `0`, moderate `1`, aggressive `2` |
| RGB power | `0x2089` | off `0`, on `1` |
| RGB brightness | `0x208a` | `0..20` |
| RGB effect | `0x208b` | fixed `0`, loop `1`, breathing `2` |
| RGB fixed color | `0x208c` | white `0`, red `1`, orange `2`, yellow `3`, green `4`, cyan `5`, blue `6`, magenta `7` |
| Monitor output | `0x20af` | base bit `0x4`, mic bit `0x1`, computer bit `0x2` |

The monitor values therefore are none `4`, mic only `5`, computer only `6`,
and both `7`. Preserve bit 2; Maono Link always includes it.

The app's UI-to-backend message keys observed during delta mapping were gain 6,
headphone 7, noise power 13, noise level 14, RGB power 16, RGB effect 18, RGB
color 19, and monitor output 34. Startup reads tied these keys to the addresses
above. All settings were returned to their exact initial values after capture.

## EQ and scenes (partial)

`0x2022` is read when the scene/EQ state initializes. Seven EQ point blocks
begin at `0x2023`, with a stride of five registers:

```text
band 0: 0x2023..0x2027
band 1: 0x2028..0x202c
band 2: 0x202d..0x2031
band 3: 0x2032..0x2036
band 4: 0x2037..0x203b
HPF:    0x203c..0x2040
LPF:    0x2041..0x2045
```

Selecting Original and Podcast caused Maono Link to rewrite all seven blocks.
The logical Original curve is five flat bell filters at 125, 250, 500, 1000,
and 2000 Hz, plus HPF at 20 Hz and LPF at 20 kHz. Podcast1 uses 100 Hz/+2.5
dB/Q0.7, 300 Hz/-4.0457 dB/Q2, 1100 Hz/0 dB/Q0.7, 4880 Hz/-3 dB/Q5, and a
10 kHz high shelf at 0 dB/Q0.7, with HPF/LPF bypassed.

The five raw fields' fixed-point encoding is not yet sufficiently verified, so
the public writer deliberately does not expose scene or arbitrary EQ writes.
That avoids sending plausible but unsafe coefficients. The mapping harness and
local preset metadata are retained for the next capture round.

