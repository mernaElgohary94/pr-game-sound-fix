
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bootstrapCameraKit,
  createMediaStreamSource,
  Transform2D,
  type CameraKit,
  type CameraKitSession,
} from '@snap/camera-kit';
import { Analytics } from '@vercel/analytics/react';

const API_TOKEN = import.meta.env.VITE_SNAP_CAMERA_KIT_API_TOKEN as string | undefined;
const LENS_GROUP_ID = import.meta.env.VITE_SNAP_LENS_GROUP_ID as string | undefined;
const LENS_ID = import.meta.env.VITE_SNAP_LENS_ID as string | undefined;

type Capture = {
  url: string;
  blob: Blob;
  type: 'photo' | 'video';
  extension: 'jpg' | 'mp4' | 'webm';
} | null;
type CaptureMode = 'photo' | 'video';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function drawPortrait(source: HTMLCanvasElement, output: HTMLCanvasElement) {
  const context = output.getContext('2d');
  if (!context) throw new Error('Could not prepare a capture canvas.');
  const sourceWidth = source.width || source.clientWidth;
  const sourceHeight = source.height || source.clientHeight;
  const targetAspect = output.width / output.height;
  const sourceAspect = sourceWidth / sourceHeight;
  const cropWidth = sourceAspect > targetAspect ? sourceHeight * targetAspect : sourceWidth;
  const cropHeight = sourceAspect > targetAspect ? sourceHeight : sourceWidth / targetAspect;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  context.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, output.width, output.height);
}

function portraitCanvas(source: HTMLCanvasElement) {
  const output = document.createElement('canvas');
  output.width = 720;
  output.height = 1280;
  drawPortrait(source, output);
  return output;
}

