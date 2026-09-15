import type { AudioStats, LiveEvent, TransportFactory } from './types';

export const createTransport: TransportFactory = async ({ onEvent, onFailure }) => {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('Microphone access needs HTTPS or localhost.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  let peer: RTCPeerConnection | undefined;
  let audio: HTMLAudioElement | undefined;
  let channel: RTCDataChannel;
  try {
    peer = new RTCPeerConnection();
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    document.body.appendChild(audio);
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    channel = peer.createDataChannel('oai-events', { ordered: true });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    peer?.close();
    audio?.remove();
    throw error;
  }
  const pc = peer;
  const player = audio;
  let closed = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  pc.ontrack = (event) => {
    if (closed) return;
    player.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void player.play().catch(() => {
      if (!closed) onFailure('Your browser blocked audio playback. Start the call again.');
    });
  };
  channel.onmessage = ({ data }) => {
    if (closed || typeof data !== 'string') return;
    try {
      onEvent(JSON.parse(data) as LiveEvent);
    } catch {
      /* Ignore unrelated data packets. */
    }
  };
  channel.onclose = () => {
    if (!closed) onFailure('The voice connection closed. Start again to reconnect.');
  };
  pc.onconnectionstatechange = () => {
    clearTimeout(disconnectTimer);
    if (closed) return;
    if (pc.connectionState === 'failed')
      onFailure('The audio connection failed. Check your connection.');
    if (pc.connectionState === 'disconnected')
      disconnectTimer = setTimeout(() => onFailure('The audio connection was lost.'), 7000);
  };
  return {
    async offer() {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Could not establish an audio route.'));
          }, 10000);
          const check = () => {
            if (pc.iceGatheringState === 'complete') {
              cleanup();
              resolve();
            }
          };
          const cleanup = () => {
            clearTimeout(timeout);
            pc.removeEventListener('icegatheringstatechange', check);
          };
          pc.addEventListener('icegatheringstatechange', check);
          check();
        });
      }
      if (!pc.localDescription?.sdp) throw new Error('Could not prepare the audio connection.');
      return pc.localDescription.sdp;
    },
    answer: (sdp) => pc.setRemoteDescription({ type: 'answer', sdp }),
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
      (await pc.getStats()).forEach((report) => {
        if (report.kind !== 'audio' && report.mediaType !== 'audio') return;
        if (report.type === 'media-source')
          result.inputLevel = Math.max(result.inputLevel, report.audioLevel ?? 0);
        if (report.type === 'inbound-rtp') {
          result.outputLevel = Math.max(result.outputLevel, report.audioLevel ?? 0);
          result.receivedPackets += report.packetsReceived ?? 0;
        }
        if (report.type === 'outbound-rtp') result.sentPackets += report.packetsSent ?? 0;
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
      player.srcObject = null;
      player.remove();
    },
  };
};
