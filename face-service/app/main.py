import base64
import json
import os
from typing import Any, Dict, List

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from starlette.datastructures import UploadFile
from insightface.app import FaceAnalysis
from pydantic import BaseModel, Field

MIN_FACE_SIZE = int(os.getenv("MIN_FACE_SIZE", "60"))
MIN_DET_SCORE = float(os.getenv("MIN_DET_SCORE", "0.6"))
MAX_BLUR = float(os.getenv("MAX_BLUR", "35"))
KIOSK_MIN_FACE_SIZE = int(os.getenv("KIOSK_MIN_FACE_SIZE", "48"))
KIOSK_MIN_DET_SCORE = float(os.getenv("KIOSK_MIN_DET_SCORE", "0.35"))
KIOSK_MAX_BLUR = float(os.getenv("KIOSK_MAX_BLUR", "12"))
FACE_DET_SIZE = int(os.getenv("FACE_DET_SIZE", "480"))

app = FastAPI(title="Face Service POC")
face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
face_app.prepare(ctx_id=-1, det_size=(FACE_DET_SIZE, FACE_DET_SIZE))


class CompareRequest(BaseModel):
    embedding1: List[float] = Field(..., min_length=512, max_length=512)
    embedding2: List[float] = Field(..., min_length=512, max_length=512)


class Base64ImageRequest(BaseModel):
    image: str


def decode_image_bytes(image_bytes: bytes) -> np.ndarray:
    data = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Could not decode image")
    return img


def decode_base64_image(image: str) -> np.ndarray:
    if "," in image:
        image = image.split(",", 1)[1]
    try:
        return decode_image_bytes(base64.b64decode(image))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid base64 image") from exc


def blur_score(img: np.ndarray, bbox) -> float:
    height, width = img.shape[:2]
    x1, y1, x2, y2 = [int(v) for v in bbox]
    pad_x = int((x2 - x1) * 0.18)
    pad_y = int((y2 - y1) * 0.18)
    x1 = max(0, x1 - pad_x)
    y1 = max(0, y1 - pad_y)
    x2 = min(width, x2 + pad_x)
    y2 = min(height, y2 + pad_y)
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        crop = img
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def required_blur_score(base_threshold: float, face_size: float) -> float:
    size_factor = max(0.5, min(1.0, face_size / 160.0))
    return base_threshold * size_factor


def primary_face(faces, img: np.ndarray):
    height, width = img.shape[:2]
    image_center = np.asarray([width / 2, height / 2], dtype=np.float32)
    max_center_distance = float(np.linalg.norm(image_center)) or 1.0

    def face_score(face):
        x1, y1, x2, y2 = face.bbox
        face_area = max(0.0, float(x2 - x1)) * max(0.0, float(y2 - y1))
        face_center = np.asarray([(x1 + x2) / 2, (y1 + y2) / 2], dtype=np.float32)
        center_weight = 1.0 - min(1.0, float(np.linalg.norm(face_center - image_center)) / max_center_distance)
        return (face_area * 0.75) + (float(face.det_score) * 10000.0) + (center_weight * 5000.0)

    return max(faces, key=face_score)


def embedding_for_image(img: np.ndarray, strict: bool = True):
    faces = face_app.get(img)
    face_count = len(faces)

    if face_count == 0:
        raise HTTPException(status_code=400, detail="No face detected")

    face = primary_face(faces, img)
    x1, y1, x2, y2 = face.bbox
    face_size = float(min(x2 - x1, y2 - y1))
    det_score = float(face.det_score)
    blur = blur_score(img, face.bbox)

    min_det_score = MIN_DET_SCORE if strict else KIOSK_MIN_DET_SCORE
    min_face_size = MIN_FACE_SIZE if strict else KIOSK_MIN_FACE_SIZE
    min_blur = required_blur_score(MAX_BLUR if strict else KIOSK_MAX_BLUR, face_size)

    if det_score < min_det_score:
        raise HTTPException(status_code=400, detail=f"Face detector confidence is too low ({det_score:.2f})")
    if face_size < min_face_size:
        raise HTTPException(status_code=400, detail=f"Face is too small ({face_size:.0f}px)")
    if blur < min_blur:
        raise HTTPException(status_code=400, detail=f"Image is too blurry ({blur:.0f}; need {min_blur:.0f})")

    embedding = np.asarray(face.embedding, dtype=np.float32)
    norm = np.linalg.norm(embedding)
    if norm == 0:
        raise HTTPException(status_code=400, detail="Could not produce a valid embedding")

    return {
        "embedding": (embedding / norm).astype(float).tolist(),
        "face_count": face_count,
        "quality": {
            "det_score": det_score,
            "face_size": face_size,
            "blur": blur,
        },
    }


