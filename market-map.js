import * as THREE from "./vendor/three.module.min.js";

const PEER_COUNT = 12;
const SHELL_RADIUS = 3.9;
const PEER_RADIUS = 0.34;
const FOCUS_RADIUS = 0.7;
const LINK_SEGMENTS = 24;
const TAP_DISTANCE = 6;
const AUTO_ROTATION_SPEED = 0.075;
const DRAG_ROTATION_SPEED = 0.006;

const COLORS = {
  background: 0x071018,
  focusUp: 0x41d78b,
  focusDown: 0xff7658,
  focusNeutral: 0x9ba8b8,
  peerUp: 0x49da8b,
  peerDown: 0xff704f,
  peerMuted: 0x778392,
  positive: 0x91a0ff,
  inverse: 0xf05bc9,
  cyan: 0x45e7e0,
  missingLink: 0x667382,
};

const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSAHEDRON_VERTICES = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanSymbol(value) {
  return String(value || "").trim().toUpperCase().slice(0, 12);
}

function normalizeFocus(focus) {
  if (!focus || typeof focus !== "object") {
    return {
      symbol: "",
      price: null,
      change24h: null,
      up: null,
      alignment: null,
    };
  }

  const change24h = Number(focus.change24h);
  return {
    symbol: cleanSymbol(focus.symbol),
    price: Number.isFinite(Number(focus.price)) ? Number(focus.price) : null,
    change24h: Number.isFinite(change24h) ? change24h : null,
    up:
      typeof focus.up === "boolean"
        ? focus.up
        : Number.isFinite(change24h)
          ? change24h >= 0
          : null,
    alignment: focus.alignment ?? null,
  };
}

