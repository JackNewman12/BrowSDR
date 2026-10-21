import { describe, expect, it, vi } from 'vitest';
import { DabStream, DAB_RATE } from '@/worker/decoders/dab';
import { dabMethods } from '@/app/decoders/dab';

/** Minimal stand-in for the welle.io module: queued PCM and a fixed status. */
function fakeModule() {
	const buffer = new ArrayBuffer(1 << 24);
	let next = 16;
	const module = {
		HEAPF32: new Float32Array(buffer),
		HEAP16: new Int16Array(buffer),
		HEAPU8: new Uint8Array(buffer),
		HEAP32: new Int32Array(buffer),
		slide: [],
		slideSeq: 0,
		pcm: [],
		rate: 48000,
		selected: [],
		inits: 0,
		pushed: 0,
		_malloc: (bytes) => ((next += bytes + 16), next - bytes),
		_free: () => {},
		UTF8ToString: () =>
			JSON.stringify({ sync: true, ensemble: 'Test', services: [{ id: 0x1234, label: 'One', dabPlus: true }], slideSeq: module.slideSeq }),
		_dab_init: () => module.inits++,
		_dab_destroy: () => {},
		_dab_push: (_ptr, count) => (module.pushed += count),
		_dab_select: (id) => module.selected.push(id),
		_dab_audio_rate: () => module.rate,
		_dab_status: () => 0,
		_dab_slide: (info) => {
			module.HEAP32.set([module.slide.length, 3], info / 4);
			module.HEAPU8.set(module.slide, 1 << 23);
			return 1 << 23;
		},
		_dab_audio_read: (ptr, max) => {
			const frames = Math.min(max, module.pcm.length / 2);
			module.HEAP16.set(module.pcm.splice(0, frames * 2), ptr / 2);
			return frames;
		},
	};
	return module;
}

globalThis.crossOriginIsolated = true;
const module = fakeModule();
vi.mock('/wasm/welle/welle.js', () => ({ default: async () => ((module.created = (module.created ?? 0) + 1), module) }));

describe('DAB stream', () => {
	it('paces decoded stereo audio by the IQ clock after a prebuffer', async () => {
		const statuses = [];
		const stream = new DabStream((status) => statuses.push(status));
		stream.configure(202.928, 0x1234);
		await vi.waitFor(() => expect(module.inits).toBe(1));
		expect(module.selected).toContain(0x1234);

		const chunk = new Float32Array((DAB_RATE / 100) * 2); // 10 ms of IQ
		let frames = 0;
		let audible = 0;
		for (let i = 0; i < 100; i++) {
			// Decoder output arrives in 120 ms bursts like DAB+ superframes.
			if (i % 12 === 0) for (let f = 0; f < 5760; f++) module.pcm.push(16384, -16384);
			const out = stream.process(chunk);
			frames += out.length / 2;
			if (out[0] !== 0) {
				audible++;
				expect(out[0]).toBeCloseTo(0.5);
				expect(out[1]).toBeCloseTo(-0.5);
			}
		}
		expect(module.pushed).toBe(DAB_RATE);
		expect(frames).toBe(48000); // one second of audio for one second of IQ
		expect(audible).toBeGreaterThan(60); // silent only while prebuffering
		expect(statuses.at(-1)).toMatchObject({ state: 'receiving', ensemble: 'Test', message: 'Synchronised' });
	});

	it('restarts the receiver when retuned to another ensemble', async () => {
		const stream = new DabStream(() => {});
		const before = module.inits;
		stream.configure(202.928, 0);
		await vi.waitFor(() => expect(module.inits).toBe(before + 1));
		stream.configure(202.928, 0x1234);
		expect(module.inits).toBe(before + 1);
		stream.configure(204.64, 0);
		expect(module.inits).toBe(before + 2);
	});

	it('reuses one welle instance after switching away from DAB and back', async () => {
		const stream = new DabStream(() => {});
		const before = module.inits;
		stream.configure(202.928, 0);
		await vi.waitFor(() => expect(module.inits).toBe(before + 1));
		stream.reset();
		stream.configure(202.928, 0);
		await vi.waitFor(() => expect(module.inits).toBe(before + 2));
		expect(module.created).toBe(1); // each instance pins its own memory and threads
	});
});

describe('DAB panel helpers', () => {
	const app = (centerFreq, sampleRate) => ({
		radio: { centerFreq, sampleRate },
		vfos: [{ freq: centerFreq, dabService: 0x1234 }],
		locks: {},
		remoteMode: null,
		dabStatus: [],
		validateAndApplyVfoFreq(index, freq) {
			this.vfos[index].freq = freq;
		},
	});

	it('recentres the radio when the chosen ensemble would not fit', () => {
		const receiver = app(202.0, 2048000);
		dabMethods.tuneDabChannel.call(Object.assign(receiver, { dabFits: dabMethods.dabFits }), 0, '9A');
		expect(receiver.vfos[0]).toMatchObject({ freq: 202.928, dabService: 0 });
		expect(receiver.radio.centerFreq).toBe(202.928);
		const wide = Object.assign(app(202.5, 3200000), { dabFits: dabMethods.dabFits });
		dabMethods.tuneDabChannel.call(wide, 0, '9A');
		expect(wide.radio.centerFreq).toBe(202.5); // 0.428 + 0.768 MHz fits in ±1.6 MHz
	});

	it('lists labelled stations alphabetically before unlabelled ones', () => {
		const receiver = app(202.928, 2048000);
		receiver.dabStatus[0] = {
			services: [
				{ id: 3, label: '' },
				{ id: 2, label: 'Zed' },
				{ id: 1, label: 'Abc' },
			],
		};
		expect(dabMethods.dabServices.call(receiver, 0).map((s) => s.id)).toEqual([1, 2, 3]);
	});

	it('turns a new slideshow image into a data URL once', async () => {
		const statuses = [];
		const stream = new DabStream((status) => statuses.push(status));
		const inits = module.inits;
		stream.configure(202.928, 0x1234);
		await vi.waitFor(() => expect(module.inits).toBe(inits + 1));
		module.slide = [0x89, 0x50, 0x4e, 0x47];
		module.slideSeq = 1;
		stream.process(new Float32Array(2048));
		expect(statuses.at(-1).slide).toBe('data:image/png;base64,iVBORw==');
	});

	it('formats the playing station details and the broadcaster clock', () => {
		const service = { id: 7, label: 'Talk', dabPlus: true, programType: 'News', language: '', bitrate: 48, protection: 'EEP 3-A' };
		const status = (time, utcOffset) => ({ dabStatus: [{ playing: 7, services: [service], time, utcOffset }] });
		expect(dabMethods.dabStationInfo.call(status(), 0)).toBe('News · 48 kbit/s EEP 3-A');
		expect(dabMethods.dabBroadcastTime.call(status('2026-10-20T23:12:42Z', 600), 0)).toBe('09:12 UTC+10');
		expect(dabMethods.dabBroadcastTime.call(status('2026-10-20T23:12:42Z', 570), 0)).toBe('08:42 UTC+9:30');
		expect(dabMethods.dabBroadcastTime.call(status('2026-10-20T03:00:00Z', -300), 0)).toBe('22:00 UTC-5');
		expect(dabMethods.dabBroadcastTime.call(status(undefined, 0), 0)).toBe('');
	});
});
