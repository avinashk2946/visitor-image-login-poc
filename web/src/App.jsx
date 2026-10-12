import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Checkbox,
  Chip,
  Container,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Toolbar,
  Typography
} from '@mui/material';
import CameraAltIcon from '@mui/icons-material/CameraAlt';
import DeleteIcon from '@mui/icons-material/Delete';
import ReplayIcon from '@mui/icons-material/Replay';
import LoginIcon from '@mui/icons-material/Login';
import PersonAddAltIcon from '@mui/icons-material/PersonAddAlt';
import TableViewIcon from '@mui/icons-material/TableView';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { apiFetch } from './api.js';
import { captureBestFrame, startCamera, stopCamera } from './camera.js';

const routes = [
  { href: '/register', label: 'Register' },
  { href: '/kiosk', label: 'Kiosk' },
  { href: '/admin', label: 'Admin' }
];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dataUrlToBlob(dataUrl) {
  const [meta, payload] = dataUrl.split(',');
  const mime = meta.match(/data:(.*);base64/)?.[1] || 'image/jpeg';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const FACE_MODEL_LANDMARKS = [1, 10, 33, 61, 127, 152, 199, 234, 263, 291, 356, 454];
const FACE_MODEL_PAIRS = [
  [33, 263],
  [61, 291],
  [10, 152],
  [234, 454],
  [1, 152],
  [1, 10],
  [1, 33],
  [1, 263],
  [33, 61],
  [263, 291],
  [127, 356],
  [199, 152]
];

function distance3d(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0), (a?.z || 0) - (b?.z || 0));
}

function extractFaceModel(landmarks) {
  if (!landmarks?.length) return null;
  const nose = landmarks[1];
  const leftCheek = landmarks[234];
  const rightCheek = landmarks[454];
  if (!nose || !leftCheek || !rightCheek) return null;

  const scale = distance3d(leftCheek, rightCheek);
  if (!scale || scale < 0.05) return null;

  const pointMap = new Map(FACE_MODEL_LANDMARKS.map((id) => {
    const point = landmarks[id];
    return [id, [
      Number(((point.x - nose.x) / scale).toFixed(4)),
      Number(((point.y - nose.y) / scale).toFixed(4)),
      Number((((point.z || 0) - (nose.z || 0)) / scale).toFixed(4))
    ]];
  }));

  const features = FACE_MODEL_PAIRS.map(([a, b]) => {
    const distance = distance3d(landmarks[a], landmarks[b]) / scale;
    return Number(distance.toFixed(4));
  });

  return {
    version: 'mediapipe-face-landmarker-v1',
    points: FACE_MODEL_LANDMARKS.map((id) => pointMap.get(id)),
    features
  };
}

function Shell({ children }) {
  return (
    <>
      <AppBar position="sticky" color="default" elevation={1}>
        <Toolbar sx={{ gap: 1 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>Visitor Check-In POC</Typography>
          {routes.map((route) => (
            <Button key={route.href} href={route.href}>{route.label}</Button>
          ))}
        </Toolbar>
      </AppBar>
      {children}
    </>
  );
}

function HomePage() {
  return (
    <Shell>
      <Container maxWidth="md" sx={{ py: 8 }}>
        <Stack spacing={3} alignItems="center" textAlign="center">
          <Typography variant="h3">Visitor Check-In</Typography>
          <Typography variant="h6" color="text.secondary">
            Choose a flow to continue.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ width: '100%', pt: 2 }}>
            <Button
              fullWidth
              size="large"
              variant="contained"
              href="/register"
              startIcon={<PersonAddAltIcon />}
              sx={{ py: 2 }}
            >
              Pre-register
            </Button>
            <Button
              fullWidth
              size="large"
              variant="contained"
              color="success"
              href="/kiosk"
              startIcon={<LoginIcon />}
              sx={{ py: 2 }}
            >
              Kiosk sign-in
            </Button>
            <Button
              fullWidth
              size="large"
              variant="outlined"
              href="/admin"
              startIcon={<TableViewIcon />}
              sx={{ py: 2 }}
            >
              Admin
            </Button>
          </Stack>
        </Stack>
      </Container>
    </Shell>
  );
}

