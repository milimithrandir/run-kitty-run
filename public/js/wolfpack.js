import * as THREE from 'three';

// Draws every wolf of a view with one InstancedMesh per wolf-part geometry (body, head, eyes, jaw, leg, tail x3;
// per wolf type, since each type bakes its own geometry). The rigs (models.js createWolfRig, one per wolf type, shared
// by all its wolves) stay invisible proxies that are never added to the scene: main.js poses a rig for one wolf, add()
// copies each part's world matrix (and the eye glow color) into the instanced meshes. ~11 draws per wolf become ~8 per
// wolf type. rigs: [[rig, number of wolves using it], ...]
const _c = new THREE.Color(), _m = new THREE.Matrix4();

// A wolf under a tree: its shape shows through the leaves, dark with a warning orange-red rim (stands out on the dark
// green spring canopy, its pink / white blossom and the grass; it was cream, too like the blossom). Drawn after everything solid, only
// where a tree covers the wolf: the tree marked the pixel (stencil 2, world.js coversWolves; a kitty or wolf in front
// of the tree takes the mark off, models.js VC_MAT) and the wolf is behind what is drawn there (GreaterDepth). Each
// pixel once (the stencil counts up), so the parts of a wolf don't draw over one another.
function xrayMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthFunc: THREE.GreaterDepth,
    stencilWrite: true, stencilRef: 2, stencilFunc: THREE.EqualStencilFunc, stencilZPass: THREE.IncrementStencilOp,
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalMatrix * mat3(instanceMatrix) * normal; vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = 1.0 - abs(dot(normalize(vN + vec3(1e-5)), normalize(vV)));
        rim = smoothstep(0.35, 0.9, rim);
        gl_FragColor = vec4(mix(vec3(0.06, 0.04, 0.08), vec3(1.0, 0.36, 0.1), rim), mix(0.45, 0.95, rim));
        #include <colorspace_fragment>
      }`,
  });
}

// glow: a material to draw every part with instead (a see-through layer over wolves drawn by another pack: the black
// wolves' heat as they turn round, main.js); add(m, color) gives each wolf its own colour (black: nothing shows)
function createWolfPack(scene, rigs, glow = null) {
  const packs = new Map();          // geometry -> { mesh, xray, n, eye, cap }
  const xrayMat = xrayMaterial();
  const cap = new Map();
  for (const [m, n] of rigs) m.group.traverse((o) => { if (o.isMesh) cap.set(o.geometry, (cap.get(o.geometry) || 0) + n); });
  const parts = new Map();          // rig -> [[proxyMesh, pack], ...]
  for (const [m] of rigs) {
    const list = [];
    m.group.traverse((o) => {
      if (!o.isMesh) return;
      let p = packs.get(o.geometry);
      if (!p) {
        // the eyes have a per-wolf MeshBasicMaterial (eye colour): white material * instance color instead
        // (the final run's ember cracks are unlit too: vertex colours * a white instance color)
        const eye = !glow && o.material.isMeshBasicMaterial;
        const mesh = new THREE.InstancedMesh(o.geometry, glow || (eye ? new THREE.MeshBasicMaterial({ vertexColors: !!o.material.vertexColors }) : o.material), cap.get(o.geometry));
        mesh.castShadow = !glow && o.castShadow;
        mesh.frustumCulled = false;   // wolves are already distance-culled in syncVisuals
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (glow) mesh.renderOrder = 2;
        if (eye || glow) {
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap.get(o.geometry) * 3), 3);
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        mesh.count = 0;
        mesh.name = 'wolfPack';
        scene.add(mesh);
        // the see-through copy: the same geometry and instance matrices (the eyes and ember cracks stay hidden)
        let xray = null;
        if (!eye && !glow) {
          xray = new THREE.InstancedMesh(o.geometry, xrayMat, cap.get(o.geometry));
          xray.instanceMatrix = mesh.instanceMatrix;
          xray.frustumCulled = false;
          xray.count = 0;
          xray.name = 'wolfXray';
          scene.add(xray);
        }
        p = { mesh, xray, n: 0, eye, glow: !!glow, cap: cap.get(o.geometry) };
        packs.set(o.geometry, p);
      }
      list.push([o, p]);
    });
    parts.set(m, list);
  }

  function begin() { for (const p of packs.values()) p.n = 0; }
  function add(m, color) {
    m.group.updateMatrixWorld(true);  // proxy has no parent: matrixWorld = its pose in the world
    for (const [o, p] of parts.get(m)) {
      if (p.n >= p.cap) continue;
      p.mesh.setMatrixAt(p.n, o.matrixWorld);
      if (p.glow) p.mesh.setColorAt(p.n, color);
      else if (p.eye) p.mesh.setColorAt(p.n, _c.copy(o.material.color));
      p.n++;
    }
  }
  // a posed rig's part matrices (and eye colours), to stamp at many places: the wolves of a hell wave all run the same
  // way, so one pose (a few strides) serves them all, moved (addSnap: x, y, z added to the pose's place)
  // (into buf, kept by the caller and reused frame after frame: nothing new made each frame)
  function snap(m, buf = []) {
    m.group.updateMatrixWorld(true);
    const list = parts.get(m);
    for (let j = 0; j < list.length; j++) {
      const [o, p] = list[j];
      const s = buf[j] || (buf[j] = [p, new THREE.Matrix4(), p.eye ? new THREE.Color() : null]);
      s[0] = p; s[1].copy(o.matrixWorld);
      if (s[2]) s[2].copy(o.material.color);
    }
    buf.length = list.length;
    return buf;
  }
  function addSnap(s, x, y, z) {
    for (const [p, mat, col] of s) {
      if (p.n >= p.cap) continue;
      _m.copy(mat);
      _m.elements[12] += x; _m.elements[13] += y; _m.elements[14] += z;
      p.mesh.setMatrixAt(p.n, _m);
      if (col) p.mesh.setColorAt(p.n, col);
      p.n++;
    }
  }
  function end() {
    for (const p of packs.values()) {
      p.mesh.count = p.n;
      p.mesh.visible = p.n > 0;   // skip empty packs (incl. shadow passes)
      if (p.xray) { p.xray.count = p.n; p.xray.visible = p.n > 0; }
      if (!p.n) continue;
      const im = p.mesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, p.n * 16); im.needsUpdate = true;
      const ic = p.mesh.instanceColor;
      if (ic) { ic.clearUpdateRanges(); ic.addUpdateRange(0, p.n * 3); ic.needsUpdate = true; }
    }
  }
  // frees the instance buffers and the eye materials; the part geometries and the shared wolf material are cached
  function dispose() {
    for (const p of packs.values()) {
      p.mesh.removeFromParent(); p.mesh.dispose(); if (p.eye) p.mesh.material.dispose();   // (a glow material is its owner's)
      if (p.xray) { p.xray.removeFromParent(); p.xray.dispose(); }
    }
    xrayMat.dispose();
    packs.clear();
    parts.clear();
  }
  return { begin, add, snap, addSnap, end, dispose };
}

export { createWolfPack };
