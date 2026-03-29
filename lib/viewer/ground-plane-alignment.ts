import * as THREE from "three";

export type GroundAlignUpAxis = "y" | "z";

export interface GroundAlignOptions {
  upAxis?: GroundAlignUpAxis;
  gridSize?: number;
  bottomPercentile?: number;
  ransacThreshold?: number;
  ransacIterations?: number;
  debug?: boolean;
  useGridEnvelope?: boolean;
  translateToGround?: boolean;
  maxVertices?: number;
  maxDebugPoints?: number;
  externalSupportPoints?: THREE.Vector3[];
}

export interface PlaneFit {
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
}

export interface PlaneRansacResult {
  plane: PlaneFit;
  inlierIndices: number[];
  inlierPoints: THREE.Vector3[];
  threshold: number;
}

export interface SceneAlignmentApplyResult {
  rotationQuaternion: THREE.Quaternion;
  rotationAngleRad: number;
  translation: THREE.Vector3;
}

export interface SceneGroundAlignmentResult {
  ok: boolean;
  reason?: string;
  sampledVertexCount: number;
  supportCandidateCount: number;
  inlierCount: number;
  fittedNormal: THREE.Vector3 | null;
  rotationAngleDeg: number;
  debugGroup: THREE.Group | null;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    GroundAlignOptions,
    | "upAxis"
    | "gridSize"
    | "bottomPercentile"
    | "ransacThreshold"
    | "ransacIterations"
    | "debug"
    | "useGridEnvelope"
    | "translateToGround"
    | "maxVertices"
    | "maxDebugPoints"
  >
> = {
  upAxis: "y",
  gridSize: 0.35,
  bottomPercentile: 0.12,
  ransacThreshold: 0.03,
  ransacIterations: 220,
  debug: false,
  useGridEnvelope: true,
  translateToGround: true,
  maxVertices: 120000,
  maxDebugPoints: 8000
};

const IDENTITY_QUATERNION = new THREE.Quaternion(0, 0, 0, 1);
const EPSILON = 1e-9;

function worldUpVector(upAxis: GroundAlignUpAxis): THREE.Vector3 {
  return upAxis === "z" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
}

function getAxisValue(vec: THREE.Vector3, upAxis: GroundAlignUpAxis): number {
  return upAxis === "z" ? vec.z : vec.y;
}

function setAxisValue(vec: THREE.Vector3, upAxis: GroundAlignUpAxis, value: number) {
  if (upAxis === "z") vec.z = value;
  else vec.y = value;
}

function horizontalPair(vec: THREE.Vector3, upAxis: GroundAlignUpAxis): [number, number] {
  return upAxis === "z" ? [vec.x, vec.y] : [vec.x, vec.z];
}

function isFiniteVector3(vec: THREE.Vector3) {
  return Number.isFinite(vec.x) && Number.isFinite(vec.y) && Number.isFinite(vec.z);
}

export function collectWorldVertices(
  root: THREE.Object3D,
  options?: Pick<GroundAlignOptions, "maxVertices">
): THREE.Vector3[] {
  const maxVertices = Math.max(5000, Math.floor(options?.maxVertices ?? DEFAULT_OPTIONS.maxVertices));
  const vertices: THREE.Vector3[] = [];
  const scratch = new THREE.Vector3();
  const traversed: Array<{ object: THREE.Object3D; count: number }> = [];
  let totalCount = 0;

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const points = object as THREE.Points;
    const isRenderable = mesh.isMesh || points.isPoints;
    if (!isRenderable) return;
    const geometry = (mesh.geometry ?? points.geometry) as THREE.BufferGeometry | undefined;
    if (!geometry) return;
    const position = geometry.getAttribute("position");
    if (!position || position.count <= 0) return;
    totalCount += position.count;
    traversed.push({ object, count: position.count });
  });

  if (totalCount <= 0) return vertices;
  const globalStride = totalCount > maxVertices ? Math.ceil(totalCount / maxVertices) : 1;

  for (const entry of traversed) {
    const mesh = entry.object as THREE.Mesh;
    const points = entry.object as THREE.Points;
    const geometry = (mesh.geometry ?? points.geometry) as THREE.BufferGeometry | undefined;
    if (!geometry) continue;
    const position = geometry.getAttribute("position");
    if (!position || position.count <= 0) continue;

    const stride = Math.max(1, globalStride);
    for (let i = 0; i < position.count; i += stride) {
      scratch.fromBufferAttribute(position, i).applyMatrix4(entry.object.matrixWorld);
      if (!isFiniteVector3(scratch)) continue;
      vertices.push(scratch.clone());
    }
  }

  return vertices;
}

