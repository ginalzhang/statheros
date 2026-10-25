#!/usr/bin/env python3
"""Process-level fake-input checks. Never passes --real-input or opens devices."""
import json, queue, subprocess, sys, threading, time, uuid

binary = sys.argv[1] if len(sys.argv) > 1 else 'resources/bin/SteadyNative'

def launch():
    process = subprocess.Popen([binary, '--test-fake-backend'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    incoming = queue.Queue()
    def read():
        for line in process.stdout:
            message = json.loads(line)
            message["_receivedTimestamp"] = time.monotonic()*1000
            incoming.put(message)
    threading.Thread(target=read, daemon=True).start()
    return process, incoming

class Peer:
    def __init__(self):
        self.process, self.incoming = launch()
        self.session = str(uuid.uuid4()); self.seq = 0; self.states = []
        hello = self.request('hello', {'bundleId': 'org.steady.local'})
        assert hello['accepted'] and hello['protocolVersion'] == 1
        assert 'fake-input' in hello['capabilities']
        rounds = []
        for _ in range(8):
            start = time.monotonic()*1000
            ack = self.request('ping', {'senderTimestamp': start})
            end = time.monotonic()*1000
            rounds.append((end-start, ack['nativeTimestamp']-(start+end)/2))
        self.offset = min(rounds)[1]
        self.request('configure', {'generation': 1, 'targetBundleId': 'org.krita', 'targetPid': 123, 'displayId': 1, 'canvas': {'x': -1000, 'y': 100, 'width': 500, 'height': 500}, 'excludedRects': []})
    def request(self, kind, payload):
        self.seq += 1
        self.process.stdin.write(json.dumps({'v': 1, 'session': self.session, 'seq': self.seq, 'type': kind, 'payload': payload})+'\n')
        self.process.stdin.flush()
        deadline = time.monotonic()+2
        while time.monotonic() < deadline:
            message = self.incoming.get(timeout=2)
            if message['type'] == 'state':
                self.states.append((message['_receivedTimestamp'], message['payload']))
            if message['type'] == 'ack' and message['payload']['requestSeq'] == self.seq:
                return message['payload']
        raise AssertionError('missing ack')
    def ready_and_down(self):
        for frame in range(1, 7):
            stamp = time.monotonic()*1000+self.offset
            ack = self.request('sample', {'generation': 1, 'frameId': frame, 'captureTimestamp': stamp, 'valid': True, 'position': {'x': -800, 'y': 200}})
            assert ack['accepted'], ack
            if frame < 6:
                time.sleep(.105)
        self.last_capture_main = stamp-self.offset
        for action in ['resume', 'penDown']:
            ack = self.request('action', {'generation': 1, 'eventId': str(uuid.uuid4()), 'actionId': action})
            assert ack['accepted'], ack
        assert ack['state']['buttonDown']
    def eof(self):
        self.process.stdin.close()
        self.process.wait(timeout=2)
        diagnostics = self.process.stderr.read()
        event_line = next(line for line in diagnostics.splitlines() if line.startswith('fake-events: '))
        events = json.loads(event_line.removeprefix('fake-events: '))
        assert events[-1] == 'up', events
        assert self.process.returncode == 0
        return events

peer = Peer(); peer.ready_and_down()
for _ in range(4):
    time.sleep(.085)
    ack = peer.request('ping', {'senderTimestamp': time.monotonic()*1000})
assert ack['state']['state'] == 'PAUSED' and not ack['state']['buttonDown'], ack
assert ack['state']['reason'] == 'stale-capture'
release_observation = next(observed for observed,state in peer.states if state['reason'] == 'stale-capture')
release_upper_bound_ms = release_observation-peer.last_capture_main
assert release_upper_bound_ms <= 300, release_upper_bound_ms
assert 'down' in peer.eof()
print(f'PASS actual process: live pings do not refresh stale capture; release observed within {release_upper_bound_ms:.1f}ms (fake backend, <=300ms)')

peer = Peer(); peer.ready_and_down(); assert 'down' in peer.eof()
print('PASS actual process: parent stdin EOF releases held fake button and exits')

release = subprocess.run([binary, '--test-fake-backend', '--release-and-exit'], capture_output=True, text=True, timeout=2)
assert release.returncode == 0 and 'fake-events: ["up"]' in release.stderr
release_default = subprocess.run([binary, '--release-and-exit'], capture_output=True, text=True, timeout=2)
assert release_default.returncode == 0 and 'fake mode' in release_default.stderr
print('PASS actual process: emergency entry point attempts fake up; default posts no desktop event')

process, incoming = launch()
process.stdin.write('x'*16385); process.stdin.flush()
fault = incoming.get(timeout=2)
assert fault['type'] == 'fault'
process.wait(timeout=2)
assert process.returncode == 3
print('PASS actual process: oversized incomplete message faults and exits')

# Exercise the exact dedicated probe branch, not just the stdio engine's EOF path.
probe = subprocess.Popen([binary, '--probe', '--test-fake-backend'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
probe.stdin.write('CONFIRM_DISPOSABLE_KRITA\n'); probe.stdin.flush()
probe_messages = queue.Queue()
def read_probe():
    for line in probe.stdout:
        probe_messages.put(json.loads(line))
threading.Thread(target=read_probe, daemon=True).start()
while True:
    message = probe_messages.get(timeout=2)
    if message['type'] == 'ack' and message['payload']['state']['buttonDown']:
        break
probe.stdin.close(); probe.wait(timeout=2)
assert probe.returncode == 0
probe_diagnostics = probe.stderr.read()
probe_events = json.loads(next(line for line in probe_diagnostics.splitlines() if line.startswith('fake-events: ')).removeprefix('fake-events: '))
assert 'down' in probe_events and probe_events[-1] == 'up', probe_events
print('PASS actual process: dedicated bounded probe observes EOF and releases held fake button')

peer = Peer()
# Legacy speech requests cannot schedule permission, asset, or microphone work.
for kind, payload in [('microphone', {'enabled': True, 'speechSession': str(uuid.uuid4())}), ('installSpeechAssets', {'locale': 'en-US'})]:
    ack = peer.request(kind, payload)
    assert not ack['accepted'] and ack['code'] == 'voice-deferred-phase01', ack
assert peer.request('microphone', {'enabled': False, 'speechSession': str(uuid.uuid4())})['accepted']
peer.eof()
print('PASS actual process: deferred voice rejects microphone enable and asset setup; disable remains allowed')

peer = Peer()
time.sleep(1.2)
peer.eof()
assert 'steady-speech-probe:' not in peer.process.stderr.read()
print('PASS actual process: idle helper has no retired speech diagnostics timer')
process, incoming = launch()
process.stdin.write(json.dumps({'v': 2, 'session': str(uuid.uuid4()), 'seq': 1, 'type': 'hello', 'payload': {'bundleId': 'org.steady.local'}})+'\n'); process.stdin.flush()
assert incoming.get(timeout=2)['type'] == 'fault'
process.wait(timeout=2)
assert process.returncode == 3
assert 'fake-events: ["up","up"]' in process.stderr.read()
print('PASS actual process: protocol-version mismatch faults and releases without input')
print('8 process checks passed; fake backend only; no camera/microphone/native input used')
