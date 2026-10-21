#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIN="$ROOT/upstream.json"
read -r COMMIT SHA256 EMSCRIPTEN < <(python3 - "$PIN" <<'PY'
import json, re, sys
pin = json.load(open(sys.argv[1]))
assert re.fullmatch(r'[0-9a-f]{40}', pin['commit']), 'Invalid upstream commit'
assert re.fullmatch(r'[0-9a-f]{64}', pin['sha256']), 'Invalid source checksum'
assert re.fullmatch(r'\d+\.\d+\.\d+', pin['emscripten']), 'Invalid compiler version'
print(pin['commit'], pin['sha256'], pin['emscripten'])
PY
)
SOURCE="$ROOT/welle.io-$COMMIT/src"
BUILD="$ROOT/build/$COMMIT"
OUT="$ROOT/pkg"
if [[ "$(emcc --version | head -1)" != *" $EMSCRIPTEN "* ]]; then
    echo "Activate Emscripten $EMSCRIPTEN before rebuilding welle.io." >&2
    exit 1
fi
if [ ! -d "$SOURCE" ]; then
    if [ ! -f "$ROOT/source.tar.gz" ] || ! echo "$SHA256  $ROOT/source.tar.gz" | sha256sum --check --status; then
        curl -fL --retry 3 "https://codeload.github.com/AlbrechtL/welle.io/tar.gz/$COMMIT" -o "$ROOT/source.tar.gz"
    fi
    echo "$SHA256  $ROOT/source.tar.gz" | sha256sum --check
    tar xzf "$ROOT/source.tar.gz" -C "$ROOT"
fi
mkdir -p "$BUILD" "$OUT"
# Same backend, KISS FFT, FAAD2, mpg123 and FEC sources as upstream's CMake build;
# GUI, CLI, sockets, WAV output and native SDR inputs are left out.
BACKEND="dab-audio decoder_adapter dab_decoder dabplus_decoder charsets dab-constants mot_manager
    pad_decoder eep-protection fib-processor fic-handler msc-handler freq-interleaver ofdm-decoder
    ofdm-processor phasereference phasetable tii-decoder protTables radio-receiver tools
    uep-protection viterbi"
MPG123="compat compat_str parse frame format dct64 equalizer id3 icy icy2utf8 optimize readers
    tabinit libmpg123 index layer1 layer2 layer3 dither feature synth synth_real ntom synth_8bit
    synth_s32 stringbuf"
FAAD="bits cfft common decoder drc drm_dec error filtbank hcr huffman ic_predict is lt_predict mdct
    mp4 ms output pns ps_dec ps_syntax pulse rvlc sbr_dct sbr_dec sbr_e_nf sbr_fbt sbr_hfadj
    sbr_hfgen sbr_huff sbr_qmf sbr_syntax sbr_tf_grid specrec ssr ssr_fb ssr_ipqf syntax tns"
SOURCES=("$ROOT/wrapper.cpp" "$SOURCE/various/Xtan2.cpp" "$SOURCE/various/channels.cpp"
    "$SOURCE/various/fft.cpp" "$SOURCE/various/profiling.cpp" "$SOURCE/libs/kiss_fft/kiss_fft.c"
    "$SOURCE/libs/fec/decode_rs_char.c" "$SOURCE/libs/fec/encode_rs_char.c" "$SOURCE/libs/fec/init_rs_char.c")
for f in $BACKEND; do SOURCES+=("$SOURCE/backend/$f.cpp"); done
for f in $MPG123; do SOURCES+=("$SOURCE/libs/mpg123/$f.c"); done
for f in $FAAD; do SOURCES+=("$SOURCE/libs/faad2/libfaad/$f.c"); done
FLAGS=(-O3 -DNDEBUG -pthread -fwasm-exceptions -DDABLIN_AAC_FAAD2 -DKISSFFT -DOPT_GENERIC -DHAVE_CONFIG_H
    -I"$SOURCE" -I"$SOURCE/backend" -I"$SOURCE/various" -I"$SOURCE/input" -I"$SOURCE/libs/fec"
    -I"$SOURCE/libs/kiss_fft" -I"$SOURCE/libs/mpg123" -I"$SOURCE/libs/faad2"
    -I"$SOURCE/libs/faad2/include" -I"$SOURCE/libs/faad2/libfaad" -I"$SOURCE/libs/faad2/libfaad/codebook")
OBJECTS=()
for src in "${SOURCES[@]}"; do
    obj="$BUILD/$(basename "${src%.*}")-$(dirname "$src" | sha256sum | cut -c1-8).o"
    OBJECTS+=("$obj")
    if [[ "$src" == *.cpp ]]; then em++ -std=c++17 "${FLAGS[@]}" -c "$src" -o "$obj" &
    else emcc "${FLAGS[@]}" -c "$src" -o "$obj" & fi
    while (( $(jobs -r | wc -l) >= 8 )); do wait -n; done
done
wait
# welle runs its OFDM and decoder loops on their own threads; BrowSDR is cross-origin isolated.
# Fixed memory: growth would leave the JS heap views stale while welle threads allocate.
# welle stops its threads by throwing StopProcessingException, so exceptions must be caught.
em++ -O3 -pthread -fwasm-exceptions "${OBJECTS[@]}" \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=WelleModule \
    -s ENVIRONMENT=web,worker,node -s FILESYSTEM=0 \
    -s INITIAL_MEMORY=100663296 -s PTHREAD_POOL_SIZE=4 -s STACK_SIZE=1048576 \
    -s DEFAULT_PTHREAD_STACK_SIZE=2097152 ${WELLE_LINK_FLAGS:-} \
    -s EXPORTED_FUNCTIONS='["_dab_init","_dab_destroy","_dab_push","_dab_select","_dab_audio_read","_dab_audio_rate","_dab_status","_dab_slide","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPF32","HEAP16","HEAPU8","HEAP32"]' \
    -o "$BUILD/welle.js"
python3 - "$PIN" "$BUILD/NOTICE" <<'PY'
import json, pathlib, sys
pin = json.load(open(sys.argv[1]))
pathlib.Path(sys.argv[2]).write_text(f"""welle.io DAB/DAB+ browser decoder for BrowSDR

Upstream: https://github.com/AlbrechtL/welle.io
Revision: {pin['commit']}
Source archive SHA-256: {pin['sha256']}
Compiler: Emscripten {pin['emscripten']}
License: GPL-2.0-or-later; see COPYING and upstream per-file copyright notices.
Bundled upstream libraries: FAAD2 (GPL-2.0-or-later), mpg123 (LGPL-2.1),
KISS FFT (BSD-3-Clause) and Phil Karn's FEC library (LGPL-2.1).

Corresponding source: upstream revision above, wasm/welle/wrapper.cpp and
wasm/welle/build.sh in the BrowSDR source repository. Only the receiver backend
and its bundled libraries are compiled; upstream source is unchanged.
""")
PY
cp "$BUILD/welle.js" "$BUILD/welle.wasm" "$BUILD/NOTICE" "$OUT/"
cp "$SOURCE/../COPYING" "$OUT/COPYING"
