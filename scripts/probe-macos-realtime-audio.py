#!/usr/bin/env python3
"""Explicit-device synthetic loopback probe. No microphone or audio files.
Usage: python3 scripts/probe-macos-realtime-audio.py DEVICE_UID LIBOPUS_PATH
The selected BlackHole must be idle; this writes a short 440 Hz test tone to it.
"""
import base64
import ctypes as c
import json
import math
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'native/macos-audio-bridge/.build/release/CodexRemoteMacAudioBridge'

class Helper:
    def __init__(self):
        self.process = subprocess.Popen([str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.replies, self.events = queue.Queue(), queue.Queue()
        self.number = 0
        def read():
            for line in self.process.stdout:
                value = json.loads(line)
                (self.events if 'event' in value else self.replies).put(value)
        threading.Thread(target=read, daemon=True).start()

    def request(self, op, **values):
        self.number += 1
        self.process.stdin.write(json.dumps(dict(id=str(self.number), op=op, **values)) + '\n')
        self.process.stdin.flush()
        reply = self.replies.get(timeout=10)
        assert reply['id'] == str(self.number), reply
        assert reply['ok'], (reply, list(self.events.queue))
        return reply.get('result', reply)

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        assert self.process.returncode == 0, self.process.returncode


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    device, library = sys.argv[1:]
    opus = c.CDLL(library)
    opus.opus_encoder_create.argtypes = [c.c_int, c.c_int, c.c_int, c.POINTER(c.c_int)]
    opus.opus_encoder_create.restype = c.c_void_p
    opus.opus_decoder_create.argtypes = [c.c_int, c.c_int, c.POINTER(c.c_int)]
    opus.opus_decoder_create.restype = c.c_void_p
    opus.opus_encode.argtypes = [c.c_void_p, c.POINTER(c.c_int16), c.c_int, c.POINTER(c.c_ubyte), c.c_int]
    opus.opus_decode.argtypes = [c.c_void_p, c.POINTER(c.c_ubyte), c.c_int, c.POINTER(c.c_int16), c.c_int, c.c_int]
    opus.opus_encoder_destroy.argtypes = [c.c_void_p]
    opus.opus_decoder_destroy.argtypes = [c.c_void_p]
    error = c.c_int()
    encoder = opus.opus_encoder_create(16000, 1, 2048, c.byref(error))
    assert encoder and error.value == 0
    decoder = opus.opus_decoder_create(16000, 1, c.byref(error))
    assert decoder and error.value == 0
    capture, inject = Helper(), Helper()
    try:
        devices = capture.request('capture_list')['devices']
        assert any(d['id'] == device for d in devices), 'Select an installed BlackHole UID'
        first = capture.request('capture_start', deviceId=device)
        silence = capture.events.get(timeout=5)
        assert silence['event'] == 'capture_audio', silence
        assert silence['captureId'] == first['captureId']
        inject.request('start', deviceId=device)
        for frame in range(25):
            pcm = (c.c_int16 * 960)(*[int(12000 * math.sin(2 * math.pi * 440 * (frame * 960 + i) / 16000)) for i in range(960)])
            packet = (c.c_ubyte * 4096)()
            count = opus.opus_encode(encoder, pcm, 960, packet, 4096)
            assert count > 0
            inject.request('append', packet=base64.b64encode(bytes(packet[:count])).decode())
            time.sleep(0.06)
        inject.request('stop')
        time.sleep(0.15)
        capture.request('capture_stop')
        count, tone_peak, sequence = 0, 0.0, -1
        while not capture.events.empty():
            event = capture.events.get_nowait()
            assert event['event'] == 'capture_audio', event
            assert event['sampleRate'] == 16000 and event['frameDuration'] == 20
            assert event['sequence'] > sequence
            sequence = event['sequence']
            packet = base64.b64decode(event['packet'])
            data = (c.c_ubyte * len(packet)).from_buffer_copy(packet)
            pcm = (c.c_int16 * 320)()
            samples = opus.opus_decode(decoder, data, len(packet), pcm, 320, 0)
            assert samples == 320, samples
            real = sum(pcm[i] * math.cos(2 * math.pi * 440 * i / 16000) for i in range(320))
            imag = sum(pcm[i] * math.sin(2 * math.pi * 440 * i / 16000) for i in range(320))
            tone_peak = max(tone_peak, 2 * math.hypot(real, imag) / 320)
            count += 1
        assert count >= 25 and tone_peak > 200, (count, tone_peak)
        second = capture.request('capture_start', deviceId=device)
        assert second['captureId'] != first['captureId']
        deadline = time.monotonic() + 5
        while True:
            event = capture.events.get(timeout=max(.01, deadline - time.monotonic()))
            if event.get('captureId') == second['captureId']:
                assert event['event'] == 'capture_audio', event
                break
        capture.request('capture_stop')
        print(json.dumps(dict(passed=True, opusFrames=count, frameSamples=320, tone440HzPeak=round(tone_peak), restart=True)))
    finally:
        capture.close()
        inject.close()
        opus.opus_encoder_destroy(encoder)
        opus.opus_decoder_destroy(decoder)

if __name__ == '__main__':
    main()
