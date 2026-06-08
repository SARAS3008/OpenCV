const canvas = document.getElementById('canvas');
const linksLayer = document.getElementById('linksLayer');
const workflowJson = document.getElementById('workflowJson');
const inspector = document.getElementById('inspector');
const emptyInspector = document.getElementById('emptyInspector');
const statusEl = document.getElementById('status');
const imageInput = document.getElementById('imageInput');
const originalPreview = document.getElementById('originalPreview');
const resultPreview = document.getElementById('resultPreview');

let uploadedFile = null;
let nodeSeq = 1;
let selectedNodeId = null;
let pendingOutputPort = null;
let dragging = null;

const state = {
  nodes: [],
  links: [],
};

const defaultMorphParams = () => ({
  operation: 'open',
  mode: 'binary',
  thresholdMode: 'manual',
  threshold: 128,
  invert: false,
  kernelShape: 'rect',
  kernelSize: 5,
  iterations: 1,
});

const nodeCatalog = {
  image_input: {
    title: '图像输入',
    typeLabel: 'Input',
    body: '上传图像或使用内置工业演示图。',
    inputs: [],
    outputs: [{ id: 'image', label: 'image' }],
  },
  morphology: {
    title: '形态学操作',
    typeLabel: 'OpenCV',
    body: '对灰度图、二值掩膜或彩色图逐通道执行 morphology。',
    inputs: [{ id: 'image', label: 'image' }],
    outputs: [{ id: 'image', label: 'image' }],
  },
  image_output: {
    title: '输出预览',
    typeLabel: 'Preview',
    body: '执行后在右侧预览输出图像。',
    inputs: [{ id: 'image', label: 'image' }],
    outputs: [],
  },
};

function addNode(type, x, y, extra = {}) {
  const id = extra.id || `${type}_${nodeSeq++}`;
  const node = {
    id,
    type,
    x,
    y,
    params: type === 'morphology' ? defaultMorphParams() : {},
    ...extra,
  };
  state.nodes.push(node);
  render();
  return node;
}

function initDefaultWorkflow() {
  const input = addNode('image_input', 70, 140, { id: 'input_1' });
  const morph = addNode('morphology', 370, 140, { id: 'morphology_1' });
  const output = addNode('image_output', 700, 140, { id: 'output_1' });
  state.links.push({ id: 'link_1', fromNode: input.id, fromPort: 'image', toNode: morph.id, toPort: 'image' });
  state.links.push({ id: 'link_2', fromNode: morph.id, fromPort: 'image', toNode: output.id, toPort: 'image' });
  selectedNodeId = morph.id;
  render();
  loadDemoPreview();
}

function render() {
  [...canvas.querySelectorAll('.node')].forEach(el => el.remove());

  for (const node of state.nodes) {
    const el = createNodeElement(node);
    canvas.appendChild(el);
  }

  renderLinks();
  renderInspector();
  updateWorkflowJson();
}

function createNodeElement(node) {
  const meta = nodeCatalog[node.type];
  const el = document.createElement('div');
  el.className = `node ${node.id === selectedNodeId ? 'selected' : ''}`;
  el.dataset.nodeId = node.id;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;

  const inputRows = meta.inputs.map(port => `
    <div class="port-row">
      <span class="port input" data-node-id="${node.id}" data-port-id="${port.id}" data-port-kind="input"></span>
      <span>${port.label}</span>
    </div>`).join('');

  const outputRows = meta.outputs.map(port => `
    <div class="port-row">
      <span>${port.label}</span>
      <span class="port output" data-node-id="${node.id}" data-port-id="${port.id}" data-port-kind="output"></span>
    </div>`).join('');

  el.innerHTML = `
    <div class="node-header">
      <span class="node-title">${meta.title}</span>
      <span class="node-type">${meta.typeLabel}</span>
    </div>
    <div class="node-body">
      ${inputRows}
      <div>${meta.body}</div>
      ${node.type === 'morphology' ? morphologySummary(node.params) : ''}
      ${outputRows}
    </div>
  `;

  el.addEventListener('mousedown', event => {
    if (event.target.classList.contains('port')) return;
    selectNode(node.id);
    const header = event.target.closest('.node-header');
    if (!header) return;
    dragging = {
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originalX: node.x,
      originalY: node.y,
    };
  });

  el.querySelectorAll('.port').forEach(portEl => {
    portEl.addEventListener('click', event => {
      event.stopPropagation();
      handlePortClick(portEl);
    });
  });

  el.addEventListener('click', () => selectNode(node.id));

  return el;
}

