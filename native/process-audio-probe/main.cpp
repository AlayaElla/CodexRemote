// Independent in-memory experiment using Microsoft's process-loopback API.
// Reference: Windows-classic-samples/Samples/ApplicationLoopback.
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <mmdeviceapi.h>
#include <ksmedia.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl.h>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>
#include <algorithm>
using Microsoft::WRL::ComPtr;
constexpr UINT32 Rate = 44100;
constexpr double Pi = 3.14159265358979323846;
std::wstring OutputId;
thread_local HRESULT lastFailure = E_FAIL;
void Check(HRESULT hr) { if (FAILED(hr)) { lastFailure = hr; char text[32]; sprintf_s(text, "HRESULT 0x%08lX", static_cast<unsigned long>(hr)); throw std::runtime_error(text); } }
struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) { if (!h) throw std::runtime_error("Cannot create Windows handle"); }
    ~Handle() { if (value) CloseHandle(value); }
    Handle(const Handle&) = delete;
};
WAVEFORMATEX Format() { return { WAVE_FORMAT_PCM, 2, Rate, Rate * 4, 4, 16, 0 }; }
ComPtr<IMMDevice> DefaultOutput() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    Check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)));
    ComPtr<IMMDevice> device;
    if (OutputId.empty()) Check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device));
    else Check(enumerator->GetDevice(OutputId.c_str(), &device));
    return device;
}
struct Activation : Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
    Handle ready{ CreateEventW(nullptr, TRUE, FALSE, nullptr) };
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activated = E_FAIL; ComPtr<IUnknown> value;
        result = operation->GetActivateResult(&activated, &value);
        if (SUCCEEDED(result)) result = activated;
        if (SUCCEEDED(result)) result = value.As(&client);
        SetEvent(ready.value); return S_OK;
    }
};
struct Capture {
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> reader;
    Handle event{ CreateEventW(nullptr, FALSE, FALSE, nullptr) };
    explicit Capture(DWORD process) {
        std::cout << "phase: activate target " << process << std::endl;
        auto completion = Microsoft::WRL::Make<Activation>();
        AUDIOCLIENT_ACTIVATION_PARAMS params{};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId = process;
        params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        PROPVARIANT variant{}; variant.vt = VT_BLOB; variant.blob.cbSize = sizeof(params); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
        ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
        Check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, completion.Get(), &operation));
        if (WaitForSingleObject(completion->ready.value, 5000) != WAIT_OBJECT_0) throw std::runtime_error("Process capture activation timed out");
        Check(completion->result); client = completion->client;
        std::cout << "phase: initialize capture" << std::endl;
        auto format = Format();
        Check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0, 0, &format, nullptr));
        Check(client->GetService(IID_PPV_ARGS(&reader))); Check(client->SetEventHandle(event.value));
        std::cout << "phase: capture initialized" << std::endl;
    }
    ~Capture() { if (client) client->Stop(); }
    void Drain(std::vector<float>& samples) {
        UINT32 count = 0;
        for (Check(reader->GetNextPacketSize(&count)); count; Check(reader->GetNextPacketSize(&count))) {
            BYTE* buffer = nullptr; DWORD flags = 0;
            Check(reader->GetBuffer(&buffer, &count, &flags, nullptr, nullptr));
            if (samples.size() + count > Rate * 10) { reader->ReleaseBuffer(count); throw std::runtime_error("Capture memory limit"); }
            const auto data = reinterpret_cast<const short*>(buffer);
            for (UINT32 i = 0; i < count; ++i) samples.push_back((flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.f : (data[i * 2] + data[i * 2 + 1]) / 65536.f);
            Check(reader->ReleaseBuffer(count));
        }
    }
};
int Render(double frequency, bool mute, const wchar_t* goName, const wchar_t* readyName) {
    std::cout << "renderer " << GetCurrentProcessId() << ": opening events" << std::endl;
    Handle go{ goName ? OpenEventW(SYNCHRONIZE, FALSE, goName) : CreateEventW(nullptr, TRUE, TRUE, nullptr) };
    Handle ready{ readyName ? OpenEventW(EVENT_MODIFY_STATE, FALSE, readyName) : CreateEventW(nullptr, TRUE, FALSE, nullptr) };
    auto device = DefaultOutput(); ComPtr<IAudioClient> client;
    std::cout << "renderer " << GetCurrentProcessId() << ": activating output" << std::endl;
    Check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())));
    WAVEFORMATEX* mix = nullptr; Check(client->GetMixFormat(&mix));
    struct MixOwner { WAVEFORMATEX* value; ~MixOwner() { CoTaskMemFree(value); } } mixOwner{mix};
    const bool isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
        (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE && reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mix)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    if (isFloat ? mix->wBitsPerSample != 32 : mix->wBitsPerSample != 16) throw std::runtime_error("Unsupported renderer mix format");
    GUID session; Check(CoCreateGuid(&session));
    std::cout << "renderer " << GetCurrentProcessId() << ": initializing output" << std::endl;
    std::cout << "mix: " << mix->nSamplesPerSec << " Hz, " << mix->nChannels << " channels, " << mix->wBitsPerSample << " bits, float=" << isFloat << std::endl;
    Check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_NOPERSIST, 1000000, 0, mix, &session));
    ComPtr<ISimpleAudioVolume> volume; Check(client->GetService(IID_PPV_ARGS(&volume)));
    std::cout << "renderer " << GetCurrentProcessId() << ": configuring session" << std::endl;
    Check(volume->SetMasterVolume(1.f, nullptr)); Check(volume->SetMute(mute, nullptr));
    BOOL confirmed = FALSE; Check(volume->GetMute(&confirmed));
    if (!!confirmed != mute) throw std::runtime_error("Session mute did not apply");
    ComPtr<IAudioRenderClient> writer; Check(client->GetService(IID_PPV_ARGS(&writer)));
    UINT32 capacity; Check(client->GetBufferSize(&capacity));
    UINT64 produced = 0;
    auto fill = [&](UINT32 frames) {
        BYTE* bytes; Check(writer->GetBuffer(frames, &bytes));
        for (UINT32 i = 0; i < frames; ++i, ++produced) {
            const double t = static_cast<double>(produced) / mix->nSamplesPerSec;
            const double envelope = t < .05 ? t / .05 : t > 5.95 ? std::max(0., (6.0 - t) / .05) : 1.;
            const double value = .01 * envelope * sin(2 * Pi * frequency * t);
            for (UINT32 channel = 0; channel < mix->nChannels; ++channel) {
                if (isFloat) reinterpret_cast<float*>(bytes)[i * mix->nChannels + channel] = static_cast<float>(value);
                else reinterpret_cast<short*>(bytes)[i * mix->nChannels + channel] = static_cast<short>(32767 * value);
            }
        }
        Check(writer->ReleaseBuffer(frames, 0));
    };
    fill(capacity); SetEvent(ready.value);
    std::cout << "renderer " << GetCurrentProcessId() << ": ready" << std::endl;
    if (WaitForSingleObject(go.value, 20000) != WAIT_OBJECT_0) throw std::runtime_error("Render start timed out");
    Check(client->Start()); const auto end = GetTickCount64() + 6200;
    try {
        while (GetTickCount64() < end) {
            UINT32 padding; Check(client->GetCurrentPadding(&padding));
            if (padding < capacity) fill(capacity - padding);
            Sleep(5);
        }
    } catch (...) { client->Stop(); throw; }
    Check(client->Stop()); return 0;
}
struct Child {
    PROCESS_INFORMATION process{};
    Child(const std::wstring& args, HANDLE job) {
        wchar_t self[32768]; if (!GetModuleFileNameW(nullptr, self, 32768)) throw std::runtime_error("Executable path unavailable");
        std::wstring command = L"\"" + std::wstring(self) + L"\" " + args;
        STARTUPINFOW startup{}; startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        SetHandleInformation(startup.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(startup.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(startup.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        if (!CreateProcessW(self, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup, &process)) throw std::runtime_error("Cannot launch tone process");
        if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateProcess(process.hProcess, 1); CloseHandle(process.hThread); CloseHandle(process.hProcess); process = {}; throw std::runtime_error("Cannot contain tone process"); }
        ResumeThread(process.hThread);
    }
    ~Child() { if (process.hProcess) { if (WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) TerminateProcess(process.hProcess, 1); CloseHandle(process.hThread); CloseHandle(process.hProcess); } }
    void VerifyExit() { if (WaitForSingleObject(process.hProcess, 2000) != WAIT_OBJECT_0) throw std::runtime_error("Tone process timeout"); DWORD code; if (!GetExitCodeProcess(process.hProcess, &code) || code != 0) throw std::runtime_error("Tone process failed"); }
};
double Magnitude(const std::vector<float>& values, double hz) {
    double re = 0, im = 0;
    for (size_t i = 0; i < values.size(); ++i) { const double phase = 2 * Pi * hz * static_cast<double>(i) / Rate; re += values[i] * cos(phase); im += values[i] * sin(phase); }
    return values.empty() ? 0 : 2 * sqrt(re * re + im * im) / values.size();
}
bool Probe(bool mute) {
    const auto prefix = L"Local\\CodexRemoteProcessProbe-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    const auto goName = prefix + L"-go", targetName = prefix + L"-target", otherName = prefix + L"-other";
    Handle go{ CreateEventW(nullptr, TRUE, FALSE, goName.c_str()) }, ready{ CreateEventW(nullptr, TRUE, FALSE, targetName.c_str()) }, otherReady{ CreateEventW(nullptr, TRUE, FALSE, otherName.c_str()) };
    Handle job{ CreateJobObjectW(nullptr, nullptr) }; JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) throw std::runtime_error("Cannot configure child lifetime");
    auto args = [&](int hz, const std::wstring& name) { return L"--render " + std::to_wstring(hz) + (mute ? L" 1 " : L" 0 ") + goName + L" " + name + L" --device-id \"" + OutputId + L"\""; };
    Child target(args(997, targetName), job.value), other(args(1733, otherName), job.value);
    std::cout << "phase: wait for render children" << std::endl;
    HANDLE events[]{ ready.value, otherReady.value };
    if (WaitForMultipleObjects(2, events, TRUE, 6000) != WAIT_OBJECT_0) {
        DWORD a = 0, b = 0; GetExitCodeProcess(target.process.hProcess, &a); GetExitCodeProcess(other.process.hProcess, &b);
        std::cout << "Tone process status: target=0x" << std::hex << a << "; other=0x" << b << std::dec << std::endl;
        throw std::runtime_error("Tone initialization failed or timed out");
    }
    SetEvent(go.value); Sleep(500);
    Capture capture(target.process.dwProcessId);
    std::cout << "phase: start capture" << std::endl;
    Check(capture.client->Start());
    std::vector<float> samples; samples.reserve(Rate * 6); const auto until = GetTickCount64() + 5800;
    while (GetTickCount64() < until) { WaitForSingleObject(capture.event.value, 50); capture.Drain(samples); }
    std::cout << "phase: stop capture" << std::endl;
    Check(capture.client->Stop()); target.VerifyExit(); other.VerifyExit();
    const auto targetMagnitude = Magnitude(samples, 997), otherMagnitude = Magnitude(samples, 1733);
    double energy = 0; for (const auto value : samples) energy += value * value;
    const bool passed = samples.size() > Rate / 2 && targetMagnitude > .002 && otherMagnitude < targetMagnitude * .02;
    std::cout << "{\"sessionMuted\":" << (mute ? "true" : "false") << ",\"frames\":" << samples.size() << ",\"target997\":" << targetMagnitude << ",\"excluded1733\":" << otherMagnitude << ",\"rms\":" << (samples.empty() ? 0 : sqrt(energy / samples.size())) << ",\"passed\":" << (passed ? "true" : "false") << "}" << std::endl;
    return passed;
}
int wmain(int argc, wchar_t** argv) {
    Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    try {
        if (argc == 8 && std::wstring(argv[1]) == L"--render" && std::wstring(argv[6]) == L"--device-id") { OutputId = argv[7]; return Render(_wtof(argv[2]), std::wstring(argv[3]) == L"1", argv[4], argv[5]); }
        if (argc == 4 && std::wstring(argv[2]) == L"--device-id") OutputId = argv[3];
        if (argc == 4 && std::wstring(argv[1]) == L"--render-only") return Render(997, false, nullptr, nullptr);
        if ((argc != 2 && argc != 4) || std::wstring(argv[1]) != L"--self-probe") { std::cout << "Usage: ProcessAudioProbe --self-probe [--device-id ID] (two brief low-volume tones; no microphone or audio files)\n"; return 2; }
        // A native driver call may block beyond its documented contract. This
        // standalone experiment must never leave capture or tone workers alive.
        HANDLE watchdog = CreateThread(nullptr, 0, [](void*) -> DWORD { Sleep(40000); TerminateProcess(GetCurrentProcess(), 124); return 0; }, nullptr, 0, nullptr);
        if (!watchdog) throw std::runtime_error("Cannot create probe watchdog");
        CloseHandle(watchdog);
        auto device = DefaultOutput(); ComPtr<IPropertyStore> properties; Check(device->OpenPropertyStore(STGM_READ, &properties));
        ComPtr<IAudioEndpointVolume> endpointVolume;
        Check(device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(endpointVolume.GetAddressOf())));
        float level; BOOL endpointMuted; Check(endpointVolume->GetMasterVolumeLevelScalar(&level)); Check(endpointVolume->GetMute(&endpointMuted));
        std::cout << "Endpoint volume: " << level << "; endpoint muted: " << !!endpointMuted << std::endl;
        PROPVARIANT name{}; Check(properties->GetValue(PKEY_Device_FriendlyName, &name));
        char outputName[2048]{}; WideCharToMultiByte(CP_UTF8, 0, name.pwszVal, -1, outputName, sizeof(outputName), nullptr, nullptr);
        std::cout << "Test output: " << outputName << std::endl; PropVariantClear(&name);
        const bool audible = Probe(false); const bool muted = Probe(true);
        return audible && muted ? 0 : 1;
    } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return static_cast<int>(lastFailure); }
}
