from __future__ import annotations

import base64
import json
from collections import defaultdict, deque
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = __import__('pathlib').Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / 'public'

app = FastAPI(title='OpenCV Node Image Processor', version='0.1.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


def clamp_int(value: Any, min_value: int, max_value: int, default: int) -> int:
    try:
        value = int(value)
    except (TypeError, ValueError):
        return default
    return max(min_value, min(max_value, value))


def odd_kernel_size(value: Any) -> int:
    k = clamp_int(value, 1, 99, 5)
    if k % 2 == 0:
        k += 1
    return min(k, 99)


def encode_image_data_url(image: np.ndarray, ext: str = '.png') -> str:
    ok, buf = cv2.imencode(ext, image)
    if not ok:
        raise HTTPException(status_code=500, detail='Failed to encode image')
    mime = 'image/png' if ext.lower() == '.png' else 'image/jpeg'
    return f'data:{mime};base64,' + base64.b64encode(buf).decode('utf-8')


def decode_upload_to_bgr(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail='Cannot decode uploaded image')
    return image


def make_demo_industrial_image(width: int = 960, height: int = 540) -> np.ndarray:
    """Generate a deterministic industrial-like demo image.

    The synthetic frame contains bright machined parts, scratches, small chips,
    and salt/pepper noise so morphology effects are visible without uploading data.
    """
    rng = np.random.default_rng(20260608)
    img = np.full((height, width), 34, dtype=np.uint8)

    # Low-frequency illumination gradient.
    x_grad = np.linspace(0, 46, width, dtype=np.float32)
    y_grad = np.linspace(0, 22, height, dtype=np.float32)[:, None]
    img = np.clip(img.astype(np.float32) + x_grad + y_grad, 0, 255).astype(np.uint8)

    # Conveyor/metal surface bands.
    for y in range(60, height, 90):
        cv2.line(img, (0, y), (width, y + 15), 50, 2)

    # Main circular parts.
    parts = [(230, 260, 92), (485, 250, 112), (735, 270, 82)]
    for cx, cy, r in parts:
        cv2.circle(img, (cx, cy), r, 178, -1)
        cv2.circle(img, (cx, cy), r, 226, 3)
        cv2.circle(img, (cx, cy), max(14, r // 4), 58, -1)
        cv2.circle(img, (cx, cy), max(14, r // 4), 205, 2)
        for angle in range(0, 360, 45):
            rad = np.deg2rad(angle)
            px = int(cx + np.cos(rad) * r * 0.62)
            py = int(cy + np.sin(rad) * r * 0.62)
            cv2.circle(img, (px, py), max(5, r // 13), 70, -1)
            cv2.circle(img, (px, py), max(5, r // 13), 215, 1)

    # Random small bright defects / burrs.
    for _ in range(42):
        x = int(rng.integers(90, width - 90))
        y = int(rng.integers(90, height - 90))
        rr = int(rng.integers(1, 5))
        cv2.circle(img, (x, y), rr, int(rng.integers(205, 255)), -1)

    # Dark scratches.
    for _ in range(26):
        x = int(rng.integers(50, width - 160))
        y = int(rng.integers(70, height - 80))
        length = int(rng.integers(35, 130))
        dy = int(rng.integers(-8, 8))
        cv2.line(img, (x, y), (x + length, y + dy), int(rng.integers(0, 30)), 1)

    # Salt and pepper noise.
    noise_count = width * height // 110
    ys = rng.integers(0, height, noise_count)
    xs = rng.integers(0, width, noise_count)
    img[ys, xs] = rng.choice([0, 255], size=noise_count, p=[0.45, 0.55]).astype(np.uint8)

    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


MORPH_OPS = {
    'erode': cv2.MORPH_ERODE,
    'dilate': cv2.MORPH_DILATE,
    'open': cv2.MORPH_OPEN,
    'close': cv2.MORPH_CLOSE,
    'gradient': cv2.MORPH_GRADIENT,
    'tophat': cv2.MORPH_TOPHAT,
    'blackhat': cv2.MORPH_BLACKHAT,
}

KERNEL_SHAPES = {
    'rect': cv2.MORPH_RECT,
    'ellipse': cv2.MORPH_ELLIPSE,
    'cross': cv2.MORPH_CROSS,
}


def apply_morphology(image_bgr: np.ndarray, params: Dict[str, Any]) -> np.ndarray:
    op_name = str(params.get('operation', 'open')).lower()
    if op_name not in MORPH_OPS:
        raise HTTPException(status_code=400, detail=f'Unsupported morphology operation: {op_name}')

    shape_name = str(params.get('kernelShape', 'rect')).lower()
    if shape_name not in KERNEL_SHAPES:
        raise HTTPException(status_code=400, detail=f'Unsupported kernel shape: {shape_name}')

    k = odd_kernel_size(params.get('kernelSize', 5))
    iterations = clamp_int(params.get('iterations', 1), 1, 20, 1)
    kernel = cv2.getStructuringElement(KERNEL_SHAPES[shape_name], (k, k))

    mode = str(params.get('mode', 'binary')).lower()
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)

    # Industrial morphology is often easier to reason about on binary masks.
    if mode == 'binary':
        threshold_mode = str(params.get('thresholdMode', 'manual')).lower()
        invert = bool(params.get('invert', False))
        thresh_type = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
        if threshold_mode == 'otsu':
            _, src = cv2.threshold(gray, 0, 255, thresh_type | cv2.THRESH_OTSU)
        else:
            threshold = clamp_int(params.get('threshold', 128), 0, 255, 128)
            _, src = cv2.threshold(gray, threshold, 255, thresh_type)
    elif mode == 'grayscale':
        src = gray
    elif mode == 'color':
        # Applies the operation channel-by-channel.
        src = image_bgr
    else:
        raise HTTPException(status_code=400, detail=f'Unsupported mode: {mode}')

    if op_name == 'erode':
        dst = cv2.erode(src, kernel, iterations=iterations)
    elif op_name == 'dilate':
        dst = cv2.dilate(src, kernel, iterations=iterations)
    else:
        dst = cv2.morphologyEx(src, MORPH_OPS[op_name], kernel, iterations=iterations)

    return dst


def topological_node_order(nodes: List[Dict[str, Any]], links: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    nodes_by_id = {n['id']: n for n in nodes if 'id' in n}
    indeg = {node_id: 0 for node_id in nodes_by_id}
    graph = defaultdict(list)

    for link in links:
        src = link.get('fromNode')
        dst = link.get('toNode')
        if src in nodes_by_id and dst in nodes_by_id:
            graph[src].append(dst)
            indeg[dst] += 1

    q = deque([node_id for node_id, degree in indeg.items() if degree == 0])
    order_ids = []
    while q:
        node_id = q.popleft()
        order_ids.append(node_id)
        for child in graph[node_id]:
            indeg[child] -= 1
            if indeg[child] == 0:
                q.append(child)

    if len(order_ids) != len(nodes_by_id):
        # Fall back to visual left-to-right order if the graph has a cycle.
        return sorted(nodes, key=lambda n: (n.get('x', 0), n.get('y', 0)))
    return [nodes_by_id[node_id] for node_id in order_ids]


def execute_workflow(image_bgr: np.ndarray, workflow: Dict[str, Any]) -> np.ndarray:
    nodes = workflow.get('nodes', [])
    links = workflow.get('links', [])
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise HTTPException(status_code=400, detail='Invalid workflow format')

    order = topological_node_order(nodes, links)
    current = image_bgr.copy()
    executed_any = False

    # MVP rule: apply all morphology nodes in topological/visual order.
    # Later, replace this with per-port tensor/image routing.
    for node in order:
        if node.get('type') == 'morphology':
            current = apply_morphology(current, node.get('params', {}))
            if current.ndim == 2:
                current = cv2.cvtColor(current, cv2.COLOR_GRAY2BGR)
            executed_any = True

    if not executed_any:
        # Help the demo still do something useful when the user deletes connections.
        morph_nodes = [n for n in sorted(nodes, key=lambda n: (n.get('x', 0), n.get('y', 0))) if n.get('type') == 'morphology']
        for node in morph_nodes:
            current = apply_morphology(current, node.get('params', {}))
            if current.ndim == 2:
                current = cv2.cvtColor(current, cv2.COLOR_GRAY2BGR)

    return current


@app.get('/api/demo-image')
def demo_image() -> Response:
    img = make_demo_industrial_image()
    ok, buf = cv2.imencode('.png', img)
    if not ok:
        raise HTTPException(status_code=500, detail='Failed to encode demo image')
    return Response(content=buf.tobytes(), media_type='image/png')


@app.post('/api/process')
async def process_image(
    workflow: str = Form(...),
    image: Optional[UploadFile] = File(None),
) -> JSONResponse:
    try:
        workflow_obj = json.loads(workflow)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f'Invalid workflow JSON: {exc}') from exc

    if image is not None:
        image_bytes = await image.read()
        input_bgr = decode_upload_to_bgr(image_bytes)
    else:
        input_bgr = make_demo_industrial_image()

    output_bgr = execute_workflow(input_bgr, workflow_obj)

    return JSONResponse(
        {
            'original': encode_image_data_url(input_bgr),
            'result': encode_image_data_url(output_bgr),
            'width': int(output_bgr.shape[1]),
            'height': int(output_bgr.shape[0]),
        }
    )


@app.get('/')
def index() -> FileResponse:
    return FileResponse(PUBLIC_DIR / 'index.html')


app.mount('/', StaticFiles(directory=PUBLIC_DIR), name='public')
