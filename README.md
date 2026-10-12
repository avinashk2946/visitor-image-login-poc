# Face Recognition Visitor Check-In POC

Dockerized proof of concept for visitor pre-registration and kiosk check-in.

## How It Works for Non-Technical Users

This project is a simple visitor check-in system that uses a visitor's face instead of asking them to type their name at the front desk.

1. Before the visit, the visitor opens the registration page.
2. The visitor enters their name, email, phone, host name, and visit date.
3. The visitor either takes a face photo with the webcam or uploads a picture.
4. The system stores the visitor details and a temporary face record for matching. It does not keep the original full-size photo.
5. When the visitor arrives, they use the kiosk page.
6. The kiosk asks the visitor to look at the camera and blink once, so a simple printed photo or still phone image is less likely to pass.
7. If the face matches one of today's expected visitors, the visitor details page opens.
8. The visitor or receptionist confirms the check-in.
9. The admin page shows who is registered, who has checked in, and allows deleting a visitor and their biometric data.

This is a proof of concept, not a production security system. It demonstrates the end-to-end flow, but it should not be treated as Face ID-level identity verification.

## How It Works for Technical Users

The system runs as four Docker services:

- `web` serves the React/MUI UI for registration, kiosk scan, visitor details, and admin.
- `api` owns the business flow, MongoDB reads/writes, retention cleanup, and all calls to the face service.
- `face-service` is a stateless FastAPI service that detects faces and creates InsightFace embeddings.
- `mongo` stores visitors, embeddings, thumbnails, and kiosk attempt logs.

Registration flow:

```text
browser /register -> api POST /api/visitors -> face-service POST /embed -> MongoDB visitor record
```

The API rejects registrations without biometric consent. It sends the submitted image to the face service, stores the returned 512-dimensional embedding, stores visitor metadata, and keeps only a small thumbnail for admin display.

Kiosk flow:

```text
browser /kiosk -> MediaPipe blink check -> api POST /api/kiosk/identify -> face-service recognition -> visitor details -> api POST /api/kiosk/check-in/:id
```

The browser uses MediaPipe Face Landmarker for the client-side live blink check. After liveness passes, the browser submits one cropped frame to the API. The API sends that frame to the face service, compares the generated embedding only against today's `registered` visitors, logs the attempt, and returns the best match if the score meets `MATCH_THRESHOLD`. The matched visitor is not marked checked in until the details page confirmation calls `POST /api/kiosk/check-in/:id`.

## Services

- `web`: React + Vite + MUI, served by nginx.
- `api`: Node.js + Express + Mongoose. Owns MongoDB data and calls the face service.
- `face-service`: Python 3.11 + FastAPI + InsightFace `buffalo_l` with ONNX Runtime CPU.
- `mongo`: MongoDB 7 with a named volume.

## Run

```bash
docker compose up --build
```

Open:

- Registration: http://localhost:5173/register
- Kiosk face scan: http://localhost:5173/kiosk
- Admin: http://localhost:5173/admin
- API health: http://localhost:4000/health
- Face service health: http://localhost:8000/health

The face model is downloaded during the `face-service` image build so container start is fast. The first build can take a while.

## Face Model

The face service uses InsightFace's `buffalo_l` model pack through `FaceAnalysis`. It produces normalized 512-dimensional face embeddings and runs inference with ONNX Runtime's `CPUExecutionProvider`; a GPU is not required. Model assets are downloaded and cached under `/models` while building the face-service image.

## 3D Model Context and Challenges

This POC does not build a true depth-based 3D face model like Apple Face ID. It uses two different face signals:

- `InsightFace embedding`: the main identity signal. This is a 512-dimensional numeric representation created from a normal 2D image.
- `MediaPipe Face Landmarker`: a browser-side helper that estimates face landmarks and approximate face pose from the webcam image. During webcam registration, the app can store a small normalized landmark shape as a "3D assist" signal.

The landmark signal is useful for rough pose/shape checks and for guiding the kiosk UI, but it is not the same as measuring real face depth. A normal webcam provides a flat RGB image, so the system has to estimate face geometry from pixels. That means it cannot reliably prove that the face is a real 3D human head.

Practical challenges:

- A normal webcam has no trusted depth, infrared, or structured-light signal.
- A high-quality phone video can still imitate blink or head movement better than a printed photo.
- Browser-side liveness can be tampered with by a motivated user because the code runs on the client.
- Glasses, lighting, camera angle, blur, motion, and masks can reduce match quality.
- Uploaded registration pictures do not provide live 3D/landmark context, so they rely mainly on the 2D face embedding.
- Real 3D anti-spoofing needs extra hardware, server-side liveness, or a dedicated presentation-attack detection model.

For production-grade 3D/liveness, use one or more of:

- Depth or IR camera hardware.
- Device-backed biometric authentication where available.
- Server-side liveness and anti-spoofing models trained for printed photos, screens, masks, replay attacks, and deepfake/video attacks.
- Challenge-response checks combined with replay detection and audit controls.

## Deployment Requirements

- A host or VM with Docker Engine and the Docker Compose v2 plugin. The supplied Compose file runs all four services on one host.

Minimum starting point for a single-host, low-traffic POC (not a load-tested capacity guarantee):

| Resource | Minimum | Notes |
| --- | --- | --- |
| CPU | 2 vCPU | Increase for concurrent kiosk requests. |
| Memory | 4 GiB RAM | Current idle stack uses about 1 GiB. |
| Disk, runtime | 10 GB free | Four project images total about 4.8 GB; MongoDB data and backups need additional space. |
| Disk, initial build | 15 GB free | Allows for image layers and build cache. |
| Accelerator | CPU only | No GPU required. |