function morphologySummary(params) {
  const opMap = {
    erode: '腐蚀', dilate: '膨胀', open: '开运算', close: '闭运算',
    gradient: '梯度', tophat: '顶帽', blackhat: '黑帽',
  };
  return `<div style="margin:10px 0;padding:8px;border-radius:10px;background:rgba(255,255,255,.04);color:#dce4f6;">
    ${opMap[params.operation] || params.operation} · ${params.mode} · ${params.kernelShape} ${params.kernelSize}×${params.kernelSize} · iter ${params.iterations}
  </div>`;
}

function selectNode(nodeId) {
  selectedNodeId = nodeId;
  render();
}

function handlePortClick(portEl) {
  const kind = portEl.dataset.portKind;
  const nodeId = portEl.dataset.nodeId;
  const portId = portEl.dataset.portId;

  if (kind === 'output') {
    document.querySelectorAll('.port.pending').forEach(p => p.classList.remove('pending'));
    pendingOutputPort = { nodeId, portId };
    portEl.classList.add('pending');
    return;
  }

  if (kind === 'input' && pendingOutputPort) {
    if (pendingOutputPort.nodeId === nodeId) {
      setStatus('不能把节点连接到自己。', 'err');
      pendingOutputPort = null;
      document.querySelectorAll('.port.pending').forEach(p => p.classList.remove('pending'));
      return;
    }

    // Single incoming edge per input port for this MVP.
    state.links = state.links.filter(link => !(link.toNode === nodeId && link.toPort === portId));
    state.links.push({
      id: `link_${Date.now()}`,
      fromNode: pendingOutputPort.nodeId,
      fromPort: pendingOutputPort.portId,
      toNode: nodeId,
      toPort: portId,
    });
    pendingOutputPort = null;
    render();
  }
}