function normalizePeer(peer) {
  const corr = Number(peer?.corr);
  const bias24h = Number(peer?.bias24h);
  const corrDelta = Number(peer?.corrDelta);
  const volRatio = Number(peer?.volRatio);
  const divScore = Number(peer?.divScore);

  return {
    symbol: cleanSymbol(peer?.symbol),
    corr: Number.isFinite(corr) ? clamp(corr, -1, 1) : null,
    corrDelta: Number.isFinite(corrDelta) ? corrDelta : 0,
    bias24h: Number.isFinite(bias24h) ? bias24h : null,
    volRatio: Number.isFinite(volRatio) && volRatio > 0 ? volRatio : 1,
    divScore: Number.isFinite(divScore) ? divScore : null,
  };
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "PRICE N/A";

  const absolute = Math.abs(value);
  if (absolute >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  if (absolute >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${value.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
}

function formatChange(value) {
  if (!Number.isFinite(value)) return "24H N/A";
  const percent = value * 100;
  return `24H ${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatAlignment(value) {
  if (typeof value === "string" && value.trim()) {
    return `ALIGN ${value.trim().toUpperCase().slice(0, 16)}`;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) return "ALIGN N/A";
  const percent = Math.abs(number) <= 1 ? number * 100 : number;
  return `ALIGN ${Math.round(percent)}%`;
}

function formatPeerMetric(peer, mode) {
  if (mode === "diversify") {
    const diversity = peer.corr === null ? null : 1 - Math.abs(peer.corr);
    return diversity === null ? "DIV N/A" : `DIV ${Math.round(diversity * 100)}%`;
  }

  if (peer.corr === null) return "CORR N/A";
  return `CORR ${peer.corr >= 0 ? "+" : ""}${peer.corr.toFixed(2)}`;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function colorToCss(color) {
  return `#${color.getHexString()}`;
}

function safeCall(callback, value) {
  if (typeof callback !== "function") return;
  try {
    callback(value);
  } catch (error) {
    console.error("Market map callback failed", error);
  }
}

/**
 * Creates the progressively enhanced 3D relationship map.
 * The returned API remains usable as a semantic-only fallback without WebGL2.
 */
export function createMarketMap(container, callbacks = {}) {
  if (!container || typeof container.appendChild !== "function") {
    throw new TypeError("createMarketMap requires a DOM container");
  }

  const state = {
    destroyed: false,
    visible: true,
    contextLost: false,
    reducedMotion: false,
    mode: "map",
    focus: normalizeFocus(null),
    peers: [],
    hoveredIndex: -1,
    activePointerId: null,
    pointerStartX: 0,
    pointerStartY: 0,
    pointerX: 0,
    pointerY: 0,
    pointerTravel: 0,
    lastTapAt: 0,
    dragging: false,
    rafId: null,
    lastFrameTime: 0,
    dpr: 1,
    width: 1,
    height: 1,
    coarsePointer: Boolean(globalThis.matchMedia?.("(pointer: coarse)").matches),
    phases: Array.from({ length: PEER_COUNT }, (_, index) => (index * 0.173) % 1),
  };

  const srList = document.createElement("ul");
  srList.className = "market-map-controls";
  srList.setAttribute("aria-label", "Related markets");
  Object.assign(srList.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "0",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    border: "0",
    listStyle: "none",
  });
  container.appendChild(srList);

  let canvas = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  let network = null;
  let peerMesh = null;
  let focusMesh = null;
  let linkLines = null;
  let synapses = null;
  let focusLabel = null;
  let peerGeometry = null;
  let focusGeometry = null;
  let linkGeometry = null;
  let synapseGeometry = null;
  let peerMaterial = null;
  let focusMaterial = null;
  let linkMaterial = null;
  let synapseMaterial = null;
  let resizeObserver = null;

  const peerLabels = [];
  const labelResources = [];
  const curves = [];
  const instanceMatrix = new THREE.Matrix4();
  const instanceScale = new THREE.Vector3();
  const identityQuaternion = new THREE.Quaternion();
  const peerColor = new THREE.Color();
  const accentColor = new THREE.Color();
  const linkColor = new THREE.Color();
  const tempPoint = new THREE.Vector3();
  const labelWorldPosition = new THREE.Vector3();
  const dragEuler = new THREE.Euler(0, 0, 0, "XYZ");
  const dragQuaternion = new THREE.Quaternion();

  function notifyFallback(reason) {
    safeCall(callbacks.onFallback, reason);
  }

  function drawLabel(resource, primary, secondary, accent, focus = false) {
    const { canvas: labelCanvas, context, texture } = resource;
    const width = labelCanvas.width;
    const height = labelCanvas.height;
    context.clearRect(0, 0, width, height);

    roundedRect(context, 4, 4, width - 8, height - 8, 18);
    context.fillStyle = "rgba(6, 13, 22, 0.88)";
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = colorToCss(accent);
    context.globalAlpha = 0.72;
    context.stroke();
    context.globalAlpha = 1;

    const left = focus ? 28 : 22;
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillStyle = "#f3f7fb";
    context.font = focus
      ? "700 42px ui-monospace, SFMono-Regular, Menlo, monospace"
      : "700 36px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(primary, left, focus ? 47 : 38, width - left * 2);

    context.fillStyle = "#aebbc9";
    context.font = focus
      ? "500 25px ui-monospace, SFMono-Regular, Menlo, monospace"
      : "500 24px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(secondary, left, focus ? 108 : 82, width - left * 2);
    texture.needsUpdate = true;
  }

  function makeLabel(width, height, scaleX, scaleY) {
    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = width;
    labelCanvas.height = height;
    const context = labelCanvas.getContext("2d");
    const texture = new THREE.CanvasTexture(labelCanvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if ("colorSpace" in texture && THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    } else if ("encoding" in texture && THREE.sRGBEncoding) {
      texture.encoding = THREE.sRGBEncoding;
    }

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(scaleX, scaleY, 1);
    sprite.renderOrder = 4;
    const resource = { canvas: labelCanvas, context, texture, material, sprite };
    labelResources.push(resource);
    return resource;
  }

  function createCurves() {
    // Every peer stays on one shell; correlation never changes node distance.
    for (let index = 0; index < PEER_COUNT; index += 1) {
      const direction = ICOSAHEDRON_VERTICES[index];
      const start = direction.clone().multiplyScalar(FOCUS_RADIUS * 0.9);
      const end = direction.clone().multiplyScalar(SHELL_RADIUS - PEER_RADIUS * 1.25);
      const midpoint = start.clone().add(end).multiplyScalar(0.5);
      const referenceAxis = Math.abs(direction.y) > 0.82
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      const bend = new THREE.Vector3()
        .crossVectors(direction, referenceAxis)
        .normalize()
        .multiplyScalar(index % 2 === 0 ? 0.38 : -0.38);
      const control = midpoint.add(bend);
      curves.push(new THREE.QuadraticBezierCurve3(start, control, end));
    }
  }

  function createLinkGeometry() {
    const vertexCount = PEER_COUNT * LINK_SEGMENTS * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const alphas = new Float32Array(vertexCount);
    const dashCoords = new Float32Array(vertexCount);
    const inverseFlags = new Float32Array(vertexCount);
    let vertexOffset = 0;

    for (let peerIndex = 0; peerIndex < PEER_COUNT; peerIndex += 1) {
      const curve = curves[peerIndex];
      for (let segment = 0; segment < LINK_SEGMENTS; segment += 1) {
        const from = curve.getPoint(segment / LINK_SEGMENTS);
        const to = curve.getPoint((segment + 1) / LINK_SEGMENTS);
        positions.set([from.x, from.y, from.z, to.x, to.y, to.z], vertexOffset * 3);
        dashCoords[vertexOffset] = segment * 0.52;
        dashCoords[vertexOffset + 1] = (segment + 1) * 0.52;
        vertexOffset += 2;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("lineAlpha", new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute("dashCoord", new THREE.BufferAttribute(dashCoords, 1));
    geometry.setAttribute("inverseFlag", new THREE.BufferAttribute(inverseFlags, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }

  function createSynapseGeometry() {
    const positions = new Float32Array(PEER_COUNT * 2 * 3);
    const colors = new Float32Array(PEER_COUNT * 2 * 3);
    const sizes = new Float32Array(PEER_COUNT * 2);
    const alphas = new Float32Array(PEER_COUNT * 2);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("pointSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("pointAlpha", new THREE.BufferAttribute(alphas, 1));
    geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geometry.setDrawRange(0, 0);
    return geometry;
  }

  function initScene() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

    network = new THREE.Group();
    network.rotation.set(-0.17, 0.34, -0.035);
    scene.add(network);

    const ambient = new THREE.HemisphereLight(0xcbd8ff, 0x18202a, 1.45);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.65);
    keyLight.position.set(4, 6, 8);
    scene.add(ambient, keyLight);

    peerGeometry = new THREE.SphereGeometry(PEER_RADIUS, 16, 12);
    focusGeometry = new THREE.SphereGeometry(FOCUS_RADIUS, 24, 16);
    peerMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.14,
    });
    focusMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.focusNeutral,
      roughness: 0.42,
      metalness: 0.18,
      emissive: COLORS.focusNeutral,
      emissiveIntensity: 0.12,
    });

    peerMesh = new THREE.InstancedMesh(peerGeometry, peerMaterial, PEER_COUNT);
    peerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    peerMesh.count = 0;
    peerMesh.renderOrder = 2;
    network.add(peerMesh);

    focusMesh = new THREE.Mesh(focusGeometry, focusMaterial);
    focusMesh.visible = false;
    focusMesh.renderOrder = 2;
    network.add(focusMesh);

    createCurves();
    linkGeometry = createLinkGeometry();
    linkMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      vertexShader: `
        attribute float lineAlpha;
        attribute float dashCoord;
        attribute float inverseFlag;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDashCoord;
        varying float vInverse;

        void main() {
          vColor = color;
          vAlpha = lineAlpha;
          vDashCoord = dashCoord;
          vInverse = inverseFlag;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDashCoord;
        varying float vInverse;

        void main() {
          if (vInverse > 0.5 && mod(vDashCoord, 1.0) > 0.58) discard;
          gl_FragColor = vec4(vColor, vAlpha);
        }
      `,
    });
    linkLines = new THREE.LineSegments(linkGeometry, linkMaterial);
    linkLines.visible = false;
    linkLines.renderOrder = 0;
    network.add(linkLines);

    synapseGeometry = createSynapseGeometry();
    synapseMaterial = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: state.dpr } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      vertexShader: `
        attribute float pointSize;
        attribute float pointAlpha;
        uniform float pixelRatio;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vColor = color;
          vAlpha = pointAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = pointSize * pixelRatio;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          float distanceFromCenter = length(gl_PointCoord - vec2(0.5));
          float edge = 1.0 - smoothstep(0.22, 0.5, distanceFromCenter);
          if (edge <= 0.0) discard;
          gl_FragColor = vec4(vColor, vAlpha * edge);
        }
      `,
    });
    synapses = new THREE.Points(synapseGeometry, synapseMaterial);
    synapses.visible = false;
    synapses.frustumCulled = false;
    synapses.renderOrder = 1;
    network.add(synapses);

    for (let index = 0; index < PEER_COUNT; index += 1) {
      const label = makeLabel(384, 112, state.coarsePointer ? 2.35 : 1.75, state.coarsePointer ? 0.68 : 0.51);
      label.sprite.position.copy(ICOSAHEDRON_VERTICES[index]).multiplyScalar(SHELL_RADIUS + 0.72);
      label.sprite.visible = false;
      network.add(label.sprite);
      peerLabels.push(label);
    }

    focusLabel = makeLabel(512, 148, state.coarsePointer ? 3.2 : 2.5, state.coarsePointer ? 0.92 : 0.72);
    focusLabel.sprite.position.set(0, -1.08, 0.5);
    focusLabel.sprite.visible = false;
    scene.add(focusLabel.sprite);
  }

  function currentLinkColor(peer, target = linkColor) {
    if (peer.corr === null) {
      return target.setHex(COLORS.missingLink);
    }

    const magnitude = Math.abs(peer.corr);
    target.setHex(peer.corr < 0 ? COLORS.inverse : COLORS.positive);
    target.multiplyScalar(0.45 + magnitude * 0.55);
    if (state.mode === "diversify") {
      accentColor.setHex(COLORS.cyan);
      target.lerp(accentColor, (1 - magnitude) * 0.72);
    }
    return target;
  }

  function updatePeerInstances() {
    if (!peerMesh) return;

    peerMesh.count = state.peers.length;
    for (let index = 0; index < state.peers.length; index += 1) {
      const peer = state.peers[index];
      const magnitude = peer.corr === null ? 0 : Math.abs(peer.corr);
      const scale = clamp(Math.sqrt(peer.volRatio), 0.8, 1.25)
        * (state.hoveredIndex === index ? 1.12 : 1);

      instanceScale.setScalar(scale);
      instanceMatrix.compose(
        tempPoint.copy(ICOSAHEDRON_VERTICES[index]).multiplyScalar(SHELL_RADIUS),
        identityQuaternion,
        instanceScale,
      );
      peerMesh.setMatrixAt(index, instanceMatrix);

      if (peer.bias24h === null || peer.bias24h === 0) {
        peerColor.setHex(COLORS.peerMuted);
      } else {
        peerColor.setHex(peer.bias24h > 0 ? COLORS.peerUp : COLORS.peerDown);
      }
      if (state.mode === "diversify") {
        accentColor.setHex(COLORS.cyan);
        peerColor.lerp(accentColor, (1 - magnitude) * 0.68);
      }
      if (state.hoveredIndex === index) peerColor.offsetHSL(0, 0, 0.13);
      peerMesh.setColorAt(index, peerColor);
    }

    peerMesh.instanceMatrix.needsUpdate = true;
    if (peerMesh.instanceColor) peerMesh.instanceColor.needsUpdate = true;
    peerMesh.computeBoundingSphere?.();
  }

  function updateLinkStyles() {
    if (!linkGeometry) return;
    linkLines.visible = state.peers.length > 0;
    const colorAttribute = linkGeometry.getAttribute("color");
    const alphaAttribute = linkGeometry.getAttribute("lineAlpha");
    const inverseAttribute = linkGeometry.getAttribute("inverseFlag");
    const verticesPerPeer = LINK_SEGMENTS * 2;

    for (let peerIndex = 0; peerIndex < PEER_COUNT; peerIndex += 1) {
      const peer = state.peers[peerIndex];
      const magnitude = peer?.corr === null || !peer ? 0 : Math.abs(peer.corr);
      const alpha = peer ? (peer.corr === null ? 0.1 : 0.16 + magnitude * 0.66) : 0;
      const inverse = peer?.corr !== null && peer?.corr < 0 ? 1 : 0;
      const color = peer
        ? currentLinkColor(peer)
        : linkColor.setHex(COLORS.missingLink);

      for (let localVertex = 0; localVertex < verticesPerPeer; localVertex += 1) {
        const vertexIndex = peerIndex * verticesPerPeer + localVertex;
        colorAttribute.setXYZ(vertexIndex, color.r, color.g, color.b);
        alphaAttribute.setX(vertexIndex, alpha);
        inverseAttribute.setX(vertexIndex, inverse);
      }
    }

    colorAttribute.needsUpdate = true;
    alphaAttribute.needsUpdate = true;
    inverseAttribute.needsUpdate = true;
  }

  function updateSynapses(deltaSeconds = 0) {
    if (!synapseGeometry) return;
    synapses.visible = state.peers.length > 0;
    const positionAttribute = synapseGeometry.getAttribute("position");
    const colorAttribute = synapseGeometry.getAttribute("color");
    const sizeAttribute = synapseGeometry.getAttribute("pointSize");
    const alphaAttribute = synapseGeometry.getAttribute("pointAlpha");

    for (let index = 0; index < state.peers.length; index += 1) {
      const peer = state.peers[index];
      const magnitude = peer.corr === null ? 0 : Math.abs(peer.corr);
      const deltaStrength = clamp(Math.abs(peer.corrDelta), 0, 0.25) / 0.25;
      const speed = 0.055 + deltaStrength * 0.42;
      if (deltaSeconds > 0) {
        state.phases[index] = (state.phases[index] + deltaSeconds * speed) % 1;
      }

      // Mirrored phases show change intensity without suggesting causal flow.
      const phase = state.phases[index];
      const color = currentLinkColor(peer);
      const alpha = peer.corr === null ? 0.18 : 0.42 + magnitude * 0.48;
      const size = 4.2 + magnitude * 2.6;
      const firstIndex = index * 2;
      curves[index].getPoint(phase, tempPoint);
      positionAttribute.setXYZ(firstIndex, tempPoint.x, tempPoint.y, tempPoint.z);
      curves[index].getPoint(1 - phase, tempPoint);
      positionAttribute.setXYZ(firstIndex + 1, tempPoint.x, tempPoint.y, tempPoint.z);

      colorAttribute.setXYZ(firstIndex, color.r, color.g, color.b);
      colorAttribute.setXYZ(firstIndex + 1, color.r, color.g, color.b);
      sizeAttribute.setX(firstIndex, size);
      sizeAttribute.setX(firstIndex + 1, size);
      alphaAttribute.setX(firstIndex, alpha);
      alphaAttribute.setX(firstIndex + 1, alpha);
    }

    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    sizeAttribute.needsUpdate = true;
    alphaAttribute.needsUpdate = true;
    synapseGeometry.setDrawRange(0, state.peers.length * 2);
  }

  function updateLabels() {
    if (!focusLabel) return;

    const hasFocus = Boolean(state.focus.symbol);
    focusLabel.sprite.visible = hasFocus;
    focusMesh.visible = hasFocus;
    if (hasFocus) {
      if (state.focus.up === true) {
        peerColor.setHex(COLORS.focusUp);
      } else if (state.focus.up === false) {
        peerColor.setHex(COLORS.focusDown);
      } else {
        peerColor.setHex(COLORS.focusNeutral);
      }
      focusMaterial.color.copy(peerColor);
      focusMaterial.emissive.copy(peerColor);
      drawLabel(
        focusLabel,
        `${state.focus.symbol}  ${formatPrice(state.focus.price)}`,
        `${formatChange(state.focus.change24h)} | ${formatAlignment(state.focus.alignment)}`,
        peerColor,
        true,
      );
    }

    for (let index = 0; index < PEER_COUNT; index += 1) {
      const label = peerLabels[index];
      const peer = state.peers[index];
      label.sprite.visible = Boolean(peer);
      if (!peer) continue;
      const color = currentLinkColor(peer, new THREE.Color());
      drawLabel(label, peer.symbol || "UNKNOWN", formatPeerMetric(peer, state.mode), color);
    }
    updateLabelVisibility();
  }

  function updateLabelVisibility() {
    if (!network) return;
    network.updateMatrixWorld(true);
    const compact = state.width < 600;
    const depths = [];
    for (let index = 0; index < peerLabels.length; index += 1) {
      if (!state.peers[index]) continue;
      peerLabels[index].sprite.getWorldPosition(labelWorldPosition);
      depths.push({ index, z: labelWorldPosition.z });
    }
    const compactVisible = new Set(depths.sort((a, b) => b.z - a.z).slice(0, 5).map(item => item.index));
    for (let index = 0; index < peerLabels.length; index += 1) {
      const label = peerLabels[index];
      const hasPeer = Boolean(state.peers[index]);
      if (!hasPeer) {
        label.sprite.visible = false;
        continue;
      }
      label.sprite.getWorldPosition(labelWorldPosition);
      label.sprite.visible = (compact ? compactVisible.has(index) : labelWorldPosition.z > 0.05) || state.hoveredIndex === index;
    }
  }

  function updateSemanticList() {
    srList.replaceChildren();
    for (const peer of state.peers) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${peer.symbol || "Unknown market"}, ${formatPeerMetric(peer, state.mode)}`;
      button.addEventListener("click", () => {
        safeCall(callbacks.onSelect, peer.symbol);
      });
      item.appendChild(button);
      srList.appendChild(item);
    }
    updateSemanticPositions();
  }

  function updateSemanticPositions() {
    if (!network || !camera || !state.width || !state.height) return;
    network.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const buttons = srList.querySelectorAll("button");
    for (let index = 0; index < Math.min(buttons.length, state.peers.length); index += 1) {
      tempPoint
        .copy(ICOSAHEDRON_VERTICES[index])
        .multiplyScalar(SHELL_RADIUS)
        .applyMatrix4(network.matrixWorld)
        .project(camera);
      buttons[index].dataset.mapX = String(Math.round((tempPoint.x + 1) * 0.5 * state.width));
      buttons[index].dataset.mapY = String(Math.round((1 - tempPoint.y) * 0.5 * state.height));
    }
  }

  function renderNow(force = false) {
    if (
      !renderer
      || !scene
      || !camera
      || state.destroyed
      || state.contextLost
      || (!state.visible && !force)
    ) {
      return false;
    }

    renderer.render(scene, camera);
    return true;
  }

  function stopLoop() {
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.lastFrameTime = 0;
  }

  function frame(time) {
    state.rafId = null;
    if (state.destroyed || state.contextLost || !state.visible || !renderer) return;

    const deltaSeconds = state.lastFrameTime
      ? Math.min((time - state.lastFrameTime) / 1000, 0.05)
      : 0;
    state.lastFrameTime = time;

    if (!state.reducedMotion) {
      if (!state.dragging) network.rotateY(deltaSeconds * AUTO_ROTATION_SPEED);
      updateSynapses(deltaSeconds);
    }
    updateLabelVisibility();
    updateSemanticPositions();
    renderNow();

    if (!state.reducedMotion) {
      state.rafId = requestAnimationFrame(frame);
    }
  }

  function requestRender() {
    if (
      state.rafId === null
      && state.visible
      && !state.destroyed
      && !state.contextLost
      && renderer
    ) {
      state.rafId = requestAnimationFrame(frame);
    }
  }

  function resize() {
    if (!renderer || !camera || state.destroyed) return;
    const bounds = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || container.clientWidth || 1));
    const height = Math.max(1, Math.round(bounds.height || container.clientHeight || 1));
    state.width = width;
    state.height = height;
    state.dpr = Math.min(globalThis.devicePixelRatio || 1, state.coarsePointer ? 1.5 : 2);
    const compact = width < 600;
    for (const label of peerLabels) label.sprite.scale.set(compact ? 3.6 : 1.75, compact ? 1.04 : 0.51, 1);
    if (focusLabel) focusLabel.sprite.scale.set(compact ? 4.1 : 2.5, compact ? 1.18 : 0.72, 1);

    renderer.setPixelRatio(state.dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    const limitingHalfFov = Math.max(0.12, Math.min(verticalHalfFov, horizontalHalfFov));
    const framingRadius = compact ? 6.3 : 5.15;
    camera.position.set(0, 0, framingRadius / Math.sin(limitingHalfFov) + 0.35);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    if (synapseMaterial) synapseMaterial.uniforms.pixelRatio.value = state.dpr;
    updateSemanticPositions();
    requestRender();
  }

  function raycastPeer(clientX, clientY) {
    if (!peerMesh || state.peers.length === 0 || !camera || !scene) return -1;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return -1;
    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;
    const hitRadius = state.width < 600 ? 26 : 24;
    let nearest = -1;
    let nearestDistance = Infinity;
    network.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    for (let index = 0; index < state.peers.length; index += 1) {
      tempPoint.copy(ICOSAHEDRON_VERTICES[index]).multiplyScalar(SHELL_RADIUS).applyMatrix4(network.matrixWorld).project(camera);
      const x = (tempPoint.x + 1) * 0.5 * bounds.width;
      const y = (1 - tempPoint.y) * 0.5 * bounds.height;
      const distance = Math.hypot(localX - x, localY - y);
      if (distance <= hitRadius && distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function setHoveredIndex(index, inspect = true) {
    if (index === state.hoveredIndex) return;
    state.hoveredIndex = index;
    updatePeerInstances();
    updateLabelVisibility();
    canvas.style.cursor = state.dragging ? "grabbing" : index >= 0 ? "pointer" : "grab";
    if (inspect && index >= 0) safeCall(callbacks.onInspect, state.peers[index].symbol);
    requestRender();
  }

  function onPointerDown(event) {
    if (state.destroyed || state.contextLost || !state.visible || state.activePointerId !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    state.activePointerId = event.pointerId;
    state.pointerStartX = event.clientX;
    state.pointerStartY = event.clientY;
    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    state.pointerTravel = 0;
    state.dragging = true;
    canvas.style.cursor = "grabbing";
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Capture can fail when the pointer is already ending.
    }

    if (event.pointerType === "touch" || event.pointerType === "pen") {
      setHoveredIndex(raycastPeer(event.clientX, event.clientY));
    }
  }

  function onPointerMove(event) {
    if (state.destroyed || state.contextLost || !state.visible) return;

    if (event.pointerId === state.activePointerId) {
      event.preventDefault();
      const deltaX = event.clientX - state.pointerX;
      const deltaY = event.clientY - state.pointerY;
      state.pointerX = event.clientX;
      state.pointerY = event.clientY;
      state.pointerTravel = Math.max(
        state.pointerTravel,
        Math.hypot(event.clientX - state.pointerStartX, event.clientY - state.pointerStartY),
      );

      if (deltaX || deltaY) {
        dragEuler.set(deltaY * DRAG_ROTATION_SPEED, deltaX * DRAG_ROTATION_SPEED, 0);
        dragQuaternion.setFromEuler(dragEuler);
        network.quaternion.premultiply(dragQuaternion).normalize();
        requestRender();
      }
      return;
    }

    if (event.pointerType === "mouse" || event.pointerType === "pen") {
      const hitIndex = raycastPeer(event.clientX, event.clientY);
      setHoveredIndex(hitIndex);
    }
  }

  function finishPointer(event, cancelled = false) {
    if (event.pointerId !== state.activePointerId) return;
    event.preventDefault();
    state.pointerTravel = Math.max(
      state.pointerTravel,
      Math.hypot(event.clientX - state.pointerStartX, event.clientY - state.pointerStartY),
    );
    const wasTap = !cancelled && state.pointerTravel < TAP_DISTANCE;
    const tapIndex = wasTap ? raycastPeer(event.clientX, event.clientY) : -1;
    try {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may release capture before pointercancel is delivered.
    }
    state.activePointerId = null;
    state.dragging = false;
    canvas.style.cursor = state.hoveredIndex >= 0 ? "pointer" : "grab";

    if (tapIndex >= 0) {
      setHoveredIndex(tapIndex);
      state.lastTapAt = Date.now();
      safeCall(callbacks.onSelect, state.peers[tapIndex].symbol);
    }
    requestRender();
  }

  function onCanvasClick(event) {
    if (Date.now() - state.lastTapAt < 250) return;
    const index = raycastPeer(event.clientX, event.clientY);
    if (index < 0) return;
    setHoveredIndex(index);
    state.lastTapAt = Date.now();
    safeCall(callbacks.onSelect, state.peers[index].symbol);
  }

  function onPointerUp(event) {
    finishPointer(event, false);
  }

  function onPointerCancel(event) {
    finishPointer(event, true);
  }

  function onPointerLeave(event) {
    if (event.pointerId !== state.activePointerId) setHoveredIndex(-1, false);
  }

  function onContextLost(event) {
    event.preventDefault();
    if (state.destroyed) return;
    state.contextLost = true;
    stopLoop();
    notifyFallback("webgl-context-lost");
  }

  function onContextRestored() {
    if (state.destroyed || !renderer) return;
    try {
      renderer.resetState?.();
      state.contextLost = false;
      resize();
      renderNow(true);
      safeCall(callbacks.onReady);
      requestRender();
    } catch (error) {
      state.contextLost = true;
      stopLoop();
      notifyFallback(`webgl-context-restore-failed: ${error?.message || "unknown error"}`);
    }
  }

  function update(model = {}) {
    if (state.destroyed) return;
    state.focus = normalizeFocus(model.focus);
    state.peers = Array.isArray(model.peers)
      ? model.peers.slice(0, PEER_COUNT).map(normalizePeer)
      : [];
    state.mode = model.mode === "diversify" ? "diversify" : "map";
    const nextReducedMotion = Boolean(model.reducedMotion);
    if (nextReducedMotion !== state.reducedMotion) {
      state.reducedMotion = nextReducedMotion;
      stopLoop();
    }
    state.hoveredIndex = -1;

    updateSemanticList();
    if (!renderer) return;
    updatePeerInstances();
    updateLinkStyles();
    updateSynapses(0);
    updateLabels();
    requestRender();
  }

  function setVisible(visible) {
    if (state.destroyed) return;
    state.visible = Boolean(visible);
    srList.hidden = !state.visible;
    if (canvas) canvas.style.visibility = state.visible ? "visible" : "hidden";

    if (!state.visible) {
      stopLoop();
      try {
        if (
          state.activePointerId !== null
          && canvas?.hasPointerCapture(state.activePointerId)
        ) {
          canvas.releasePointerCapture(state.activePointerId);
        }
      } catch {
        // Capture may already have been released by the browser.
      }
      state.dragging = false;
      state.activePointerId = null;
      return;
    }
    resize();
    requestRender();
  }

  function capture() {
    if (!renderer || !canvas || state.destroyed || state.contextLost) return null;
    if (!renderNow(true)) return null;

    const snapshot = document.createElement("canvas");
    snapshot.width = canvas.width;
    snapshot.height = canvas.height;
    const context = snapshot.getContext("2d", { alpha: true });
    if (!context) {
      notifyFallback("capture-2d-context-unavailable");
      return null;
    }

    try {
      context.drawImage(canvas, 0, 0);
      return snapshot;
    } catch (error) {
      notifyFallback(`capture-failed: ${error?.message || "unknown error"}`);
      return null;
    }
  }

  function getStats() {
    const focusTriangles = focusGeometry?.index
      ? focusGeometry.index.count / 3
      : (focusGeometry?.getAttribute("position")?.count || 0) / 3;
    const peerTriangles = peerGeometry?.index
      ? peerGeometry.index.count / 3
      : (peerGeometry?.getAttribute("position")?.count || 0) / 3;
    const estimatedTriangles = Math.round(
      (state.focus.symbol ? focusTriangles : 0)
      + peerTriangles * state.peers.length
      + (state.focus.symbol ? 2 : 0)
      + state.peers.length * 2,
    );
    const estimatedDrawCalls =
      (state.focus.symbol ? 2 : 0)
      + (state.peers.length ? 3 : 0)
      + state.peers.length;

    return {
      webgl2: Boolean(renderer),
      visible: state.visible,
      reducedMotion: state.reducedMotion,
      contextLost: state.contextLost,
      peerCount: state.peers.length,
      dpr: state.dpr,
      width: state.width,
      height: state.height,
      triangles: renderer?.info.render.triangles ?? estimatedTriangles,
      drawCalls: renderer?.info.render.calls ?? estimatedDrawCalls,
      estimatedTriangles,
      estimatedDrawCalls,
      withinBudget: estimatedTriangles < 10000 && estimatedDrawCalls < 30,
    };
  }

  function removeCanvasListeners() {
    if (!canvas) return;
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("click", onCanvasClick);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
  }

  function disposeGraphics() {
    for (const resource of labelResources) {
      resource.texture.dispose();
      resource.material.dispose();
    }
    labelResources.length = 0;
    peerLabels.length = 0;
    curves.length = 0;

    peerGeometry?.dispose();
    focusGeometry?.dispose();
    linkGeometry?.dispose();
    synapseGeometry?.dispose();
    peerMaterial?.dispose();
    focusMaterial?.dispose();
    linkMaterial?.dispose();
    synapseMaterial?.dispose();
    renderer?.renderLists?.dispose();
    renderer?.dispose();
    scene?.clear();

    renderer = null;
    scene = null;
    camera = null;
    network = null;
    peerMesh = null;
    focusMesh = null;
    linkLines = null;
    synapses = null;
    focusLabel = null;
    peerGeometry = null;
    focusGeometry = null;
    linkGeometry = null;
    synapseGeometry = null;
    peerMaterial = null;
    focusMaterial = null;
    linkMaterial = null;
    synapseMaterial = null;
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    stopLoop();
    resizeObserver?.disconnect();
    if (!resizeObserver) globalThis.removeEventListener?.("resize", resize);

    removeCanvasListeners();
    disposeGraphics();

    canvas?.remove();
    srList.remove();
    canvas = null;
  }

  const api = { update, setVisible, resize, capture, destroy, getStats };

  try {
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
      touchAction: "none",
      cursor: "grab",
      outline: "none",
    });

    const contextAttributes = {
      alpha: true,
      antialias: !state.coarsePointer,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    };
    const gl = canvas.getContext("webgl2", contextAttributes);
    if (!gl) {
      canvas = null;
      notifyFallback("webgl2-unavailable");
      return api;
    }

    renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl,
      ...contextAttributes,
    });
    renderer.setClearColor(COLORS.background, 0);
    renderer.autoClear = true;
    renderer.shadowMap.enabled = false;
    if ("outputColorSpace" in renderer && THREE.SRGBColorSpace) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else if ("outputEncoding" in renderer && THREE.sRGBEncoding) {
      renderer.outputEncoding = THREE.sRGBEncoding;
    }

    initScene();
    container.insertBefore(canvas, srList);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("click", onCanvasClick);
    canvas.addEventListener("webglcontextlost", onContextLost, false);
    canvas.addEventListener("webglcontextrestored", onContextRestored, false);

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
    } else {
      globalThis.addEventListener?.("resize", resize, { passive: true });
    }

    resize();
    renderNow(true);
    safeCall(callbacks.onReady);
    requestRender();
  } catch (error) {
    stopLoop();
    resizeObserver?.disconnect();
    resizeObserver = null;
    globalThis.removeEventListener?.("resize", resize);
    removeCanvasListeners();
    disposeGraphics();
    canvas?.remove();
    canvas = null;
    notifyFallback(`renderer-init-failed: ${error?.message || "unknown error"}`);
  }

  return api;
}