export function buildLowerEnvelopeCandidates(
  points: THREE.Vector3[],
  upAxis: GroundAlignUpAxis,
  gridSize: number
): THREE.Vector3[] {
  if (points.length === 0) return [];
  const safeGrid = Math.max(gridSize, 1e-4);
  const byCell = new Map<string, THREE.Vector3>();

  for (const point of points) {
    const [hx, hy] = horizontalPair(point, upAxis);
    const gx = Math.floor(hx / safeGrid);
    const gy = Math.floor(hy / safeGrid);
    const key = `${gx},${gy}`;
    const existing = byCell.get(key);
    if (!existing || getAxisValue(point, upAxis) < getAxisValue(existing, upAxis)) {
      byCell.set(key, point);
    }
  }

  return [...byCell.values()].map((point) => point.clone());
}

function buildBottomPercentileCandidates(
  points: THREE.Vector3[],
  upAxis: GroundAlignUpAxis,
  percentile: number
): THREE.Vector3[] {
  if (points.length === 0) return [];
  const safePercentile = Math.min(0.95, Math.max(0.01, percentile));
  const heights = points
    .map((point) => getAxisValue(point, upAxis))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (heights.length === 0) return [];
  const thresholdIndex = Math.min(
    heights.length - 1,
    Math.max(0, Math.floor((heights.length - 1) * safePercentile))
  );
  const threshold = heights[thresholdIndex] ?? heights[heights.length - 1] ?? 0;
  const candidates = points.filter((point) => getAxisValue(point, upAxis) <= threshold);
  return candidates.length >= 3 ? candidates.map((point) => point.clone()) : points.slice(0, Math.min(200, points.length));
}

function fitPlaneFromThreePoints(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): PlaneFit | null {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const normal = ab.cross(ac);
  if (normal.lengthSq() <= EPSILON) return null;
  normal.normalize();
  const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  return { normal, centroid };
}

function pointPlaneDistance(point: THREE.Vector3, plane: PlaneFit): number {
  return Math.abs(plane.normal.dot(point.clone().sub(plane.centroid)));
}

function symmetricEigenvectorSmallest(cov: [number, number, number, number, number, number]): THREE.Vector3 | null {
  // Symmetric covariance matrix:
  // [xx xy xz]
  // [xy yy yz]
  // [xz yz zz]
  const [xx, xy, xz, yy, yz, zz] = cov;
  const a = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz]
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];

  for (let iter = 0; iter < 24; iter += 1) {
    let p = 0;
    let q = 1;
    let maxAbs = Math.abs(a[0][1]);
    const c02 = Math.abs(a[0][2]);
    const c12 = Math.abs(a[1][2]);
    if (c02 > maxAbs) {
      maxAbs = c02;
      p = 0;
      q = 2;
    }
    if (c12 > maxAbs) {
      maxAbs = c12;
      p = 1;
      q = 2;
    }
    if (maxAbs <= 1e-10) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    for (let k = 0; k < 3; k += 1) {
      const aik = a[p][k];
      const aqk = a[q][k];
      a[p][k] = c * aik - s * aqk;
      a[q][k] = s * aik + c * aqk;
    }
    for (let k = 0; k < 3; k += 1) {
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = c * akp - s * akq;
      a[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k += 1) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }

  const eigenvalues = [a[0][0], a[1][1], a[2][2]];
  let smallestIndex = 0;
  if (eigenvalues[1] < eigenvalues[smallestIndex]) smallestIndex = 1;
  if (eigenvalues[2] < eigenvalues[smallestIndex]) smallestIndex = 2;

  const eigenvector = new THREE.Vector3(
    v[0][smallestIndex],
    v[1][smallestIndex],
    v[2][smallestIndex]
  );
  if (eigenvector.lengthSq() <= EPSILON) return null;
  return eigenvector.normalize();
}

