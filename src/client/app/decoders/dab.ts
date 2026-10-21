import type { AppInstance } from '@/app/core/receiver.types';
import type { DabStatus } from '@/worker/decoders/types';
import { DAB_CHANNELS } from '@/app/core/constants';

/** Half the 1.536 MHz DAB signal, which must sit inside the received band. */
const DAB_HALF_WIDTH_MHZ = 0.768;

export const dabMethods = {
	_onDabStatus(this: AppInstance, vfoIndex: number, status: DabStatus) {
		this.dabStatus[vfoIndex] = status;
	},
	dabChannels() {
		return DAB_CHANNELS;
	},
	dabChannelName(freq: number): string {
		return DAB_CHANNELS.find((channel) => Math.abs(channel.freq - freq) < 0.001)?.name ?? '';
	},
	dabFits(this: AppInstance, freq: number): boolean {
		return Math.abs(freq - this.radio.centerFreq) + DAB_HALF_WIDTH_MHZ <= this.radio.sampleRate / 2e6;
	},
	tuneDabChannel(this: AppInstance, index: number, name: string) {
		const channel = DAB_CHANNELS.find((value) => value.name === name);
		if (!channel) return;
		this.vfos[index].dabService = 0;
		this.validateAndApplyVfoFreq(index, channel.freq);
		// The whole ensemble must be received, not just its centre frequency.
		if (!this.dabFits(channel.freq) && !(this.remoteMode === 'client' && this.locks.centerFreq)) this.radio.centerFreq = channel.freq;
	},
	/** Stations by label; services whose label has not arrived yet go last. */
	dabServices(this: AppInstance, index: number) {
		const services = [...(this.dabStatus[index]?.services ?? [])];
		return services.sort((a, b) => Number(!a.label) - Number(!b.label) || a.label.localeCompare(b.label));
	},
	/** VFO indices in DAB mode, for the DAB window. */
	dabVfos(this: AppInstance): number[] {
		return this.vfos.flatMap((vfo, index) => (vfo.mode === 'dab' ? [index] : []));
	},
	dabStationLabel(this: AppInstance, index: number): string {
		const status = this.dabStatus[index];
		return status?.services.find((service) => service.id === status.playing)?.label ?? '';
	},
	/** Programme type, language and coding of the playing station. */
	dabStationInfo(this: AppInstance, index: number): string {
		const status = this.dabStatus[index];
		const service = status?.services.find((item) => item.id === status.playing);
		if (!service) return '';
		const coding = service.bitrate ? `${service.bitrate} kbit/s ${service.protection}` : '';
		return [service.programType, service.language, coding].filter(Boolean).join(' · ');
	},
	/** Broadcaster's local time from the multiplex clock, e.g. "09:12 UTC+10". */
	dabBroadcastTime(this: AppInstance, index: number): string {
		const { time, utcOffset = 0 } = this.dabStatus[index] ?? {};
		const utc = time ? Date.parse(time) : NaN;
		if (!Number.isFinite(utc)) return '';
		const local = new Date(utc + utcOffset * 60000);
		const pad = (value: number) => String(value).padStart(2, '0');
		const offset = `${utcOffset < 0 ? '-' : '+'}${Math.floor(Math.abs(utcOffset) / 60)}${Math.abs(utcOffset) % 60 ? ':' + pad(Math.abs(utcOffset) % 60) : ''}`;
		return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} UTC${offset}`;
	},
	/** One SVG path of dots; the plot spans -2..2 on both axes. */
	dabConstellationPath(this: AppInstance, index: number): string {
		const points = this.dabStatus[index]?.constellation ?? [];
		let path = '';
		for (let i = 0; i + 1 < points.length; i += 2) path += `M${points[i]} ${-points[i + 1]}h0`;
		return path;
	},
};
