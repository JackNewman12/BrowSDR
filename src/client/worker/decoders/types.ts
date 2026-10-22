export type Rtl433Message =
	{ type: 'rtl433_event'; freq: number; event: Record<string, unknown> } | { type: 'rtl433_status'; freq?: number; status: Rtl433Status };

export interface Rtl433Protocol {
	id: number;
	name: string;
	disabled: boolean;
}

export interface Rtl433Status {
	state: 'off' | 'loading' | 'receiving' | 'error';
	message: string;
	sampleRate: number;
	samples: number;
	events: number;
	protocols?: Rtl433Protocol[];
}

export interface RtlModule {
	HEAPF32: Float32Array;
	_malloc(bytes: number): number;
	_free(ptr: number): void;
	stringToNewUTF8(text: string): number;
	UTF8ToString(ptr: number): string;
	_rtl433_init(rate: number, frequency: number, protocols: number): number;
	_rtl433_process(ptr: number, count: number): number;
	_rtl433_flush(): number;
	_rtl433_destroy(): void;
	_rtl433_protocol_count(): number;
	_rtl433_protocol_name(id: number): number;
	_rtl433_protocol_disabled(id: number): number;
}

export type RtlFactory = (options: {
	locateFile(path: string): string;
	onDecoded(json: string): void;
	print(): void;
	printErr(): void;
}) => Promise<RtlModule>;

export interface MbelibModule {
	HEAP8: Int8Array;
	HEAPF32: Float32Array;
	_malloc(this: void, size: number): number;
	_free(this: void, ptr: number): void;
	cwrap(name: string, result: 'number', args: ['number', 'number']): (frame: number, audio: number) => number;
	cwrap(name: string, result: null, args: []): () => void;
}

export type MbelibFactory = (options: { locateFile(path: string): string }) => Promise<MbelibModule>;

export interface SidebandState {
	ssbPhase?: number;
	agcGain?: number;
}

export interface RDSMessage {
	ps?: string;
	rt?: string;
	pi?: string;
	pty?: number;
	ptyLabel?: string;
	tp?: boolean;
	ta?: boolean;
}

/** Per-character decode confidence, parallel to a message's text. */
export const POCSAG_CHAR_OK = 0; // all source bits from clean codewords
export const POCSAG_CHAR_CORRECTED = 1; // at least one source bit BCH-corrected
export const POCSAG_CHAR_UNCORRECTABLE = 2; // at least one source bit from an uncorrectable codeword

export interface POCSAGMessage {
	capcode: number;
	func: number;
	type: 'alpha' | 'tone' | 'numeric';
	text: string;
	/**
	 * Per-character confidence, one entry per character of `text`:
	 * 0 = ok, 1 = corrected (BCH-repaired), 2 = uncorrectable (data was lost /
	 * placeholder). Lets the UI colour-code characters. Empty for tone pages.
	 */
	charStatus: number[];
	baud: number;
	/** Debug: content-detection scores (alpha vs numeric), when DEBUG build. */
	detectDebug?: string;
	/**
	 * Runner-up interpretation (the other of alpha/numeric), present only in
	 * auto mode when the "show second guess" option is on. The UI renders it
	 * dimmed beside the primary text.
	 */
	alt?: { type: 'alpha' | 'numeric'; text: string };
}

/** POCSAG type-detection mode. */
export type PocsagMode = 'auto' | 'alpha' | 'numeric';

/**
 * Live link status for a POCSAG VFO (sync / speed / polarity / bit-error rate).
 * Emitted periodically by the decoder for a glanceable UI readout, independent
 * of decoded messages.
 */
export interface POCSAGStatus {
	/** True while a sub-decoder is locked onto a batch (receiving data). */
	synced: boolean;
	/** Baud rate of the locked sub-decoder, or null when not synced. */
	baud: number | null;
	/** True when the locked signal is inverted polarity. */
	inverted: boolean;
	/**
	 * Rolling bit-error rate (0..1): BCH-corrected bits / total data bits over
	 * the recent window of codewords. null until enough codewords are seen.
	 */
	ber: number | null;
	/** Codewords observed in the current rolling window (for UI confidence). */
	codewords: number;
}

export interface DabService {
	id: number;
	label: string;
	dabPlus: boolean;
	/** Programme type name (e.g. News), '' when the broadcaster sends none. */
	programType: string;
	language: string;
	/** Subchannel bitrate in kbit/s and error protection (e.g. EEP 3-A). */
	bitrate: number;
	protection: string;
}

export interface DabStatus {
	state: 'loading' | 'receiving' | 'error';
	message: string;
	sync: boolean;
	snr: number;
	ensemble: string;
	ensembleId: number;
	services: DabService[];
	/** Service ID currently decoded, 0 when none. */
	playing: number;
	/** Dynamic label (now-playing text). */
	dls: string;
	audioMode: string;
	frameErrors: number;
	rsErrors: number;
	aacErrors: number;
	/** Interleaved I/Q of demodulated carriers, one OFDM frame decimated. */
	constellation: number[];
	/** Multiplex clock in UTC (ISO 8601) and the broadcaster's local offset in minutes. */
	time?: string;
	utcOffset?: number;
	/** Latest slideshow image (album art, station logo) as a data URL. */
	slide: string;
}

export interface DabModule {
	HEAPF32: Float32Array;
	HEAP16: Int16Array;
	HEAPU8: Uint8Array;
	HEAP32: Int32Array;
	_malloc(bytes: number): number;
	_free(ptr: number): void;
	UTF8ToString(ptr: number): string;
	_dab_init(): void;
	_dab_destroy(): void;
	_dab_push(ptr: number, count: number): void;
	_dab_select(serviceId: number): void;
	_dab_audio_read(ptr: number, maxFrames: number): number;
	_dab_audio_rate(): number;
	_dab_status(): number;
	_dab_slide(infoPtr: number): number;
}

export type DabFactory = (options: { locateFile(path: string): string; print(): void; printErr(): void }) => Promise<DabModule>;
