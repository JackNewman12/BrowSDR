import fs from 'node:fs';
import assert from 'node:assert/strict';
import WelleModule from '../wasm/welle/pkg/welle.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/validate-dab.mjs capture.cu8   (unsigned 8-bit IQ at 2.048 MS/s, e.g. from rtl_sdr)');
const bytes = fs.readFileSync(file);
assert.equal(bytes.length % 2, 0, 'Expected interleaved unsigned 8-bit IQ');
const module = await WelleModule({ print: () => {}, printErr: () => {} });
const chunk = 204800; // 100 ms
const iqPtr = module._malloc(chunk * 8);
const audioPtr = module._malloc(48000 * 4);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module._dab_init();
let status = {};
let frames = 0;
let peak = 0;
// welle's threads decode in real time, so feed the capture at real-time pace.
for (let offset = 0; offset + chunk * 2 <= bytes.length; offset += chunk * 2) {
	for (let i = 0; i < chunk * 2; i++) module.HEAPF32[iqPtr / 4 + i] = (bytes[offset + i] - 127.5) / 127.5;
	module._dab_push(iqPtr, chunk);
	await sleep(100);
	status = JSON.parse(module.UTF8ToString(module._dab_status()));
	if (!status.playing && status.services.length) module._dab_select(status.services[0].id);
	const read = module._dab_audio_read(audioPtr, 48000);
	for (let i = 0; i < read * 2; i++) peak = Math.max(peak, Math.abs(module.HEAP16[audioPtr / 2 + i]));
	frames += read;
}
module._dab_destroy();
const { constellation, ...summary } = status;
console.log(JSON.stringify({ ...summary, constellationPoints: constellation.length / 2, audioSeconds: frames / 48000, peak }, null, 1));
assert(status.ensemble, 'No ensemble label decoded');
assert(status.services.length > 0, 'No audio services found');
assert(frames > 0 && peak > 100, 'No audible programme audio decoded');
process.exit(0);