function CameraBox({ videoRef, captured, onCapture, onRetake, large = false, captureLabel = 'Capture', disabled = false, mirrorStill = true }) {
  return (
    <Box className={large ? 'cameraBox cameraBoxLarge' : 'cameraBox'}>
      <video className="cameraMedia" ref={videoRef} muted playsInline />
      {captured && <img className={`cameraMedia cameraStill${mirrorStill ? '' : ' cameraStillUploaded'}`} src={captured} alt="Captured visitor" />}
      <Box className="ovalGuide" />
      <Stack direction="row" spacing={1} className="cameraActions">
        {captured ? (
          <Button startIcon={<ReplayIcon />} variant="contained" onClick={onRetake}>Retake</Button>
        ) : (
          <Button startIcon={<CameraAltIcon />} variant="contained" disabled={disabled} onClick={onCapture}>{captureLabel}</Button>
        )}
      </Stack>
    </Box>
  );
}

function RegisterPage() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const landmarkerRef = useRef(null);
  const fileInputRef = useRef(null);
  const [capturedPhoto, setCapturedPhoto] = useState('');
  const [photoSource, setPhotoSource] = useState('camera');
  const [faceModel, setFaceModel] = useState(null);
  const [message, setMessage] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    hostName: '',
    visitDate: today(),
    consent: false
  });

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const stream = await startCamera(videoRef.current);
        streamRef.current = stream;
        if (!cancelled) setCameraReady(true);
        try {
          const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.15/wasm');
          landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
              delegate: 'CPU'
            },
            runningMode: 'VIDEO',
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: true,
            numFaces: 1
          });
        } catch {
          if (!cancelled) {
            setMessage({ severity: 'warning', text: 'Camera is ready. 3D assist model could not load, so registration will use the face photo.' });
          }
        }
      } catch (error) {
        setMessage({ severity: 'error', text: error.message });
      }
    }
    boot();
    return () => {
      cancelled = true;
      stopCamera(streamRef.current);
      landmarkerRef.current?.close();
    };
  }, []);

  const update = (field) => (event) => {
    const value = field === 'consent' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  async function capture3dModel() {
    setMessage(null);
    setCapturing(true);
    try {
      const landmarker = landmarkerRef.current;
      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        throw new Error('Camera preview is still loading. Try again in a moment.');
      }

      const photo = await captureBestFrame(video, {
        maxWidth: 1100,
        quality: 0.94,
        crop: 'face-guide',
        samples: 5,
        intervalMs: 70
      });
      setCapturedPhoto(photo);
      setPhotoSource('camera');

      let model = null;
      if (landmarker) {
        const detection = landmarker.detectForVideo(video, performance.now());
        model = extractFaceModel(detection.faceLandmarks?.[0]);
      }

      setFaceModel(model);
      setMessage({
        severity: model ? 'success' : 'warning',
        text: model ? 'Face photo and 3D assist captured.' : 'Face photo captured. 3D assist was not available for this frame.'
      });
    } catch (error) {
      setMessage({ severity: 'error', text: error.message });
    } finally {
      setCapturing(false);
    }
  }

  function uploadPhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMessage({ severity: 'error', text: 'Upload an image file.' });
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setCapturedPhoto(String(reader.result || ''));
      setPhotoSource('upload');
      setFaceModel(null);
      setMessage({ severity: 'success', text: 'Face photo uploaded.' });
      event.target.value = '';
    };
    reader.onerror = () => {
      setMessage({ severity: 'error', text: 'Could not read the uploaded photo.' });
      event.target.value = '';
    };
    reader.readAsDataURL(file);
  }

  async function submit(event) {
    event.preventDefault();
    setMessage(null);
    if (!capturedPhoto) {
      setMessage({ severity: 'error', text: 'Capture a face photo before submitting.' });
      return;
    }

    const body = new FormData();
    Object.entries(form).forEach(([key, value]) => body.append(key, value));
    body.append('photo', dataUrlToBlob(capturedPhoto), 'registration-3d.jpg');
    if (faceModel) body.append('faceModel', JSON.stringify(faceModel));

    setSubmitting(true);
    try {
      await apiFetch('/api/visitors', { method: 'POST', body });
      setMessage({ severity: 'success', text: 'Visitor registered for check-in.' });
      setCapturedPhoto('');
      setPhotoSource('camera');
      setFaceModel(null);
      setForm({ name: '', email: '', phone: '', hostName: '', visitDate: today(), consent: false });
    } catch (error) {
      setMessage({ severity: 'error', text: error.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Shell>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="flex-start">
          <Paper component="form" onSubmit={submit} sx={{ p: 3, flex: 1 }}>
            <Stack spacing={2}>
              <Typography variant="h5">Pre-registration</Typography>
              {message && <Alert severity={message.severity}>{message.text}</Alert>}
              <TextField required label="Visitor name" value={form.name} onChange={update('name')} />
              <TextField required label="Email" type="email" value={form.email} onChange={update('email')} />
              <TextField label="Phone" value={form.phone} onChange={update('phone')} />
              <TextField required label="Host name" value={form.hostName} onChange={update('hostName')} />
              <TextField required label="Visit date" type="date" value={form.visitDate} onChange={update('visitDate')} InputLabelProps={{ shrink: true }} />
              <FormControlLabel
                control={<Checkbox checked={form.consent} onChange={update('consent')} />}
                label="I consent to temporary biometric processing for visitor check-in. My face embedding and thumbnail are used only for this visit and deleted after the configured retention period."
              />
              <Button disabled={submitting || !form.consent} type="submit" size="large" variant="contained">Register visitor</Button>
            </Stack>
          </Paper>
          <Stack spacing={1.5} sx={{ width: 'min(100%, 520px)' }}>
            <CameraBox
              videoRef={videoRef}
              captured={capturedPhoto}
              captureLabel={capturing ? 'Capturing...' : 'Capture face photo'}
              disabled={capturing || !cameraReady}
              mirrorStill={photoSource === 'camera'}
              onCapture={capture3dModel}
              onRetake={() => {
                setCapturedPhoto('');
                setPhotoSource('camera');
                setFaceModel(null);
                videoRef.current?.play?.();
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={uploadPhoto}
            />
            <Button
              startIcon={<UploadFileIcon />}
              variant="outlined"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload picture
            </Button>
            {capturedPhoto && (
              <Chip
                color={faceModel ? 'success' : 'warning'}
                label={faceModel ? `${faceModel.points.length}-point 3D assist ready` : photoSource === 'upload' ? 'Uploaded face photo ready' : 'Face photo ready'}
              />
            )}
          </Stack>
        </Stack>
      </Container>
    </Shell>
  );
}

function faceMetrics(landmarks) {
  if (!landmarks) return null;
  const nose = landmarks[1];
  const leftCheek = landmarks[234];
  const rightCheek = landmarks[454];
  const forehead = landmarks[10];
  const chin = landmarks[152];
  if (!nose || !leftCheek || !rightCheek || !forehead || !chin) return null;

  return {
    centerX: nose.x,
    centerY: nose.y,
    faceWidth: Math.abs(rightCheek.x - leftCheek.x),
    faceHeight: Math.abs(chin.y - forehead.y),
    yaw: nose.x - ((leftCheek.x + rightCheek.x) / 2),
    depth: nose.z || 0
  };
}

function KioskPage({ mode = 'challenge' }) {
  const passiveMode = mode === '3d';
  const liveMode = mode === 'live';
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const landmarkerRef = useRef(null);
  const identifyingRef = useRef(false);
  const stableFramesRef = useRef(0);
  const lastMetricsRef = useRef(null);
  const livenessRef = useRef({ openFrames: 0, blinked: false, reopenedFrames: 0 });
  const [state, setState] = useState('loading');
  const [challenge, setChallenge] = useState('');
  const [feedback, setFeedback] = useState('Starting camera...');
  const [result, setResult] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [scanRun, setScanRun] = useState(0);
  const [pose, setPose] = useState({ yaw: 0, pitch: 0 });
  const [modelReady, setModelReady] = useState(false);

  const challengeText = useMemo(() => ({
    blink: 'Blink once',
    live_blink: 'Blink once',
    left: 'Turn your head left',
    right: 'Turn your head right',
    passive_3d: '3D face scan'
  })[challenge] || 'Look at the camera', [challenge]);

  function reset() {
    identifyingRef.current = false;
    stableFramesRef.current = 0;
    lastMetricsRef.current = null;
    livenessRef.current = { openFrames: 0, blinked: false, reopenedFrames: 0 };
    setResult(null);
    setConfirming(false);
    setChallenge(passiveMode ? 'passive_3d' : liveMode ? 'live_blink' : ['blink', 'left', 'right'][Math.floor(Math.random() * 3)]);
    setState('challenge');
    setFeedback(passiveMode ? 'Move into the circle' : liveMode ? 'Center your face, then blink' : 'Follow the prompt');
    setModelReady(false);
    setScanRun((current) => current + 1);
    if (videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
    videoRef.current?.play?.().catch(() => {});
  }

  async function confirmCheckIn() {
    if (!result?.visitor?.id) return;
    setConfirming(true);
    try {
      const response = await apiFetch(`/api/kiosk/check-in/${result.visitor.id}`, { method: 'POST' });
      setResult((prev) => ({
        ...prev,
        visitor: response.visitor,
        checkedIn: response.checkedIn
      }));
      setState('success');
    } catch (error) {
      setState('failed');
      setResult({ error: error.message });
    } finally {
      setConfirming(false);
    }
  }

  function openMatchDetails(match) {
    const returnPath = '/kiosk';
    window.sessionStorage.setItem('kioskMatch', JSON.stringify({
      ...match,
      returnPath,
      matchedAt: new Date().toISOString()
    }));
    const params = new URLSearchParams({
      id: match.visitor.id,
      returnPath,
      score: String(match.score || 0)
    });
    if (match.embeddingScore !== undefined) params.set('embeddingScore', String(match.embeddingScore));
    if (match.geometryScore !== undefined) params.set('geometryScore', String(match.geometryScore));
    window.location.assign(`/visitor-details?${params.toString()}`);
  }

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const stream = await startCamera(videoRef.current);
        streamRef.current = stream;
        const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.15/wasm');
        landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
            delegate: 'CPU'
          },
          runningMode: 'VIDEO',
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          numFaces: 1
        });
        if (!cancelled) reset();
      } catch (error) {
        setState('failed');
        setResult({ error: error.message || 'Camera/liveness unavailable' });
      }
    }
    boot();
    return () => {
      cancelled = true;
      stopCamera(streamRef.current);
      landmarkerRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (state !== 'challenge') return undefined;
    let active = true;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (!active || identifyingRef.current) return;
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || video.readyState < 2) return;

      let detection;
      try {
        detection = landmarker.detectForVideo(video, performance.now());
      } catch (error) {
        setFeedback(error.message || 'Face scan paused. Try again.');
        return;
      }

      const landmarks = detection.faceLandmarks?.[0];
      const blendshapes = detection.faceBlendshapes?.[0]?.categories || [];
      if (!landmarks) {
        setFeedback('Move into the circle');
        setModelReady(false);
        stableFramesRef.current = 0;
        lastMetricsRef.current = null;
        livenessRef.current = { openFrames: 0, blinked: false, reopenedFrames: 0 };
        return;
      }

      const metrics = faceMetrics(landmarks);
      if (metrics) {
        const yawDegrees = Math.max(-28, Math.min(28, metrics.yaw * 170));
        const pitchDegrees = Math.max(-18, Math.min(18, (metrics.centerY - 0.5) * -70));
        setPose({ yaw: yawDegrees, pitch: pitchDegrees });
      }

      const blinkScore = blendshapes
        .filter((shape) => shape.categoryName === 'eyeBlinkLeft' || shape.categoryName === 'eyeBlinkRight')
        .reduce((total, shape) => total + shape.score, 0);
      const noseX = landmarks[1]?.x || 0.5;
      const leftCheek = landmarks[234]?.x || 0.35;
      const rightCheek = landmarks[454]?.x || 0.65;
      const center = (leftCheek + rightCheek) / 2;

      let passed = (challenge === 'blink' && blinkScore > 0.7)
        || (challenge === 'left' && noseX > center + 0.035)
        || (challenge === 'right' && noseX < center - 0.035);

      if (liveMode) {
        const centered = metrics && metrics.centerX > 0.2 && metrics.centerX < 0.8 && metrics.centerY > 0.16 && metrics.centerY < 0.84;
        const largeEnough = metrics && metrics.faceWidth > 0.16 && metrics.faceHeight > 0.2;

        if (!centered || !largeEnough) {
          stableFramesRef.current = 0;
          livenessRef.current = { openFrames: 0, blinked: false, reopenedFrames: 0 };
          setModelReady(false);
          setFeedback(largeEnough ? 'Center your face' : 'Move closer');
          passed = false;
        } else {
          stableFramesRef.current += 1;
          setModelReady(true);

          const live = livenessRef.current;
          if (!live.blinked && blinkScore < 0.25) live.openFrames += 1;
          if (live.openFrames >= 2 && blinkScore > 0.65) live.blinked = true;
          if (live.blinked && blinkScore < 0.35) live.reopenedFrames += 1;
          livenessRef.current = live;

          if (!live.blinked) {
            setFeedback(stableFramesRef.current > 2 ? 'Blink once to continue' : 'Live face detected');
          } else {
            setFeedback(live.reopenedFrames >= 2 ? 'Blink confirmed. Matching...' : 'Blink detected');
          }
          passed = stableFramesRef.current >= 3 && live.reopenedFrames >= 2;
        }
      }

      if (passiveMode) {
        const previous = lastMetricsRef.current;
        const movement = previous && metrics
          ? Math.hypot(metrics.centerX - previous.centerX, metrics.centerY - previous.centerY)
          : 0;
        const centered = metrics && metrics.centerX > 0.2 && metrics.centerX < 0.8 && metrics.centerY > 0.16 && metrics.centerY < 0.84;
        const largeEnough = metrics && metrics.faceWidth > 0.16 && metrics.faceHeight > 0.2;
        const steady = !previous || movement < 0.055;

        if (centered && largeEnough && steady) {
          stableFramesRef.current += 1;
          setModelReady(stableFramesRef.current > 1);
          setFeedback(stableFramesRef.current > 2 ? '3D face detected. Matching...' : '3D face detected. Hold still');
        } else {
          setModelReady(false);
          stableFramesRef.current = 0;
          setFeedback(largeEnough ? 'Center your face' : 'Move closer');
        }

        lastMetricsRef.current = metrics;
        passed = stableFramesRef.current >= 4 && Date.now() - startedAt > 650;
      }

      if (!passed && Date.now() - startedAt > (liveMode ? 10000 : 7000)) {
        setState('failed');
        setResult({ error: passiveMode ? 'Face scan timed out. Please try again.' : 'Live blink check timed out. Please try again.' });
        return;
      }

      if (passed) {
        const liveFaceModel = extractFaceModel(landmarks);
        if (passiveMode && !liveFaceModel) {
          setState('failed');
          setResult({ error: '3D face model could not be captured. Please try again.' });
          return;
        }

        identifyingRef.current = true;
        window.clearInterval(timer);
        setState('identifying');
        setFeedback(liveMode ? 'Capturing live face...' : 'Capturing 3D face model...');
        const frame = await captureBestFrame(video, {
          maxWidth: 1200,
          quality: 0.96,
          crop: 'face-guide',
          samples: 5,
          intervalMs: 65
        });
        setFeedback(liveMode ? 'Matching live face...' : 'Matching 3D face model...');
        const body = new FormData();
        body.append('image', dataUrlToBlob(frame), 'kiosk.jpg');
        if (liveFaceModel) body.append('faceModel', JSON.stringify(liveFaceModel));
        body.append('liveness', JSON.stringify({
          passed: true,
          challenge,
          mode,
          checks: liveMode ? { blinkTransition: true } : { clientChallenge: true }
        }));
        try {
          const response = await apiFetch('/api/kiosk/identify', { method: 'POST', body });
          if (response.matched) {
            setState('matched');
            setFeedback('Match found. Opening visitor details.');
            setResult(response);
            stopCamera(streamRef.current);
            openMatchDetails(response);
          } else {
            setState('failed');
            const scoreText = response.score ? ` Best score ${response.score.toFixed(3)}.` : '';
            setResult({ error: `${response.reason || 'We could not match you to an expected visitor.'}${scoreText}`, score: response.score });
          }
        } catch (error) {
          setState('failed');
          setResult({ error: error.message });
        } finally {
          identifyingRef.current = false;
        }
      }
    }, 150);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [challenge, liveMode, mode, passiveMode, scanRun, state]);

  useEffect(() => {
    if (state !== 'success' && state !== 'failed') return undefined;
    const timer = window.setTimeout(reset, 5000);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <Box className={`kiosk kiosk-${state}`}>
      <video className="kioskVideo" ref={videoRef} muted playsInline />
      <Box className="kioskOverlay">
        {(passiveMode || liveMode) && state !== 'matched' && state !== 'success' && (
          <Chip
            className="kioskStatus"
            color={modelReady ? 'success' : 'default'}
            label={modelReady ? (liveMode ? 'Live face detected' : '3D face detected') : 'Looking for face'}
          />
        )}
        {state !== 'matched' && state !== 'success' && <Box className="ovalGuide kioskOval" />}
        {passiveMode && state !== 'matched' && state !== 'success' && (
          <Box className="faceModel" style={{ '--yaw': `${pose.yaw}deg`, '--pitch': `${pose.pitch}deg` }}>
            <Box className="faceModelHead">
              <span className="faceEye faceEyeLeft" />
              <span className="faceEye faceEyeRight" />
              <span className="faceNose" />
            </Box>
          </Box>
        )}
        {state === 'matched' ? (
          <Box className="visitorConfirm">
            <Typography variant="h3" align="center">Visitor details</Typography>
            <Chip color="success" label="Match found" />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} alignItems="center">
              {result?.visitor?.thumbnail && <img className="confirmThumb" src={result.visitor.thumbnail} alt="" />}
              <Stack spacing={1} className="confirmDetails">
                <Typography variant="h4">{result?.visitor?.name}</Typography>
                <Typography variant="h6">Host: {result?.visitor?.hostName}</Typography>
                <Typography>Email: {result?.visitor?.email}</Typography>
                <Typography>Phone: {result?.visitor?.phone || '-'}</Typography>
                <Typography>Visit date: {result?.visitor?.visitDate}</Typography>
                <Typography>Match score: {result?.score?.toFixed(3)}</Typography>
              </Stack>
            </Stack>
            <Stack direction="row" spacing={2}>
              <Button size="large" variant="contained" color="success" disabled={confirming} onClick={confirmCheckIn}>
                {confirming ? 'Confirming...' : 'Confirm check-in'}
              </Button>
              <Button
                size="large"
                variant="outlined"
                color="inherit"
                disabled={confirming}
                onClick={() => {
                  window.sessionStorage.removeItem('kioskMatch');
                  reset();
                }}
              >
                Not this visitor
              </Button>
            </Stack>
          </Box>
        ) : (
          <>
            <Typography variant="h2" align="center">
              {state === 'success' ? `Welcome, ${result?.visitor?.name}` : challengeText}
            </Typography>
            <Typography variant="h5" align="center">
              {state === 'success'
                ? `Host: ${result?.visitor?.hostName} | score ${result?.score?.toFixed(3)}`
                : state === 'failed'
                  ? result?.error
                  : feedback}
            </Typography>
          </>
        )}
        {state === 'failed' && (
          <Stack direction="row" spacing={2}>
            <Button size="large" variant="contained" onClick={reset}>Try again</Button>
            <Button size="large" variant="outlined" color="inherit">Call reception</Button>
          </Stack>
        )}
      </Box>
    </Box>
  );
}