export function refinePlaneSVD(points: THREE.Vector3[]): PlaneFit | null {
  if (points.length < 3) return null;
  const centroid = new THREE.Vector3();
  for (const point of points) centroid.add(point);
  centroid.multiplyScalar(1 / points.length);

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;

  for (const point of points) {
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;
    const dz = point.z - centroid.z;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }

  const inv = 1 / points.length;
  const normal = symmetricEigenvectorSmallest([xx * inv, xy * inv, xz * inv, yy * inv, yz * inv, zz * inv]);
  if (!normal) return null;
  return { normal, centroid };
}

export function fitPlaneRANSAC(
  points: THREE.Vector3[],
  threshold: number,
  iterations: number,
  upAxis: GroundAlignUpAxis
): PlaneRansacResult | null {
  if (points.length < 3) return null;
  const up = worldUpVector(upAxis);
  let bestPlane: PlaneFit | null = null;
  let bestInlierIndices: number[] = [];
  const effectiveThreshold = Math.max(1e-5, threshold);

  for (let iter = 0; iter < iterations; iter += 1) {
    const i0 = Math.floor(Math.random() * points.length);
    let i1 = Math.floor(Math.random() * points.length);
    let i2 = Math.floor(Math.random() * points.length);
    if (i0 === i1 || i0 === i2 || i1 === i2) {
      iter -= 1;
      continue;
    }

    const seedPlane = fitPlaneFromThreePoints(points[i0] as THREE.Vector3, points[i1] as THREE.Vector3, points[i2] as THREE.Vector3);
    if (!seedPlane) continue;
    if (seedPlane.normal.dot(up) < 0) seedPlane.normal.negate();

    const inlierIndices: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i] as THREE.Vector3;
      if (pointPlaneDistance(point, seedPlane) <= effectiveThreshold) {
        inlierIndices.push(i);
      }
    }

    if (inlierIndices.length > bestInlierIndices.length) {
      bestInlierIndices = inlierIndices;
      bestPlane = seedPlane;
    }
  }

  if (!bestPlane || bestInlierIndices.length < 3) return null;
  const inlierPoints = bestInlierIndices.map((index) => points[index] as THREE.Vector3);
  const refined = refinePlaneSVD(inlierPoints) ?? bestPlane;
  if (refined.normal.dot(up) < 0) refined.normal.negate();

  return {
    plane: refined,
    inlierIndices: bestInlierIndices,
    inlierPoints,
    threshold: effectiveThreshold
  };
}

