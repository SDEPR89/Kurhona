import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Task, Subject } from '../types';
import './Visualizer3D.css';

// Hex values matching CSS variables for both light and dark themes
const COLOR_MAP: Record<string, string> = {
  'do_first': '#f87171',
  'schedule': '#60a5fa',
  'delegate': '#fbbf24',
  'eliminate': '#9ca3af',
  'var(--q-do-first)': '#f87171',
  'var(--q-schedule)': '#60a5fa',
  'var(--q-delegate)': '#fbbf24',
  'var(--q-eliminate)': '#9ca3af',
  'var(--subject-palette-1)': '#1ba39c',
  'var(--subject-palette-2)': '#60a5fa',
  'var(--subject-palette-3)': '#fbbf24',
  'var(--subject-palette-4)': '#f87171',
  'var(--subject-palette-5)': '#a78bfa',
  'var(--subject-palette-6)': '#34d399',
};

function resolveColor(colorStr: string | null | undefined, fallback: string): string {
  if (!colorStr) return fallback;
  if (colorStr.startsWith('#')) return colorStr;
  if (colorStr.startsWith('var(')) {
    const key = colorStr.trim();
    return COLOR_MAP[key] || fallback;
  }
  return COLOR_MAP[colorStr] || colorStr || fallback;
}

interface Visualizer3DProps {
  tasks: Task[];
  subjects: Subject[];
  onEdit: (task: Task) => void;
  completionPercentage: number;
  activeEditingTaskId: string | null;
}

// concentric ring configurations
const RING_CONFIGS = {
  do_first: { radius: 3.5, color: '#f87171', label: 'Do First' },
  schedule: { radius: 5.5, color: '#60a5fa', label: 'Schedule' },
  delegate: { radius: 7.5, color: '#fbbf24', label: 'Delegate' },
  eliminate: { radius: 9.5, color: '#9ca3af', label: 'Eliminate' },
} as const;