function KioskMatchPage() {
  const query = new URLSearchParams(window.location.search);
  const [match, setMatch] = useState(() => {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem('kioskMatch') || 'null');
      if (saved?.visitor?.id) return saved;
    } catch {
      // Ignore malformed stored matches and fall back to the URL.
    }
    const visitorId = query.get('id');
    if (!visitorId) return null;
    const score = Number(query.get('score') || 0);
    const embeddingScore = query.has('embeddingScore') ? Number(query.get('embeddingScore')) : undefined;
    const geometryScore = query.has('geometryScore') ? Number(query.get('geometryScore')) : undefined;
    return {
      matched: true,
      score,
      embeddingScore,
      geometryScore,
      returnPath: query.get('returnPath') || '/kiosk',
      visitor: { id: visitorId }
    };
  });
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(Boolean(match?.visitor?.id && !match?.visitor?.name));
  const [message, setMessage] = useState(null);

  const visitor = match?.visitor;
  const returnPath = match?.returnPath || '/kiosk';

  useEffect(() => {
    let active = true;
    async function loadVisitor() {
      if (!visitor?.id || visitor.name) return;
      setLoading(true);
      try {
        const response = await apiFetch(`/api/visitors/${visitor.id}`);
        if (!active) return;
        const nextMatch = { ...match, visitor: response.visitor };
        window.sessionStorage.setItem('kioskMatch', JSON.stringify(nextMatch));
        setMatch(nextMatch);
      } catch (error) {
        if (active) setMessage({ severity: 'error', text: error.message });
      } finally {
        if (active) setLoading(false);
      }
    }
    loadVisitor();
    return () => {
      active = false;
    };
  }, [visitor?.id]);

  async function confirmCheckIn() {
    if (!visitor?.id) return;
    setConfirming(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/kiosk/check-in/${visitor.id}`, { method: 'POST' });
      const nextMatch = { ...match, visitor: response.visitor, checkedIn: true };
      window.sessionStorage.setItem('kioskMatch', JSON.stringify(nextMatch));
      setMatch(nextMatch);
      setMessage({ severity: 'success', text: `Welcome, ${response.visitor.name}` });
      window.setTimeout(() => {
        window.sessionStorage.removeItem('kioskMatch');
        window.location.assign(returnPath);
      }, 5000);
    } catch (error) {
      setMessage({ severity: 'error', text: error.message });
    } finally {
      setConfirming(false);
    }
  }

  function notThisVisitor() {
    window.sessionStorage.removeItem('kioskMatch');
    window.location.assign(returnPath);
  }

  if (!visitor || loading) {
    return (
      <Shell>
        <Container maxWidth="sm" sx={{ py: 8 }}>
          <Paper sx={{ p: 4 }}>
            <Stack spacing={2} alignItems="center" textAlign="center">
              <Typography variant="h5">{loading ? 'Loading visitor details...' : 'No matched visitor'}</Typography>
              {!loading && <Button variant="contained" href="/kiosk">Back to kiosk</Button>}
            </Stack>
          </Paper>
        </Container>
      </Shell>
    );
  }

  return (
    <Shell>
      <Container maxWidth="md" sx={{ py: 5 }}>
        <Paper className="matchDetails" sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={3} alignItems="center">
            <Chip color={match.checkedIn ? 'success' : 'primary'} label={match.checkedIn ? 'Checked in' : 'Match found'} />
            <Typography variant="h3" align="center">{match.checkedIn ? `Welcome, ${visitor.name}` : 'Visitor details'}</Typography>
            {message && <Alert severity={message.severity} sx={{ width: '100%' }}>{message.text}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} alignItems="center" sx={{ width: '100%' }}>
              {visitor.thumbnail && <img className="matchThumb" src={visitor.thumbnail} alt="" />}
              <Stack spacing={1.2} className="matchInfo">
                <Typography variant="h4">{visitor.name}</Typography>
                <Typography variant="h6">Host: {visitor.hostName}</Typography>
                <Typography>Email: {visitor.email}</Typography>
                <Typography>Phone: {visitor.phone || '-'}</Typography>
                <Typography>Visit date: {visitor.visitDate}</Typography>
                <Typography>Status: {visitor.status?.replace('_', ' ')}</Typography>
                <Typography>Match score: {match.score?.toFixed(3)}</Typography>
                {match.embeddingScore !== undefined && <Typography>Face score: {match.embeddingScore.toFixed(3)}</Typography>}
                {match.geometryScore !== undefined && <Typography>3D assist score: {match.geometryScore?.toFixed(3)}</Typography>}
              </Stack>
            </Stack>
            {!match.checkedIn && (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ width: '100%' }}>
                <Button fullWidth size="large" variant="contained" color="success" disabled={confirming} onClick={confirmCheckIn}>
                  {confirming ? 'Confirming...' : 'Confirm check-in'}
                </Button>
                <Button fullWidth size="large" variant="outlined" disabled={confirming} onClick={notThisVisitor}>
                  Not this visitor
                </Button>
              </Stack>
            )}
          </Stack>
        </Paper>
      </Container>
    </Shell>
  );
}

function AdminPage() {
  const [date, setDate] = useState(today());
  const [visitors, setVisitors] = useState([]);
  const [message, setMessage] = useState(null);

  async function load() {
    try {
      const body = await apiFetch(`/api/visitors?date=${date}`);
      setVisitors(body.visitors);
      setMessage(null);
    } catch (error) {
      setMessage({ severity: 'error', text: error.message });
    }
  }

  useEffect(() => {
    load();
  }, [date]);

  async function remove(id) {
    await apiFetch(`/api/visitors/${id}`, { method: 'DELETE' });
    await load();
  }

  return (
    <Shell>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <Typography variant="h5" sx={{ flexGrow: 1 }}>Visitors</Typography>
            <TextField label="Visit date" type="date" value={date} onChange={(event) => setDate(event.target.value)} InputLabelProps={{ shrink: true }} />
            <Button variant="outlined" onClick={load}>Refresh</Button>
          </Stack>
          {message && <Alert severity={message.severity}>{message.text}</Alert>}
          <Paper sx={{ overflowX: 'auto' }}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Photo</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Host</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Checked in</TableCell>
                  <TableCell align="right">Delete</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visitors.map((visitor) => (
                  <TableRow key={visitor._id}>
                    <TableCell>{visitor.thumbnail && <img className="thumb" src={visitor.thumbnail} alt="" />}</TableCell>
                    <TableCell>{visitor.name}</TableCell>
                    <TableCell>{visitor.hostName}</TableCell>
                    <TableCell>{visitor.email}</TableCell>
                    <TableCell><Chip size="small" color={visitor.status === 'checked_in' ? 'success' : 'default'} label={visitor.status.replace('_', ' ')} /></TableCell>
                    <TableCell>{visitor.checkedInAt ? new Date(visitor.checkedInAt).toLocaleString() : '-'}</TableCell>
                    <TableCell align="right">
                      <IconButton aria-label={`Delete ${visitor.name}`} onClick={() => remove(visitor._id)}>
                        <DeleteIcon />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {!visitors.length && (
                  <TableRow>
                    <TableCell colSpan={7} align="center">No visitors for this date.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </Stack>
      </Container>
    </Shell>
  );
}

export default function App() {
  const path = window.location.pathname;
  if (path === '/kiosk') return <KioskPage mode="live" />;
  if (path === '/kiosk-challenge') return <KioskPage mode="live" />;
  if (path === '/kiosk-3d') return <KioskPage mode="live" />;
  if (path === '/kiosk-match') return <KioskMatchPage />;
  if (path === '/visitor-details') return <KioskMatchPage />;
  if (path === '/admin') return <AdminPage />;
  if (path === '/register') return <RegisterPage />;
  return <HomePage />;
}