- Outbound internet access during the first image build to install dependencies and download the InsightFace model assets. Keep enough disk space for the built images, model assets, and MongoDB data.
- Persistent storage for the `mongo-data` Docker volume. Back up this volume as required, and include thumbnails, indexes, and database overhead in disk planning. The retention job removes expired embeddings and thumbnails from application records; it does not replace database backup and storage policies.
- For remote kiosk or registration browsers, serve the web app over HTTPS. Browser camera access (`getUserMedia`) requires a secure context; plain HTTP is generally allowed only on localhost.
- In the default setup, the web container's Nginx serves the UI and proxies `/api/` and `/health` to the API. The UI uses same-origin API paths by default. If hosting the UI on a different origin, set `VITE_API_BASE` at web image build time to a browser-reachable API URL and configure the API/network for that origin.
- Compose publishes host ports `5173` (web), `4000` (API), `8000` (face service), and `27017` (MongoDB) for local development. For deployment, expose the web app through HTTPS and keep the API, face service, and MongoDB ports private; the API and face service should communicate over the internal Docker network.
- Set deployment-specific secrets and environment values rather than relying on local defaults. In particular, use a secure MongoDB deployment/credentials and review matching thresholds, face-quality settings, retention, access controls, TLS termination, backups, and biometric privacy/compliance requirements before handling real visitors.

The Docker Compose file currently overrides some application defaults: `MATCH_THRESHOLD` is `0.35`, `MIN_FACE_SIZE` is `60`, `MIN_DET_SCORE` is `0.6`, `MAX_BLUR` is `75`, and `FACE_DET_SIZE` is `480`. Kiosk recognition also has more tolerant defaults in code so moving visitors are not rejected too easily. Tune these values with representative test data before deployment; do not treat the POC defaults as validated production settings.

## Configuration

API environment variables:

- `MONGO_URI`: MongoDB connection string.
- `FACE_SERVICE_URL`: URL for the Python face service.
- `MATCH_THRESHOLD`: cosine similarity threshold, default `0.35` for this POC. Raise it for stricter production-style matching.
- `RETENTION_DAYS`: days to retain embeddings and thumbnails after the visit date, default `1`.

Face service environment variables:

- `MIN_FACE_SIZE`: minimum detected face box dimension, default `60`.
- `MIN_DET_SCORE`: minimum detector score, default `0.6`.
- `MAX_BLUR`: minimum Laplacian variance blur score, default `75`.
- `KIOSK_MIN_FACE_SIZE`: kiosk-only minimum face size, default `48`.
- `KIOSK_MIN_DET_SCORE`: kiosk-only minimum detector score, default `0.35`.
- `KIOSK_MAX_BLUR`: kiosk-only blur threshold, default `15`.
- `FACE_DET_SIZE`: face detector input size, default `480`.

## Data Flow

1. `/register` captures a webcam frame or accepts an uploaded picture, then submits visitor details, consent, and photo to `POST /api/visitors`.
2. The API rejects missing consent, sends the image to `face-service /embed`, stores the 512-dimensional embedding, and saves only a small JPEG thumbnail for admin display.
3. `/kiosk` opens the single kiosk face-scan flow. It uses MediaPipe Face Landmarker in the browser to find a centered face, requires a live blink transition, captures a cropped frame, and calls `POST /api/kiosk/identify`.
4. The API sends the frame to `face-service /recognize`, compares only against today's `registered` visitors, and logs every attempt.
5. A successful match opens the visitor details page. Reception or the visitor confirms with `Confirm check-in`, which calls `POST /api/kiosk/check-in/:id` and marks the visitor `checked_in`.
6. `Not this visitor` returns to `/kiosk` and starts a new scan.
7. A scheduled cleanup job removes embeddings and thumbnails for visits older than `RETENTION_DAYS`.

## Scaling Notes

The current POC compares each kiosk scan against the registered visitors scheduled for today. This keeps the search scope small and readable, but it is still a simple linear comparison across today's active visitors. That is acceptable for proving the flow with tens or hundreds of visitors, but it will become slow for large visitor volumes.

For high-volume pre-registration data, replace the linear matching path with a vector search layer:

- Keep filtering candidates by `visitDate` and `status=registered`.
- Store 512-dimensional embeddings in a vector index instead of scanning every active visitor.
- Use approximate nearest neighbor search with a database or service such as MongoDB Atlas Vector Search, Qdrant, Milvus, Weaviate, pgvector, or FAISS.
- Return the top few candidates, then run exact cosine comparison and optional 3D/landmark reranking.
- Add normal database indexes for `visitDate` and `status`.
- Cache today's active visitor embeddings if the deployment uses a small number of kiosks/API instances and a simple POC architecture is still desired.

Current POC flow:

```text
kiosk image -> embedding -> compare against every registered visitor today
```

Recommended scalable flow:

```text
kiosk image -> embedding -> vector search top candidates -> exact verify -> visitor details
```

## Important POC Limitations

The kiosk liveness check is intentionally simple and runs in the browser with MediaPipe Face Landmarker. The default kiosk route requires a live blink transition before matching, which blocks basic printed photos and still images shown on a phone. It is **not Face ID-grade security** and is **not secure for production** because a user can tamper with browser code, replay video, use a video on another screen, or bypass scan results. A production visitor system should use server-side or device-backed liveness, depth/IR camera signals, anti-spoofing models, replay detection, audit controls, privacy review, and explicit biometric compliance handling.

This POC stores embeddings temporarily for matching and deletes biometric data according to the retention job. The raw registration photo is not stored; only a small admin thumbnail is retained until cleanup.