function renderLinks() {
  linksLayer.innerHTML = '';
  const canvasRect = canvas.getBoundingClientRect();

  for (const link of state.links) {
    const start = findPortCenter(link.fromNode, link.fromPort, 'output', canvasRect);
    const end = findPortCenter(link.toNode, link.toPort, 'input', canvasRect);
    if (!start || !end) continue;

    const dx = Math.max(80, Math.abs(end.x - start.x) * 0.45);
    const d = `M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'link-path');
    linksLayer.appendChild(path);
  }
}

function findPortCenter(nodeId, portId, kind, canvasRect) {
  const portEl = canvas.querySelector(`.port[data-node-id="${nodeId}"][data-port-id="${portId}"][data-port-kind="${kind}"]`);
  if (!portEl) return null;
  const rect = portEl.getBoundingClientRect();
  return {
    x: rect.left - canvasRect.left + rect.width / 2,
    y: rect.top - canvasRect.top + rect.height / 2,
  };
}

function renderInspector() {
  const node = state.nodes.find(n => n.id === selectedNodeId);
  const isMorph = node && node.type === 'morphology';
  inspector.classList.toggle('hidden', !isMorph);
  emptyInspector.classList.toggle('hidden', isMorph);
  if (!isMorph) return;

  const params = node.params;
  for (const [key, value] of Object.entries(params)) {
    const input = inspector.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  }
  updateRangeLabels();
}

function updateRangeLabels() {
  document.getElementById('thresholdValue').textContent = inspector.elements.threshold.value;
  document.getElementById('kernelValue').textContent = inspector.elements.kernelSize.value;
  document.getElementById('iterationsValue').textContent = inspector.elements.iterations.value;
}

inspector.addEventListener('input', () => {
  const node = state.nodes.find(n => n.id === selectedNodeId);
  if (!node || node.type !== 'morphology') return;

  const form = new FormData(inspector);
  node.params = {
    operation: form.get('operation'),
    mode: form.get('mode'),
    thresholdMode: form.get('thresholdMode'),
    threshold: Number(form.get('threshold')),
    invert: inspector.elements.invert.checked,
    kernelShape: form.get('kernelShape'),
    kernelSize: Number(form.get('kernelSize')),
    iterations: Number(form.get('iterations')),
  };
  updateRangeLabels();
  updateWorkflowJson();

  const nodeEl = canvas.querySelector(`.node[data-node-id="${node.id}"]`);
  if (nodeEl) {
    const summary = nodeEl.querySelector('.node-body > div[style]');
    if (summary) summary.outerHTML = morphologySummary(node.params);
  }
});

window.addEventListener('mousemove', event => {
  if (!dragging) return;
  const node = state.nodes.find(n => n.id === dragging.nodeId);
  if (!node) return;
  const nextX = dragging.originalX + event.clientX - dragging.startX;
  const nextY = dragging.originalY + event.clientY - dragging.startY;
  node.x = Math.max(8, Math.min(canvas.clientWidth - 245, nextX));
  node.y = Math.max(8, Math.min(canvas.clientHeight - 120, nextY));

  const el = canvas.querySelector(`.node[data-node-id="${node.id}"]`);
  if (el) {
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
  }
  renderLinks();
  updateWorkflowJson(false);
});

window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = null;
    updateWorkflowJson();
  }
});

canvas.addEventListener('dragover', event => event.preventDefault());
canvas.addEventListener('drop', event => {
  event.preventDefault();
  const type = event.dataTransfer.getData('node/type');
  if (!type) return;
  const rect = canvas.getBoundingClientRect();
  const node = addNode(type, event.clientX - rect.left - 110, event.clientY - rect.top - 30);
  selectedNodeId = node.id;
  render();
});

document.querySelectorAll('.palette-node').forEach(paletteNode => {
  paletteNode.addEventListener('dragstart', event => {
    event.dataTransfer.setData('node/type', paletteNode.dataset.nodeType);
  });
});

function updateWorkflowJson(pretty = true) {
  const workflow = buildWorkflow();
  workflowJson.textContent = JSON.stringify(workflow, null, pretty ? 2 : 0);
}

function buildWorkflow() {
  return {
    nodes: state.nodes.map(n => ({
      id: n.id,
      type: n.type,
      x: Math.round(n.x),
      y: Math.round(n.y),
      params: n.params || {},
    })),
    links: state.links,
  };
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`.trim();
}

imageInput.addEventListener('change', () => {
  uploadedFile = imageInput.files?.[0] || null;
  if (!uploadedFile) return;
  const url = URL.createObjectURL(uploadedFile);
  originalPreview.src = url;
  resultPreview.removeAttribute('src');
  setStatus(`已加载：${uploadedFile.name}`);
});

document.getElementById('loadDemoBtn').addEventListener('click', async () => {
  uploadedFile = null;
  imageInput.value = '';
  await loadDemoPreview();
});

async function loadDemoPreview() {
  originalPreview.src = '/api/demo-image?ts=' + Date.now();
  resultPreview.removeAttribute('src');
  setStatus('已加载内置工业演示图。');
}

document.getElementById('runBtn').addEventListener('click', runWorkflow);

async function runWorkflow() {
  setStatus('正在执行 OpenCV 工作流...');
  const form = new FormData();
  form.append('workflow', JSON.stringify(buildWorkflow()));
  if (uploadedFile) form.append('image', uploadedFile);

  try {
    const resp = await fetch('/api/process', {
      method: 'POST',
      body: form,
    });
    const payload = await resp.json();
    if (!resp.ok) throw new Error(payload.detail || '处理失败');

    originalPreview.src = payload.original;
    resultPreview.src = payload.result;
    setStatus(`执行完成，输出尺寸：${payload.width}×${payload.height}`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), 'err');
  }
}

// Keep SVG paths aligned when the browser window changes size.
window.addEventListener('resize', renderLinks);

initDefaultWorkflow();
