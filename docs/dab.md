# DAB and DAB+ radio

BrowSDR plays DAB+ and DAB stations with the [welle.io](https://github.com/AlbrechtL/welle.io)
receiver compiled to WebAssembly.

1. Set a VFO to **DAB** and pick a **Channel** (Band III 5A–13F or L-band LA–LP).
   The radio is recentred if the 1.536 MHz ensemble would not fit in the received band.
2. Wait for the green sync light, then choose a **Station**.
3. Open **Tools → DAB Radio** for now-playing text, slideshow image, signal
   details and the DQPSK constellation. Four tight clusters mean a clean signal.

## Limits

- Use 2.048 or 2.4 MS/s on an RTL-SDR; it drops samples above 2.4 MS/s. Close to a
  transmitter, lower the gain.
- The page must be cross-origin isolated, because the decoder uses threads.
- One station per VFO. Now-playing text and slides come only from that station.
- Transmitter identification and saving the station in a bookmark are not implemented.
