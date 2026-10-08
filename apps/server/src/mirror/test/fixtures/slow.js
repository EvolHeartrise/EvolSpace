// Test widget whose create() resolves after 600 ms and then builds geometry one
// frame later: screenshots must wait for it instead of capturing an empty scene.
export default {
  description: 'Slow-loading test widget (orange torus knot).',
  version: '1',
  props: {},
  size: [0.4, 0.4, 0.2],
  async create(ctx) {
    const { THREE } = ctx;
    await new Promise((r) => setTimeout(r, 600));
    let built = false;
    return {
      update() {
        if (built) return;
        built = true;
        const geo = new THREE.TorusKnotGeometry(0.12, 0.04, 96, 12);
        ctx.root.add(new THREE.Mesh(geo, new THREE.MeshNormalMaterial()));
      },
    };
  },
};
