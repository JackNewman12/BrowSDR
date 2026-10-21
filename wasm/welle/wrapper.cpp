/* BrowSDR streaming adapter for the welle.io DAB/DAB+ backend (GPL-2.0-or-later). */
#include <emscripten.h>
#include <algorithm>
#include <cstdio>
#include <chrono>
#include <cmath>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include "radio-receiver.h"
#include "libs/json.hpp"

using nlohmann::json;

/* Samples pushed by JS on the worker thread, pulled by welle's OFDM thread. */
class PushInput : public InputInterface {
    public:
        void push(const float *iq, int count) {
            std::lock_guard<std::mutex> lock(mutex);
            for (int i = 0; i < count; i++) samples.emplace_back(iq[2 * i], iq[2 * i + 1]);
            // Drop the oldest half second if decoding falls behind real time.
            if (samples.size() > 2048000) samples.erase(samples.begin(), samples.begin() + 1024000);
        }
        int32_t getSamples(DSPCOMPLEX *buffer, int32_t size) override {
            std::lock_guard<std::mutex> lock(mutex);
            int32_t n = std::min<int32_t>(size, samples.size());
            std::copy(samples.begin(), samples.begin() + n, buffer);
            samples.erase(samples.begin(), samples.begin() + n);
            return n;
        }
        int32_t getSamplesToRead() override {
            std::lock_guard<std::mutex> lock(mutex);
            return samples.size();
        }
        void setFrequency(int) override {}
        int getFrequency() const override { return 0; }
        bool is_ok() override { return true; }
        bool restart() override { return true; }
        void stop() override {}
        void reset() override {}
        std::vector<DSPCOMPLEX> getSpectrumSamples(int) override { return {}; }
        float setGain(int) override { return 0; }
        float getGain() const override { return 0; }
        int getGainCount() override { return 0; }
        void setAgc(bool) override {}
        std::string getDescription() override { return "BrowSDR"; }
    private:
        std::mutex mutex;
        std::deque<DSPCOMPLEX> samples;
};

/* Collects backend callbacks (from welle threads) until JS polls them. */
class Collector : public RadioControllerInterface, public ProgrammeHandlerInterface {
    public:
        std::mutex mutex;
        bool sync = false, signal = false;
        float snr = 0;
        int fineCorrection = 0, coarseCorrection = 0;
        int frameErrors = 0, rsErrors = 0, aacErrors = 0;
        int audioRate = 0;
        std::string audioMode, dls;
        std::deque<int16_t> audio;
        std::vector<DSPCOMPLEX> constellation;
        std::vector<uint8_t> slide;
        int slideType = 0, slideSeq = 0;
        dab_date_time_t dateTime;
        bool hasTime = false;

        void onSNR(float value) override { std::lock_guard<std::mutex> l(mutex); snr = value; }
        void onFrequencyCorrectorChange(int fine, int coarse) override {
            std::lock_guard<std::mutex> l(mutex); fineCorrection = fine; coarseCorrection = coarse;
        }
        void onSyncChange(char isSync) override { std::lock_guard<std::mutex> l(mutex); sync = isSync; }
        void onSignalPresence(bool isSignal) override { std::lock_guard<std::mutex> l(mutex); signal = isSignal; }
        void onServiceDetected(uint32_t) override {}
        void onNewEnsemble(uint16_t) override {}
        void onSetEnsembleLabel(DabLabel&) override {}
        void onDateTimeUpdate(const dab_date_time_t& value) override {
            std::lock_guard<std::mutex> l(mutex); dateTime = value; hasTime = true;
        }
        void onFIBDecodeSuccess(bool, const uint8_t*) override {}
        void onNewImpulseResponse(std::vector<float>&&) override {}
        void onConstellationPoints(std::vector<DSPCOMPLEX>&& data) override {
            std::lock_guard<std::mutex> l(mutex); constellation = std::move(data);
        }
        void onNewNullSymbol(std::vector<DSPCOMPLEX>&&) override {}
        void onTIIMeasurement(tii_measurement_t&&) override {}
        void onMessage(message_level_t, const std::string&, const std::string&) override {}

        void onFrameErrors(int errors) override { std::lock_guard<std::mutex> l(mutex); frameErrors = errors; }
        void onNewAudio(std::vector<int16_t>&& data, int sampleRate, const std::string& mode) override {
            std::lock_guard<std::mutex> l(mutex);
            if (sampleRate != audioRate) audio.clear();
            audioRate = sampleRate;
            audioMode = mode;
            audio.insert(audio.end(), data.begin(), data.end());
            // Bound latency to two seconds of stereo audio.
            if (audio.size() > 192000) audio.erase(audio.begin(), audio.end() - 192000);
        }
        void onRsErrors(bool uncorrected, int) override { std::lock_guard<std::mutex> l(mutex); rsErrors += uncorrected; }
        void onAacErrors(int errors) override { std::lock_guard<std::mutex> l(mutex); aacErrors += errors; }
        void onNewDynamicLabel(const std::string& label) override { std::lock_guard<std::mutex> l(mutex); dls = label; }
        void onMOT(const mot_file_t& file) override {
            // Slideshow images only: MOT subtype 1 is JPEG, 3 is PNG.
            if (file.content_sub_type != 1 && file.content_sub_type != 3) return;
            std::lock_guard<std::mutex> l(mutex);
            slide = file.data;
            slideType = file.content_sub_type;
            slideSeq++;
        }
        void onPADLengthError(size_t, size_t) override {}
};

static std::unique_ptr<PushInput> input;
static std::unique_ptr<Collector> collector;
static std::unique_ptr<RadioReceiver> receiver;
static uint32_t wantedService = 0, playingService = 0;
static std::string statusJson;
static std::vector<uint8_t> slideCopy;