export function Visualizer3D({
  tasks,
  subjects,
  onEdit,
  completionPercentage,
  activeEditingTaskId,
}: Visualizer3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const percentageHudRef = useRef<HTMLDivElement>(null);

  // Filter and rotation states
  const [autoRotate, setAutoRotate] = useState(true);
  const [subjectFilter, setSubjectFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  // Tooltip state
  const [hoveredTask, setHoveredTask] = useState<Task | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Refs for sharing between React states and the Three.js loop
  const autoRotateRef = useRef(autoRotate);
  const subjectFilterRef = useRef(subjectFilter);
  const statusFilterRef = useRef(statusFilter);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    subjectFilterRef.current = subjectFilter;
  }, [subjectFilter]);

  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);

  const activeEditingTaskIdRef = useRef(activeEditingTaskId);

  useEffect(() => {
    activeEditingTaskIdRef.current = activeEditingTaskId;
  }, [activeEditingTaskId]);

  // Ref to the camera-reset handler so the "Reset Camera" button can
  // reach it without going through a window global. Assigned in the
  // WebGL effect (which is the only place that holds the live camera
  // and controls), cleared in cleanup. Button calls
  // `resetCameraRef.current?.()` — see the comment near the ref.
  const resetCameraRef = useRef<(() => void) | null>(null);

  const completionPercentageRef = useRef(completionPercentage);

  useEffect(() => {
    completionPercentageRef.current = completionPercentage;
  }, [completionPercentage]);

  // Container dimensions, measured via ResizeObserver. The WebGL
  // effect needs a real width/height before PerspectiveCamera can
  // set its aspect — if we initialize with 0×0 the renderer produces
  // a blank canvas. Mount-time is the most common failure point
  // (the dashboard-pane parent may not have laid out yet), but
  // window resize and device rotation hit the same path.
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Initial measurement — the observer fires on mount but we don't
    // want to wait one tick for the first valid dimension.
    setSize({ w: container.clientWidth, h: container.clientHeight });
    const observer = new ResizeObserver(() => {
      setSize({ w: container.clientWidth, h: container.clientHeight });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Stable ref the button can call to reset the camera. Lives on a
  // ref (not `window.resetVisCamera`) so it can't be undefined in
  // the gap between effect cleanup and re-assignment when `tasks`
  // changes mid-click.
  // Compute stats for HUD overlay
  const stats = {
    total: tasks.length,
    do_first: tasks.filter(t => t.quadrant === 'do_first').length,
    schedule: tasks.filter(t => t.quadrant === 'schedule').length,
    delegate: tasks.filter(t => t.quadrant === 'delegate').length,
    eliminate: tasks.filter(t => t.quadrant === 'eliminate').length,
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    // Wait for the container to be laid out — a 0×0 element gives
    // PerspectiveCamera a NaN aspect, and the canvas renders blank
    // until the next size change. The ResizeObserver above will
    // re-run this effect with a real measurement.
    if (size.w === 0 || size.h === 0) return;

    // Detect light or dark mode
    let isDark = document.documentElement.getAttribute('data-theme') !== 'light';

    // 1. Scene setup
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(isDark ? 0x020617 : 0xfffff0, 0.015);

    // 2. Camera setup
    const camera = new THREE.PerspectiveCamera(
      45,
      size.w / size.h,
      0.1,
      100
    );
    // Portrait phones frame the orbital rings differently — the
    // landscape framing crops the top/bottom on a tall viewport, so
    // we pull the camera up and back. `initialCamPos` / `initialDistance`
    // are captured once at effect init and reused by the outro zoom
    // and the reset handler so the three places can never drift out
    // of sync. Recomputed every effect run, so a layout change
    // (e.g. rotate-to-portrait via the ResizeObserver) reframes.
    const isPortrait = size.w < size.h;
    const initialCamPos = isPortrait
      ? new THREE.Vector3(0, 18, 24)
      : new THREE.Vector3(0, 12, 16);
    const initialDistance = isPortrait ? 30.0 : 20.0;
    camera.position.copy(initialCamPos);

    // 3. Renderer setup
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      alpha: true,
    });
    renderer.setSize(size.w, size.h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 4. Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2.1; // Limit camera from going below ground
    controls.minDistance = 3;
    // 50 leaves comfortable headroom past the portrait overview
    // distance of 30 — orbit rings top out at radius 9.5, so the
    // user can pull back to ~5× the outermost ring without clipping.
    controls.maxDistance = 50;

    // 5. Lighting
    const ambientLight = new THREE.AmbientLight(isDark ? 0x090d16 : 0xfffff0, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 15, 5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.bias = -0.001;
    scene.add(dirLight);

    // Subtle blueish point light at the center
    const pointLight = new THREE.PointLight(0x1ba39c, 2.0, 15);
    pointLight.position.set(0, 0, 0);
    scene.add(pointLight);

    // 6. Grid and ground
    const gridColor = isDark ? 0x334155 : 0x94a3b8;
    const gridHelper = new THREE.GridHelper(30, 30, gridColor, gridColor);
    gridHelper.position.y = -0.5;
    (gridHelper.material as THREE.LineBasicMaterial).opacity = 0.25;
    (gridHelper.material as THREE.LineBasicMaterial).transparent = true;
    gridHelper.visible = isDark;
    scene.add(gridHelper);

    // 7. Rotating orbital container groups
    const mainGroup = new THREE.Group();
    scene.add(mainGroup);

    // Render 4 concentric rings
    const ringMeshes: THREE.Mesh[] = [];
    Object.entries(RING_CONFIGS).forEach(([_, config]) => {
      // Torus geometry for elegant 3D pipes
      const ringGeom = new THREE.TorusGeometry(config.radius, 0.025, 8, 80);
      ringGeom.rotateX(Math.PI / 2); // Make flat on the XZ plane

      const ringMat = new THREE.MeshPhysicalMaterial({
        color: config.color,
        roughness: 0.1,
        metalness: 0.1,
        transparent: true,
        opacity: 0.2,
        transmission: 0.7,
        thickness: 0.5,
      });

      const ringMesh = new THREE.Mesh(ringGeom, ringMat);
      ringMesh.position.y = 0;
      mainGroup.add(ringMesh);
      ringMeshes.push(ringMesh);
    });

    // Center Nucleus - Transparent Outer Glass Shell (increased base size to 2.0)
    const nucleusGeom = new THREE.SphereGeometry(2.0, 32, 32);
    const nucleusMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.1,
      roughness: 0.05,
      metalness: 0.1,
      transparent: true,
      opacity: 0.2,
      transmission: 0.98,
      ior: 1.5,
      thickness: 1.0,
    });
    const nucleus = new THREE.Mesh(nucleusGeom, nucleusMat);
    nucleus.position.set(0, 0.5, 0);
    // Set base scale from completion percentage
    const baseScale = 0.4 + 1.2 * completionPercentage;
    nucleus.scale.setScalar(baseScale);
    mainGroup.add(nucleus);

    // Inner Core - Glowing Wireframe (nested inside the glass shell)
    const innerCoreGeom = new THREE.IcosahedronGeometry(1.1, 1);
    const innerCoreMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.4,
      wireframe: true,
      transparent: true,
      opacity: 0.6,
    });
    const innerCore = new THREE.Mesh(innerCoreGeom, innerCoreMat);
    nucleus.add(innerCore);

    // 8. Create Task Nodes
    interface TaskNode {
      task: Task;
      mesh: THREE.Mesh;
      quadrant: 'do_first' | 'schedule' | 'delegate' | 'eliminate';
      baseTheta: number;
      speed: number;
      yFloatOffset: number;
      targetScale: number;
      targetOpacity: number;
      spawnScale: number;
    }

    const taskNodes: TaskNode[] = [];
    const sphereGeom = new THREE.SphereGeometry(0.35, 24, 24);

    // Distribute tasks along rings with even spacing
    const tasksByQuadrant: Record<string, Task[]> = {
      do_first: [],
      schedule: [],
      delegate: [],
      eliminate: [],
    };

    tasks.forEach((t) => {
      if (tasksByQuadrant[t.quadrant]) {
        tasksByQuadrant[t.quadrant].push(t);
      }
    });

    Object.entries(tasksByQuadrant).forEach(([quadrantKey, qTasks]) => {
      const config = RING_CONFIGS[quadrantKey as keyof typeof RING_CONFIGS];
      const count = qTasks.length;

      qTasks.forEach((task, idx) => {
        // Space them evenly
        const baseTheta = count > 0 ? (idx / count) * Math.PI * 2 : 0;
        const randomSpeed = 0.05 + Math.random() * 0.04; // slight differences in speed
        const randomOffset = Math.random() * Math.PI * 2;

        // Use default quadrant color (e.g. Do First = red) to match task category
        const taskColor: string = config.color;

        const sphereMat = new THREE.MeshPhysicalMaterial({
          color: taskColor,
          emissive: taskColor,
          emissiveIntensity: 0.15,
          roughness: 0.15,
          metalness: 0.1,
          transparent: true,
          opacity: 0.85,
          transmission: 0.6,
          thickness: 0.5,
        });

        const sphereMesh = new THREE.Mesh(sphereGeom, sphereMat);
        sphereMesh.castShadow = true;
        sphereMesh.receiveShadow = true;
        
        // Store task metadata directly on the mesh's userData
        sphereMesh.userData = { taskId: task.id, task };

        // Spawn at center core with scale 0 for burst intro transition
        sphereMesh.scale.set(0, 0, 0);
        sphereMesh.position.set(0, 0.5, 0);
        mainGroup.add(sphereMesh);

        taskNodes.push({
          task,
          mesh: sphereMesh,
          quadrant: quadrantKey as 'do_first' | 'schedule' | 'delegate' | 'eliminate',
          baseTheta,
          speed: randomSpeed,
          yFloatOffset: randomOffset,
          targetScale: 1,
          targetOpacity: 0.85,
          spawnScale: 0,
        });
      });
    });

    // 9. Raycasting and interactions
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hoveredMesh: THREE.Mesh | null = null;
    let cameraTargetNode: TaskNode | null = null;
    let lastEditingId: string | null = null;
    let isAnimating = false;
    let outroMode = false;
    let animationStartTime = 0;
    let currentAnimationDuration = 500; // ms
    const startTarget = new THREE.Vector3();
    const endTarget = new THREE.Vector3();
    const startCamPos = new THREE.Vector3();
    const endCamPos = new THREE.Vector3();

    // Track pointer movement
    const onPointerMove = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    };

    // Track click on node
    const onCanvasClick = () => {
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(
        taskNodes.map(n => n.mesh)
      );

      if (intersects.length > 0) {
        const clickedMesh = intersects[0].object as THREE.Mesh;
        const matchedNode = taskNodes.find(n => n.mesh === clickedMesh);
        if (matchedNode) {
          cameraTargetNode = matchedNode;
          startTarget.copy(controls.target);
          startCamPos.copy(camera.position);
          animationStartTime = performance.now();
          currentAnimationDuration = 500; // 500ms for click intro
          isAnimating = true;
          outroMode = false;
          controls.enabled = false; // Block user rotation/pan interactions during zoom-in flight

          setTimeout(() => {
            onEdit(matchedNode.task);
          }, 500);
        }
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('click', onCanvasClick);

    // Theme listener via MutationObserver
    const observer = new MutationObserver(() => {
      const currentThemeDark = document.documentElement.getAttribute('data-theme') !== 'light';
      if (currentThemeDark !== isDark) {
        isDark = currentThemeDark;
        scene.fog = new THREE.FogExp2(isDark ? 0x020617 : 0xfffff0, 0.015);
        ambientLight.color.setHex(isDark ? 0x090d16 : 0xfffff0);
        (gridHelper.material as THREE.LineBasicMaterial).color.setHex(isDark ? 0x334155 : 0x94a3b8);
        gridHelper.visible = isDark;
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // 10. Animation loop
    const clock = new THREE.Clock();
    let animationFrameId: number;

    const tick = () => {
      const elapsedTime = clock.getElapsedTime();

      // Slow rotation of the entire matrix system if auto-rotate is toggled on
      if (autoRotateRef.current) {
        mainGroup.rotation.y = elapsedTime * 0.08;
      }


      // Pulse scale modulation (breathing effect) and completion glow feedback
      const pct = completionPercentageRef.current;
      const targetGlassScale = 0.4 + 1.2 * pct;
      const pulseScale = targetGlassScale * (1.0 + Math.sin(elapsedTime * 1.5) * 0.08);
      nucleus.scale.setScalar(pulseScale);

      // Parallax breathing pulse for the nested core
      const innerPulse = 1.0 + Math.cos(elapsedTime * 2.2) * 0.05;
      innerCore.scale.setScalar(innerPulse);

      // Color/Glow updates based on task completion (Dark mode: Ivory -> Emerald, Light mode: Midnight -> Dark Emerald)
      const startColor = new THREE.Color(isDark ? 0xfffff0 : 0x020617);
      const endColor = new THREE.Color(isDark ? 0x34d399 : 0x047857);
      const currentColor = startColor.clone().lerp(endColor, pct);
      
      innerCoreMat.color.copy(currentColor);
      innerCoreMat.emissive.copy(currentColor);
      innerCoreMat.emissiveIntensity = isDark ? (0.35 + pct * 1.65) : (0.1 + pct * 0.4);

      // Spin the inner wireframe core independently
      innerCore.rotation.x = elapsedTime * 0.4;
      innerCore.rotation.y = elapsedTime * 0.6;
      innerCore.rotation.z = elapsedTime * 0.2;

      // Node specific animations (floating & filtering)
      taskNodes.forEach((node) => {
        const activeSubFilter = subjectFilterRef.current;
        const activeStatFilter = statusFilterRef.current;

        // Verify filters
        const matchesSubject = activeSubFilter === '' || node.task.subject_id === activeSubFilter;
        const matchesStatus = activeStatFilter === '' || node.task.status === activeStatFilter;
        const matchesFilters = matchesSubject && matchesStatus;

        // Target settings for filtering transitions
        node.targetScale = matchesFilters ? 1.0 : 0.05;
        node.targetOpacity = matchesFilters ? 0.85 : 0.0;

        // Increment spawn/intro radial expansion factor towards 1.0
        node.spawnScale = THREE.MathUtils.lerp(node.spawnScale ?? 0, 1.0, 0.035);

        // Smooth scale and opacity interpolation (including spawn scale intro)
        const currentTargetScale = node.targetScale * node.spawnScale;
        node.mesh.scale.lerp(new THREE.Vector3(currentTargetScale, currentTargetScale, currentTargetScale), 0.1);
        
        const mat = node.mesh.material as THREE.MeshPhysicalMaterial;
        mat.opacity = THREE.MathUtils.lerp(mat.opacity, node.targetOpacity * node.spawnScale, 0.1);
        mat.transparent = true;

        // Position nodes along their concentric rings (expanding outwards during spawn)
        const ringConfig = RING_CONFIGS[node.quadrant];
        const currentRadius = ringConfig.radius * node.spawnScale;
        const theta = node.baseTheta + elapsedTime * node.speed * 0.2;
        
        // Gentle vertical floating motion (lerps from center height of 0.5 to target floating height)
        const targetFloatY = 0.4 + Math.sin(elapsedTime * 2.5 + node.yFloatOffset) * 0.15;
        const floatY = THREE.MathUtils.lerp(0.5, targetFloatY, node.spawnScale);

        // Node position in world space
        node.mesh.position.x = currentRadius * Math.cos(theta);
        node.mesh.position.z = currentRadius * Math.sin(theta);
        node.mesh.position.y = floatY;
      });

      const editingId = activeEditingTaskIdRef.current;

      // Detect editing state changes to trigger intro/outro animations
      if (editingId !== lastEditingId) {
        if (lastEditingId && !editingId) {
          // Modal was closed! Start OUTRO zoom-out animation!
          startTarget.copy(controls.target);
          startCamPos.copy(camera.position);

          // Zoom out along the current angle back to the overview
          // distance captured at effect init. Using the captured
          // value (not a re-read of containerRef.current) keeps the
          // outro stable across a rapid view switch — the ref can be
          // null mid-tear-down, but `initialDistance` is the value
          // the camera was framed with, which is what we want.
          const center = new THREE.Vector3(0, 0.5, 0);
          const dir = camera.position.clone().sub(center).normalize();
          endTarget.set(0, 0.5, 0);
          endCamPos.copy(center).add(dir.multiplyScalar(initialDistance));

          animationStartTime = performance.now();
          currentAnimationDuration = 700; // 700ms slow zoom out
          isAnimating = true;
          outroMode = true;
          controls.enabled = false;
          cameraTargetNode = null;
        } else if (!lastEditingId && editingId) {
          // Modal was opened externally: start intro if not already running
          if (!isAnimating || !cameraTargetNode || cameraTargetNode.task.id !== editingId) {
            const matched = taskNodes.find(n => n.task.id === editingId);
            if (matched) {
              cameraTargetNode = matched;
              startTarget.copy(controls.target);
              startCamPos.copy(camera.position);
              
              animationStartTime = performance.now();
              currentAnimationDuration = 500; // 500ms for intro
              isAnimating = true;
              outroMode = false;
              controls.enabled = false;
            }
          }
        }
        lastEditingId = editingId;
      }

      if (isAnimating) {
        const elapsed = performance.now() - animationStartTime;
        const t = Math.min(elapsed / currentAnimationDuration, 1.0);
        
        let easedT = 0;
        if (outroMode) {
          // easeInOutCubic: smooth acceleration and deceleration to prevent warp jumps
          easedT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        } else {
          // easeOutCubic: snappy responsive start for click zoom-ins
          easedT = 1 - Math.pow(1 - t, 3);
        }

        if (outroMode) {
          // Smoothly zoom out to overview position
          controls.target.lerpVectors(startTarget, endTarget, easedT);
          camera.position.lerpVectors(startCamPos, endCamPos, easedT);
        } else if (cameraTargetNode) {
          // Track current node position (it's orbiting)
          cameraTargetNode.mesh.getWorldPosition(endTarget);
          
          const center = new THREE.Vector3(0, 0.5, 0);
          const direction = endTarget.clone().sub(center);
          direction.y = 0;
          direction.normalize();
          
          endCamPos.copy(endTarget)
            .add(direction.multiplyScalar(3.0))
            .add(new THREE.Vector3(0, 1.8, 0));

          // Smoothly interpolate target and camera position
          controls.target.lerpVectors(startTarget, endTarget, easedT);
          camera.position.lerpVectors(startCamPos, endCamPos, easedT);
        }

        controls.enableDamping = false;
        controls.update();

        if (t === 1.0) {
          isAnimating = false;
          controls.enabled = true;
          controls.enableDamping = true;
          outroMode = false;
        }
      } else {
        controls.enableDamping = true;

        // If a task is being edited (modal is open), hold that zoom lock on the orbiting node
        if (editingId) {
          const matched = taskNodes.find(n => n.task.id === editingId);
          if (matched) {
            const targetPos = new THREE.Vector3();
            matched.mesh.getWorldPosition(targetPos);
            controls.target.copy(targetPos);

            const center = new THREE.Vector3(0, 0.5, 0);
            const direction = targetPos.clone().sub(center);
            direction.y = 0;
            direction.normalize();

            const followCamPos = targetPos.clone()
              .add(direction.multiplyScalar(3.0))
              .add(new THREE.Vector3(0, 1.8, 0));

            // Smoothly track camera position behind the orbiting node
            camera.position.lerp(followCamPos, 0.1);
          }
        }
        controls.update();
      }

      // Raycast detection for hovered node / tooltip
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(
        taskNodes.filter(n => n.targetScale > 0.5).map(n => n.mesh)
      );

      if (intersects.length > 0) {
        const hitMesh = intersects[0].object as THREE.Mesh;
        
        if (hoveredMesh !== hitMesh) {
          // Reset previous hover
          if (hoveredMesh) {
            const mat = hoveredMesh.material as THREE.MeshPhysicalMaterial;
            mat.emissiveIntensity = 0.15;
          }

          hoveredMesh = hitMesh;
          const mat = hoveredMesh.material as THREE.MeshPhysicalMaterial;
          mat.emissiveIntensity = 0.65; // Make glow brighter on hover

          const matchedNode = taskNodes.find(n => n.mesh === hitMesh);
          if (matchedNode) {
            setHoveredTask(matchedNode.task);
          }
        }

        // Project 3D node center to 2D screen space to position HTML tooltip
        if (hoveredMesh && containerRef.current) {
          const nodeWorldPos = new THREE.Vector3();
          hoveredMesh.getWorldPosition(nodeWorldPos);

          const vector = nodeWorldPos.clone();
          vector.project(camera);

          const widthHalf = containerRef.current.clientWidth / 2;
          const heightHalf = containerRef.current.clientHeight / 2;

          const screenX = vector.x * widthHalf + widthHalf;
          const screenY = -vector.y * heightHalf + heightHalf;

          setTooltipPos({ x: screenX, y: screenY });
        }
      } else {
        if (hoveredMesh) {
          const mat = hoveredMesh.material as THREE.MeshPhysicalMaterial;
          mat.emissiveIntensity = 0.15;
          hoveredMesh = null;
          setHoveredTask(null);
        }
      }

      // Project central sphere (0, 0.5, 0) to 2D screen space to position HTML percentage overlay
      if (percentageHudRef.current && containerRef.current) {
        const centerPos = new THREE.Vector3(0, 0.5, 0);
        centerPos.project(camera);

        // Hide if behind the camera
        const isBehind = centerPos.z > 1.0;
        
        if (isBehind) {
          percentageHudRef.current.style.opacity = '0';
        } else {
          percentageHudRef.current.style.opacity = '1';
          
          const widthHalf = containerRef.current.clientWidth / 2;
          const heightHalf = containerRef.current.clientHeight / 2;
          
          const screenX = centerPos.x * widthHalf + widthHalf;
          const screenY = -centerPos.y * heightHalf + heightHalf;
          
          percentageHudRef.current.style.left = `${screenX}px`;
          percentageHudRef.current.style.top = `${screenY}px`;
          
          const pctVal = Math.round(completionPercentageRef.current * 100);
          percentageHudRef.current.textContent = `${pctVal}%`;

          if (isDark) {
            percentageHudRef.current.style.color = '#fffff0'; // Ivory
            percentageHudRef.current.style.textShadow = '0 0 10px rgba(255, 255, 240, 0.6)';
          } else {
            percentageHudRef.current.style.color = '#020617'; // Midnight
            percentageHudRef.current.style.textShadow = 'none';
          }
        }
      }

      renderer.render(scene, camera);
      animationFrameId = requestAnimationFrame(tick);
    };

    tick();

    // Reset camera handler. Stored on a ref (not `window`) so the
    // button can always reach it — the previous `window.resetVisCamera`
    // pattern was undefined in the gap between effect cleanup and
    // re-assignment whenever `tasks` changed mid-click.
    const handleResetCamera = () => {
      controls.reset();
      camera.position.copy(initialCamPos);
      controls.target.set(0, 0.5, 0);
      controls.update();
    };
    resetCameraRef.current = handleResetCamera;

    // (No window assignment — see the comment on resetCameraRef.)

    // (The old window.resize handler is gone — the ResizeObserver
    // effect above now drives size changes. Re-deriving the camera
    // position on rotate/resize happens for free because `size` is
    // in this effect's deps: the effect re-runs, re-measures
    // container dimensions, and recomputes initialCamPos /
    // initialDistance from the new isPortrait value.)

    // 11. Component cleanup
    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('pointermove', onPointerMove);
      observer.disconnect();
      resetCameraRef.current = null;

      if (canvas) {
        canvas.removeEventListener('click', onCanvasClick);
      }

      // Dispose resources
      nucleusGeom.dispose();
      nucleusMat.dispose();
      innerCoreGeom.dispose();
      innerCoreMat.dispose();
      sphereGeom.dispose();

      taskNodes.forEach((node) => {
        (node.mesh.material as THREE.Material).dispose();
      });

      ringMeshes.forEach((mesh) => {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });

      renderer.dispose();
    };
  }, [tasks, subjects, onEdit, completionPercentage, size]);

  // Find subject details for the tooltip
  const hoveredTaskSubject = hoveredTask?.subject_id
    ? subjects.find(s => s.id === hoveredTask.subject_id)
    : null;

  return (
    <div className="visualizer-container" ref={containerRef}>
      <canvas className="visualizer-canvas" ref={canvasRef} />
      <div className="visualizer-percentage-hud" ref={percentageHudRef} />

      {/* HUD / Legend Widget (Top Left) */}
      <div className="visualizer-hud glass-widget">
        <h3>
          <span>Dashboard Hub</span>
          <span className="total-badge">{stats.total} Active</span>
        </h3>
        <div className="hud-ring-item">
          <div className="hud-ring-color" style={{ color: '#f87171', backgroundColor: '#f87171' }} />
          <span className="hud-ring-label">{RING_CONFIGS.do_first.label}</span>
          <span className="hud-ring-count">{stats.do_first}</span>
        </div>
        <div className="hud-ring-item">
          <div className="hud-ring-color" style={{ color: '#60a5fa', backgroundColor: '#60a5fa' }} />
          <span className="hud-ring-label">{RING_CONFIGS.schedule.label}</span>
          <span className="hud-ring-count">{stats.schedule}</span>
        </div>
        <div className="hud-ring-item">
          <div className="hud-ring-color" style={{ color: '#fbbf24', backgroundColor: '#fbbf24' }} />
          <span className="hud-ring-label">{RING_CONFIGS.delegate.label}</span>
          <span className="hud-ring-count">{stats.delegate}</span>
        </div>
        <div className="hud-ring-item">
          <div className="hud-ring-color" style={{ color: '#9ca3af', backgroundColor: '#9ca3af' }} />
          <span className="hud-ring-label">{RING_CONFIGS.eliminate.label}</span>
          <span className="hud-ring-count">{stats.eliminate}</span>
        </div>
        <div className="hud-ring-item" style={{ borderTop: '1px solid var(--divider)', paddingTop: '8px', marginTop: '8px' }}>
          <div className="hud-ring-color" style={{ color: '#1ba39c', backgroundColor: '#1ba39c', boxShadow: '0 0 10px #1ba39c' }} />
          <span className="hud-ring-label" style={{ fontWeight: '600' }}>Done Progress</span>
          <span className="hud-ring-count" style={{ backgroundColor: 'var(--check-accent)', color: '#fff' }}>{Math.round(completionPercentage * 100)}%</span>
        </div>
      </div>

      {/* Floating projected tooltip */}
      {hoveredTask && (
        <div
          className="visualizer-tooltip is-visible"
          style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
        >
          <div className="tooltip-content glass-widget">
            <div className="tooltip-title">{hoveredTask.title}</div>
            <div className="tooltip-meta">
              <span className="tooltip-badge">
                {hoveredTask.quadrant.replace('_', ' ')}
              </span>
              <span className="tooltip-badge">
                {hoveredTask.status.replace('_', ' ')}
              </span>
              {hoveredTaskSubject && (
                <span className="tooltip-subject">
                  <span
                    className="tooltip-subject-dot"
                    style={{
                      backgroundColor: resolveColor(hoveredTaskSubject.color, '#cbd5e1')
                    }}
                  />
                  {hoveredTaskSubject.name}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Control panel (Bottom toolbar) */}
      <div className="visualizer-controls-bar glass-widget">
        <div className="controls-group">
          {/* Play/Pause Rotation */}
          <button
            type="button"
            className={`vis-btn${autoRotate ? ' is-active' : ''}`}
            onClick={() => setAutoRotate(!autoRotate)}
            title="Toggle orbit rotation"
          >
            {autoRotate ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
                <span>Pause</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span>Rotate</span>
              </>
            )}
          </button>

          {/* Camera reset */}
          <button
            type="button"
            className="vis-btn"
            onClick={() => resetCameraRef.current?.()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 12a11 11 0 1 1-2.9-7.7L23 7" />
              <polyline points="23 3 23 7 19 7" />
            </svg>
            <span>Reset Camera</span>
          </button>
        </div>

        {/* Dynamic Filters */}
        <div className="controls-group">
          {/* Subject Filter */}
          <select
            className="vis-select"
            value={subjectFilter}
            onChange={(e) => setSubjectFilter(e.target.value)}
            aria-label="Filter by Subject"
          >
            <option value="">All Subjects</option>
            {subjects.map((sub) => (
              <option key={sub.id} value={sub.id}>
                {sub.name}
              </option>
            ))}
          </select>

          {/* Status Filter */}
          <select
            className="vis-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by Status"
          >
            <option value="">All Statuses</option>
            <option value="not_started">Not Started</option>
            <option value="in_progress">In Progress</option>
            <option value="ready_to_submit">Ready to Submit</option>
            <option value="submitted">Submitted</option>
          </select>
        </div>
      </div>
    </div>
  );
}