def cosine_similarity(a: List[float], b: List[float]) -> float:
    v1 = np.asarray(a, dtype=np.float32)
    v2 = np.asarray(b, dtype=np.float32)
    denom = float(np.linalg.norm(v1) * np.linalg.norm(v2))
    if denom == 0:
        return 0.0
    return float(np.dot(v1, v2) / denom)


def recognize_subjects(img: np.ndarray, subjects: List[Dict[str, Any]]):
    embedded = embedding_for_image(img, strict=False)
    source = embedded["embedding"]
    matches = []

    for subject in subjects:
        subject_id = str(subject.get("subject", ""))
        examples = subject.get("embeddings") or []
        if not subject_id or not examples:
            continue

        best = max((cosine_similarity(source, example) for example in examples), default=0.0)
        matches.append({"subject": subject_id, "similarity": best})

    matches.sort(key=lambda item: item["similarity"], reverse=True)
    return {
        "embedding": source,
        "face_count": embedded["face_count"],
        "quality": embedded["quality"],
        "result": matches,
    }


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/embed")
async def embed(request: Request):
    content_type = request.headers.get("content-type", "")

    if content_type.startswith("multipart/form-data") or content_type.startswith("application/x-www-form-urlencoded"):
        form = await request.form()
        image = form.get("image")
        image_base64 = form.get("image_base64")
        if isinstance(image, UploadFile):
            img = decode_image_bytes(await image.read())
        elif image_base64:
            img = decode_base64_image(str(image_base64))
        elif isinstance(image, str):
            img = decode_base64_image(image)
        else:
            raise HTTPException(status_code=400, detail="Multipart body must include image or image_base64")
    elif content_type.startswith("application/json"):
        payload = await request.json()
        raw_image = payload.get("image") or payload.get("image_base64")
        if not raw_image:
            raise HTTPException(status_code=400, detail="JSON body must include image or image_base64")
        img = decode_base64_image(raw_image)
    else:
        raise HTTPException(status_code=400, detail="Send an image file, image_base64 form field, or JSON image")

    return embedding_for_image(img)


@app.post("/embed/base64")
def embed_base64(payload: Base64ImageRequest):
    return embedding_for_image(decode_base64_image(payload.image))


@app.post("/compare")
def compare(payload: CompareRequest):
    return {"similarity": cosine_similarity(payload.embedding1, payload.embedding2)}


@app.post("/recognize")
async def recognize(request: Request):
    content_type = request.headers.get("content-type", "")

    if content_type.startswith("multipart/form-data") or content_type.startswith("application/x-www-form-urlencoded"):
        form = await request.form()
        image = form.get("image")
        subjects_raw = form.get("subjects")

        if isinstance(image, UploadFile):
            img = decode_image_bytes(await image.read())
        elif isinstance(image, str):
            img = decode_base64_image(image)
        else:
            raise HTTPException(status_code=400, detail="Multipart body must include image")

        try:
            subjects = json.loads(str(subjects_raw or "[]"))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="subjects must be valid JSON") from exc
    elif content_type.startswith("application/json"):
        payload = await request.json()
        raw_image = payload.get("image") or payload.get("image_base64")
        if not raw_image:
            raise HTTPException(status_code=400, detail="JSON body must include image or image_base64")
        img = decode_base64_image(raw_image)
        subjects = payload.get("subjects") or []
    else:
        raise HTTPException(status_code=400, detail="Send an image and subjects as multipart or JSON")

    if not isinstance(subjects, list):
        raise HTTPException(status_code=400, detail="subjects must be a list")

    return recognize_subjects(img, subjects)
