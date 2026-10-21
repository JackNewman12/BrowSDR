import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { DabStream } from '@/worker/decoders/dab';
import { LatestStatus } from './latest-status';
import type { DSDStatus } from '@/worker/decoders/dsd/types';
import type { DabStatus } from '@/worker/decoders/types';
import type { DspOutput } from './dsp-messages.types';
import type { VfoParams } from './types';

/** Decoders that turn a VFO's IQ into their own audio: DSD voice and DAB broadcasts. */
export class DigitalAudio {
	private dsd: DSDStream | null = null;
	private dab: DabStream | null = null;
	private dsdStatus: LatestStatus<DSDStatus>;
	private dabStatus: LatestStatus<DabStatus>;
	/** True only for chunks that carried decoded audio. */
	audioActive = false;

	constructor(post: (message: DspOutput) => void) {
		this.dsdStatus = new LatestStatus((status) => post({ type: 'dsd_status', status }));
		this.dabStatus = new LatestStatus((status) => post({ type: 'dab_status', status }));
	}

	configure(params: VfoParams, sampleRate: number): void {
		if (params.mode === 'dsd') {
			this.dsd ??= new DSDStream((status) => this.dsdStatus.push(status));
			this.dsd.configure(params.freq, params.bandwidth, params.enabled, sampleRate);
		} else if (this.dsd) {
			this.dsd.reset();
			this.dsd = null;
		}
		if (params.mode === 'dab') {
			this.dab ??= new DabStream((status) => this.dabStatus.push(status));
			this.dab.configure(params.freq, params.dabService ?? 0);
		} else if (this.dab) {
			this.dab.reset();
			this.dab = null;
		}
	}

	process(mode: string, iq: Float32Array, squelched: boolean): Float32Array {
		const decoder = mode === 'dab' ? this.dab : this.dsd;
		const audio = mode === 'dab' ? this.dab?.process(iq) : this.dsd?.process(iq, squelched);
		// Both emit paced silence while searching. An open RF squelch alone is not
		// evidence of decoded playback.
		this.audioActive = decoder?.audioActive ?? false;
		return audio ?? new Float32Array(mode === 'dab' ? 0 : iq.length / 2);
	}

	resetStatus(): void {
		this.dsdStatus.reset();
		this.dabStatus.reset();
	}

	reset(): void {
		this.resetStatus();
		this.dsd?.reset();
	}
}
