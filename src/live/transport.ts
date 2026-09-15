import { mediaDevices, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import type { AudioStats, LiveEvent, TransportFactory } from './types';

// Native WebRTC uses iOS voice processing for acoustic echo cancellation.
// Both RTP directions stay open throughout the call, including assistant speech.
export const createTransport: TransportFactory = async ({ onEvent, onFailure }) => {
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  let peer: RTCPeerConnection | undefined;
  let channel: ReturnType<RTCPeerConnection['createDataChannel']>;
  try {
    peer = new RTCPeerConnection({ iceServers: [] });
    // VideoChat means speaker by default with voice processing; no camera is used.
    InCallManager.start({ media: 'video', auto: true });
    if (process.env.EXPO_OS === 'ios') InCallManager.setKeepScreenOn(false);
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    channel = peer.createDataChannel('oai-events', { ordered: true });
  } catch (error) {
    // Every setup failure after capture must release the microphone too.
    stream.getTracks().forEach((track) => track.stop());
    peer?.close();
    stream.release();
    InCallManager.stop();
    throw error;
  }
  const pc = peer;
  let closed = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const energies = new Map<string, { energy: number; duration: number }>();
  channel.onmessage = (event: unknown) => {
    const { data } = event as unknown as { data: unknown };
    if (closed || typeof data !== 'string') return;
    try {
      onEvent(JSON.parse(data) as LiveEvent);
    } catch {
      /* Ignore unrelated data packets. */
    }
  };
  channel.onclose = () => {
    if (!closed) onFailure('The voice connection closed. Start a new conversation to reconnect.');
  };
  pc.onconnectionstatechange = () => {
    clearTimeout(disconnectTimer);
    if (closed) return;
    if (pc.connectionState === 'failed')
      onFailure('The audio connection failed. Check your connection and try again.');
    if (pc.connectionState === 'disconnected') {
      disconnectTimer = setTimeout(
        () => onFailure('The audio connection was lost. Try starting again.'),
        7000,
      );
    }
  };
  return {
    async offer() {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error('Could not establish an audio route. Check your network and try again.'),
            );
          }, 10000);
          const check = () => {
            if (pc.iceGatheringState === 'complete') {
              cleanup();
              resolve();
            }
          };
          const cleanup = () => {
            clearTimeout(timeout);
            pc.onicegatheringstatechange = null;
          };
          pc.onicegatheringstatechange = check;
          check();
        });
      }
      if (!pc.localDescription?.sdp) throw new Error('Could not prepare the audio connection.');
      return pc.localDescription.sdp;
    },
    answer: (sdp) => pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp })),
    send(event) {
      if (closed || channel.readyState !== 'open') return false;
      try {
        channel.send(JSON.stringify(event));
        return true;
      } catch {
        return false;
      }
    },
    setMuted(muted) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    },
    async stats() {
      const result: AudioStats = {
        inputLevel: 0,
        outputLevel: 0,
        sentPackets: 0,
        receivedPackets: 0,
      };
      if (closed) return result;
      const reports = await pc.getStats();
      reports.forEach((report: Record<string, unknown>) => {
        if (report.kind !== 'audio' && report.mediaType !== 'audio') return;
        let level = typeof report.audioLevel === 'number' ? report.audioLevel : 0;
        if (
          typeof report.totalAudioEnergy === 'number' &&
          typeof report.totalSamplesDuration === 'number'
        ) {
          const previous = energies.get(String(report.id));
          if (
            previous &&
            report.totalSamplesDuration > previous.duration &&
            typeof report.audioLevel !== 'number'
          ) {
            level = Math.sqrt(
              Math.max(
                0,
                (report.totalAudioEnergy - previous.energy) /
                  (report.totalSamplesDuration - previous.duration),
              ),
            );
          }
          energies.set(String(report.id), {
            energy: report.totalAudioEnergy,
            duration: report.totalSamplesDuration,
          });
        }
        if (report.type === 'media-source') result.inputLevel = Math.max(result.inputLevel, level);
        if (report.type === 'inbound-rtp') {
          result.outputLevel = Math.max(result.outputLevel, level);
          result.receivedPackets += Number(report.packetsReceived || 0);
        }
        if (report.type === 'outbound-rtp') result.sentPackets += Number(report.packetsSent || 0);
      });
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(disconnectTimer);
      stream.getTracks().forEach((track) => track.stop());
      channel.close();
      pc.close();
      stream.release();
      InCallManager.stop();
    },
  };
};
