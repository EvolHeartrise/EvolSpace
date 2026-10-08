// Test widget with one sane mesh and one mesh whose geometry contains NaN
// (as a widget with an undefined size prop would produce). Framing must ignore the NaN part.
export default {
  description: 'Box plus a NaN-geometry mesh.',
  props: {},
  create(ctx) {
    const { THREE } = ctx;
    ctx.root.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.1), new THREE.MeshNormalMaterial()));
    const bad = new THREE.BufferGeometry();
    bad.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, NaN, 1, 0, 1, NaN, 0], 3));
    ctx.root.add(new THREE.Mesh(bad, new THREE.MeshBasicMaterial()));
    return {};
  },
};
