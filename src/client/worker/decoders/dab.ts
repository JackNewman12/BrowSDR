import { RationalResampler } from '@/worker/streams/dsp-pipeline';
import { errorMessage } from '@/platform/errors';
import { isRecord } from '@/platform/data';
import type { DabFactory, DabModule, DabStatus } from './types';

/** DAB transmission mode I sample rate expected by welle.io. */
export const DAB_RATE = 2048000;
const AUDIO_RATE = 48000;
const PREBUFFER_FRAMES = AUDIO_RATE / 4;
const STATUS_INTERVAL_MS = 200;
const IDLE_STATUS: DabStatus = {
	state: 'loading',
	message: 'Loading DAB decoder',
	sync: false,
	snr: 0,
	ensemble: '',
	ensembleId: 0,
	services: [],
	playing: 0,
	dls: '',
	audioMode: '',
	frameErrors: 0,
	rsErrors: 0,
	aacErrors: 0,
	constellation: [],
	slide: '',
};

// One instance per worker: each instance owns its own 96 MB memory and thread pool, which are never freed.
let modulePromise: Promise<DabModule> | undefined;
function loadModule(): Promise<DabModule> {
	const url = typeof location === 'undefined' ? '/wasm/welle/welle.js' : new URL('/wasm/welle/welle.js', location.origin).href;
	modulePromise ??= import(/* @vite-ignore */ url)
		.then((module: unknown) => {
			if (!isRecord(module) || typeof module.default !== 'function') throw new Error('Missing welle.io factory');
			return (module.default as DabFactory)({ locateFile: (path) => '/wasm/welle/' + path, print: () => {}, printErr: () => {} });
		})
		.catch((error) => {
			modulePromise = undefined;
			throw new Error(`Could not load the DAB decoder. Restore wasm/welle/pkg assets or rebuild it. ${errorMessage(error)}`);
		});
	return modulePromise;
}

/** Feeds 2.048 MS/s IQ to welle.io and returns 48 kHz stereo audio paced by the IQ clock. */
export class DabStream {
	private module?: DabModule;
	private loading?: Promise<void>;
	private generation = 0;
	private iqPtr = 0;
	private iqCapacity = 0;
	private audioPtr = 0;
	private frequency = 0;
	private service = 0;
	private sourceRate = 0;
	private resamplers?: [RationalResampler, RationalResampler];
	private queue = new Float32Array(AUDIO_RATE * 4);
	private readPos = 0;
	private queued = 0;
	private buffering = true;
	private pendingFrames = 0;
	private lastStatus = -Infinity;
	private slideSeq = 0;
	private slide = '';
	audioActive = false;

	constructor(private onStatus: (status: DabStatus) => void) {}

	configure(frequency: number, service: number): void {
		if (this.module && frequency !== this.frequency) this.restart();
		this.frequency = frequency;
		this.service = service;
		this.module?._dab_select(service);
		if (!this.module) void this.load();
	}

	/** iq: interleaved I/Q at DAB_RATE. Returns interleaved stereo frames at 48 kHz. */
	process(iq: Float32Array): Float32Array {
		this.pendingFrames += ((iq.length / 2) * AUDIO_RATE) / DAB_RATE;
		const frames = Math.floor(this.pendingFrames);
		this.pendingFrames -= frames;
		const output = new Float32Array(frames * 2);
		this.audioActive = false;
		const module = this.module;
		if (!module) return output;
		const count = iq.length / 2;
		if (count > this.iqCapacity) {
			if (this.iqPtr) module._free(this.iqPtr);
			this.iqPtr = module._malloc(iq.length * 4);
			this.iqCapacity = count;
		}
		module.HEAPF32.set(iq, this.iqPtr / 4);
		module._dab_push(this.iqPtr, count);
		this.drainAudio(module);
		this.emitStatus(module);
		if (this.buffering && this.queued >= PREBUFFER_FRAMES) this.buffering = false;
		if (this.buffering) return output;
		const available = Math.min(frames, this.queued);
		for (let i = 0; i < available; i++) {
			output[i * 2] = this.queue[this.readPos * 2];
			output[i * 2 + 1] = this.queue[this.readPos * 2 + 1];
			this.readPos = (this.readPos + 1) % (this.queue.length / 2);
		}
		this.queued -= available;
		// Rebuffer after an underrun instead of playing choppy fragments.
		if (available < frames) this.buffering = true;
		this.audioActive = available > 0;
		return output;
	}

