// "New build" of the rebuilt test widget: a RED box. The test serves this
// manifest from /api/widgets without broadcasting widgets.updated, so the
// mirror must pick it up through its pre-capture freshness check.
export default {
  description: 'Rebuilt test widget, version 2 (red).',
  version: '2',
  props: {},
  size: [0.3, 0.3, 0.3],
  create(ctx) {
    const { THREE } = ctx;
    ctx.root.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xff0000 })));
    return {};
  },
};
