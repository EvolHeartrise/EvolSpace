// "Old build" of the rebuilt test widget: a GREEN box (see rebuilt-v2.js).
export default {
  description: 'Rebuilt test widget, version 1 (green).',
  version: '1',
  props: {},
  size: [0.3, 0.3, 0.3],
  create(ctx) {
    const { THREE } = ctx;
    ctx.root.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0x00ff00 })));
    return {};
  },
};
