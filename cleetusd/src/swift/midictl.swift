// midictl — send and receive MIDI from the shell.
//
// WHY SWIFT AND NOT PYTHON. pyobjc exposes CoreMIDI's symbols but not a usable
// MIDIPacketList: the struct is a variable-length tail-packed C type, and the
// bridge hands back a fixed-size shim, so MIDIPacketListAdd writes into memory
// that is not the packet list and the send silently delivers nothing. No error,
// no bytes on the wire. There is no rtmidi / mido / sendmidi on this machine.
// Swift talks to CoreMIDI directly, so this is the reliable path.
//
// WHY `stream` EXISTS. Every other subcommand opens a CoreMIDI client, sends,
// and exits — roughly 50 ms of setup per invocation. A 128-note LED sweep run
// as 128 processes takes ~7 s, which is far too slow to time a staged test a
// human is watching. `stream` opens the client once and reads a script on
// stdin, so a sweep lands in milliseconds and `sleep` lines mean what they say.
//
// SAFETY NOTE ON SYSEX. Vendor SysEx can write device memory — on Akai and
// Arturia hardware that includes preset banks. This tool will send whatever
// bytes you give it, so only send commands you have a spec for. Nothing here
// guesses at command bytes on its own.

import Foundation
import CoreMIDI

// MARK: - client

var client = MIDIClientRef()
MIDIClientCreate("midictl" as CFString, nil, nil, &client)
var outPort = MIDIPortRef()
MIDIOutputPortCreate(client, "out" as CFString, &outPort)

func str(_ obj: MIDIObjectRef, _ prop: CFString) -> String {
    var p: Unmanaged<CFString>?
    guard MIDIObjectGetStringProperty(obj, prop, &p) == noErr, let p else { return "?" }
    return p.takeRetainedValue() as String
}
func isOffline(_ obj: MIDIObjectRef) -> Bool {
    var v: Int32 = 0
    MIDIObjectGetIntegerProperty(obj, kMIDIPropertyOffline, &v)
    return v != 0
}
func destName(_ i: Int) -> String {
    let d = MIDIGetDestination(i)
    var ent = MIDIEntityRef(); MIDIEndpointGetEntity(d, &ent)
    var dev = MIDIDeviceRef(); MIDIEntityGetDevice(ent, &dev)
    return "\(str(dev, kMIDIPropertyName)) \(str(d, kMIDIPropertyName))"
}

// MARK: - sending

/// Send raw MIDI bytes to a destination index. Handles SysEx (which must not be
/// split across packets) and short messages the same way.
func sendBytes(_ dst: Int, _ bytes: [UInt8]) {
    guard dst >= 0 && dst < MIDIGetNumberOfDestinations() else {
        FileHandle.standardError.write("no destination \(dst)\n".data(using: .utf8)!); return
    }
    let endpoint = MIDIGetDestination(dst)
    // 65_536 is far above any message this tool sends; a fixed buffer avoids
    // the alignment traps of building MIDIPacketList by hand.
    var packet = MIDIPacketList()
    let p = MIDIPacketListInit(&packet)
    _ = MIDIPacketListAdd(&packet, 65_536, p, 0, bytes.count, bytes)
    MIDISend(outPort, endpoint, &packet)
}

func parseHex(_ tokens: [String]) -> [UInt8] {
    tokens.compactMap { t in
        let s = t.hasPrefix("0x") ? String(t.dropFirst(2)) : t
        return UInt8(s, radix: 16) ?? UInt8(t)
    }
}

// MARK: - receiving

final class Listener {
    var lines: [String] = []
    var inPort = MIDIPortRef()
    func start() {
        MIDIInputPortCreateWithBlock(client, "in" as CFString, &inPort) { [weak self] pktList, _ in
            guard let self else { return }
            var pkt = pktList.pointee.packet
            for _ in 0..<pktList.pointee.numPackets {
                let bytes = withUnsafeBytes(of: pkt.data) { raw in
                    (0..<Int(pkt.length)).map { raw[$0] }
                }
                self.lines.append(bytes.map { String(format: "%02X", $0) }.joined(separator: " "))
                pkt = MIDIPacketNext(&pkt).pointee
            }
        }
        for i in 0..<MIDIGetNumberOfSources() {
            MIDIPortConnectSource(inPort, MIDIGetSource(i), nil)
        }
    }
}

// MARK: - commands

let args = Array(CommandLine.arguments.dropFirst())
let usage = """
usage:
  midictl list
  midictl send <dst> <b1> <b2> <b3>       one short message (hex)
  midictl sysex <dst> <hex...>            raw bytes, F0..F7 supplied by you
  midictl inquiry <dst>                   MIDI Device Inquiry, prints replies
  midictl listen <secs>                   print everything arriving on any source
  midictl stream <dst>                    read a script on stdin:
                                            <hex bytes>   send them
                                            sleep <ms>    wait
                                            # ...         comment
"""

switch args.first {

case "list":
    print("devices:")
    for i in 0..<MIDIGetNumberOfDevices() {
        let d = MIDIGetDevice(i)
        print("  [\(i)] \(str(d, kMIDIPropertyName))  \(isOffline(d) ? "OFFLINE" : "online")")
    }
    print("destinations (send targets):")
    for i in 0..<MIDIGetNumberOfDestinations() { print("  dst[\(i)] \(destName(i))") }
    print("sources (listen targets):")
    for i in 0..<MIDIGetNumberOfSources() {
        let s = MIDIGetSource(i)
        var ent = MIDIEntityRef(); MIDIEndpointGetEntity(s, &ent)
        var dev = MIDIDeviceRef(); MIDIEntityGetDevice(ent, &dev)
        print("  src[\(i)] \(str(dev, kMIDIPropertyName)) \(str(s, kMIDIPropertyName))")
    }

case "send":
    guard args.count >= 5, let dst = Int(args[1]) else { print(usage); exit(2) }
    sendBytes(dst, parseHex(Array(args[2...])))
    usleep(120_000)

case "sysex":
    guard args.count >= 3, let dst = Int(args[1]) else { print(usage); exit(2) }
    sendBytes(dst, parseHex(Array(args[2...])))
    usleep(200_000)

case "inquiry":
    guard args.count >= 2, let dst = Int(args[1]) else { print(usage); exit(2) }
    let l = Listener(); l.start()
    // Universal Non-Realtime, device 7F (all), sub-id 06 01 = Identity Request.
    sendBytes(dst, [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7])
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    if l.lines.isEmpty { print("no reply") } else { l.lines.forEach { print($0) } }

case "listen":
    let secs = Double(args.count > 1 ? args[1] : "5") ?? 5
    let l = Listener(); l.start()
    RunLoop.current.run(until: Date().addingTimeInterval(secs))
    if l.lines.isEmpty { print("nothing received") } else { l.lines.forEach { print($0) } }

case "stream":
    guard args.count >= 2, let dst = Int(args[1]) else { print(usage); exit(2) }
    var sent = 0
    while let line = readLine(strippingNewline: true) {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.isEmpty || t.hasPrefix("#") { continue }
        let parts = t.split(separator: " ").map(String.init)
        if parts[0] == "sleep", parts.count > 1, let ms = UInt32(parts[1]) {
            usleep(ms * 1000); continue
        }
        let bytes = parseHex(parts)
        if bytes.isEmpty { continue }
        sendBytes(dst, bytes)
        sent += 1
        usleep(1_500)   // CoreMIDI will drop a tight burst; 1.5 ms paces it
    }
    print("sent \(sent) messages to dst[\(dst)] \(destName(dst))")

default:
    print(usage); exit(args.first == nil ? 2 : 0)
}