function download(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kitRef = useRef<CameraKit | null>(null);
  const sessionRef = useRef<CameraKitSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordFrameRef = useRef<number | null>(null);

  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [mode, setMode] = useState<CaptureMode>('photo');
  const [recording, setRecording] = useState(false);
  const [capture, setCapture] = useState<Capture>(null);
  const [error, setError] = useState('');
  const [lensLoading, setLensLoading] = useState(true);
  const [needsUnmute, setNeedsUnmute] = useState(false);

  const setCamera = useCallback(async (nextFacing: 'user' | 'environment') => {
    const session = sessionRef.current;
    if (!session) return;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    await session.pause();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: nextFacing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    streamRef.current = stream;
    const source = createMediaStreamSource(stream, { cameraType: nextFacing });
    // Mirror only the front-camera input; Lens UI remains correctly oriented.
    const transform = nextFacing === 'user' ? Transform2D.MirrorX : Transform2D.Identity;
    source.setTransform(transform);
    await session.setSource(source);
     source.setTransform(transform);
    await session.play();
    setFacing(nextFacing);
  }, []);

  useEffect(() => {
    let disposed = false;
    async function start() {
      if (!API_TOKEN || !LENS_GROUP_ID || !LENS_ID) {
        setError('Add your Camera Kit API token, Lens Group ID, and Lens ID to .env, then restart the app.');
        setLensLoading(false);
        return;
      }
      if (!canvasRef.current) return;
      try {
        const cameraKit = await bootstrapCameraKit({ apiToken: API_TOKEN });
        if (disposed) return;
        kitRef.current = cameraKit;
        const session = await cameraKit.createSession({ liveRenderTarget: canvasRef.current });
        sessionRef.current = session;
        session.events.addEventListener('error', ({ detail }) => {
          if (detail.error.name === 'LensVideoPlaybackMutedError') setNeedsUnmute(true);
        });
        const loadedLens = await cameraKit.lensRepository.loadLens(LENS_ID, LENS_GROUP_ID);
        if (disposed) return;
        await session.applyLens(loadedLens);
        await setCamera('user');
        if (!disposed) setLensLoading(false);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to open the camera.');
        if (!disposed) setLensLoading(false);
      }
    }
    void start();
    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void sessionRef.current?.destroy();
      void kitRef.current?.destroy();
    };
  }, [setCamera]);

  const takePhoto = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    portraitCanvas(canvas).toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      setCapture((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return { url, blob, type: 'photo', extension: 'jpg' };
      });
    }, 'image/jpeg', 0.95);
  };

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const session = sessionRef.current;
    if (!session || typeof MediaRecorder === 'undefined') {
      setError('Video recording is not supported in this browser.');
      return;
    }
    const mimeType = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      setError('This browser does not support recording video.');
      return;
    }
    chunksRef.current = [];
    // The capture target omits Lens UI intended only for the person using the Lens.
    await session.play('capture');
    const recordingCanvas = portraitCanvas(session.output.capture);
    const paintFrame = () => {
      drawPortrait(session.output.capture, recordingCanvas);
      recordFrameRef.current = requestAnimationFrame(paintFrame);
    };
    paintFrame();

    const recorder = new MediaRecorder(recordingCanvas.captureStream(30), { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => event.data.size && chunksRef.current.push(event.data);
    recorder.onstop = () => {
      if (recordFrameRef.current) cancelAnimationFrame(recordFrameRef.current);
      recordFrameRef.current = null;
      void session.pause('capture');
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType });
      const url = URL.createObjectURL(blob);
      setCapture((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return { url, blob, type: 'video', extension: (recorder.mimeType || mimeType).includes('mp4') ? 'mp4' : 'webm' };
      });
      setRecording(false);
    };
    recorder.start(250);
    setRecording(true);
  };

  const releaseShutter = () => mode === 'photo' ? takePhoto() : void toggleRecording();
  const unmuteLens = () => {
    // This must run from a click/tap because browsers block unprompted audio playback.
    sessionRef.current?.unmute();
    setNeedsUnmute(false);
  };
  const saveCapture = async () => {
    if (!capture) return;
    const file = new File([capture.blob], `snap-lens-${stamp()}.${capture.extension}`, { type: capture.blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Snap Lens capture' });
        return;
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
      }
    }
    download(capture.url, file.name);
  };
  return (
    <main className="camera-app">
      <canvas ref={canvasRef} className="camera-preview" />
      <header className="camera-header">
        <div className="header-actions">
          <button className="header-button" onClick={() => void setCamera(facing === 'user' ? 'environment' : 'user')} disabled={recording || !sessionRef.current} aria-label="Switch front and back camera">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7V4l-3 3 3 3V7h7a5 5 0 0 1 5 5M17 17v3l3-3-3-3v3h-7a5 5 0 0 1-5-5" /></svg>
          </button>
        </div>
      </header>

      {recording && <div className="recording-pill"><span /> REC</div>}
      {needsUnmute && <button className="lens-unmute" onClick={unmuteLens}>Tap to enable Lens sound</button>}
      {error && <div className="camera-error"><p>{error}</p><button onClick={() => setError('')}>Dismiss</button></div>}
      {lensLoading && <div className="lens-loading" role="status" aria-label="Loading Lens"><span /></div>}

      <button className={`lens-capture ${mode === 'video' ? 'video-mode' : ''} ${recording ? 'is-recording' : ''}`} onClick={releaseShutter} disabled={!sessionRef.current || lensLoading} aria-label={mode === 'photo' ? 'Take photo' : recording ? 'Stop recording' : 'Start recording'}>
        {recording ? <span className="stop-recording" /> : <span className="shutter-core" />}
      </button>

      <footer className="camera-footer">
        <div className="mode-switch" role="tablist" aria-label="Capture mode">
          <button className={mode === 'photo' ? 'active' : ''} onClick={() => !recording && setMode('photo')} role="tab" aria-selected={mode === 'photo'}>PHOTO</button>
          <button className={mode === 'video' ? 'active' : ''} onClick={() => !recording && setMode('video')} role="tab" aria-selected={mode === 'video'}>VIDEO</button>
        </div>
      </footer>

      {capture && <aside className="capture-sheet" aria-label="Latest capture">
        <button className="sheet-close" onClick={() => setCapture(null)} aria-label="Close capture">×</button>
        {capture.type === 'photo' ? <img src={capture.url} alt="Captured Lens photo" /> : <video src={capture.url} controls autoPlay playsInline preload="auto" />}
        <button className="download-button" onClick={() => void saveCapture()}>Save to Gallery</button>
      </aside>}
      <Analytics />
    </main>
  );
}