export function quaternionFromNormals(a: THREE.Vector3, b: THREE.Vector3): THREE.Quaternion {
  const from = a.clone().normalize();
  const to = b.clone().normalize();
  const dot = THREE.MathUtils.clamp(from.dot(to), -1, 1);

  if (dot >= 1 - 1e-8) return IDENTITY_QUATERNION.clone();
  if (dot <= -1 + 1e-8) {
    const orthogonal = Math.abs(from.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const axis = orthogonal.cross(from).normalize();
    return new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  }

  const axis = from.clone().cross(to).normalize();
  const angle = Math.acos(dot);
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

export function applySceneAlignment(
  root: THREE.Object3D,
  quaternion: THREE.Quaternion,
  pivot: THREE.Vector3,
  translateToGround: boolean,
  supportPointsWorld: THREE.Vector3[],
  upAxis: GroundAlignUpAxis
): SceneAlignmentApplyResult {
  root.updateMatrixWorld(true);
  const parentWorldInverse = new THREE.Matrix4();
  if (root.parent) {
    root.parent.updateMatrixWorld(true);
    parentWorldInverse.copy(root.parent.matrixWorld).invert();
  } else {
    parentWorldInverse.identity();
  }

  const currentWorld = root.matrixWorld.clone();
  const rotateAroundPivot = new THREE.Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternion))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  let nextWorld = currentWorld.clone().premultiply(rotateAroundPivot);

  let translation = new THREE.Vector3(0, 0, 0);
  if (translateToGround && supportPointsWorld.length > 0) {
    let minHeight = Number.POSITIVE_INFINITY;
    const transformedPoint = new THREE.Vector3();
    for (const point of supportPointsWorld) {
      transformedPoint.copy(point).applyMatrix4(rotateAroundPivot);
      const h = getAxisValue(transformedPoint, upAxis);
      if (h < minHeight) minHeight = h;
    }
    if (Number.isFinite(minHeight)) {
      setAxisValue(translation, upAxis, -minHeight);
      nextWorld = nextWorld.premultiply(
        new THREE.Matrix4().makeTranslation(translation.x, translation.y, translation.z)
      );
    }
  }

  const nextLocal = nextWorld.clone().premultiply(parentWorldInverse);
  nextLocal.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);

  return {
    rotationQuaternion: quaternion.clone(),
    rotationAngleRad: 2 * Math.acos(THREE.MathUtils.clamp(quaternion.w, -1, 1)),
    translation
  };
}

export function createDebugPoints(
  points: THREE.Vector3[],
  color: number,
  size = 0.05,
  maxPoints = DEFAULT_OPTIONS.maxDebugPoints
): THREE.Points {
  const safeMax = Math.max(100, Math.floor(maxPoints));
  const stride = points.length > safeMax ? Math.ceil(points.length / safeMax) : 1;
  const sampledCount = Math.max(1, Math.ceil(points.length / stride));
  const positions = new Float32Array(sampledCount * 3);
  let writeIndex = 0;
  for (let i = 0; i < points.length && writeIndex < sampledCount; i += stride) {
    const point = points[i] as THREE.Vector3;
    positions[writeIndex * 3 + 0] = point.x;
    positions[writeIndex * 3 + 1] = point.y;
    positions[writeIndex * 3 + 2] = point.z;
    writeIndex += 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.85
  });
  return new THREE.Points(geometry, material);
}

export function createPlaneDebugMesh(
  centroid: THREE.Vector3,
  normal: THREE.Vector3,
  extent: number,
  color = 0x22d3ee
): THREE.Mesh {
  const planeGeometry = new THREE.PlaneGeometry(extent, extent, 1, 1);
  const planeMaterial = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.17,
    depthWrite: false
  });
  const planeMesh = new THREE.Mesh(planeGeometry, planeMaterial);
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
  planeMesh.quaternion.copy(orientation);
  planeMesh.position.copy(centroid);
  return planeMesh;
}

function createNormalDebugLine(
  centroid: THREE.Vector3,
  normal: THREE.Vector3,
  length: number,
  color = 0xf59e0b
): THREE.Line {
  const a = centroid.clone();
  const b = centroid.clone().add(normal.clone().normalize().multiplyScalar(length));
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9
  });
  return new THREE.Line(geometry, material);
}

