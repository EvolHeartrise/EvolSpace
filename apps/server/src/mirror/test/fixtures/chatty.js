// Test widget with side effects in create() and update(): scene edits
// (setProps, spawnChild), channel publishes, widget events and agent requests.
// The mirror is a passive observer, so none of these may reach the server.
export default {
  description: 'Side-effecting test widget (green box).',
  props: {},
  size: [0.2, 0.2, 0.2],
  create(ctx) {
    const { THREE } = ctx;
    ctx.root.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0x20c040 })));
    ctx.setProps({ touched: true });
    ctx.spawnChild('box', { size: 0.05 }, { position: [0, 0.2, 0] });
    ctx.channels.publish('test.chatty', 1);
    ctx.event('created', { n: 1 });
    ctx.askAgent('hello from chatty');
    let n = 0;
    return {
      onProps() { /* handles prop changes in place (no re-create) */ },
      update() {
        n++;
        if (n % 5 === 0) {
          ctx.channels.publish('test.chatty', n);
          ctx.setProps({ n });
        }
      },
    };
  },
};
