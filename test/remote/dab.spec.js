import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/worker/runtime/wasm-init', () => ({ ensureWasmInitialized: vi.fn(), init: vi.fn() }));
vi.mock('@/remote/webrtc', () => ({
	PEER_ID_PREFIX: 'test-',
	WebRTCHandler: class {
		init = vi.fn();
		sendCommandTo = vi.fn();
		sendAudioChunkTo = vi.fn();
	},
}));

import * as remoteBackend from '@/worker/streams/remote-clients';
import { remoteMethods } from '@/app/workspace/remote';
import { dabMethods } from '@/app/decoders/dab';
import { isReceiverCommand } from '@/remote/validation';

afterEach(() => vi.unstubAllGlobals());

const params = { freq: 202.928, mode: 'dab', enabled: true, dabService: 0x1234, bandwidth: 1536000, volume: 50 };
const slide = 'data:image/png;base64,iVBORw==';
const status = {
	state: 'receiving',
	message: 'Synchronised',
	sync: true,
	snr: 17.5,
	ensemble: 'DAB+ Brisbane 1',
	ensembleId: 0x1001,
	services: [{ id: 0x1234, label: 'Nova1069', dabPlus: true, programType: '', language: '', bitrate: 48, protection: 'EEP 3-A' }],
	playing: 0x1234,
	dls: 'Song - Artist',
	audioMode: 'HE-AAC',
	frameErrors: 0,
	rsErrors: 0,
	aacErrors: 0,
	constellation: [1, 0, 0, -1],
	time: '2026-10-21T23:12:42Z',
	utcOffset: 600,
	slide,
};

function makeBackend() {
	vi.stubGlobal(
		'Worker',
		class {
			terminate = vi.fn();
			postMessage() {}
		},
	);
	const backend = { _sampleRate: 2048000, _centerFreq: 202.928, sharedIqPools: [new ArrayBuffer(32)] };
	for (const [name, method] of Object.entries(remoteBackend)) backend[name] = method.bind(backend);
	return backend;
}

describe('remote DAB status', () => {
	it('reaches the matching client through validation and sends each slide once', async () => {
		vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
		vi.stubGlobal('localStorage', { getItem: () => null });
		const backend = makeBackend();
		const host = { connected: true, running: true, remoteMode: 'none', locks: {}, backend, radio: {}, gains: {} };
		await remoteMethods.startRemoteHost.call(host);
		const client = { remoteMode: 'client', vfos: [{ ...params }], dabStatus: [], ...dabMethods };
		const sent = [];
		host._webrtc.sendCommandTo.mockImplementation((id, command) => {
			const wire = JSON.parse(JSON.stringify(command));
			sent.push(wire);
			expect(id).toBe('alice');
			expect(isReceiverCommand(wire)).toBe(true);
			remoteMethods.handleRemoteCommand.call(client, wire);
		});
		await backend.addRemoteClient('alice');
		await backend.setRemoteVfoParams('alice', 0, params);
		const worker = backend._remoteClients.get('alice').workers[0];
		worker.onmessage({ data: { type: 'dab_status', status } });
		worker.onmessage({ data: { type: 'dab_status', status: { ...status, dls: 'Next song' } } });
		expect(sent.map((command) => command.status.slide)).toEqual([slide, undefined]);
		expect(client.dabStatus[0]).toMatchObject({ dls: 'Next song', slide });
		expect(client.dabStationLabel(0)).toBe('Nova1069');

		await backend.setRemoteVfoParams('alice', 0, { ...params, mode: 'wfm' });
		worker.onmessage({ data: { type: 'dab_status', status } });
		expect(sent).toHaveLength(2);
	});

	it('rejects malformed status and slides that are not inline images', () => {
		const command = (changes) => ({ type: 'dab_status', vfoIndex: 0, status: { ...status, ...changes } });
		expect(isReceiverCommand(command({}))).toBe(true);
		expect(isReceiverCommand(command({ slide: undefined }))).toBe(true);
		expect(isReceiverCommand(command({ snr: null }))).toBe(false);
		expect(isReceiverCommand(command({ constellation: [1, null] }))).toBe(false);
		expect(isReceiverCommand(command({ services: [{ ...status.services[0], label: 7 }] }))).toBe(false);
		expect(isReceiverCommand(command({ slide: 'https://example.com/track.png' }))).toBe(false);
		expect(isReceiverCommand(command({ slide: 'data:image/svg+xml;base64,PHN2Zz4=' }))).toBe(false);
	});
});