export function alignSceneToGroundPlane(
  sceneObject: THREE.Object3D,
  options?: GroundAlignOptions
): SceneGroundAlignmentResult {
  const upAxis = options?.upAxis ?? DEFAULT_OPTIONS.upAxis;
  const useGridEnvelope = options?.useGridEnvelope ?? DEFAULT_OPTIONS.useGridEnvelope;
  const bottomPercentile = options?.bottomPercentile ?? DEFAULT_OPTIONS.bottomPercentile;
  const externalSupportPoints = options?.externalSupportPoints ?? [];
  const allVertices = collectWorldVertices(sceneObject, { maxVertices: options?.maxVertices });
  const sampledVertices = [
    ...allVertices.filter((point) => isFiniteVector3(point)),
    ...externalSupportPoints.filter((point) => isFiniteVector3(point))
  ];

  if (sampledVertices.length < 3) {
    return {
      ok: false,
      reason: "Not enough world-space vertices to estimate support plane.",
      sampledVertexCount: sampledVertices.length,
      supportCandidateCount: 0,
      inlierCount: 0,
      fittedNormal: null,
      rotationAngleDeg: 0,
      debugGroup: null
    };
  }

  let candidates = useGridEnvelope
    ? buildLowerEnvelopeCandidates(sampledVertices, upAxis, options?.gridSize ?? DEFAULT_OPTIONS.gridSize)
    : buildBottomPercentileCandidates(sampledVertices, upAxis, bottomPercentile);
  if (candidates.length < 3) {
    candidates = buildBottomPercentileCandidates(sampledVertices, upAxis, bottomPercentile);
  }
  if (candidates.length < 3) {
    return {
      ok: false,
      reason: "Too few support candidates after envelope filtering.",
      sampledVertexCount: sampledVertices.length,
      supportCandidateCount: candidates.length,
      inlierCount: 0,
      fittedNormal: null,
      rotationAngleDeg: 0,
      debugGroup: null
    };
  }

  const candidateBounds = new THREE.Box3().setFromPoints(candidates);
  const candidateScale = candidateBounds.isEmpty()
    ? 1
    : Math.max(1e-3, candidateBounds.getSize(new THREE.Vector3()).length());
  const adaptiveThreshold = Math.max(
    1e-4,
    (options?.ransacThreshold ?? DEFAULT_OPTIONS.ransacThreshold),
    candidateScale * 0.002
  );

  const ransac = fitPlaneRANSAC(
    candidates,
    adaptiveThreshold,
    Math.max(32, options?.ransacIterations ?? DEFAULT_OPTIONS.ransacIterations),
    upAxis
  );
  if (!ransac) {
    return {
      ok: false,
      reason: "RANSAC failed to find a stable support plane.",
      sampledVertexCount: sampledVertices.length,
      supportCandidateCount: candidates.length,
      inlierCount: 0,
      fittedNormal: null,
      rotationAngleDeg: 0,
      debugGroup: null
    };
  }

  const targetUp = worldUpVector(upAxis);
  const fittedNormal = ransac.plane.normal.clone().normalize();
  if (fittedNormal.dot(targetUp) < 0) fittedNormal.negate();
  const alignmentQuaternion = quaternionFromNormals(fittedNormal, targetUp);
  const applyResult = applySceneAlignment(
    sceneObject,
    alignmentQuaternion,
    ransac.plane.centroid,
    options?.translateToGround ?? DEFAULT_OPTIONS.translateToGround,
    ransac.inlierPoints,
    upAxis
  );

  let debugGroup: THREE.Group | null = null;
  if (options?.debug ?? DEFAULT_OPTIONS.debug) {
    const spanBox = new THREE.Box3().setFromPoints(ransac.inlierPoints);
    const extent = Math.max(0.5, spanBox.getSize(new THREE.Vector3()).length() * 0.75);
    debugGroup = new THREE.Group();
    debugGroup.name = "GroundAlignDebug";
    debugGroup.add(createDebugPoints(candidates, 0x22c55e, 0.04, options?.maxDebugPoints));
    debugGroup.add(createDebugPoints(ransac.inlierPoints, 0xf97316, 0.06, options?.maxDebugPoints));
    debugGroup.add(createPlaneDebugMesh(ransac.plane.centroid, fittedNormal, extent));
    debugGroup.add(createNormalDebugLine(ransac.plane.centroid, fittedNormal, extent * 0.5));
  }

  return {
    ok: true,
    sampledVertexCount: sampledVertices.length,
    supportCandidateCount: candidates.length,
    inlierCount: ransac.inlierPoints.length,
    fittedNormal,
    rotationAngleDeg: THREE.MathUtils.radToDeg(applyResult.rotationAngleRad),
    debugGroup
  };
}