	reset(): void {
		this.module?._dab_destroy();
		if (this.iqPtr) this.module?._free(this.iqPtr);
		if (this.audioPtr) this.module?._free(this.audioPtr);
		this.audioPtr = 0;
		this.module = undefined;
		this.loading = undefined;
		this.generation++;
		this.iqPtr = 0;
		this.iqCapacity = 0;
		this.clearAudio();
	}

	private restart(): void {
		this.module?._dab_init();
		this.clearAudio();
		this.lastStatus = -Infinity;
		this.slideSeq = 0;
		this.slide = '';
	}

	private clearAudio(): void {
		this.queued = 0;
		this.readPos = 0;
		this.buffering = true;
		this.sourceRate = 0;
		this.resamplers = undefined;
	}

	private async load(): Promise<void> {
		if (this.loading) return this.loading;
		this.onStatus({ ...IDLE_STATUS });
		const generation = this.generation;
		this.loading = (async () => {
			try {
				if (!globalThis.crossOriginIsolated) throw new Error('DAB needs a cross-origin isolated page for its threaded decoder.');
				const module = await loadModule();
				if (generation !== this.generation) return; // reset while loading
				this.audioPtr = module._malloc(AUDIO_RATE * 4);
				module._dab_init();
				module._dab_select(this.service);
				this.module = module;
			} catch (error) {
				this.onStatus({ ...IDLE_STATUS, state: 'error', message: errorMessage(error) });
			}
		})();
		return this.loading;
	}

	private drainAudio(module: DabModule): void {
		const rate = module._dab_audio_rate();
		for (let frames; (frames = module._dab_audio_read(this.audioPtr, AUDIO_RATE)) > 0;) {
			if (rate !== this.sourceRate) {
				this.sourceRate = rate;
				this.resamplers =
					rate === AUDIO_RATE ? undefined : [new RationalResampler(rate, AUDIO_RATE), new RationalResampler(rate, AUDIO_RATE)];
			}
			const pcm = module.HEAP16.subarray(this.audioPtr / 2, this.audioPtr / 2 + frames * 2);
			const left = new Float32Array(frames);
			const right = new Float32Array(frames);
			for (let i = 0; i < frames; i++) {
				left[i] = pcm[i * 2] / 32768;
				right[i] = pcm[i * 2 + 1] / 32768;
			}
			const [l, r] = this.resamplers ? [this.resamplers[0].process(left), this.resamplers[1].process(right)] : [left, right];
			const capacity = this.queue.length / 2;
			for (let i = 0; i < Math.min(l.length, r.length); i++) {
				// Bound latency if the SDR clock runs slow against the broadcast.
				if (this.queued === capacity) {
					this.readPos = (this.readPos + 1) % capacity;
					this.queued--;
				}
				const write = ((this.readPos + this.queued++) % capacity) * 2;
				this.queue[write] = l[i];
				this.queue[write + 1] = r[i];
			}
		}
	}

	private emitStatus(module: DabModule): void {
		const now = performance.now();
		if (now - this.lastStatus < STATUS_INTERVAL_MS) return;
		this.lastStatus = now;
		const raw: unknown = JSON.parse(module.UTF8ToString(module._dab_status()));
		if (!isRecord(raw)) return;
		if (typeof raw.slideSeq === 'number' && raw.slideSeq !== this.slideSeq) {
			this.slideSeq = raw.slideSeq;
			this.slide = readSlide(module);
		}
		this.onStatus({
			...IDLE_STATUS,
			...raw,
			slide: this.slide,
			state: 'receiving',
			message: raw.sync ? 'Synchronised' : 'Searching for DAB signal',
		});
	}
}

/** Latest MOT slideshow image as a data URL, or '' when the station has sent none. */
function readSlide(module: DabModule): string {
	const info = module._malloc(8);
	const ptr = module._dab_slide(info);
	const length = module.HEAP32[info / 4];
	const type = module.HEAP32[info / 4 + 1];
	module._free(info);
	if (!length) return '';
	const bytes = module.HEAPU8.subarray(ptr, ptr + length);
	let binary = '';
	for (let i = 0; i < length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return `data:image/${type === 3 ? 'png' : 'jpeg'};base64,${btoa(binary)}`;
}
