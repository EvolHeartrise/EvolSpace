// Test widget (plain ESM, as the server's esbuild output would be).
// MeshNormalMaterial gives each face a different color, so screenshots have variance.
export default {
  description: 'Test box with normal-shaded faces, white edges and a text label.',
  version: '1',
  props: {
    size: { type: 'number', default: 0.3 },
    label: { type: 'string', default: 'box' },
  },
  size: [0.3, 0.3, 0.3],
  create(ctx) {
    const { THREE } = ctx;
    const s = ctx.props.size;
    const geo = new THREE.BoxGeometry(s, s, s);
    const mesh = new THREE.Mesh(geo, new THREE.MeshNormalMaterial());
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff })));
    ctx.root.add(mesh);
    let text = null;
    if (ctx.ui && typeof ctx.ui.text === 'function') {
      text = ctx.ui.text(String(ctx.props.label), { size: s * 0.25, anchorX: 'center', anchorY: 'bottom' });
      text.position.set(0, s / 2 + 0.02, 0);
      ctx.root.add(text);
    }
    return {
      dispose() { geo.dispose(); },
    };
  },
};