extern "C" {

EMSCRIPTEN_KEEPALIVE void dab_destroy() {
    receiver.reset(); // joins welle threads before their inputs go away
    collector.reset();
    input.reset();
    wantedService = playingService = 0;
}

EMSCRIPTEN_KEEPALIVE void dab_init() {
    dab_destroy();
    input = std::make_unique<PushInput>();
    collector = std::make_unique<Collector>();
    receiver = std::make_unique<RadioReceiver>(*collector, *input, RadioReceiverOptions{});
    receiver->restart(false);
}

/* iq: interleaved float I/Q at 2.048 MS/s; count: complex samples. */
EMSCRIPTEN_KEEPALIVE void dab_push(const float *iq, int count) {
    if (input) input->push(iq, count);
}

EMSCRIPTEN_KEEPALIVE void dab_select(uint32_t serviceId) {
    wantedService = serviceId;
}

/* Copies up to maxFrames stereo frames into out; returns frames copied. */
EMSCRIPTEN_KEEPALIVE int dab_audio_read(int16_t *out, int maxFrames) {
    if (!collector) return 0;
    std::lock_guard<std::mutex> l(collector->mutex);
    int frames = std::min<int>(maxFrames, collector->audio.size() / 2);
    std::copy(collector->audio.begin(), collector->audio.begin() + frames * 2, out);
    collector->audio.erase(collector->audio.begin(), collector->audio.begin() + frames * 2);
    return frames;
}

EMSCRIPTEN_KEEPALIVE int dab_audio_rate() {
    if (!collector) return 0;
    std::lock_guard<std::mutex> l(collector->mutex);
    return collector->audioRate;
}

/* Copies the latest slideshow image; info receives [bytes, MOT subtype]. Valid until the next call. */
EMSCRIPTEN_KEEPALIVE const uint8_t *dab_slide(int *info) {
    info[0] = info[1] = 0;
    if (!collector) return nullptr;
    std::lock_guard<std::mutex> l(collector->mutex);
    slideCopy = collector->slide;
    info[0] = slideCopy.size();
    info[1] = collector->slideType;
    return slideCopy.data();
}

/* Returns a JSON status snapshot, valid until the next call. */
EMSCRIPTEN_KEEPALIVE const char *dab_status() {
    if (!receiver) return "{}";
    json services = json::array();
    for (const auto& s : receiver->getServiceList()) {
        if (!receiver->serviceHasAudioComponent(s)) continue;
        json service = {{"id", s.serviceId}, {"label", s.serviceLabel.utf8_label()}, {"dabPlus", false},
            {"programType", DABConstants::getProgramTypeName(s.programType)},
            {"language", DABConstants::getLanguageName(s.language)}, {"bitrate", 0}, {"protection", ""}};
        for (const auto& c : receiver->getComponents(s)) {
            if (c.transportMode() != TransportMode::Audio) continue;
            const auto sub = receiver->getSubchannel(c);
            service["dabPlus"] = c.ASCTy == 63;
            service["bitrate"] = sub.bitrate();
            service["protection"] = sub.protection();
            break;
        }
        services.push_back(service);
        if (s.serviceId == wantedService && playingService != wantedService) {
            if (receiver->playSingleProgramme(*collector, "", s)) {
                playingService = wantedService;
                std::lock_guard<std::mutex> l(collector->mutex);
                collector->dls.clear();
                collector->audio.clear();
                collector->audioMode.clear();
                collector->frameErrors = collector->rsErrors = collector->aacErrors = 0;
                collector->slide.clear();
                collector->slideType = 0;
                collector->slideSeq++;
            }
        }
    }
    json status = {
        {"ensemble", receiver->getEnsembleLabel().utf8_label()},
        {"ensembleId", receiver->getEnsembleId()},
        {"services", services},
        {"playing", playingService},
    };
    json points = json::array();
    {
        std::lock_guard<std::mutex> l(collector->mutex);
        status["sync"] = collector->sync;
        status["signal"] = collector->signal;
        status["snr"] = collector->snr;
        status["fineCorrection"] = collector->fineCorrection;
        status["coarseCorrection"] = collector->coarseCorrection;
        status["frameErrors"] = collector->frameErrors;
        status["rsErrors"] = collector->rsErrors;
        status["aacErrors"] = collector->aacErrors;
        status["audioRate"] = collector->audioRate;
        status["audioMode"] = collector->audioMode;
        status["dls"] = collector->dls;
        status["slideSeq"] = collector->slideSeq;
        if (collector->hasTime) {
            const auto& t = collector->dateTime;
            char utc[24];
            std::snprintf(utc, sizeof utc, "%04d-%02d-%02dT%02d:%02d:%02dZ", t.year, t.month, t.day, t.hour, t.minutes, t.seconds);
            status["time"] = utc;
            status["utcOffset"] = t.hourOffset * 60 + (t.hourOffset < 0 ? -t.minuteOffset : t.minuteOffset);
        }
        // Differential products have arbitrary scale; normalise to mean magnitude 1.
        float mean = 0;
        for (const auto& p : collector->constellation) mean += std::abs(p);
        mean = mean > 0 ? mean / collector->constellation.size() : 1;
        for (const auto& p : collector->constellation) {
            // Two decimals keep the JSON small; the plot is ~100 px across.
            points.push_back(std::round(p.real() / mean * 100) / 100);
            points.push_back(std::round(p.imag() / mean * 100) / 100);
        }
        collector->constellation.clear();
    }
    status["constellation"] = points;
    statusJson = status.dump();
    return statusJson.c_str();
}

}
