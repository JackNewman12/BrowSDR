# welle.io WebAssembly integration

`wrapper.cpp` and `build.sh` compile the receiver backend of
[AlbrechtL/welle.io](https://github.com/AlbrechtL/welle.io) and its bundled FAAD2,
mpg123, KISS FFT and FEC libraries. The GUI, CLI and native SDR inputs are left out.

`pkg/welle.js` and `pkg/welle.wasm` are committed with `COPYING` and `NOTICE`, so app
builds do not need Emscripten. The upstream commit, archive SHA-256 and Emscripten
version are pinned in `upstream.json`.

## Rebuild

Activate Emscripten 4.0.7 (see `wasm/mbelib/README.md`), then from the repository root:

```bash
npm run build:welle
```

To check a build against a real 2.048 MS/s unsigned 8-bit IQ recording:

```bash
rtl_sdr -f 202928000 -s 2048000 -g 40 -n 20480000 9a.cu8
node scripts/validate-dab.mjs 9a.cu8
```
